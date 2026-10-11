/**
 * dsh-plugin-grill-me — the Cordis (host) half.
 *
 * Reproduces mattpocock's `grill-me` / `grilling` skill as a deterministic
 * interview state machine that lives in the host rather than in the prompt:
 *
 *   1. two skills — `grill-me` (wrapper, user-invoked only) and `grilling`
 *      (primitive, model-invocable) — from `../src/skill.js`;
 *   2. a read-only `grill_status` tool that reports the interview state;
 *   3. an `agent/pre-step` listener that injects the current frontier state
 *      into the step, keeping exactly one plugin-owned message;
 *   4. an `agent/turn-stopping` listener that steers a correction back into
 *      the turn that committed the breach, once per distinct violation;
 *   5. a `/grill-me` command that arms the interview and prints the status.
 *
 * Every host surface is optional at runtime: a missing or incompatible
 * service degrades to a no-op instead of failing `apply` and taking the
 * whole plugin (including the skills) down with it.
 *
 * This module may import ONLY `node:` builtins and the plugin's own pure
 * modules — the `desktop` profile has no `@deepseek-ai` scope installed, so
 * message objects are built with the dependency-free `makeUserMessage`.
 *
 * @module dsh-plugin-grill-me
 */

import {
  SOURCE_KIND,
  correctionDelivered,
  createProjector,
  describeViolation,
  isPluginMessage,
  makeUserMessage,
  renderDirective,
  renderStatus,
  violationKey,
} from '../src/state.js'
import {
  PRIMITIVE_CONTENT,
  PRIMITIVE_DESCRIPTION,
  PRIMITIVE_NAME,
  PROVIDER,
  WRAPPER_CONTENT,
  WRAPPER_DESCRIPTION,
  WRAPPER_NAME,
} from '../src/skill.js'

/** Cordis plugin name. */
export const name = 'grill-me'

/**
 * Services this plugin composes with. All three are core host services in
 * DSH; each is still probed defensively below before use.
 */
export const inject = ['skills', 'tools', 'commands']

/**
 * Hard ceiling on corrections steered for one distinct violation.
 *
 * One is enough: the point of a correction is to hand the model the rule it
 * broke, and the transcript guard below already suppresses a repeat while the
 * model has not answered. Budgeting per `(agent, turn)` instead let each steer —
 * which starts a *new* turn — buy a fresh budget, so a single recorded act
 * re-fired forever (GRILL-23).
 */
const CORRECTION_CAP = 1

/** Upper bound on tracked violation correction counters. */
const CORRECTION_TRACK_LIMIT = 128

/** Upper bound on memoised per-agent transcript projections. */
const PROJECTOR_LIMIT = 64

/** Tool name the model sees. */
const TOOL_NAME = 'grill_status'

/** Command name the user types. */
const COMMAND_NAME = 'grill-me'

/** Shown when the transcript cannot be read (never thrown). */
const STATUS_FALLBACK = 'grill-me：无法读取当前会话的转写记录，暂时拿不到访谈状态。'

/** Command preamble; the status of the session follows it. */
const COMMAND_ARMED_TEXT =
  '已就绪：grill-me 访谈已装填。接下来我会把你的计划当成一棵设计树，逐轮清空 frontier —— 每个问题都给出推荐答案，等你回答后再进入下一轮；需要事实时我自己去查，不问你。'

/**
 * Read the calling agent's transcript in the order the host stores it.
 *
 * @param {unknown} agent Runtime agent instance (only `session` is touched).
 * @returns {unknown[] | null} Raw session events, or `null` when unavailable.
 */
function readTranscript(agent) {
  try {
    const session = agent?.session
    const snapshot = session?.snapshotEvents
    if (typeof snapshot !== 'function') return null
    const events = snapshot.call(session)
    if (!Array.isArray(events)) return null
    return events
  } catch {
    return null
  }
}

/**
 * Register one disposer, ignoring anything an optional service did not return.
 *
 * @param {Function[]} disposers Collected disposers.
 * @param {unknown} disposer Value returned by a `register` call.
 * @returns {void}
 */
function keep(disposers, disposer) {
  if (typeof disposer === 'function') disposers.push(disposer)
}

/**
 * Register both skills: the user-invoked wrapper and the model-invocable
 * primitive. Mirrors upstream's two-layer `grill-me` → `grilling` split.
 *
 * @param {object} ctx Cordis context.
 * @param {Function[]} disposers Collected disposers.
 * @returns {void}
 */
function registerSkills(ctx, disposers) {
  const skills = ctx?.skills
  if (skills === null || skills === undefined || typeof skills.register !== 'function') return

  const definitions = [
    {
      name: WRAPPER_NAME,
      description: WRAPPER_DESCRIPTION,
      content: WRAPPER_CONTENT,
      invocation: { modelInvocable: false, userInvocable: true },
      provider: PROVIDER,
      source: `plugin:${name}`,
      metadata: { grillMe: 'wrapper' },
    },
    {
      name: PRIMITIVE_NAME,
      description: PRIMITIVE_DESCRIPTION,
      content: PRIMITIVE_CONTENT,
      invocation: { modelInvocable: true, userInvocable: true },
      provider: PROVIDER,
      source: `plugin:${name}`,
      metadata: { grillMe: 'primitive' },
    },
  ]

  for (const definition of definitions) {
    // A rejected duplicate must not prevent the second skill from landing.
    try {
      keep(disposers, skills.register(definition))
    } catch {
      /* skill registry refused this one — keep going */
    }
  }
}

/**
 * Register the read-only `grill_status` tool.
 *
 * @param {object} ctx Cordis context.
 * @param {Function[]} disposers Collected disposers.
 * @param {Function} readState Instance state reader.
 * @returns {void}
 */
function registerTool(ctx, disposers, readState) {
  const tools = ctx?.tools
  if (tools === null || tools === undefined || typeof tools.register !== 'function') return

  const definition = {
    name: TOOL_NAME,
    description:
      '报告当前会话中的 grill-me 访谈状态：是否正在进行、已经问了几轮、哪些问题还在等用户回答、是否可以收尾。只读操作，不改变任何状态。',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'string' },
      render(_args, value) {
        return [{ type: 'text', text: typeof value === 'string' ? value : String(value ?? '') }]
      },
    },
    // The runtime calls this as a function (`tool.isConcurrencySafe(exec.arguments)`,
    // dsh-tools lib/index.js:3059-3061), so it must never be a bare boolean.
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      try {
        const state = readState(exec?.agent)
        if (state === null) return STATUS_FALLBACK
        return renderStatus(state)
      } catch {
        return STATUS_FALLBACK
      }
    },
  }

  try {
    keep(disposers, tools.register(definition))
  } catch {
    /* tool surface unavailable on this host */
  }
}

/**
 * Register the `/grill-me` command.
 *
 * @param {object} ctx Cordis context.
 * @param {Function[]} disposers Collected disposers.
 * @param {Function} readState Instance state reader.
 * @returns {void}
 */
function registerCommand(ctx, disposers, readState) {
  const commands = ctx?.commands
  if (commands === null || commands === undefined || typeof commands.register !== 'function') return

  const definition = {
    name: COMMAND_NAME,
    description: '装填 grill-me：把当前会话切进不留情面的访谈模式，并显示访谈状态。',
    input: { hint: '[可选：这次要拷问的主题]' },
    handler(invocation) {
      try {
        const state = readState(invocation?.agent)
        const status = state === null ? STATUS_FALLBACK : renderStatus(state)
        return { kind: 'success', text: `${COMMAND_ARMED_TEXT}\n\n${status}` }
      } catch {
        return { kind: 'success', text: COMMAND_ARMED_TEXT }
      }
    },
  }

  try {
    keep(disposers, commands.register(definition))
  } catch {
    /* command surface unavailable on this host */
  }
}

/**
 * Build the `agent/pre-step` waterfall listener for one plugin instance.
 *
 * Appends — or refreshes in place — a single plugin-owned directive message
 * carrying the current frontier state, and drops every *further* plugin-owned
 * *directive* in the same batch, so exactly one ever reaches the model. A
 * plugin-owned message of any other form — the `correction` the turn gate
 * steers — is passed through untouched: it carries the rule the model just
 * broke, and collapsing it into the directive erased it before the model (and
 * therefore before the transcript) ever saw it (GRILL-27). Matching is by
 * `source.kind` (plus `source.form` for the directive) and never by
 * `message.id`: an id-less stale message used to make the replacement hit an
 * unrelated id-less message, and a second plugin message used to survive
 * untouched (GRILL-19, GRILL-20).
 *
 * It never rejects and never throws: a failure to analyze the transcript
 * returns the untouched decision (`{kind:'reject'}` ends the turn as `blocked`
 * and can strand tool results already produced).
 *
 * @param {Function} readState Instance state reader.
 * @returns {Function} The listener.
 */
function createPreStepListener(readState) {
  return async function onPreStep({ agent }, next) {
    const decision = await next()
    try {
      if (decision === null || decision === undefined) return decision
      if (decision.kind === 'reject') return decision

      const state = readState(agent)
      if (state === null || state.active !== true) return decision

      const text = renderDirective(state)
      if (typeof text !== 'string' || text.length === 0) return decision

      const directive = makeUserMessage(text, { kind: SOURCE_KIND, form: 'directive' })
      const messages = Array.isArray(decision.messages) ? decision.messages : []
      // A step that claimed no input has no user turn to grill; injecting there
      // would send the model a plugin-only prompt (dsh-tool-skill appends
      // unconditionally, but its catalog is harmless in that position).
      if (messages.length === 0) return decision

      const rewritten = []
      let replaced = false
      for (const message of messages) {
        // A steered correction is the one plugin-owned message that must NOT be
        // absorbed: the model has to read the rule it just broke (GRILL-27).
        if (!isPluginMessage(message) || message?.source?.form !== 'directive') {
          rewritten.push(message)
          continue
        }
        if (!replaced) {
          rewritten.push(directive)
          replaced = true
        }
      }
      if (!replaced) rewritten.push(directive)

      return { ...decision, kind: 'enter', messages: rewritten }
    } catch {
      return decision
    }
  }
}

/**
 * Build the `agent/turn-stopping` listener for one plugin instance.
 *
 * When the transcript violates the protocol, steer a correction into the same
 * turn so the model answers the outstanding round instead of acting on it.
 * Capped at {@link CORRECTION_CAP} per distinct violation, and only ever for a
 * breach that is still live: the act must belong to the ending turn and the round
 * it jumped ahead of must still be unanswered (GRILL-31). Never throws.
 *
 * @param {Function} readState Instance state reader.
 * @param {Function} allowCorrection Instance correction budget.
 * @returns {Function} The listener.
 */
function createTurnStoppingListener(readState, allowCorrection) {
  return async function onTurnStopping({ agent, turn }) {
    try {
      if (agent === null || agent === undefined) return
      if (typeof agent.steer !== 'function') return

      const events = readTranscript(agent)
      if (events === null) return
      const state = readState(agent)
      if (state === null || state === undefined || state.active !== true) return

      // Keyed by the violation, not by the turn (GRILL-23), and `null` for a
      // violation that is history rather than a live breach (GRILL-31).
      const key = violationKey(state, turn)
      if (key === null) return

      const text = describeViolation(state)
      if (typeof text !== 'string' || text.length === 0) return

      // Our own correction still being the newest conversational event means the
      // model has not answered it yet; steering again would only stack duplicates.
      if (hasUnansweredCorrection(events)) return

      // The transcript outlives this instance: a reloaded or re-applied plugin
      // starts with a fresh budget, so the record of what was already said is what
      // stops the same correction from being bought twice (GRILL-31).
      if (correctionDelivered(events, text)) return

      if (!allowCorrection(agent.id, key)) return
      agent.steer(makeUserMessage(text, { kind: SOURCE_KIND, form: 'correction' }))
    } catch {
      /* a turn must never fail because of this listener */
    }
  }
}

/**
 * Whether the newest conversational event is a correction we steered that the
 * model has not responded to yet.
 *
 * A correction is steered onto the inbox and only surfaces as a `user/message`
 * once the host claims it for the next step, so "we already asked for this" is
 * observable purely from the transcript. An `assistant/message` after the
 * correction proves the model responded — a repeat violation is then fair game.
 *
 * @param {unknown[]} events Raw session events (oldest first).
 * @returns {boolean} `true` when a fresh steer would only duplicate.
 */
function hasUnansweredCorrection(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'assistant/message') return false
    if (event?.type === 'user/message') {
      const message = event.data
      return isPluginMessage(message) && message?.source?.form === 'correction'
    }
  }
  return false
}

/**
 * Cordis entry point.
 *
 * @param {object} ctx Cordis context.
 * @param {object} [config] Plugin config (unused; kept for loader symmetry).
 * @returns {Function[]} Disposers, so a host that disposes return values can
 * tear the plugin down.
 */
export function apply(ctx, config = {}) {
  void config
  const disposers = []

  /**
   * Correction counters keyed by `"<agent id>::<turn>"`, oldest inserted entry
   * evicted once the map exceeds {@link CORRECTION_TRACK_LIMIT}.
   *
   * Per plugin instance, not per process: a reloaded, disabled-then-enabled or
   * re-applied plugin starts with a full budget, and two instances living in one
   * process cannot spend each other's (GRILL-22).
   */
  const correctionCounts = new Map()

  /**
   * One memoised projector per agent. The host hands over the whole session on
   * every step; re-projecting it from scratch made each step cost a full pass
   * over a transcript that only grows.
   */
  const projectors = new Map()

  /**
   * Read and analyze the calling agent's transcript, tolerating any failure.
   *
   * @param {unknown} agent Runtime agent instance.
   * @returns {object | null} `GrillState`, or `null` when unreadable.
   */
  const readState = (agent) => {
    const events = readTranscript(agent)
    if (events === null) return null
    const key = String(agent?.id ?? 'anonymous')
    let projector = projectors.get(key)
    if (projector === undefined) {
      projector = createProjector()
      projectors.set(key, projector)
      while (projectors.size > PROJECTOR_LIMIT) {
        const oldest = projectors.keys().next().value
        if (oldest === undefined) break
        projectors.delete(oldest)
      }
    }
    try {
      return projector.analyze(events)
    } catch {
      return null
    }
  }

  /**
   * Decide whether one more correction may be steered for a violation, and
   * record it.
   *
   * The key is a violation identity (see `violationKey`), never a turn: a turn
   * key made every steer pay for the next one (GRILL-23).
   *
   * @param {unknown} agentId Agent identity (`agent.id`).
   * @param {unknown} violation Stable violation key.
   * @returns {boolean} `true` when a correction is still allowed.
   */
  const allowCorrection = (agentId, violation) => {
    const key = `${agentId ?? 'unknown'}::${violation ?? 'unknown'}`
    const used = correctionCounts.get(key) ?? 0
    if (used >= CORRECTION_CAP) return false
    correctionCounts.set(key, used + 1)
    while (correctionCounts.size > CORRECTION_TRACK_LIMIT) {
      const oldest = correctionCounts.keys().next().value
      if (oldest === undefined) break
      correctionCounts.delete(oldest)
    }
    return true
  }

  const onPreStep = createPreStepListener(readState)
  const onTurnStopping = createTurnStoppingListener(readState, allowCorrection)

  const disposeAll = () => {
    correctionCounts.clear()
    projectors.clear()
    for (const dispose of disposers.splice(0).reverse()) {
      try {
        dispose()
      } catch {
        /* already disposed */
      }
    }
  }

  registerSkills(ctx, disposers)
  registerTool(ctx, disposers, readState)
  registerCommand(ctx, disposers, readState)

  if (typeof ctx?.on === 'function') {
    try {
      keep(disposers, ctx.on('agent/pre-step', onPreStep))
    } catch {
      /* event bus refused the listener */
    }
    try {
      keep(disposers, ctx.on('agent/turn-stopping', onTurnStopping))
    } catch {
      /* event bus refused the listener */
    }
  }

  if (typeof ctx?.effect === 'function') {
    try {
      ctx.effect(() => disposeAll)
    } catch {
      /* effects unavailable — the returned array still covers disposal */
    }
  }

  return disposers
}
