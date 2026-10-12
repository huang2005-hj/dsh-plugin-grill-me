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

/**
 * The user-invoked entry point that switches the documentation channel on.
 *
 * Upstream keeps `grill-with-docs` a separate wrapper (`disable-model-invocation`)
 * around the same `grilling` primitive plus `domain-modeling`. The name is what
 * separates the two modes here: only an interview armed through this entry point
 * gets documentation obligations. `grill-me` / `grilling` behave exactly as
 * before and never talk about documents.
 */
export const DOCS_WRAPPER_NAME = 'grill-with-docs'

/** The documentation primitive `grill-with-docs` loads. It never arms alone. */
export const DOCS_PRIMITIVE_NAME = 'domain-modeling'

/**
 * Declaration marker the interviewer writes to promise one document.
 *
 * `📄 ADR: <title>` books an ADR, `📄 术语: <term>` books a glossary entry. The
 * machine never decides whether a decision *deserves* an ADR — that is the
 * model's judgement under upstream's three criteria — it only holds the model to
 * what it said it would write.
 */
export const DOC_MARKER = '📄'

/** `📄 ADR: …` / `📄 术语: …`, in prose, at the start of a line. */
const DOC_DECL_RE =
  /(?:^|\n)[ \t]*(?:[-*+][ \t]+)?\*{0,2}📄[ \t]*(ADR|术语)\*{0,2}[ \t]*[:：][ \t]*\*{0,2}([^\n*]{1,200})/g

/** Path argument keys a host uses for a write, in the order they are tried. */
const PATH_ARG_KEYS = ['file_path', 'filePath', 'path', 'filename', 'fileName', 'target', 'target_file']


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
  if (/\/(?:grill-me|grilling|grill-with-docs)\b/i.test(speech)) return true
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
        skillNames: sourceSkillNames(message?.source),
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
        docDecls: parseDocDeclarations(text),
        writePaths: writePathsOfMessage(message),
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
        writePaths: writePathsOf(name, args),
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
  return typeof name === 'string' && /^(?:grill-me|grilling|grill-with-docs)$/i.test(name.trim())
}

/**
 * Whether a skill name is the documentation entry point.
 *
 * Only `grill-with-docs` opens the documentation channel. `domain-modeling` on
 * its own is a documentation skill, not an interview: loading it inside a plain
 * `grilling` round must not quietly add obligations the user never asked for.
 */
function isDocsSkillName(name) {
  return typeof name === 'string' && /^grill-with-docs$/i.test(name.trim())
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

/* ------------------------------------------------------------------ *
 * The documentation channel (grill-with-docs)
 *
 * Upstream's `domain-modeling` writes a term into `GLOSSARY.md` the moment it
 * settles and only proposes an ADR when three criteria hold — and its own docs
 * record the failure mode this channel exists to prevent: "the file write
 * silently does not happen". A prompt cannot make "as it settles" deterministic,
 * so the channel adds one machine-readable promise (`📄 ADR: …` / `📄 术语: …`)
 * and holds the model to it.
 *
 * Everything here stays at the transcript layer, exactly like the existing
 * gates: a declaration is text the model wrote, and a write is a write-tool call
 * whose arguments name a document path. Nothing reads the disk.
 * ------------------------------------------------------------------ */

/** Tools whose whole job is writing a file, so they carry a target path. */
const WRITE_TOOL_RE =
  /^(?:write|write_?file|create_?file|edit|edit_?file|multi_?edit|str_?replace|replace|replace_?in_?file|apply_?patch|patch|insert|append_?file|save_?file|fs_?write|fs_?edit|notebook_?edit)$/

/** Whether a tool name writes a file. */
export function isWriteTool(name) {
  if (typeof name !== 'string') return false
  return WRITE_TOOL_RE.test(name.trim().toLowerCase())
}

/**
 * What kind of document a write target is, or `null` for anything else.
 *
 * Upstream's layout, verbatim: an ADR is `docs/adr/NNNN-slug.md`, a glossary is
 * always a file named `GLOSSARY.md` (one per context, hence "any path segment"),
 * and the multi-context index is `GLOSSARY-MAP.md`. Separators are normalized
 * because the transcript carries whatever the host recorded.
 *
 * `glossary-map` is documentation — writing it is never "running on to the work"
 * — but it is not a debt payment: only a `GLOSSARY.md` settles a term.
 */
export function classifyDocPath(path) {
  if (typeof path !== 'string' || path.length === 0) return null
  const normalized = path.replace(/\\/g, '/').toLowerCase()
  if (/(?:^|\/)docs\/adr\/[^/]+$/.test(normalized)) return 'adr'
  if (/(?:^|\/)glossary\.md$/.test(normalized)) return 'glossary'
  if (/(?:^|\/)glossary-map\.md$/.test(normalized)) return 'glossary-map'
  return null
}

/**
 * Slug of a document title, used to match a declaration against the file that
 * pays it off.
 *
 * ASCII-only on purpose: a title with no ASCII in it yields `''`, which disables
 * slug matching for that debt — it is then paid by kind alone, which is the
 * right fallback when a title is Chinese and the file name is up to the model.
 */
export function docSlug(title) {
  return String(title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

/**
 * Slug of the *file* a path points at — its own name, never the directories.
 *
 * Matching a declared title against the whole path was wrong: a path
 * `docs/adr/0002-redis-cache.md` slugged whole reads `docs-adr-0002-redis-cache-md`,
 * so a debt titled "docs" swallowed every ADR write. The stem keeps the two
 * halves comparable, and the leading `NNNN-` that upstream's ADR naming adds is
 * dropped so `0007-use-json-for-storage.md` still matches "Use JSON for storage".
 */
export function docFileSlug(path) {
  const normalized = String(path ?? '').replace(/\\/g, '/')
  const base = normalized.slice(normalized.lastIndexOf('/') + 1)
  const stem = base.replace(/\.[a-z0-9]+$/i, '')
  return docSlug(stem.replace(/^\d{2,4}-+/, ''))
}

/**
 * Every document one message promised.
 *
 * Quoted blocks are stripped first, so a marker inside a fence or a blockquote —
 * where the protocol is being *quoted* rather than followed — books nothing.
 */
export function parseDocDeclarations(text) {
  if (typeof text !== 'string' || text.length === 0) return []
  const body = strippedOf(text)
  const out = []
  const seen = new Set()
  for (const match of body.matchAll(DOC_DECL_RE)) {
    const kind = match[1] === 'ADR' ? 'adr' : 'glossary'
    const title = match[2].trim().replace(/[.。,，;；:：]+$/, '')
    if (title.length === 0) continue
    const key = `${kind}\u0000${title}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ kind, title })
  }
  return out
}

/** Patch payloads name their files in the diff text, not in an argument key. */
const PATCH_HEADER_RES = [
  /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm,
  /^diff --git a\/.+? b\/(.+)$/gm,
  /^\+\+\+ b\/(.+)$/gm,
]

/** A tool whose file targets live inside its payload text. */
function isPatchTool(name) {
  if (typeof name !== 'string') return false
  return /^(?:apply_?patch|patch)$/.test(name.trim().toLowerCase())
}

/** Paths named by a patch payload's own headers. */
function patchPathsOf(text) {
  const out = []
  for (const re of PATCH_HEADER_RES) {
    for (const match of String(text).matchAll(re)) {
      const value = match[1].trim()
      if (value.length > 0) out.push(value)
    }
  }
  return out
}

/**
 * Every path-looking value anywhere in one tool call's arguments.
 *
 * Argument shapes differ per host and per tool: `multi_edit` nests its edits as
 * `edits: [{ file_path }]`, and `apply_patch` carries the path inside its payload
 * string. Both were invisible to a top-level key scan, which left the debt
 * unpaid and — worse — had the gate accuse a model that had in fact written the
 * file (F2). The walk is depth-limited and key-driven, so it stays a path
 * extractor rather than a general object scanner.
 */
function collectWritePaths(node, out, depth) {
  if (node === null || node === undefined || depth > 6) return
  if (typeof node === 'string') {
    if (isPatchText(node)) for (const path of patchPathsOf(node)) out.push(path)
    return
  }
  if (Array.isArray(node)) {
    for (const item of node) collectWritePaths(item, out, depth + 1)
    return
  }
  if (typeof node !== 'object') return
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === 'string' && value.trim().length > 0 && PATH_ARG_KEYS.includes(key)) {
      out.push(value.trim())
      continue
    }
    collectWritePaths(value, out, depth + 1)
  }
}

/** Whether a string is written in patch-header form. */
function isPatchText(text) {
  return /^\*\*\* (?:Add|Update|Delete) File: /m.test(text) || /^\+\+\+ b\//m.test(text)
}

/** The document paths one tool call writes (empty for everything else). */
function writePathsOf(name, args) {
  if (!isWriteTool(name)) return []
  const out = []
  if (typeof args === 'string') {
    if (isPatchText(args)) out.push(...patchPathsOf(args))
    return uniquePaths(out)
  }
  if (args === null || typeof args !== 'object') return []
  collectWritePaths(args, out, 0)
  if (isPatchTool(name)) {
    for (const value of Object.values(args)) {
      if (typeof value === 'string') out.push(...patchPathsOf(value))
    }
  }
  return uniquePaths(out)
}

/** The same path written twice is one write (hosts report a call in two events). */
function uniquePaths(paths) {
  const out = []
  const seen = new Set()
  for (const path of paths) {
    const key = path.replace(/\\/g, '/')
    if (seen.has(key)) continue
    seen.add(key)
    out.push(path)
  }
  return out
}

/** The document paths every tool-call block of one assistant message writes. */
function writePathsOfMessage(message) {
  const out = []
  for (const block of asArray(unwrapMessage(message)?.content)) {
    if (!isToolBlock(block)) continue
    const tool = block.name ?? block.toolName
    const raw = block.arguments ?? block.input ?? block.args
    const args = typeof raw === 'string' ? tryParseJson(raw) : raw
    for (const path of writePathsOf(tool, args)) out.push(path)
  }
  return out
}

/** Skill names a message source carries (skill-invocation / catalog / gesture). */
function sourceSkillNames(source) {
  if (source === null || typeof source !== 'object') return []
  const out = []
  for (const value of [source.name, source.skill, source.command, source.gesture]) {
    if (typeof value === 'string' && isGrillSkillName(value)) out.push(value.trim())
  }
  return out
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
  docsMode: false,
  docDebts: [],
  openDocDebts: [],
  docViolations: [],
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
    // The documentation channel. `docsMode` latches on when the interview is
    // armed through `grill-with-docs`; `docDebts` is every document the
    // interviewer declared (`📄 …`) and whether a write paid it off;
    // `docViolations` records steps that ran on to the work while a debt was
    // still outstanding.
    docsMode: false,
    docDebts: [],
    docViolations: [],
    // `turn:step\0path` keys already spent this step, so one written file pays
    // exactly one debt however many events report it.
    paidWrites: new Set(),
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
  // grill-with-docs: writing the documents the interview owes is part of the
  // interview, not acting on the design. Upstream writes a term into the
  // glossary *as it settles* — while a round is still open — so a step that does
  // nothing but write document paths must not be corrected for it.
  if (docsOnlyWrite(fact, mutating)) return
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
 * Whether a step did nothing but write the interview's own documents.
 *
 * Both halves are required: every mutating tool call has to be a write tool, and
 * every path written has to be an ADR or a glossary. One shell command in the
 * same step, or one write outside those paths, and the step is an ordinary act.
 */
function docsOnlyWrite(fact, mutating) {
  const paths = asArray(fact.writePaths)
  if (paths.length === 0) return false
  if (!paths.every((path) => classifyDocPath(path) !== null)) return false
  return mutating.every((name) => isWriteTool(name))
}

/**
 * Whether a user fact arms the interview through the documentation entry point.
 *
 * Only an actual entry point counts: a source that names the command or skill, a
 * skill load the model performed, or a message that *is* the gesture (the slash
 * command opening the message). A mention anywhere in prose does not — the
 * catalogue a host injects lists every skill, and "remind me to run
 * /grill-with-docs later" is a sentence, not a mode (F5).
 */
function isDocsActivation(fact) {
  if (asArray(fact.skillNames).some(isDocsSkillName)) return true
  if (asArray(fact.skillLoad).some(isDocsSkillName)) return true
  return /^\s*\/grill-with-docs\b/i.test(strippedOf(fact.text ?? ''))
}

/**
 * Book the documents one message promised.
 *
 * Declaring the same title twice books one debt — the second declaration adds
 * nothing to write. Declarations in a mode without the channel are ignored:
 * `grill-me` / `grilling` promise no documents at all.
 */
function declareDocs(fold, fact) {
  if (!fold.docsMode) return
  for (const decl of asArray(fact.docDecls)) {
    const existing = fold.docDebts.find((debt) => debt.kind === decl.kind && debt.title === decl.title)
    if (existing) continue
    fold.docDebts.push({
      kind: decl.kind,
      title: decl.title,
      slug: docSlug(decl.title),
      seq: fact.seq,
      turn: fact.turn,
      step: fact.step,
      dischargedAtSeq: undefined,
      dischargedPath: undefined,
    })
    fold.evidence.push({
      seq: fact.seq,
      note: `documentation debt declared: ${decl.kind} — ${decl.title}`,
    })
  }
}

/**
 * Pay off debts from the paths one step wrote.
 *
 * Matching is by kind, then by the *file's own* slug: an exact hit wins, and
 * otherwise the longest declared slug contained in it does, so a short title
 * that happens to prefix a longer one can never steal the longer one's write
 * (F1). Slugs too short to mean anything are ignored, and a path with no match
 * at all still pays the oldest outstanding debt of its kind — the fallback that
 * covers a Chinese title whose file name the model chose freely.
 *
 * One path pays at most one debt, and a path already paid in this step is spent:
 * hosts report one tool call both on the assistant message and as a `tool/call`
 * event (F3), and the second report used to settle a second debt off the same
 * file, handing off `COMPLETE` with a document that was never written.
 *
 * Nothing here judges the file's content — the gate is about the write happening
 * at all, which is the failure upstream's own docs record.
 */
function payDocs(fold, fact) {
  const stepKey = `${fact.turn ?? '?'}:${fact.step ?? '?'}`
  for (const path of asArray(fact.writePaths)) {
    const kind = classifyDocPath(path)
    if (kind === null) continue
    const spent = `${stepKey}\u0000${path.replace(/\\/g, '/')}`
    if (fold.paidWrites.has(spent)) continue
    const open = fold.docDebts.filter((debt) => debt.kind === kind && debt.dischargedAtSeq === undefined)
    if (open.length === 0) continue
    const fileSlug = docFileSlug(path)
    let target = open.find((debt) => debt.slug.length >= 3 && debt.slug === fileSlug)
    if (target === undefined) {
      const contained = open
        .filter((debt) => debt.slug.length >= 4 && fileSlug.includes(debt.slug))
        .sort((a, b) => b.slug.length - a.slug.length)
      target = contained[0]
    }
    if (target === undefined) target = open[0]
    fold.paidWrites.add(spent)
    target.dischargedAtSeq = fact.seq
    target.dischargedPath = path
    fold.evidence.push({ seq: fact.seq, note: `documentation debt paid: ${target.kind} — ${target.title}` })
  }
}

/**
 * Record a step that ran on to the work while documents were still owed.
 *
 * This is the half of the gate the directive cannot enforce on its own: if the
 * model implements with a debt outstanding, `agent/turn-stopping` steers the
 * same recovery text an unanswered round buys.
 */
function flagDocViolation(fold, fact, toolNames) {
  if (!fold.docsMode) return
  if (fold.rounds.length === 0) return
  if (!fold.rounds.every((round) => round.answered)) return
  const open = fold.docDebts.filter((debt) => debt.dischargedAtSeq === undefined)
  if (open.length === 0) return
  const mutating = asArray(toolNames).filter((name) => !isReadOnlyTool(name))
  if (mutating.length === 0) return
  if (docsOnlyWrite(fact, mutating)) return
  // A write tool whose target could not be read tells us nothing: paying is
  // impossible and accusing would be guesswork. Silence is the safe direction —
  // it misses a breach instead of inventing one (F2).
  if (asArray(fact.writePaths).length === 0 && mutating.every((name) => isWriteTool(name))) return
  const stepKey = `doc:${fact.turn ?? '?'}:${fact.step ?? '?'}`
  if (fold.flaggedSteps.has(stepKey)) return
  fold.flaggedSteps.add(stepKey)
  fold.docViolations.push({
    seq: fact.seq,
    turn: fact.turn,
    step: fact.step,
    toolNames: mutating,
    note: `ran on to the work with ${open.length} declared document(s) still unwritten (turn ${fact.turn ?? '?'}, step ${fact.step ?? '?'})`,
  })
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
      // The documentation channel is on as soon as the interview is armed
      // through `grill-with-docs`: the gesture, its skill-invocation message, or
      // the model loading the skill itself.
      if (isDocsActivation(fact)) fold.docsMode = true
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
      if (asArray(fact.skillLoad).some(isDocsSkillName)) fold.docsMode = true
      for (const install of fact.installs) {
        if (!fold.installs.some((entry) => entry.spec === install.spec)) fold.installs.push(install)
      }
      // Declarations first, then the writes in the same message: a model that
      // declares and writes in one step nets out to a paid debt.
      declareDocs(fold, fact)
      payDocs(fold, fact)
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
      flagDocViolation(fold, fact, fact.toolNames)
      break
    }
    case 'tool-call': {
      if (asArray(fact.skillLoad).some(isDocsSkillName)) fold.docsMode = true
      if (asArray(fact.writePaths).length > 0) payDocs(fold, fact)
      if (fact.name) {
        flagAction(fold, fact, [fact.name])
        flagDocViolation(fold, fact, [fact.name])
      }
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
  // The documentation channel (grill-with-docs). None of this can fire in the
  // plain modes: `docsMode` only latches on an activation through the docs entry
  // point, and a declaration in a mode without the channel is never booked.
  const docsMode = fold.docsMode === true
  const docDebts = fold.docDebts.map((debt) => ({ ...debt }))
  const openDocDebts = docDebts.filter((debt) => debt.dischargedAtSeq === undefined)
  const docsPending = docsMode && openDocDebts.length > 0

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
    // A declared document that was never written keeps the interview open: the
    // hand-off to implementation is what the debt is owed before.
    !docsPending &&
    (fold.lastAcceptBare ||
      (fold.lastAcceptRitual && (fold.claimedSharedUnderstanding || fold.claimedDone)))

  const mode = awaitingAnswers
    ? 'awaiting-answers'
    : confirmedUnderstanding
      ? 'confirmed'
      : frontierEmpty
        ? docsPending
          ? 'awaiting-docs'
          : 'awaiting-confirmation'
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
    // Whether the human's acceptance is still standing (the documentation gate
    // asks the same question when it explains what is left to do).
    acceptanceStands,
    confirmedUnderstanding,
    // Evidence for the live check: the seq of the human message the confirmation
    // came from. It stays put while later chatter arrives (GRILL-30).
    confirmedAtSeq: confirmedUnderstanding ? fold.lastAcceptSeq : undefined,
    actionsAfterRound: fold.actionsAfterRound.map((action) => ({ ...action })),
    installs: [...fold.installs],
    // The documentation channel: which mode the interview is in, what the
    // interviewer promised to write, what is still missing, and every step that
    // ran on to the work while a promise was outstanding.
    docsMode,
    docDebts,
    openDocDebts,
    docViolations: fold.docViolations.map((violation) => ({ ...violation })),
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
 * Append the documentation-channel debt note, when there is one.
 *
 * It gets its own block because it contradicts the surrounding "do NOT run
 * mutating tools" for exactly one tool class: writing the interview's own
 * documents is part of the interview, not acting on the design.
 *
 * @param lines - directive lines being built.
 * @param state - state from {@link analyze}.
 * @returns {void}
 */
function pushDocDebtLines(lines, state) {
  if (!state?.docsMode || state.openDocDebts.length === 0) return
  lines.push('')
  lines.push(
    `Documentation channel (grill-with-docs): ${state.openDocDebts.length} declared document(s) are still unwritten.`,
  )
  for (const debt of state.openDocDebts) lines.push(`- [${debt.kind}] ${debt.title}`)
  lines.push('Writing `docs/adr/**` or `**/GLOSSARY.md` is part of the interview and stays allowed even')
  lines.push('now; nothing else is, and the hand-off is blocked until every one of them exists.')
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
      pushDocDebtLines(lines, state)
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
    pushDocDebtLines(lines, state)
    lines.push('This step: do NOT start new work, run mutating tools, or re-ask the settled questions.')
    lines.push('If the user answered, re-ask ONLY the questions still open above — numbered, each with a')
    lines.push('recommended answer — and stop. If this step was not triggered by the user, wait.')
    return lines.join('\n')
  }
  if (state.frontierEmpty) {
    // The documentation channel's own terminal state: the design is settled but
    // the papers are not written. This is the directive upstream's bug report
    // asks for — the outer loop must not be able to swallow the write half.
    if (state.docsMode && state.openDocDebts.length > 0) {
      lines.push('Grilling is ACTIVE — every question asked so far is answered, but the documentation')
      lines.push('channel still owes what the interviewer declared. The interview is not finished')
      lines.push('until those files are on disk.')
      lines.push('')
      lines.push('Outstanding documents (declared with 📄, no write has paid them off yet):')
      for (const debt of state.openDocDebts) {
        const where =
          debt.turn === undefined
            ? ''
            : ` (declared turn ${debt.turn}${debt.step === undefined ? '' : `, step ${debt.step}`})`
        lines.push(`- [${debt.kind}] ${debt.title}${where}`)
      }
      lines.push('')
      if (state.acceptanceStands) {
        lines.push('This step: write every outstanding document now — each ADR to `docs/adr/NNNN-slug.md`,')
        lines.push('each glossary entry to `GLOSSARY.md`, in prose and then the file itself. The user has')
        lines.push('already confirmed the shared understanding, so the hand-off happens the moment the')
        lines.push('last document is written — and not before.')
      } else {
        lines.push('This step: write every outstanding document now — each ADR to `docs/adr/NNNN-slug.md`,')
        lines.push('each glossary entry to `GLOSSARY.md` — and only then ask the user to confirm the shared')
        lines.push('understanding. The implementation may not start before both.')
      }
      return lines.join('\n')
    }
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
  pushDocDebtLines(lines, state)
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
  if (state.docsMode) {
    lines.push(
      `documentation channel: on — ${state.docDebts.length} declared, ${state.openDocDebts.length} outstanding`,
    )
    for (const debt of state.docDebts) {
      const state_ =
        debt.dischargedAtSeq === undefined ? '[outstanding]' : `[written: ${debt.dischargedPath}]`
      lines.push(`- [${debt.kind}] ${debt.title} ${state_}`)
    }
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
  if (state.actionsAfterRound.length > 0 || state.docViolations.length > 0) {
    lines.push('')
    const total = state.actionsAfterRound.length + state.docViolations.length
    lines.push(`Protocol violations recorded: ${total}`)
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

/**
 * Whether a documentation breach is still worth correcting.
 *
 * The same two questions as {@link violationIsLive}, with the debt in the place
 * of the round: the debt must still be outstanding (writing the file ends the
 * breach — the recovery happened), and the act must belong to the turn that is
 * ending. The debt itself is the live part, which is why this does not go stale
 * the way a recorded act does.
 *
 * @param state       - state from {@link analyze}.
 * @param violation   - an entry of `state.docViolations`.
 * @param currentTurn - the turn that is ending, when the caller knows it.
 * @returns `true` when a correction is still true at delivery time.
 */
function docViolationIsLive(state, violation, currentTurn) {
  if (state?.docsMode !== true) return false
  if (state.openDocDebts.length === 0) return false
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
  // Each category is *skipped* when its newest entry is history, never treated
  // as the end of the search: a spent action violation used to mask every later
  // documentation breach, and a spent breach every later round defect (F6).
  const action = state.actionsAfterRound[state.actionsAfterRound.length - 1]
  if (action !== undefined && violationIsLive(state, action, currentTurn)) {
    return `action:${action.seq ?? 'unknown'}`
  }
  const breach = state.docViolations[state.docViolations.length - 1]
  if (breach !== undefined && docViolationIsLive(state, breach, currentTurn)) {
    return `docs:${breach.seq ?? 'unknown'}`
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

  const actionViolation = state.actionsAfterRound[state.actionsAfterRound.length - 1]
  // GRILL-31: an act whose round has since been answered is history. The recovery
  // steps below order the model to re-ask that round, which would manufacture a
  // phantom round (GRILL-2) — so a settled violation says nothing. It must not
  // silence the *other* categories either (F6): fall through to the next one.
  if (actionViolation !== undefined && violationIsLive(state, actionViolation)) {
    const acted = actionViolation.installs.length > 0
      ? `installed ${actionViolation.installs.map((entry) => entry.spec).join(', ')}`
      : `ran ${actionViolation.toolNames.join(', ')}`
    return [
      CORRECTION_MARKER,
      `Protocol violation: ${actionViolation.note}.`,
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

  const docViolation = state.docViolations[state.docViolations.length - 1]
  if (docViolation !== undefined && docViolationIsLive(state, docViolation)) {
    const debts = state.openDocDebts
    return [
      CORRECTION_MARKER,
      `Protocol violation: ${docViolation.note}.`,
      '',
      `You ran ${docViolation.toolNames.join(', ')} while the documentation channel still owed ${debts.length} document(s):`,
      ...debts.map((debt) => `- [${debt.kind}] ${debt.title}`),
      '',
      'grill-with-docs settles the design *and* writes it down: a term goes into the glossary as it',
      'settles, and the ADR for a decision is written before the work that implements it starts.',
      'Nothing you declared with 📄 may still be unwritten when you begin implementing — that silent',
      'missing write is the exact failure this channel exists to prevent.',
      '',
      'Recover now, in this step:',
      '1. Undo nothing silently — state plainly that the work above ran ahead of the documents.',
      '2. Write every outstanding document now, one at a time, in prose and then the file itself.',
      '3. Do not resume the implementation until every one of them is on disk.',
      '',
      ...rules.slice(0, 3).map((rule) => `- ${rule}`),
      '- A declared document is a debt: writing `docs/adr/NNNN-slug.md` or `**/GLOSSARY.md` is the only way to pay it.',
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
  DOC_MARKER,
  DOCS_PRIMITIVE_NAME,
  DOCS_WRAPPER_NAME,
  analyze,
  classifyDocPath,
  correctionDelivered,
  createProjector,
  describeViolation,
  docSlug,
  isAffirmativeAll,
  isPluginMessage,
  isReadOnlyTool,
  isWriteTool,
  makeUserMessage,
  messageText,
  parseAnswers,
  parseDocDeclarations,
  parseInstalls,
  parseQuestions,
  projectEvents,
  renderDirective,
  renderStatus,
  toolCallNames,
}
