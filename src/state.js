/**
 * Deterministic grilling state machine.
 *
 * Pure, dependency-free projection of a DSH session transcript onto the
 * upstream `grilling` protocol:
 *
 *   - the design tree is worked in ROUNDS,
 *   - a round is the whole frontier asked at once (numbered questions, each
 *     carrying a recommended answer),
 *   - after a round the interviewer WAITS for the user's answers,
 *   - the session ends only when the frontier is empty AND the user confirms
 *     a shared understanding.
 *
 * Everything here is derived from the transcript, never from plugin-local
 * bookkeeping, so a resumed, forked, or externally seeded transcript projects
 * identically.
 *
 * @module dsh-plugin-grill-me/state
 */

import { randomUUID } from 'node:crypto'

/** Marker line the plugin injects at the top of its directive messages. */
export const DIRECTIVE_MARKER = '[[grill-me]]'

/** Marker line the plugin injects when it must correct the interviewer. */
export const CORRECTION_MARKER = '[[grill-me:correction]]'

/** Source tag that marks a message as plugin-owned (never a real user reply). */
export const SOURCE_KIND = 'grill-me'

/** Matches `Q1`, `**Q1**`, `❓ **Q1** - **title**`, `**Q 12**:` and friends. */
const QUESTION_RE = /(?:^|\n)\s*(?:[^\S\n]*❓)?[^\S\n]*\*{0,2}Q\s?(\d{1,3})\*{0,2}\s*[-–—:：.)、]?/g

/** Matches a recommended-answer line (`➡️ …`, `=> …`, `Recommendation: …`). */
const RECOMMEND_RE = /(?:^|\n)\s*[^\S\n]*(?:➡️?|→|=>|推荐答案|推荐|建议答案|Recommendation)\s*[:：]?/g

/**
 * The header shapes that make a message a *round* rather than prose.
 *
 * A round carries the protocol's own header — `❓ **Q1** - **Title**:` — and the
 * protocol asks for a recommendation marker. Plain prose that merely labels
 * things `Q1 … Q2 …` (revenue quarters, a quiz, a report restating the
 * questions it was asked) must never register: a false round opens an interview
 * nobody requested, and the directive then hands the model its own prose back
 * as "the frontier", which becomes the next round. Live-confirmed: one probe
 * escalated through three self-feeding rounds with no user input at all.
 */
const EMOJI_MARK_RE = /(?:^|\n)\s*[^\S\n]*❓/g
const HEADER_MARK_RE = /(?:^|\n)\s*[^\S\n]*\*{0,2}Q\s?\d{1,3}\*{0,2}\s*[-–—:：.)、]\s*\*\*[^*\n]{1,160}\*\*/g

/** Hard cap on the questions kept from one round (upstream's own sample: 13). */
const MAX_ROUND_QUESTIONS = 60

/**
 * Activation patterns matched against user-authored text.
 *
 * The English word "grill" alone is deliberately absent: a user chatting about
 * barbecue — or about the grilling protocol itself — must not be dragged into
 * an interview. English activation needs the explicit slash command; the
 * Chinese phrases are unambiguous enough to stand on their own.
 *
 * This plugin's own name is deliberately absent too. It used to be listed here,
 * and that armed the interview in every session where somebody merely
 * *mentioned* the plugin — a teammate reporting on it, a transcript quoting its
 * directive. A mention is not a gesture.
 */
const GESTURE_TRIGGER_RE = /(拷问|盘问|质询|逼问|压力测试|grill\s*我|grill\s+(?:me|us)\b)/i
// A prose gesture has to OPEN the message or open its own line: `please grill me`
// and `帮我盘问一下` are invitations, while the very same words quoted, listed or
// discussed mid-sentence are mentions (GRILL-18).
const GESTURE_LEAD_MAX = 8

/**
 * Whether the user's own speech contains an explicit grilling gesture.
 *
 * The slash command is a command, so a bare `/grill-me` anywhere in the user's
 * own speech counts; the prose triggers are words, so they must open the
 * message (or their own line) to count as an invitation.
 *
 * @param text - already de-quoted message text (see `stripQuotedBlocks`).
 * @returns true when the user asked to be grilled.
 */
function isGestureText(text) {
  if (typeof text !== 'string' || text.length === 0) return false
  const speech = text.replace(/\r/g, '')
  if (/\/(?:grill-me|grilling)\b/i.test(speech)) return true
  for (const match of speech.matchAll(new RegExp(GESTURE_TRIGGER_RE.source, 'gi'))) {
    const at = match.index ?? 0
    const lineStart = speech.lastIndexOf('\n', at - 1) + 1
    const lead = speech.slice(lineStart, at).replace(/^[ \t]*(?:[-*+>]|\d+[.)])?[ \t]*/, '')
    if (lead.length <= GESTURE_LEAD_MAX) return true
  }
  return false
}

/** Opt-out patterns matched against user-authored text. */
const USER_END_RE =
  /(\/grill-stop\b|\bstop grilling\b|\bend the grill\b|停止拷问|停止盘问|结束拷问|不用问了|别问了)/i

const CONFIRM_RE =
  /(共享理解|达成共识|确认理解|理解一致|没有问题|没有其他问题|没有别的(?:问题)?|就这些|就这样|可以了|开始吧|动手吧|确认执行|按这个来|照这个做|全部确认|全部同意|都同意|都确认|都按推荐|按你的推荐|按推荐|全按推荐|都行|都可以|都对|全对|没问题|没意见|yes to (?:all|everything|them|that)|all yes|shared understanding|nothing (?:else|more)|no more questions|go ahead|proceed|ship it|lgtm|sounds good|agreed|all confirmed|all good|confirm(?:ed)?\b)/i

/* ------------------------------------------------------------------ *
 * Message helpers
 * ------------------------------------------------------------------ */

/**
 * Build a user message shaped exactly like the host's `createUserMessage`.
 *
 * Reimplemented locally on purpose: the plugin must not import
 * `@deepseek-ai/*` (the profile does not install that scope).
 *
 * @param text    - message text.
 * @param source  - the message's producer tag.
 * @returns a frozen user message.
 */
export function makeUserMessage(text, source = { kind: SOURCE_KIND }) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text: String(text) })]),
    source: Object.freeze({ ...source }),
  })
}

/** Whether a message was produced by this plugin (never a real user reply). */
export function isPluginMessage(message) {
  return unwrapMessage(message)?.source?.kind === SOURCE_KIND
}

/* ------------------------------------------------------------------ *
 * Transcript normalization
 * ------------------------------------------------------------------ */

const first = (value) => (Array.isArray(value) ? value[0] : undefined)

const asArray = (value) => (Array.isArray(value) ? value : [])

/**
 * Accept a message, a session event, or either one nested in `data`.
 *
 * Callers legitimately hold both: `projectEvents` hands over raw events while
 * the plugin hooks hand over the message a step is about to run on.
 *
 * @param value - any message-shaped value.
 * @returns the innermost message-shaped value.
 */
export function unwrapMessage(value) {
  let current = value
  for (let depth = 0; depth < 3 && current && typeof current === 'object'; depth += 1) {
    if (current.content !== undefined || current.role !== undefined) return current
    const next = current.message ?? current.data?.message ?? current.data
    if (!next || typeof next !== 'object' || next === current) break
    current = next
  }
  return current
}

/**
 * Content block types that carry private deliberation, not speech.
 *
 * The host records a model's thinking as a `reasoning` block next to the visible
 * answer, and thinking routinely quotes the protocol back to itself ("format it
 * like ❓ **Q1** - **title**"). Counting that as a round the agent asked creates
 * phantom rounds out of nothing the user ever saw, so reasoning is never speech.
 */
const REASONING_BLOCK_TYPES = new Set([
  'reasoning',
  'reasoning_content',
  'redacted_reasoning',
  'redacted_thinking',
  'thinking',
  'analysis',
])

/** Whether a content block is private deliberation rather than speech. */
function isReasoningBlock(block) {
  return (
    Boolean(block) &&
    typeof block === 'object' &&
    REASONING_BLOCK_TYPES.has(String(block.type ?? '').toLowerCase())
  )
}

/**
 * Text of every text block in a message.
 * @param message - any message-shaped value.
 * @returns the concatenated text, with reasoning blocks excluded.
 */
export function messageText(message) {
  const blocks = asArray(unwrapMessage(message)?.content)
  let out = ''
  for (const block of blocks) {
    if (typeof block === 'string') out += block
    else if (block && typeof block.text === 'string' && !isReasoningBlock(block)) {
      out += (out ? '\n' : '') + block.text
    }
  }
  return out
}

const TOOL_BLOCK_TYPES = new Set([
  'tool-call',
  'tool_use',
  'tool-use',
  'tool_call',
  'function_call',
  'toolCall',
])

const isToolBlock = (block) =>
  Boolean(block) &&
  typeof block === 'object' &&
  (TOOL_BLOCK_TYPES.has(block.type) ||
    typeof block.name === 'string' ||
    typeof block.toolName === 'string')

/**
 * Tool names a message asks to run.
 * @param message - any message-shaped value.
 * @returns tool names, in order.
 */
export function toolCallNames(message) {
  const names = []
  for (const block of asArray(unwrapMessage(message)?.content)) {
    if (!isToolBlock(block)) continue
    const name = block.name ?? block.toolName
    if (typeof name === 'string' && name.length > 0) names.push(name)
  }
  return names
}

/**
 * The `name` argument of every `skill` tool call in a message.
 *
 * Loading `grilling` through the `skill` tool is a legitimate way into the
 * interview (the host model does it when the user asks for it), so the state
 * machine has to see which skill was fetched, not just that a tool ran.
 *
 * @param message - any message-shaped value.
 * @returns the requested skill names, in order.
 */
export function skillToolRequests(message) {
  const names = []
  for (const block of asArray(unwrapMessage(message)?.content)) {
    if (!isToolBlock(block)) continue
    const tool = block.name ?? block.toolName
    if (tool !== 'skill') continue
    const raw = block.arguments ?? block.input ?? block.args
    let args = raw
    if (typeof raw === 'string') {
      try {
        args = JSON.parse(raw)
      } catch {
        const match = /"name"\s*:\s*"([^"]+)"/.exec(raw)
        args = match ? { name: match[1] } : undefined
      }
    }
    const name = args && typeof args === 'object' ? (args.name ?? args.skill) : undefined
    if (typeof name === 'string' && name.length > 0) names.push(name)
  }
  return names
}

const SOURCE_LABELS = new Set(['skill', 'skill-content', 'gesture', 'command', 'skill-invocation'])

/** Whether a user message's own source says "a skill was invoked". */
function sourceInvokesSkill(source) {
  if (!source || typeof source !== 'object') return false
  const label = typeof source.kind === 'string' ? source.kind : ''
  if (!SOURCE_LABELS.has(label)) return false
  const value = [source.name, source.skill, source.command, source.gesture]
    .filter((entry) => typeof entry === 'string')
    .join(' ')
  return /grill/i.test(value) || /拷问|盘问/.test(value)
}

/**
 * Normalize raw session events into ordered, stable facts.
 *
 * Tolerates unknown event types, missing `data`, malformed tool arguments, and
 * non-event junk: anything unrecognized projects to `{ kind: 'unknown' }`.
 *
 * @param rawEvents - session events (`snapshotEvents()` output or similar).
 * @returns normalized facts, oldest first.
 */
export function projectEvents(rawEvents) {
  const events = asArray(rawEvents)
  const facts = []
  for (const entry of events) {
    try {
      const fact = projectEvent(entry)
      if (fact) facts.push(fact)
    } catch {
      facts.push({ kind: 'unknown', type: String(entry?.type ?? '') })
    }
  }
  return facts
}

function projectEvent(entry) {
  if (!entry || typeof entry !== 'object') return { kind: 'unknown', type: '' }
  const type = String(entry.type ?? entry.kind ?? '')
  const data = entry.data !== undefined ? entry.data : entry
  const seq = Number.isFinite(entry.seq) ? entry.seq : undefined
  const base = { seq, type, turn: entry.turn ?? data?.turn, step: entry.step ?? data?.step }

  switch (type) {
    case 'user/message': {
      const message = data?.message ?? data
      const text = messageText(message)
      const names = toolCallNames(message)
      // A gesture only counts in the user's own speech: a slash command quoted
      // inside a fenced block (documentation, a pasted transcript) must not arm
      // the machine. Prose triggers additionally require a human-authored
      // message — see the activation pass in `analyzeFacts`.
      const gestureText = strippedOf(text)
      const activation = isGestureText(gestureText) && !isDirectiveText(text)
      const deactivation = USER_END_RE.test(text)
      return {
        ...base,
        kind: 'user',
        plugin: isPluginMessage(message),
        messageId: message?.id,
        source: message?.source,
        text,
        activation,
        deactivation,
        skillInvocation: sourceInvokesSkill(message?.source),
        skillLoad: skillToolRequests(message),
        toolNames: names,
      }
    }
    case 'assistant/message': {
      const message = data?.message ?? data
      const text = messageText(message)
      return {
        ...base,
        kind: 'assistant',
        messageId: message?.id,
        source: message?.source ?? { kind: 'model' },
        text,
        questions: parseQuestions(text),
        recommends: countMatches(text, RECOMMEND_RE),
        installs: parseInstalls(text),
        announcesDone: /frontier[^\n]{0,40}(empty|clear|settled)|frontier\s*(?:已|为空|清空)|没有(?:其他)?待定问题|no\s+(?:open|remaining)\s+(?:questions|decisions)|design tree[^\n]{0,40}(complete|done|fully visited)|整棵树(?:已经)?走完/i.test(
          strippedOf(text),
        ),
        confirms: /共享理解|shared understanding/i.test(text),
        toolNames: toolCallNames(message),
        skillLoad: skillToolRequests(message),
      }
    }
    case 'assistant/attempt':
      return { ...base, kind: 'attempt', text: '', questions: [], toolNames: [] }
    case 'tool/call': {
      const args = typeof data?.arguments === 'string' ? tryParseJson(data.arguments) : data?.arguments
      const name = typeof data?.name === 'string' ? data.name : ''
      return {
        ...base,
        kind: 'tool-call',
        name,
        callId: data?.callId,
        skillLoad: name === 'skill' && args && typeof args.name === 'string' ? [args.name] : [],
      }
    }
    case 'tool/result':
      return {
        ...base,
        kind: 'tool-result',
        isError: Boolean(data?.error),
        name: data?.message?.name,
      }
    case 'turn/start':
      return { ...base, kind: 'turn-start' }
    case 'turn/end':
      return { ...base, kind: 'turn-end', reason: data?.reason?.kind ?? data?.reason }
    case 'step/start':
      return { ...base, kind: 'step-start' }
    case 'step/end':
      return { ...base, kind: 'step-end' }
    case 'developer/message':
      return { ...base, kind: 'developer', text: messageText(data?.message ?? data) }
    case 'system/message':
      return { ...base, kind: 'system', text: messageText(data?.message ?? data) }
    default:
      return { ...base, kind: 'other' }
  }
}

/** Whether text is one of this plugin's own injected messages. */
function isDirectiveText(text) {
  return (
    typeof text === 'string' &&
    (text.includes(DIRECTIVE_MARKER) || text.includes(CORRECTION_MARKER))
  )
}

/**
 * Strip the parts of a message that are quotations rather than speech.
 *
 * Fenced code blocks are how the protocol gets *documented*, the host wraps
 * a skill body in `<skill_content>`, inline code is how a trigger gets
 * *mentioned*, and a blockquote is someone else's words; a round or a gesture
 * shown as an example must never register as something the agent or the user
 * actually did.
 *
 * @param text    - raw message text.
 * @param options - `{ inlineCode }`: `'drop'` (default) removes a whole inline
 *                  span, which is what a *mention* has to be for the gesture
 *                  tests; `'keep'` unwraps the backticks and keeps the text,
 *                  which is what a question or an answer needs — dropping
 *                  `` `dsh-plugin-grill-me` `` wholesale left blank gaps in the
 *                  injected round (GRILL-24).
 * @returns the text with quotations removed.
 */
export function stripQuotedBlocks(text, options) {
  if (typeof text !== 'string' || text.length === 0) return ''
  const stripped = text
    .replace(/^[ \t]*(?:```|~~~)[^\n]*\n[\s\S]*?^[ \t]*(?:```|~~~)[ \t]*$/gm, '\n')
    .replace(/```[\s\S]*?```/g, '\n')
    .replace(/~~~[\s\S]*?~~~/g, '\n')
    .replace(/<skill_content\b[\s\S]*?<\/skill_content>/gi, '\n')
    .replace(/<skill_resources\b[\s\S]*?<\/skill_resources>/gi, '\n')
    .replace(/^[ \t]*```.*$/gm, '\n')
    .replace(/^[ \t]*>.*$/gm, '\n')
  return options?.inlineCode === 'keep'
    ? stripped.replace(/`([^`\n]*)`/g, '$1')
    : stripped.replace(/`[^`\n]*`/g, ' ')
}

function countMatches(text, re) {
  if (typeof text !== 'string' || text.length === 0) return 0
  const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
  let count = 0
  while (global.exec(text) !== null && count < 500) count += 1
  return count
}

/**
 * Remove quoted blocks before a whole-message pattern test.
 *
 * Unconditional: inline code spans and blockquotes are quotations too, so a
 * cheap "does it contain a fence?" short-circuit would let `` `/grill-me` ``
 * and `> /grill-me` arm the interview (GRILL-18).
 */
function strippedOf(text) {
  if (typeof text !== 'string') return ''
  return stripQuotedBlocks(text)
}

/** Parse JSON, returning `undefined` instead of throwing. */
function tryParseJson(raw) {
  if (typeof raw !== 'string') return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/** Whether a skill name refers to this plugin's interview. */
function isGrillSkillName(name) {
  return typeof name === 'string' && /^(?:grill-me|grilling)$/i.test(name.trim())
}

/**
 * Host-injected user-role messages that carry no `source` at all.
 *
 * The host writes runtime-context snapshots and per-step time samples into the
 * transcript as ordinary user messages. With no `source.kind` to go on, these
 * prefixes are the only evidence that the human did not write them — and a
 * snapshot left unclassified can settle a round or confirm the design on the
 * user's behalf.
 */
const HOST_CONTEXT_RE =
  /^\s*(?:Current runtime context\.|Time sampled while preparing|Browser time zone for this request:|Elapsed since the preceding step context:)/

/**
 * Whether a user-role message is the human speaking.
 *
 * The host writes runtime-context snapshots, skill catalogs and this plugin's
 * own directives into the transcript as `user/message` events, so an explicit
 * `source.kind === 'user'` is the only reliable evidence of a real reply.
 * Messages with no source at all are accepted (older transcripts, tests).
 */
function userAuthored(fact) {
  const kind = fact?.source?.kind
  if (kind === undefined || kind === null || kind === '') {
    const text = fact?.text ?? ''
    return (
      !isDirectiveText(text) && !/<skill_content\b/i.test(text) && !HOST_CONTEXT_RE.test(text)
    )
  }
  return kind === 'user'
}

/* ------------------------------------------------------------------ *
 * Round parsing
 * ------------------------------------------------------------------ */

/**
 * Parse the questions of one assistant message.
 *
 * A message counts as a round only when it is unambiguously asking: it must
 * carry one of the protocol's own header shapes (a `❓` marker line, or a
 * `**Qn — **Title**` line), plus a recommendation marker or several questions.
 * Prose that merely *labels* questions (`Q1: …`) or *discusses* the format is
 * not a round — the gate is deliberately stricter than the parser, because a
 * false round invents debt the user never agreed to answer (GRILL-16).
 *
 * @param text - assistant message text.
 * @returns the parsed questions (empty when the message is not a round).
 */
export function parseQuestions(text) {
  if (typeof text !== 'string' || text.length === 0) return []
  const speech = stripQuotedBlocks(text, { inlineCode: 'keep' })
  const marks = [...speech.matchAll(QUESTION_RE)]
  if (marks.length === 0) return []
  // Shape gate first: labelling prose `Q1 … Q2 …` is not asking a round, so a
  // message only counts once it carries one of the protocol's own headers.
  if (countMatches(speech, EMOJI_MARK_RE) === 0 && countMatches(speech, HEADER_MARK_RE) === 0) {
    return []
  }
  const recommends = countMatches(speech, RECOMMEND_RE)
  if (recommends === 0 && marks.length < 2) return []
  const limit = Math.min(marks.length, MAX_ROUND_QUESTIONS)

  const questions = []
  for (let index = 0; index < limit; index += 1) {
    const mark = marks[index]
    const start = mark.index ?? 0
    const end = index + 1 < marks.length ? (marks[index + 1].index ?? speech.length) : speech.length
    // The body must NOT keep the `❓ **Qn** - **Title**:` header itself: the
    // rendered directive echoes bodies back to the model, and a header inside a
    // body would re-parse as a brand-new round. The title is the bold run at the
    // head of the question (`**Cache**: which store?`), and its closing `**` is
    // the one followed by the header separator or the line end — so a title that
    // contains its own bold run, `**Use **Redis**?**: do we?`, keeps the inner run
    // instead of being cut at it and leaking the rest of the header into the body
    // (GRILL-13). Without a separator anywhere the old reading stands, so
    // `**Cache** which store?` still yields the title `Cache`.
    const rest = speech.slice(start + mark[0].length, end)
    const firstLine = rest.split('\n', 1)[0]
    const inlineTitle =
      /^\s*\*\*([^\n]{1,200}?)\*\*(?=\s*(?:[-–—:：.)、]|$))/.exec(firstLine) ??
      /^\s*\*\*((?:[^*\n]|\*(?!\*)){1,160})\*\*\s*(?:[-–—:：.)、]\s*)?/.exec(rest)
    const afterTitle = inlineTitle ? rest.slice(inlineTitle[0].length) : rest
    // The separator-anchored form leaves the separator in place (its lookahead is
    // zero-width); stripping it again is a no-op for the fallback, which ate it.
    const headerTail = /^[ \t]*(?:[-–—:：.)、][ \t]*)?/.exec(afterTitle)[0]
    const body = compact(afterTitle.slice(headerTail.length))
    const number = Number.parseInt(mark[1], 10)
    const hasRecommendation = RECOMMEND_RE.test(body)
    RECOMMEND_RE.lastIndex = 0
    questions.push({
      number: Number.isFinite(number) ? number : index + 1,
      // Read the title off this question's own header. A separate whole-message
      // bold scan used to feed the titles positionally, so one stray bold run
      // anywhere earlier shifted every title by one.
      title: inlineTitle ? compact(inlineTitle[1]) : '',
      body: body.slice(0, 600),
      hasRecommendation,
    })
  }
  return questions
}

/** Collapse whitespace and bound the length. */
function compact(text) {
  return String(text ?? '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/* ------------------------------------------------------------------ *
 * Answer parsing (per-question settlement)
 * ------------------------------------------------------------------ */

/**
 * Replies that accept a recommended answer.
 *
 * The protocol asks for questions worded so that "yes" accepts the
 * recommendation, so a bare "是" / "按推荐" / "ok" on a question's line *is* the
 * decision. The list is deliberately closed: any reply that carries extra words
 * ("是，不过要先做 X") is an override, not an acceptance, because the extra words
 * are the decision's actual content.
 */
const ACCEPT_TOKEN_RE =
  /^(?:是|是的|对|对的|好|好的|行|可以|同意|接受|赞成|确认|没问题|没意见|没错|没有问题|嗯|按推荐|按你的推荐|按这个|就按这个|照这个|照你说的|按你说的|听你的|都可以|都行|都同意|都确认|都对|全对|全部确认|全部同意|都按推荐|全按推荐|yes|yep|yeah|y|ok|okay|sure|agree|agreed|accept|accepted|confirm|confirmed|correct|right|lgtm|go ahead|do it|all yes|sounds good|✓|√|✅|👌)$/i

/** Item labels: `Q3 …`, `问题3：…`, and bare `3.` / `3、` / `3 …` list positions. */
const ANSWER_LABEL_RE = /(?:\*\*|__)?(?:Q|q|问题|问)\s*[.、:：]?\s*(\d{1,3})(?:\*\*|__)?|(?:\*\*|__)?(\d{1,3})(?:\*\*|__)?/g

/** A label must be followed by one of these to read as a label rather than a number. */
const LABEL_TAIL_RE = /^[ \t]*(?:[.、:：)）\-–—][ \t]*|[ \t]+\S)/

/** Decorations that may sit between the previous item and this label. */
const LABEL_DECORATION_RE = /[ \t]*(?:[-*+>][ \t]*)?(?:\*\*|__)?$/

/**
 * A number followed by a unit is a quantity, not an answer label.
 *
 * A comma can separate two answers (`1 a，2 b`) or sit inside one sentence
 * (`1 用 Redis，2 周后再评估`), so it only counts as a list position when what
 * follows the number reads as an answer rather than an amount (GRILL-32). The
 * guard errs towards leaving the round open, never towards settling a question
 * the user did not answer.
 */
const QUANTITY_AFTER_LABEL_RE =
  /^[ \t]*(?:\d|(?:周|天|日|月|年|小时|分钟|秒|个|次|倍|元|块|人|条|项|行|页|台|套|版|点|成|折))/

/**
 * Items of a numbered reply, in the order the user wrote them.
 *
 * A bare number only counts as a label at a list position (start of a line, or
 * after `/ | ; ； . 。 ) ） ! ！ ? ？` or a comma), so prose that happens to contain
 * numbers — "预算 1000, 2 周" — never turns into an answer for Q1000. An explicit
 * `Q3` label is stronger evidence and is accepted anywhere as long as it is
 * followed by a separator.
 *
 * @param speech - the user's text, already stripped of quotations.
 * @returns `[{ number, start, labelEnd }]`, deduplicated by number.
 */
function collectAnswerItems(speech) {
  const items = []
  const seen = new Set()
  for (const match of speech.matchAll(ANSWER_LABEL_RE)) {
    const raw = match[1] ?? match[2]
    if (raw === undefined) continue
    const number = Number.parseInt(raw, 10)
    if (!Number.isFinite(number) || number < 1 || number > MAX_ROUND_QUESTIONS) continue
    if (seen.has(number)) continue
    const start = match.index ?? 0
    const labelEnd = start + match[0].length
    const before = speech.slice(0, start).replace(LABEL_DECORATION_RE, '')
    const previous = before.length === 0 ? '' : before[before.length - 1]
    // A comma is the separator real one-line replies use (`1 a，2 b`); treat it as
    // a list position unless the number behind it opens a quantity (GRILL-32).
    const commaSeparated = previous === ',' || previous === '，' || previous === '、'
    const atBoundary =
      before.length === 0 ||
      previous === '\n' ||
      /[/|;；.。)）!！?？]/.test(previous) ||
      (commaSeparated && !QUANTITY_AFTER_LABEL_RE.test(speech.slice(labelEnd)))
    const labelled = match[1] !== undefined
    const tail = LABEL_TAIL_RE.test(speech.slice(labelEnd, labelEnd + 16))
    // `Q3` is explicit evidence, so it only needs a boundary or a separator; a
    // bare `3` has to look like a list position *and* be followed by its answer.
    if (!(labelled ? tail || atBoundary : tail && atBoundary)) continue
    seen.add(number)
    items.push({ number, start, labelEnd })
  }
  return items
}

/**
 * A space-separated numbered run: `1 是 2 选 B 3 你看着办`.
 *
 * Only used when no labelled item was found at all, and only for a strictly
 * ascending run starting at 1 — that shape is a numbered answer list, while
 * scattered numbers in prose are not.
 *
 * @param speech - the user's text, already stripped of quotations.
 * @returns `[{ number, start, labelEnd }]`.
 */
function sequentialAnswerRun(speech) {
  const found = []
  const re = /(?:^|[\s/|;；])(\d{1,3})(?=[\s.、:：)）]|$)/g
  for (const match of speech.matchAll(re)) {
    const number = Number.parseInt(match[1], 10)
    if (!Number.isFinite(number) || number < 1 || number > MAX_ROUND_QUESTIONS) continue
    const offset = match[0].indexOf(match[1])
    const start = (match.index ?? 0) + offset
    found.push({ number, start, labelEnd: start + match[1].length })
  }
  let best = []
  let current = []
  for (const entry of found) {
    if (entry.number === current.length + 1) current.push(entry)
    else if (entry.number === 1) current = [entry]
    else current = []
    if (current.length > best.length) best = current.slice()
  }
  return best.length >= 2 ? best : []
}

/**
 * A numbered run written without the separators the labelled pass needs:
 * `1是2两边都发3同意` (GRILL-26).
 *
 * Real replies glue the label to its answer and to the next label, so neither
 * {@link collectAnswerItems} (which wants a separator or a space after the
 * number) nor {@link sequentialAnswerRun} (which wants whitespace around it)
 * sees anything, and the whole reply fell through to the batch reading. Only two
 * shapes are read here, and only for numbers that belong to the round being
 * answered: a reply that *starts* with the number (one answer, the rest of the
 * text is its body) and a strictly ascending `1 2 3 …` run inside the text.
 *
 * @param speech - the user's text, already stripped of quotations.
 * @param known  - the numbers of the round's questions.
 * @returns `[{ number, start, labelEnd }]`.
 */
function compactAnswerItems(speech, known) {
  const found = []
  const re = /(\d{1,3})/g
  let match
  while ((match = re.exec(speech)) !== null) {
    const number = Number.parseInt(match[1], 10)
    const start = match.index
    const labelEnd = start + match[1].length
    const next = speech[labelEnd]
    if (!Number.isFinite(number) || number < 1 || number > MAX_ROUND_QUESTIONS) continue
    // A number this round never asked proves nothing: prose numbers ("预算 1000,
    // 2 周") must not invent a mapping onto the round's questions.
    if (!known.has(number)) continue
    if (next === undefined || /\d/.test(next)) continue
    if ((next === '.' || next === ',') && /\d/.test(speech[labelEnd + 1] ?? '')) continue
    found.push({ number, start, labelEnd })
  }
  if (found.length === 0) return []
  if (found.length === 1) {
    // `1是…` is an answer to Q1; `用 2 周` is not an answer to Q2.
    return found[0].start === 0 ? [found[0]] : []
  }
  let best = []
  for (let index = 0; index < found.length; index += 1) {
    if (found[index].number !== 1) continue
    const run = [found[index]]
    for (let next = index + 1; next < found.length; next += 1) {
      const last = run[run.length - 1]
      if (found[next].number === last.number + 1 && found[next].start > last.labelEnd) {
        run.push(found[next])
      }
    }
    if (run.length > best.length) best = run
  }
  return best.length >= 2 ? best : []
}

/** The recommendation line of a question body, if it has one. */
const RECOMMENDATION_LINE_RE =
  /(?:^|\n)[^\S\n]*(?:➡️?|→|=>|推荐答案|推荐|建议答案|Recommendation)\s*[:：]?[^\S\n]*([^\n]*)/i

/** The paragraph a question recommends, or `''`. */
function recommendationOf(question) {
  if (!question || typeof question.body !== 'string') return ''
  const match = RECOMMENDATION_LINE_RE.exec(question.body)
  return match ? compact(match[1]) : ''
}

/** Text normalised for comparing an answer with a recommendation. */
function normalizeForMatch(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[*_`~]/g, '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，,。.、；;：:!！?？"'“”‘’()（）\[\]【】<>《》\-–—/\\|+=]/g, '')
    .trim()
}

/**
 * Whether an answer is the question's own recommendation, restated.
 *
 * "两边都发" against the recommendation "两边都发（npm + GitHub）" is the user
 * accepting, even though it is not one of the accept words — the classifier used
 * to record it as an override and every real answer landed in `batch` (GRILL-26).
 * A negation always wins: "不同意" is never an acceptance.
 *
 * @param answer         - the item's text.
 * @param recommendation - the question's recommended answer.
 * @returns `true` when the answer restates the recommendation.
 */
function matchesRecommendation(answer, recommendation) {
  const said = normalizeForMatch(answer)
  const advised = normalizeForMatch(recommendation)
  if (said.length < 2 || advised.length < 2) return false
  if (/[不别否]/.test(said) && !/[不别否]/.test(advised)) return false
  if (said === advised) return true
  // The user names the recommendation in their own words, or pastes it into a
  // longer sentence; both directions need enough text to mean anything.
  if (said.length <= 40 && advised.includes(said)) return true
  if (advised.length >= 4 && said.includes(advised)) return true
  return false
}

/**
 * Classify one item's text as an acceptance or an override.
 *
 * @param text     - the item's text (the label removed).
 * @param question - the question it answers, when known.
 * @returns `{ disposition, answer }`.
 */
function classifyAnswer(text, question) {
  const body = compact(text)
  if (body.length === 0) return { disposition: 'unanswered', answer: '' }
  const bare = body.replace(/[*_`]/g, '').replace(/[。.!！~～]+$/g, '').trim()
  if (ACCEPT_TOKEN_RE.test(bare)) return { disposition: 'accepted', answer: bare.slice(0, 200) }
  if (question && matchesRecommendation(bare, recommendationOf(question))) {
    return { disposition: 'accepted', answer: bare.slice(0, 200) }
  }
  return { disposition: 'overridden', answer: body.slice(0, 200) }
}

/** Quantifier filler that does not change an all-accepting reply. */
const AFFIRM_FILLER_RE =
  /\s*(?:to\s+)?(?:all(?:\s+(?:of\s+)?(?:them|these|those|it|the\s+questions?|three|two))?|them|these|those|everything|每(?:一)?个|所有|全部|全都|以上|都)\s*/gi

/**
 * Whether a whole reply accepts every recommendation at once.
 *
 * @param text - the user's raw reply.
 * @returns `true` when every word of it is an acceptance token.
 */
export function isAffirmativeAll(text) {
  const speech = compact(strippedOf(text))
    .replace(/[*_`]/g, '')
    .replace(/[。.!！~～]+$/g, '')
    // A quantifier does not change an all-accepting reply: "yes to all three" is
    // `yes` plus filler, and reading it as ordinary prose left a round the user
    // had just accepted standing open.
    .replace(AFFIRM_FILLER_RE, ' ')
    .trim()
  if (speech.length === 0 || speech.length > 40) return false
  const parts = speech.split(/[，,、;；/\s]+/).filter(Boolean)
  return parts.length > 0 && parts.every((part) => ACCEPT_TOKEN_RE.test(part))
}

/**
 * Settle one round's questions from the user's reply.
 *
 * This is where the protocol's "the frontier is per decision" rule is enforced:
 * a reply that answers Q1 and Q3 leaves Q2 open, so the round stays open and the
 * next round re-asks only what is still undecided. A reply with no per-question
 * structure is one batch answer — never guess a mapping that the user did not
 * write.
 *
 * @param text      - the user's raw reply.
 * @param questions - the open round's questions.
 * @returns `{ structured, items: [{ number, text, disposition, answer }] }`.
 */
export function parseAnswers(text, questions) {
  const speech = stripQuotedBlocks(text, { inlineCode: 'keep' })
  const known = new Set(asArray(questions).map((question) => question.number))
  if (speech.length === 0 || known.size === 0) return { structured: false, items: [] }
  let labels = collectAnswerItems(speech)
  // `1 a 2 b 3 c` has only one real list position and two bare numbers in the
  // middle of the line: when the strictly-ascending run finds more items than the
  // labelled pass did, it is the better reading of the same reply.
  const run = sequentialAnswerRun(speech)
  if (run.length >= 2 && run.length > labels.length) labels = run
  // Last reading of a real reply: numbering glued to its answers (GRILL-26).
  if (labels.length === 0) labels = compactAnswerItems(speech, known)
  if (labels.length === 0) return { structured: false, items: [] }
  // Numbering that does not address this round's questions proves nothing about
  // them: fall back to the batch reading instead of guessing a mapping.
  if (labels.some((label) => !known.has(label.number))) return { structured: false, items: [] }
  const rounds = asArray(questions)
  const items = []
  for (let index = 0; index < labels.length; index += 1) {
    const label = labels[index]
    const end = index + 1 < labels.length ? labels[index + 1].start : speech.length
    // The separator that introduced the next item is not part of this answer:
    // `1 是，2 否` must classify Q1 from `是`, not from `是，`.
    const segment = speech.slice(label.labelEnd, end).replace(/[\s,，、;；]+$/, '')
    const question = rounds.find((candidate) => candidate.number === label.number)
    const { disposition, answer } = classifyAnswer(segment, question)
    items.push({ number: label.number, text: compact(segment).slice(0, 200), disposition, answer })
  }
  return { structured: true, items }
}

/** The settlement of a question that nothing has decided yet. */
const OPEN_DISPOSITION = 'open'

const INSTALL_RE =
  /(npm\s+(?:i|install|add)|pnpm\s+(?:i|install|add)|yarn\s+add|pip\s+install|winget\s+install|choco\s+install|go\s+get|cargo\s+(?:add|install))\s+([^\n`'"]{1,120})/g

/**
 * Tools that only gather facts.
 *
 * Upstream is explicit that finding facts is the agent's job and that a running
 * exploration must not block the rest of the frontier — so read-only work
 * during an open round is protocol-conformant, not a violation. Anything not
 * listed here counts as acting on the design.
 */
const READ_ONLY_TOOLS = new Set([
  'read',
  'read_image',
  'glob',
  'grep',
  'search_context',
  'acp_status',
  'acp_cache',
  'web_search',
  'web_fetch',
  'memos_search',
  'memos_environment',
  'memos_get',
  'memos_timeline',
  'memos_skill_list',
  'memos_skill_get',
  'cordis_inspect_list',
  'cordis_inspect_query',
  'skill',
  'grill_status',
  'task',
  'subagent',
  'subagent_fork',
  'list_agents',
  'job_list',
  'job_output',
])

/** Whether a tool name merely gathers facts. */
export function isReadOnlyTool(name) {
  if (typeof name !== 'string') return false
  const tool = name.toLowerCase()
  if (READ_ONLY_TOOLS.has(tool)) return true
  return /^(read|get|list|search|query|inspect|view|show|fetch|stat|find|grep|glob|ls|cat)[_-]/.test(tool)
}

/** Packages a message tells the user to install. */
export function parseInstalls(text) {
  if (typeof text !== 'string') return []
  const out = []
  for (const match of text.matchAll(INSTALL_RE)) {
    const spec = match[2].trim().split(/\s+/)[0]
    if (spec.length > 0) out.push({ command: match[1].trim(), spec })
  }
  return out
}

/* ------------------------------------------------------------------ *
 * Analysis
 * ------------------------------------------------------------------ */

const EMPTY_STATE = Object.freeze({
  active: false,
  mode: 'inactive',
  activationSeq: undefined,
  rounds: [],
  roundCount: 0,
  completeRounds: 0,
  currentRound: 0,
  latestRound: null,
  waitingForAnswers: null,
  openQuestions: [],
  answeredQuestions: [],
  frontierEmpty: false,
  awaitingAnswers: false,
  anyAnswerSinceRound: false,
  confirmedUnderstanding: false,
  actionsAfterRound: [],
  installs: [],
  claimedDone: false,
  claimedSharedUnderstanding: false,
  evidence: [],
  internalError: undefined,
})

/**
 * Derive the interview state from a transcript.
 *
 * Accepts either raw session events or the output of {@link projectEvents}.
 *
 * @param transcript - raw session events or normalized facts.
 * @returns the derived state.
 */
export function analyze(transcript) {
  const input = asArray(transcript)
  if (input.length === 0) return { ...EMPTY_STATE }
  try {
    const facts = input.every(isFact) ? input : projectEvents(input)
    return analyzeFacts(facts, null).state
  } catch (err) {
    // An internal failure must never be indistinguishable from "the plugin is
    // not active": the caller, `grill_status` and the user all have to see that
    // the analysis itself broke (GRILL-17).
    return {
      ...EMPTY_STATE,
      internalError: String(err?.stack ?? err?.message ?? err),
    }
  }
}

function isFact(entry) {
  return Boolean(entry) && typeof entry === 'object' && typeof entry.kind === 'string' && entry.type !== undefined
}

/**
 * Cheap identity of the last already-folded entry, used to prove the transcript
 * only grew: same length-or-longer *and* the entry at the previous boundary is
 * still the same event, with the same content. A replaced, replayed, truncated
 * or in-place-edited transcript is re-projected from scratch instead.
 *
 * The content hash costs one pass over the newest entry — not over the session —
 * so the fast path stays O(1) per step while an edit that keeps the type and
 * sequence still cannot be served from the memo.
 *
 * @param value     - the entry sitting at the boundary.
 * @param factInput - whether the input was already normalized facts.
 * @returns a short string fingerprint.
 */
function entryFingerprint(value, factInput) {
  if (!value || typeof value !== 'object') return `${String(value)}|0:0`
  const key = factInput
    ? `${value.kind ?? ''}|${value.seq ?? ''}|${value.type ?? ''}`
    : `${value.type ?? value.kind ?? ''}|${value.seq ?? value.data?.seq ?? ''}`
  let text = ''
  try {
    text = JSON.stringify(value) ?? ''
  } catch {
    text = String(value)
  }
  let hash = 5381
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash * 33) ^ text.charCodeAt(index)) >>> 0
  }
  return `${key}|${text.length}:${hash.toString(36)}`
}

/**
 * A memoised {@link analyze} for a transcript that only ever grows.
 *
 * The host hands the plugin the whole session on every step, and a long session
 * is thousands of events; re-projecting and re-folding all of them on every
 * `agent/pre-step` and every `agent/turn-stopping` is pure waste, because the
 * prefix can never change. This keeps the projected facts *and* the fold
 * checkpoint, so a step costs one append instead of a full pass — and falls back
 * to a full pass the moment the transcript is not append-only (a forked,
 * replayed or externally rewritten session).
 *
 * `analyze()` itself stays stateless and remains the reference implementation:
 * the two must agree on every transcript, which `test/state.test.mjs` asserts
 * prefix by prefix.
 *
 * @returns `{ analyze, reset }`.
 */
export function createProjector() {
  let facts = []
  let length = 0
  let fingerprint = ''
  let checkpoint = null
  const projector = {
    /** Drop every cached projection. */
    reset() {
      facts = []
      length = 0
      fingerprint = ''
      checkpoint = null
    },
    /**
     * @param transcript - raw session events, or normalized facts.
     * @returns the derived state (never throws).
     */
    analyze(transcript) {
      const input = asArray(transcript)
      if (input.length === 0) {
        projector.reset()
        return { ...EMPTY_STATE }
      }
      const factInput = input.every(isFact)
      if (
        length > 0 &&
        (input.length < length || entryFingerprint(input[length - 1], factInput) !== fingerprint)
      ) {
        projector.reset()
      }
      try {
        if (input.length > length) {
          const fresh = factInput ? input.slice(length) : projectEvents(input.slice(length))
          facts = facts.concat(fresh)
          length = input.length
          fingerprint = entryFingerprint(input[input.length - 1], factInput)
        }
        const result = analyzeFacts(facts, checkpoint)
        checkpoint = result.checkpoint
        return result.state
      } catch {
        // A broken incremental fold must degrade to the stateless reference
        // path, never to "grilling is not active".
        projector.reset()
        return analyze(transcript)
      }
    },
  }
  return projector
}

/**
 * Mutable accumulator of the interview fold.
 *
 * Kept as plain data so {@link createProjector} can resume the fold where the
 * previous call stopped instead of re-reading the whole transcript every step
 * (a session that has run for hours carries thousands of events, and both
 * `agent/pre-step` and `agent/turn-stopping` analyze on every step).
 *
 * @param start - index of the fact that armed the interview.
 * @returns a fresh, empty fold.
 */
function createFold(start) {
  return {
    start,
    index: start,
    rounds: [],
    claimedSharedUnderstanding: false,
    claimedDone: false,
    // GRILL-30: the confirmation is latched to the human message that carried it
    // (`lastAcceptSeq`, with the two shapes it can take) instead of being re-read
    // off the newest message on every projection. `lastSettlementSeq` is the last
    // reply that settled anything: the confirmation stands while nothing has been
    // settled since it arrived, and is re-armed the moment a new round is answered.
    lastAcceptSeq: undefined,
    lastAcceptBare: false,
    lastAcceptRitual: false,
    lastSettlementSeq: undefined,
    actionsAfterRound: [],
    installs: [],
    evidence: [],
    flaggedSteps: new Set(),
  }
}

/** Identity of a question for echo detection: its text, whitespace-collapsed. */
function questionKey(question) {
  return `${compact(question.title ?? '')}\u0000${compact(question.body ?? '')}`.toLowerCase()
}

/**
 * Discharge a round.
 *
 * @param round       - the round to close.
 * @param seq         - sequence of the reply that closed it (may be `undefined`).
 * @param disposition - settlement to stamp on questions that have none of their
 *                      own (`'accepted'` / `'batch'`), or `undefined` to keep
 *                      each question's own per-question settlement.
 * @returns {void}
 */
function closeRound(round, seq, disposition) {
  if (round.answered) return
  round.answered = true
  round.answeredAtSeq = seq
  for (const question of round.questions) {
    if (disposition && question.disposition === OPEN_DISPOSITION) {
      question.disposition = disposition
    }
    if (question.answered) continue
    question.answered = true
    question.settled = true
    if (!question.disposition || question.disposition === OPEN_DISPOSITION) {
      question.disposition = disposition ?? 'batch'
    }
  }
}

/** The newest round that is still waiting for the user, or `null`. */
function newestOpenRound(fold) {
  for (let index = fold.rounds.length - 1; index >= 0; index -= 1) {
    if (!fold.rounds[index].answered) return fold.rounds[index]
  }
  return null
}

/** The two shapes of "the human just accepted the shared understanding". */
function acceptanceShape(text) {
  const bare = ACCEPT_TOKEN_RE.test(
    compact(strippedOf(text))
      .replace(/[*_`]/g, '')
      .replace(/[。.!！~～]+$/g, '')
      .trim(),
  )
  return { bare, ritual: CONFIRM_RE.test(text) }
}

/**
 * Remember a human message that could be the confirmation (GRILL-30).
 *
 * The state used to re-read the *newest* human message on every projection, so
 * any later remark withdrew a confirmation the user had already given: they typed
 * 「确认」, the interview went to `confirmed`, and the next unrelated sentence
 * ("重启了") put it back to `awaiting-confirmation` — after which the plugin went
 * back to telling the agent to wait for a confirmation it already had. Recording
 * the candidacy here, at the seq it arrived at, is what lets
 * {@link summarizeFold} accept it while nothing has been settled since.
 *
 * @param fold - the fold accumulator.
 * @param fact - the human fact to inspect.
 * @returns {void}
 */
function recordAcceptance(fold, fact) {
  const text = fact.text ?? ''
  if (text === '') return
  const shape = acceptanceShape(text)
  if (!shape.bare && !shape.ritual) return
  fold.lastAcceptSeq = fact.seq
  fold.lastAcceptBare = shape.bare
  fold.lastAcceptRitual = shape.ritual
}

/**
 * Settle the open rounds from one real user reply.
 *
 * A reply that numbers its answers settles *those* questions and leaves the rest
 * of the round open — the frontier is per decision, so the interview advances
 * one decision at a time even inside a round. A reply with no usable numbering
 * settles a whole round only when it can mean just one thing (a bare acceptance,
 * or the round's single remaining question); otherwise it is prose that does not
 * say *which* question it answers, so the round stays open instead of deciding
 * questions on the user's behalf (GRILL-25).
 *
 * @param fold - the fold accumulator.
 * @param fact - the user fact carrying the reply.
 * @returns {void}
 */
function discharge(fold, fact) {
  const openRounds = fold.rounds.filter((round) => !round.answered)
  if (openRounds.length === 0) return
  const newest = openRounds[openRounds.length - 1]
  const excerpt = compact(fact.text).slice(0, 400)
  const parsed = parseAnswers(fact.text, newest.questions)

  let touched = 0
  if (parsed.structured) {
    for (const item of parsed.items) {
      if (item.disposition === 'unanswered') continue
      const question = newest.questions.find(
        (candidate) => candidate.number === item.number && !candidate.answered,
      )
      if (!question) continue
      question.answered = true
      question.settled = true
      question.disposition = item.disposition
      question.answer = item.answer
      touched += 1
    }
  }

  if (touched === 0) {
    const openQuestions = newest.questions.filter((question) => !question.answered)
    const accepted = isAffirmativeAll(fact.text)
    // An unstructured reply only settles the round when it can mean just one
    // thing: a bare acceptance ("是"), or a round with a single question left.
    // Anything else is prose that never says which question it answers, and
    // closing every open question on it decided them on the user's behalf while
    // making the partial-round directive unreachable (GRILL-25) — so the round
    // stays open and the next step re-asks only what is still undecided.
    if (!accepted && openQuestions.length > 1) return
    for (const question of openQuestions) {
      question.answered = true
      question.settled = true
      question.disposition = accepted ? 'accepted' : 'overridden'
      question.answer = excerpt.slice(0, 200)
    }
  }

  if (!newest.answerExcerpt) newest.answerExcerpt = excerpt
  // This reply is the one doing the settling, so it is the horizon the
  // confirmation latch compares against (GRILL-30): a confirmation that arrived
  // before it no longer holds once a new round has been answered.
  fold.lastSettlementSeq = fact.seq
  // A round overtaken by this reply is discharged wholesale — the interview has
  // moved on — while the round the reply actually answers stays open until every
  // one of its questions is settled.
  for (const round of fold.rounds) {
    if (round === newest || round.answered) continue
    if (!round.answerExcerpt) round.answerExcerpt = excerpt
    closeRound(round, fact.seq, 'batch')
  }
  if (newest.questions.every((question) => question.answered)) closeRound(newest, fact.seq)
}

/**
 * Record that the interviewer acted while a round was still unanswered.
 *
 * Reconnaissance is explicitly the agent's job during an open round, so
 * read-only tools are exempt; only mutating work counts. The host reports the
 * same call twice (once on the assistant message, once as a `tool/call`
 * event), so a step is only ever flagged once.
 *
 * @param fold      - the fold accumulator.
 * @param fact      - the fact that acted.
 * @param toolNames - tool names the fact ran.
 * @returns {void}
 */
function flagAction(fold, fact, toolNames) {
  const installs = Array.isArray(fact.installs) ? fact.installs : []
  const mutating = toolNames.filter((name) => !isReadOnlyTool(name))
  if (mutating.length === 0 && installs.length === 0) return
  const open = fold.rounds[fold.rounds.length - 1]
  if (!open || open.answered) return
  const stepKey = `${fact.turn ?? '?'}:${fact.step ?? '?'}`
  if (fold.flaggedSteps.has(stepKey)) return
  fold.flaggedSteps.add(stepKey)
  fold.actionsAfterRound.push({
    seq: fact.seq,
    turn: fact.turn,
    step: fact.step,
    // Which round the act jumped ahead of: a violation is only worth a
    // correction while *that* round is still unanswered (GRILL-31).
    roundSeq: open.seq,
    toolNames: mutating.length > 0 ? mutating : toolNames,
    installs,
    note: `acted after an unanswered round (turn ${fact.turn ?? '?'}, step ${fact.step ?? '?'})`,
  })
}

/**
 * Whether a candidate round only restates the newest round.
 *
 * The protocol itself invites this: the correction tells the agent to
 * "briefly restate the pending questions and stop", and a model reporting on
 * the interview quotes the questions back. Registering those as a brand new
 * round would mean every restatement buys another directive. A candidate that
 * carries at least one question the newest round does not already contain is
 * still a real round.
 *
 * @param fold      - the fold accumulator.
 * @param questions - the candidate round's questions.
 * @returns `true` when the candidate adds nothing.
 */
function restatesNewestRound(fold, questions) {
  const newest = fold.rounds[fold.rounds.length - 1]
  // Only an *open* round can be restated. Once the user has replied, asking
  // the same questions again is a deliberate re-ask (the user may have said
  // "I don't know, ask me again") and has to open a new round.
  if (!newest || newest.answered || newest.questions.length === 0) return false
  const known = new Set(newest.questions.map(questionKey))
  return questions.every((question) => known.has(questionKey(question)))
}

/**
 * Fold one fact into the accumulator.
 *
 * @param fold - the fold accumulator.
 * @param fact - normalized fact from {@link projectEvents}.
 * @returns {void}
 */
function stepFold(fold, fact) {
  switch (fact.kind) {
    case 'user': {
      if (fact.plugin) break
      if (fact.deactivation) break
      // Only the human answers a round. The host appends runtime-context
      // snapshots, skill catalogs and this plugin's own directive as
      // user-role messages too, and none of them is an answer.
      if (!userAuthored(fact)) break
      recordAcceptance(fold, fact)
      discharge(fold, fact)
      break
    }
    case 'assistant': {
      if (fact.confirms) fold.claimedSharedUnderstanding = true
      if (fact.announcesDone) fold.claimedDone = true
      for (const install of fact.installs) {
        if (!fold.installs.some((entry) => entry.spec === install.spec)) fold.installs.push(install)
      }
      if (fact.questions.length > 0) {
        if (restatesNewestRound(fold, fact.questions)) {
          // Seen again, not asked again: keep the round that already exists.
          fold.rounds[fold.rounds.length - 1].lastSeenSeq = fact.seq
          break
        }
        const seen = new Set()
        const questions = []
        for (const question of fact.questions) {
          const key = questionKey(question)
          if (seen.has(key)) continue
          seen.add(key)
          questions.push({
            ...question,
            answered: false,
            settled: false,
            disposition: OPEN_DISPOSITION,
            answer: '',
          })
        }
        // A round the user never answered stays open, and a later round does
        // not silently retire it: the answer bookkeeping has to keep the
        // interviews's own debt visible.
        fold.rounds.push({
          turn: fact.turn,
          step: fact.step,
          seq: fact.seq,
          questions,
          answered: false,
          answerExcerpt: '',
          lastSeenSeq: undefined,
          hasRecommendations: questions.every((question) => question.hasRecommendation),
        })
        fold.evidence.push({ seq: fact.seq, note: `round with ${questions.length} question(s)` })
      } else if (fact.toolNames.length > 0 || fact.installs.length > 0) {
        flagAction(fold, fact, fact.toolNames)
      }
      break
    }
    case 'tool-call': {
      if (fact.name) flagAction(fold, fact, [fact.name])
      break
    }
    default:
      break
  }
}

/**
 * Derive the public interview state from a finished fold.
 *
 * The returned rounds and questions are copies: the fold keeps mutating in place
 * as the transcript grows, and a caller holding an older state must not see it
 * change underneath.
 *
 * @param fold         - the fold accumulator.
 * @param activationSeq - sequence of the fact that armed the interview.
 * @returns the derived state.
 */
function summarizeFold(fold, activationSeq) {
  const rounds = fold.rounds.map((round) => ({
    ...round,
    questions: round.questions.map((question) => ({ ...question })),
  }))

  const openQuestions = []
  const answeredQuestions = []
  for (const round of rounds) {
    for (const question of round.questions) {
      const entry = { ...question, round }
      if (question.answered) answeredQuestions.push(entry)
      else openQuestions.push(entry)
    }
  }

  const waitingForAnswers = [...rounds].reverse().find((round) => !round.answered) ?? null
  const awaitingAnswers = Boolean(waitingForAnswers)
  const latestRound = rounds[rounds.length - 1] ?? null
  const completeRounds = rounds.filter((round) => round.answered).length
  const frontierEmpty = completeRounds > 0 && openQuestions.length === 0
  // Only the human confirms. A host- or teammate-authored user-role message must
  // never stand in for the user's own words here.
  //
  // A whole-message acceptance token is the user's own words too, and it must not
  // depend on ritual phrasing from the assistant: live acceptance found that the
  // most natural confirmation — a bare "确认" — matched `ACCEPT_TOKEN_RE` when it
  // settled a question but no alternative in `CONFIRM_RE`, so the human could not
  // close the interview unless the assistant happened to write "共享理解" first
  // (GRILL-28). The frontier is already empty on this path, so a bare token cannot
  // be an answer to an open question.
  //
  // The confirmation belongs to the message that carried it, not to "whatever the
  // newest message happens to be" (GRILL-30): it stands until something is settled
  // after it — a new round the user answered — or a newer acceptance replaces it.
  // Chatter in between is not a withdrawal.
  const acceptanceStands =
    fold.lastAcceptSeq !== undefined &&
    (fold.lastSettlementSeq === undefined || fold.lastAcceptSeq >= fold.lastSettlementSeq)
  const confirmedUnderstanding =
    frontierEmpty &&
    acceptanceStands &&
    (fold.lastAcceptBare ||
      (fold.lastAcceptRitual && (fold.claimedSharedUnderstanding || fold.claimedDone)))

  const mode = awaitingAnswers
    ? 'awaiting-answers'
    : confirmedUnderstanding
      ? 'confirmed'
      : frontierEmpty
        ? 'awaiting-confirmation'
        : rounds.length > 0
          ? 'rounds-complete'
          : 'active'

  const count = (disposition) =>
    answeredQuestions.filter((question) => question.disposition === disposition).length

  return {
    active: true,
    mode,
    activationSeq,
    rounds,
    roundCount: rounds.length,
    completeRounds,
    currentRound: rounds.length,
    latestRound,
    waitingForAnswers,
    openQuestions,
    answeredQuestions,
    // The frontier is per decision, not per round: what is still undecided
    // anywhere in the tree. It is the same list as `openQuestions`, named for
    // the protocol's own vocabulary.
    frontier: openQuestions,
    questionStats: {
      total: openQuestions.length + answeredQuestions.length,
      open: openQuestions.length,
      accepted: count('accepted'),
      overridden: count('overridden'),
      batch: count('batch'),
    },
    frontierEmpty,
    awaitingAnswers,
    // "A reply has landed for the newest round" — either the round is settled
    // or a reply has been recorded against it. A round that was just asked has
    // neither, which is exactly the difference the directive depends on.
    anyAnswerSinceRound: Boolean(latestRound && (latestRound.answered || latestRound.answerExcerpt)),
    confirmedUnderstanding,
    // Evidence for the live check: the seq of the human message the confirmation
    // came from. It stays put while later chatter arrives (GRILL-30).
    confirmedAtSeq: confirmedUnderstanding ? fold.lastAcceptSeq : undefined,
    actionsAfterRound: fold.actionsAfterRound.map((action) => ({ ...action })),
    installs: [...fold.installs],
    claimedDone: fold.claimedDone,
    claimedSharedUnderstanding: fold.claimedSharedUnderstanding,
    evidence: [...fold.evidence],
  }
}

/**
 * Derive the interview state from normalized facts, resuming where possible.
 *
 * @param facts  - normalized facts, oldest first.
 * @param resume - checkpoint from the previous call, or `null`.
 * @returns `{ state, checkpoint }`.
 */
function analyzeFacts(facts, resume) {
  let scanned = resume ? resume.scanned : 0
  let activationSeq = resume ? resume.activationSeq : undefined
  let activationIndex = resume ? resume.activationIndex : -1
  let deactivated = resume ? resume.deactivated : false
  let skillActivationIndex = resume ? resume.skillActivationIndex : -1
  let skillActivationSeq = resume ? resume.skillActivationSeq : undefined

  for (let index = scanned; index < facts.length; index += 1) {
    const fact = facts[index]
    if (fact.kind === 'user') {
      if (fact.deactivation && !fact.plugin) {
        deactivated = true
        activationSeq = undefined
        activationIndex = -1
        skillActivationIndex = -1
        skillActivationSeq = undefined
        continue
      }
      if (fact.plugin) continue
      // `skillInvocation` is the host telling us a skill was invoked (the message
      // itself carries the skill body, so it is never human-authored) — that path
      // arms the machine on its own. A prose gesture is different: it only counts
      // when the human wrote it. Everything else in the transcript that happens to
      // contain the trigger words — a teammate's report, a runtime-context
      // snapshot, a quoted directive — must not arm an interview the user never
      // asked for, because activation is sticky for the rest of the session.
      if (fact.skillInvocation || (fact.activation && userAuthored(fact))) {
        deactivated = false
        activationSeq = fact.seq
        activationIndex = index
      }
      continue
    }
    const loads = fact.skillLoad
    if (skillActivationIndex < 0 && Array.isArray(loads) && loads.some(isGrillSkillName)) {
      skillActivationIndex = index
      skillActivationSeq = fact.seq
    }
  }

  // The model-side path: the `skill` tool fetched this plugin's interview, so
  // the earliest such call arms the machine for everything after it.
  if (activationIndex < 0 && !deactivated && skillActivationIndex >= 0) {
    activationIndex = skillActivationIndex
    activationSeq = skillActivationSeq
  }

  const checkpoint = {
    scanned: facts.length,
    activationSeq,
    activationIndex,
    deactivated,
    skillActivationIndex,
    skillActivationSeq,
    fold: null,
  }

  if (activationIndex < 0 || deactivated) {
    return {
      state: { ...EMPTY_STATE, activationSeq: deactivated ? undefined : activationSeq },
      checkpoint,
    }
  }

  let fold = resume ? resume.fold : null
  if (!fold || fold.start !== activationIndex || fold.index > facts.length) {
    fold = createFold(activationIndex)
  }
  for (let index = fold.index; index < facts.length; index += 1) stepFold(fold, facts[index])
  fold.index = facts.length

  checkpoint.fold = fold
  return { state: summarizeFold(fold, activationSeq), checkpoint }
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

const MAX_QUESTION_CHARS = 420

/**
 * Short settlement tag for a question, as the status listing shows it.
 *
 * @param question - a round question.
 * @returns a bracketed tag.
 */
function settlementTag(question) {
  if (!question.answered) return '[open]'
  if (question.disposition === 'accepted') return '[accepted]'
  if (question.disposition === 'overridden') {
    return `[overridden: ${question.answer ? question.answer : 'no text'}]`
  }
  return '[answered]'
}

/**
 * Prose settlement of a question, as the directive shows it.
 *
 * @param question - a round question.
 * @returns a human phrase.
 */
function settlementPhrase(question) {
  if (question.disposition === 'accepted') return 'accepted your recommendation'
  if (question.disposition === 'overridden') {
    return question.answer ? `overridden: "${question.answer}"` : 'overridden by the user'
  }
  return 'answered'
}

/** One question as a directive bullet. */
function renderQuestion(question, index) {
  const title = question.title || compact(question.body).split('\n')[0].slice(0, 90)
  const body =
    question.body.length > MAX_QUESTION_CHARS
      ? `${question.body.slice(0, MAX_QUESTION_CHARS)}…`
      : question.body
  const settled = question.answered ? ` (${settlementPhrase(question)})` : ''
  return `${index + 1}. Q${question.number}${title ? ` — ${title}` : ''}${settled}\n${body}`
}

/**
 * The directive to append to one model step, or `null` when the protocol needs
 * no reminder in this step.
 *
 * @param state - state from {@link analyze}.
 * @returns the directive text, or `null`.
 */
export function renderDirective(state) {
  if (!state?.active) return null
  const lines = [DIRECTIVE_MARKER, '']
  if (state.confirmedUnderstanding) {
    lines.push('Grilling is COMPLETE: the frontier is empty and the user confirmed a shared')
    lines.push('understanding. Act on the agreed design now; no further rounds are needed.')
    return lines.join('\n')
  }
  if (state.awaitingAnswers) {
    const round = state.waitingForAnswers
    const roundNo = state.rounds.indexOf(round) + 1 || state.rounds.length
    const open = round.questions.filter((question) => !question.answered)
    const settled = round.questions.filter((question) => question.answered)
    if (settled.length === 0) {
      lines.push(
        `Grilling is ACTIVE — round ${roundNo} of ${state.rounds.length} is open and the user has not answered yet.`,
      )
      lines.push('')
      lines.push('Open questions from this round:')
      round.questions.forEach((question, index) => {
        lines.push(renderQuestion(question, index))
        lines.push('')
      })
      lines.push('This step: do NOT start new work, run mutating tools, or open a new round. The')
      lines.push('whole frontier of this round was already asked, so nothing is left to ask until the')
      lines.push("user's answers land. If this step was triggered by something other than the user's")
      lines.push('answers, briefly restate the pending questions and stop.')
      return lines.join('\n')
    }
    // The reply answered some of the round. The frontier is per decision, so the
    // settled questions are decided and only the rest is still being asked —
    // re-asking a settled question would re-open a decision the user already made.
    lines.push(
      `Grilling is ACTIVE — round ${roundNo} of ${state.rounds.length} is still open: ${settled.length} of ${round.questions.length} questions are settled, ${open.length} still open.`,
    )
    lines.push('')
    lines.push('Already settled in this round (decided — do not re-ask, do not reopen):')
    for (const question of settled) {
      lines.push(
        `- Q${question.number}${question.title ? ` — ${question.title}` : ''} — ${settlementPhrase(question)}`,
      )
    }
    lines.push('')
    lines.push('Still open (this is the whole remaining frontier of this round):')
    open.forEach((question, index) => {
      lines.push(renderQuestion(question, index))
      lines.push('')
    })
    lines.push('This step: do NOT start new work, run mutating tools, or re-ask the settled questions.')
    lines.push('If the user answered, re-ask ONLY the questions still open above — numbered, each with a')
    lines.push('recommended answer — and stop. If this step was not triggered by the user, wait.')
    return lines.join('\n')
  }
  if (state.frontierEmpty) {
    lines.push('Grilling is ACTIVE — every question asked so far is answered, so the frontier of')
    lines.push('the current branch is empty.')
    const stats = state.questionStats
    if (stats && stats.total > 0) {
      lines.push(
        `Settled so far: ${stats.accepted} accepted your recommendation, ${stats.overridden} overridden by the user, ${stats.batch} answered as a batch.`,
      )
    }
    lines.push('')
    lines.push('This step: recompute the frontier from the settled answers and ask the next round')
    lines.push('(numbered questions, each with a recommended answer, worded so "yes" accepts it).')
    lines.push('Do not act on the design yet: wait for the user to confirm the shared understanding.')
    return lines.join('\n')
  }
  lines.push(`Grilling is ACTIVE — ${state.roundCount} round(s) so far, no round is open.`)
  lines.push('')
  lines.push('This step: work the design tree in rounds — ask the whole frontier as numbered')
  lines.push('questions, each with your recommended answer, then WAIT for the user.')
  return lines.join('\n')
}

/**
 * Compact status text, for the `grill_status` tool and the `grill-me` command.
 *
 * @param state - state from {@link analyze}.
 * @returns the status text.
 */
export function renderStatus(state) {
  if (state?.internalError) {
    return `Grilling analysis FAILED (internal error, the interview state below is not trustworthy):\n${String(state.internalError).split('\n')[0]}`
  }
  if (!state?.active) {
    return 'Grilling is not active in this session. Load the `grilling` skill (or run `/grill-me`) to start an interview.'
  }
  const lines = []
  // `confirmedAt` names the message the confirmation came from, so a live check can
  // see that it survived later chatter instead of being re-derived from the last
  // thing the user said (GRILL-30).
  lines.push(
    `mode=${state.mode} rounds=${state.roundCount} open=${state.openQuestions.length} answered=${state.answeredQuestions.length} frontierEmpty=${state.frontierEmpty} awaitingAnswers=${state.awaitingAnswers} confirmed=${state.confirmedUnderstanding}${state.confirmedUnderstanding ? ` confirmedAt=${state.confirmedAtSeq ?? '?'}` : ''}`,
  )
  const stats = state.questionStats
  if (stats) {
    lines.push(
      `questions: total=${stats.total} open=${stats.open} accepted=${stats.accepted} overridden=${stats.overridden} batch=${stats.batch}`,
    )
  }
  if (state.waitingForAnswers) {
    lines.push('')
    lines.push(`Open round (turn ${state.waitingForAnswers.turn ?? '?'}):`)
    state.waitingForAnswers.questions.forEach((question, index) => {
      lines.push(
        `- Q${question.number}${question.title ? ` ${question.title}` : ''} ${settlementTag(question)}${question.hasRecommendation ? '' : ' [no recommendation]'}`,
      )
    })
  }
  if (state.installs.length > 0) {
    lines.push('')
    lines.push('The interviewer proposed installs:')
    for (const install of state.installs) lines.push(`- ${install.command} ${install.spec}`)
  }
  if (state.actionsAfterRound.length > 0) {
    lines.push('')
    lines.push(`Protocol violations recorded: ${state.actionsAfterRound.length}`)
  }
  return lines.join('\n')
}

/**
 * The round a recorded act jumped ahead of, when it is still part of the state.
 *
 * @param state     - state from {@link analyze}.
 * @param violation - an entry of `state.actionsAfterRound`.
 * @returns the round object, or `undefined` when it is not part of the interview.
 */
function violatedRound(state, violation) {
  const rounds = Array.isArray(state?.rounds) ? state.rounds : []
  return rounds.find((round) => round.seq === violation?.roundSeq)
}

/**
 * Whether a recorded act is still worth correcting (GRILL-31).
 *
 * A recorded act stays in the ledger for the rest of the session, which made the
 * gate report history as a live breach: an act from six turns earlier was still
 * corrected, and its recovery steps told the model to re-ask a round the user had
 * answered long before. Two conditions separate a live breach from history:
 *
 * 1. the round the act jumped ahead of must still be unanswered — once the user
 *    has replied there is nothing to re-ask, and asking anyway would manufacture
 *    a phantom round (GRILL-2);
 * 2. when the caller knows which turn is ending, the act must belong to *that*
 *    turn: a correction is delivered where the breach happens, never to an
 *    unrelated turn that merely ends later.
 *
 * @param state       - state from {@link analyze}.
 * @param violation   - an entry of `state.actionsAfterRound`.
 * @param currentTurn - the turn that is ending, when the caller knows it.
 * @returns `true` when a correction is still true at delivery time.
 */
function violationIsLive(state, violation, currentTurn) {
  const round = violatedRound(state, violation)
  if (round === undefined || round.answered) return false
  if (currentTurn === undefined || currentTurn === null) return true
  if (violation.turn === undefined || violation.turn === null) return false
  return violation.turn === currentTurn
}

/** Whitespace-insensitive comparison key for correction texts. */
function squash(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * Whether the transcript already carries this exact correction (GRILL-31).
 *
 * The correction budget lives in the plugin instance, so a reloaded, re-applied
 * or second instance starts with a fresh one and can buy the same correction
 * again. The transcript is the durable record: a `form = 'correction'` message
 * carrying this text proves it was already delivered, whoever delivered it. The
 * text embeds the offending turn and step, so identical text is the same
 * violation and can only be the same correction.
 *
 * @param events - raw session events (oldest first).
 * @param text   - the correction about to be steered.
 * @returns `true` when an identical correction is already in the transcript.
 */
export function correctionDelivered(events, text) {
  const wanted = squash(text)
  if (wanted.length === 0) return false
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type !== 'user/message') continue
    const message = event.data
    if (!isPluginMessage(message) || message?.source?.form !== 'correction') continue
    if (squash(messageText(message)) === wanted) return true
  }
  return false
}

/**
 * Stable identity of the violation {@link describeViolation} would report.
 *
 * A recorded act stays in the ledger for the rest of the session, so a gate that
 * keyed its correction budget by `(agent, turn)` re-steered the same correction
 * after every later step — and each steer starts a new turn, which reset the
 * budget and kept the turn alive forever (GRILL-23). The key names the
 * *violation*, so each distinct one is corrected at most once.
 *
 * History has no key at all (GRILL-31): an act whose round has been answered, or
 * that belongs to a turn other than the one ending, is not a violation to report
 * — see {@link violationIsLive}.
 *
 * @param state       - state from {@link analyze}.
 * @param currentTurn - the turn that is ending, when the caller knows it.
 * @returns a stable key, or `null` when the interview is behaving.
 */
export function violationKey(state, currentTurn) {
  if (!state?.active || state.confirmedUnderstanding) return null
  if (state.actionsAfterRound.length > 0) {
    const violation = state.actionsAfterRound[state.actionsAfterRound.length - 1]
    if (!violationIsLive(state, violation, currentTurn)) return null
    return `action:${violation.seq ?? 'unknown'}`
  }
  const badRound = state.rounds.find(
    (round) =>
      !round.answered &&
      (round.questions.length === 0 || !round.questions.every((question) => question.hasRecommendation)),
  )
  return badRound ? `round:${badRound.seq ?? 'unknown'}` : null
}

/**
 * The correction to steer the interviewer with, or `null` when it is behaving.
 *
 * @param state - state from {@link analyze}.
 * @returns the correction text, or `null`.
 */
export function describeViolation(state) {
  if (!state?.active) return null
  const rules = [
    'Ask the whole frontier in ONE round; never one question at a time.',
    'Give every question a recommended answer (➡️) and word it so "yes" accepts it.',
    'Wait for the user after a round: no acting, no new round, no tool work until the answers land.',
    'A question the user already settled is decided: never re-ask it, and re-ask only what is still open.',
  ]

  if (state.confirmedUnderstanding) return null

  if (state.actionsAfterRound.length > 0) {
    const violation = state.actionsAfterRound[state.actionsAfterRound.length - 1]
    // GRILL-31: an act whose round has since been answered is history. The recovery
    // steps below order the model to re-ask that round, which would manufacture a
    // phantom round (GRILL-2) — so a settled violation says nothing at all.
    if (!violationIsLive(state, violation)) return null
    const acted = violation.installs.length > 0
      ? `installed ${violation.installs.map((entry) => entry.spec).join(', ')}`
      : `ran ${violation.toolNames.join(', ')}`
    return [
      CORRECTION_MARKER,
      `Protocol violation: ${violation.note}.`,
      '',
      `You asked a round and then ${acted} instead of waiting for the answers.`,
      'grilling was still open: the user had not answered the pending round, and the protocol says',
      'decisions belong to the user and the session must wait for them. Facts are your job, but the',
      'round itself has to be answered before you act on it.',
      '',
      'Recover now, in this step:',
      '1. Undo nothing silently — state plainly that the work above was premature.',
      '2. Re-ask the pending round (restate it, unchanged) and stop.',
      '3. Do not run any further tool or mutating action until the answers land.',
      '',
      ...rules.map((rule) => `- ${rule}`),
    ].join('\n')
  }

  if (state.rounds.length === 0) return null

  // Only a round that is still waiting for the user is worth correcting: an
  // answered round cannot be re-issued, and reporting it forever meant every
  // later step repeated a correction the user had already satisfied.
  const badRound = state.rounds.find(
    (round) =>
      !round.answered &&
      (round.questions.length === 0 || !round.questions.every((question) => question.hasRecommendation)),
  )
  if (badRound) {
    return [
      CORRECTION_MARKER,
      'Protocol violation: a round was asked without a recommended answer for every question.',
      '',
      'Each question must arrive with your recommended answer, worded so "yes" accepts it, so the',
      'user can answer the whole round with one word per question.',
      '',
      'Recover now, in this step: re-issue that round with a recommendation attached to each',
      'question, and stop.',
      '',
      ...rules.map((rule) => `- ${rule}`),
    ].join('\n')
  }

  return null
}

export default {
  DIRECTIVE_MARKER,
  CORRECTION_MARKER,
  SOURCE_KIND,
  analyze,
  correctionDelivered,
  createProjector,
  describeViolation,
  isAffirmativeAll,
  isPluginMessage,
  isReadOnlyTool,
  makeUserMessage,
  messageText,
  parseAnswers,
  parseInstalls,
  parseQuestions,
  projectEvents,
  renderDirective,
  renderStatus,
  toolCallNames,
}
