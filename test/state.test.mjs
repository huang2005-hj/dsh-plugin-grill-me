#!/usr/bin/env node
/**
 * Adversarial test suite for src/state.js (the grill-me interview state machine).
 *
 * This suite is the independent check on src/state.js: it must not be edited to
 * make an implementation pass.
 *
 * Run:  node test/state.test.mjs
 *       node test/state.test.mjs --diag        (marker recognition report)
 *       node test/state.test.mjs --filter round
 *
 * No test framework: plain ESM + node:assert/strict, non-zero exit on failure.
 *
 * PINNED DEFECTS
 * A defect this suite can prove but that nobody has fixed yet is registered with
 * `defect()` instead of `test()`. A pinned test asserts TODAY'S WRONG BEHAVIOUR,
 * so it stays green while the bug remains visible, executable and numbered
 * (GRILL-n). If a fix lands, the pin fails on
 * purpose and tells you to promote it to a normal test.
 *
 * FIXTURE REALISM
 * Event shapes mirror the real DSH host event stream
 * (a DSH agent loop plus the tool/skill plugin):
 *   { type, seq, time, data }
 *   user/message      data = UserMessage { id, role:'user', content:[{type:'text',text}], source }
 *   assistant/message data = { turn, step, message:{id,role:'content',content:[]}, stream:[] }
 *   tool/call         data = { turn, step, callId, name, arguments }   (arguments is a JSON string)
 *   tool/result       data = { turn, step, message }
 * Activation markers copied from the real host:
 *   - a user gesture `/grilling` in a message whose source.kind === 'user', followed by
 *     dsh-tool-skill's injection: source {kind:'skill-invocation', name, form:'instructions'}
 *     whose text is renderSkillContent(skill) => `<skill_content name="grilling">...`
 *   - the model path: assistant tool-call name:'skill' args {"name":"grilling"} + its tool/result
 *   - dsh-agent-loop appends EVERY first-attempt pre-step decision message as 'user/message',
 *     so the plugin's own directive also appears as a user/message event.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const STATE_PATH = path.join(ROOT, 'src', 'state.js');
const SKILL_PATH = path.join(ROOT, 'src', 'skill.js');

if (!existsSync(STATE_PATH)) {
  console.error(`PENDING: ${STATE_PATH} does not exist yet — harness is written, waiting for src/state.js.`);
  process.exit(2);
}

const S = await import(pathToFileURL(STATE_PATH).href);
const SKILL = existsSync(SKILL_PATH) ? await import(pathToFileURL(SKILL_PATH).href) : undefined;

for (const fn of ['projectEvents', 'analyze', 'renderStatus', 'renderDirective', 'describeViolation', 'makeUserMessage']) {
  if (typeof S[fn] !== 'function') {
    console.error(`FATAL: src/state.js does not export a callable ${fn}()`);
    process.exit(2);
  }
}
const {
  projectEvents,
  analyze,
  correctionDelivered,
  createProjector,
  renderStatus,
  renderDirective,
  describeViolation,
  makeUserMessage,
  parseAnswers,
  isAffirmativeAll,
  parseQuestions,
  violationKey,
} = S;

// ───────────────────────────── tiny runner ─────────────────────────────
const ARGS = process.argv.slice(2);
const FILTER = (ARGS.find((a) => a.startsWith('--filter=')) ?? '').slice('--filter='.length);
const DIAG = ARGS.includes('--diag');

let section = '';
const passed = [];
const failed = [];
function header(name) {
  section = name;
  if (!FILTER) console.log(`\n── ${name} ${'─'.repeat(Math.max(0, 62 - name.length))}`);
}
async function test(name, fn) {
  if (FILTER && !name.toLowerCase().includes(FILTER.toLowerCase())) return;
  try {
    await fn();
    passed.push(name);
    if (!FILTER) console.log(`  ok   ${name}`);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    failed.push({ section, name, message });
    console.log(`  FAIL ${name}`);
    console.log(`       ${message.split('\n').join('\n       ')}`);
  }
}

const defects = [];
/**
 * Register a KNOWN DEFECT: the body asserts the current (wrong) behaviour.
 *
 * Green  -> the defect is still there and is listed in the summary.
 * Red    -> the behaviour changed: either the bug was fixed (promote this pin to
 *           a normal `test()` with the corrected expectation) or it mutated into
 *           something else (re-investigate).
 */
async function defect(id, name, fn) {
  if (FILTER && !`${id} ${name}`.toLowerCase().includes(FILTER.toLowerCase())) return;
  try {
    await fn();
    defects.push({ id, name, section });
    console.log(`  OPEN ${id} ${name}`);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    failed.push({
      section,
      name: `${id} ${name}`,
      message: `pinned defect no longer reproduces: ${message} — promote this pin and delete the defect() registration`,
    });
    console.log(`  CHANGED ${id} ${name}`);
    console.log(`       ${message.split('\n').join('\n       ')}`);
  }
}

// ───────────────────────────── fixtures ─────────────────────────────
const T0 = 1_700_000_000_000;

/** Fresh transcript builder: deterministic seq/time, host-shaped events. */
function T() {
  let seq = 0;
  let time = T0;
  const events = [];
  const api = {
    events,
    push(type, data) {
      const event = { type, seq: seq, time: time, data };
      seq += 1;
      time += 1;
      events.push(event);
      return event;
    },
    user(text, source = { kind: 'user' }) {
      return api.push('user/message', {
        id: `u${seq}`,
        role: 'user',
        content: [{ type: 'text', text }],
        source,
      });
    },
    /** The real host's runtime-context / catalog / plugin injections are user messages too. */
    injected(text, kind, extra = {}) {
      return api.user(text, { kind, form: 'snapshot', ...extra });
    },
    assistant(text, opts = {}) {
      const { turn = 1, step = 1, toolCalls = [], id } = opts;
      const content = [];
      if (text !== null && text !== undefined) content.push({ type: 'text', text });
      for (const call of toolCalls) {
        content.push({
          type: 'tool-call',
          callId: call.callId ?? `c${seq}`,
          name: call.name,
          arguments: typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? {}),
        });
      }
      return api.push('assistant/message', {
        turn,
        step,
        message: { id: id ?? `a${seq}`, role: 'assistant', content, source: { kind: 'model' } },
        stream: [],
      });
    },
    toolCall(name, args, opts = {}) {
      const { turn = 1, step = 1, callId } = opts;
      return api.push('tool/call', {
        turn,
        step,
        callId: callId ?? `c${seq}`,
        name,
        arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
      });
    },
    toolResult(text, opts = {}) {
      const { turn = 1, step = 1 } = opts;
      return api.push('tool/result', {
        turn,
        step,
        message: { id: `r${seq}`, role: 'tool', content: [{ type: 'text', text }], source: { kind: 'tool', name: opts.name ?? 'x' } },
      });
    },
    turnStart(turn) {
      return api.push('turn/start', { turn });
    },
    turnEnd(turn, reason = { kind: 'completed' }) {
      return api.push('turn/end', { turn, reason });
    },
  };
  return api;
}

const SKILL_CONTENT = (name) =>
  [
    `<skill_content name="${name}">`,
    '<skill_resources>',
    'Resources for this skill are managed by provider "grill-me".',
    '</skill_resources>',
    '',
    '<skill_instructions>',
    'Ask the questions one round at a time.',
    '</skill_instructions>',
    '</skill_content>',
  ].join('\n');

/** Host-canonical activation: user gesture + dsh-tool-skill's skill-invocation injection. */
function activate(t, name = 'grilling', userText = 'Interview me about the plan') {
  t.user(`/${name} ${userText}`, { kind: 'user' });
  t.injected(SKILL_CONTENT(name), 'skill-invocation', { name, form: 'instructions' });
}
/** The model-invoked path: skill tool call + its rendered result. */
function activateViaTool(t, name = 'grilling') {
  t.assistant(null, { toolCalls: [{ name: 'skill', arguments: { name } }] });
  t.toolCall('skill', { name });
  t.toolResult(SKILL_CONTENT(name), { name: 'skill' });
}

function q(n, title, body, rec) {
  return `❓ **Q${n}** - **${title}**: ${body}\n➡️ ${rec}`;
}
const ROUND3 = [q(1, 'Scope', 'Only the CLI?', 'CLI only'), q(2, 'Storage', 'JSON or SQLite?', 'JSON'), q(3, 'Auth', 'Needed now?', 'No auth yet')].join('\n\n');
const ROUND1 = q(1, 'Scope', 'Only the CLI?', 'CLI only');
const ROUND13 = Array.from({ length: 13 }, (_, i) => q(i + 1, `Topic ${i + 1}`, `Decision ${i + 1}?`, `Recommendation ${i + 1}`)).join('\n\n');
const ROUND_ZH = [q(1, '范围', '只做命令行吗？', '先只做命令行'), q(2, '存储', '用 JSON 还是 SQLite？', '用 JSON')].join('\n\n');
const ROUND_MARKUP = [
  '❓ **Q1** - **Scope**: Which of these?\n\n- option **A**\n- option *B*\n\n---\n\n```js\nconst x = 1;\n```\n\n➡️ Option A',
  q(2, 'Storage', 'Use `JSON` or *SQLite*?', 'JSON'),
].join('\n\n');

// ───────────────────────── state accessors (tolerant, documented fields) ─────────────────────────
const STATEFUL_FIELDS = ['active', 'mode', 'rounds', 'currentRound', 'openQuestions', 'anyAnswerSinceRound', 'awaitingAnswers', 'confirmedUnderstanding', 'frontierEmpty', 'evidence'];

function stateOf(events, label = 'transcript') {
  let state;
  try {
    state = analyze(events);
  } catch (error) {
    throw new Error(`analyze() threw on ${label}: ${error && error.message ? error.message : error}`);
  }
  assert.ok(state && typeof state === 'object', `analyze() must return an object for ${label}, got ${typeof state}`);
  return state;
}
function openQuestions(s) {
  return Array.isArray(s.openQuestions) ? s.openQuestions : [];
}
function roundCount(s) {
  if (Array.isArray(s.rounds)) return s.rounds.length;
  if (typeof s.rounds === 'number') return s.rounds;
  return Number.NaN;
}
function roundOpen(s) {
  return openQuestions(s).length > 0 || s.awaitingAnswers === true;
}
function textOfMessage(message) {
  if (!message || !Array.isArray(message.content)) return '';
  return message.content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n');
}
/** Distinctive failure so a cascade from a broken precondition is obvious. */
function precondition(ok, what) {
  if (!ok) throw new Error(`PRECONDITION_FAILED: ${what}`);
}

// ───────────────────────────── DIAG mode ─────────────────────────────
if (DIAG) {
  const forms = [];
  {
    const t = T();
    activate(t, 'grilling');
    forms.push(['gesture + skill-invocation(grilling)', t.events]);
  }
  {
    const t = T();
    activate(t, 'grill-me');
    forms.push(['gesture + skill-invocation(grill-me)', t.events]);
  }
  {
    const t = T();
    activateViaTool(t, 'grilling');
    forms.push(['skill tool call + result(grilling)', t.events]);
  }
  {
    const t = T();
    t.user('/grilling go', { kind: 'user' });
    forms.push(['bare /grilling gesture only', t.events]);
  }
  {
    const t = T();
    t.user('please grill me about this', { kind: 'user' });
    forms.push(['english word "grill me"', t.events]);
  }
  console.log('\n── activation recognition (DIAG) ─────────────────────────────');
  for (const [label, events] of forms) {
    let verdict;
    try {
      const s = analyze(events);
      verdict = `active=${s.active} mode=${JSON.stringify(s.mode)} evidence=${Array.isArray(s.evidence) ? s.evidence.length : typeof s.evidence}`;
    } catch (error) {
      verdict = `THREW ${error && error.message}`;
    }
    console.log(`  ${label.padEnd(42)} -> ${verdict}`);
  }
  const t = T();
  activate(t);
  t.assistant(ROUND3, { turn: 1, step: 1 });
  const s = analyze(t.events);
  console.log('\n  after round of 3:', JSON.stringify({ active: s.active, currentRound: s.currentRound, open: openQuestions(s).length, awaitingAnswers: s.awaitingAnswers, frontierEmpty: s.frontierEmpty }));
  console.log('  directive:', JSON.stringify(renderDirective(s))?.slice(0, 220));
  console.log('  status len:', typeof renderStatus(s) === 'string' ? renderStatus(s).length : renderStatus(s));
  console.log('  violation:', JSON.stringify(describeViolation(s)));
  console.log('');
}

// ───────────────────────────── Phase 1: shape ─────────────────────────────
header('shape and interface');
await test('GrillState exposes every documented field with a sane type', () => {
  const t = T();
  activate(t);
  const s = stateOf(t.events);
  for (const field of STATEFUL_FIELDS) {
    assert.ok(field in s, `GrillState is missing documented field "${field}"`);
  }
  for (const field of ['active', 'anyAnswerSinceRound', 'awaitingAnswers', 'confirmedUnderstanding', 'frontierEmpty']) {
    assert.equal(typeof s[field], 'boolean', `GrillState.${field} must be a boolean, got ${typeof s[field]}`);
  }
  assert.ok(Array.isArray(s.openQuestions), 'GrillState.openQuestions must be an array');
  assert.ok(Array.isArray(s.rounds) || typeof s.rounds === 'number', 'GrillState.rounds must be an array or a count');
  assert.ok(Array.isArray(s.evidence), 'GrillState.evidence must be an array');
});

await test('renderStatus/renderDirective/describeViolation return strings-or-null, never throw', () => {
  const t = T();
  activate(t);
  t.assistant(ROUND3, { turn: 1, step: 1 });
  const s = stateOf(t.events);
  assert.equal(typeof renderStatus(s), 'string', 'renderStatus must return a string');
  const d = renderDirective(s);
  assert.ok(d === null || typeof d === 'string', `renderDirective must return string|null, got ${typeof d}`);
  const v = describeViolation(s);
  assert.ok(v === null || typeof v === 'string', `describeViolation must return string|null, got ${typeof v}`);
});

await test('makeUserMessage returns a frozen, unique, host-shaped user message', () => {
  const a = makeUserMessage('hello', { kind: 'grill-me', form: 'correction' });
  const b = makeUserMessage('hello', { kind: 'grill-me', form: 'correction' });
  assert.equal(a.role, 'user');
  assert.ok(Array.isArray(a.content) && a.content[0].type === 'text' && a.content[0].text === 'hello', 'content must be one text block');
  assert.deepEqual(a.source, { kind: 'grill-me', form: 'correction' });
  assert.equal(typeof a.id, 'string');
  assert.ok(a.id.length > 0, 'message id must be non-empty');
  assert.notEqual(a.id, b.id, 'each message needs a fresh id (the pre-step replacement map keys on it)');
  assert.ok(Object.isFrozen(a), 'makeUserMessage must return a frozen message (createUserMessage deep-freezes)');
  assert.throws(() => { a.role = 'x'; }, 'frozen message must reject mutation');
});

// ───────────────────────────── Phase 1: activation ─────────────────────────────
header('activation');
await test('skill-invocation injection for "grilling" activates the machine', () => {
  const t = T();
  activate(t, 'grilling');
  const s = stateOf(t.events);
  assert.equal(s.active, true, `active should be true after a real /grilling invocation; got state ${JSON.stringify(s).slice(0, 300)}`);
});

await test('skill-invocation injection for "grill-me" also activates', () => {
  const t = T();
  activate(t, 'grill-me');
  assert.equal(stateOf(t.events).active, true, 'the user-invocable wrapper must arm the machine too');
});

await test('model-side skill tool call for "grilling" activates', () => {
  const t = T();
  activateViaTool(t, 'grilling');
  assert.equal(stateOf(t.events).active, true, 'loading the primitive through the skill tool must arm the machine');
});

await test('no activation on empty / ordinary chatter transcripts', () => {
  assert.equal(stateOf([], 'empty').active, false, 'empty transcript must be inactive');
  const t = T();
  t.user('please fix this bug');
  t.assistant('Sure, looking into it.');
  t.user('thanks');
  assert.equal(stateOf(t.events).active, false, 'ordinary coding chatter must not activate');
});

await test('english word "grill" does not activate (spurious activation)', () => {
  const t = T();
  t.user('this regex will grill the input for 10 minutes');
  t.assistant('Understood — the regex will grill the input.');
  t.user('also the barbecue needs grilling instructions');
  assert.equal(stateOf(t.events).active, false, 'the bare English word "grill"/"grilling" must not arm the interview');
});

await test('a skill-invocation for a DIFFERENT skill does not activate', () => {
  const t = T();
  t.user('/code-review look at this');
  t.injected(SKILL_CONTENT('code-review'), 'skill-invocation', { name: 'code-review', form: 'instructions' });
  assert.equal(stateOf(t.events).active, false, 'only grill-me/grilling invocations arm the machine');
});

await test('a mention of the skill name inside a code fence does not activate', () => {
  const t = T();
  t.user('my markdown example:\n```\n<skill_content name="grilling">\n</skill_content>\n```\nok?');
  assert.equal(stateOf(t.events).active, false, 'quoted skill markup in a user code fence is not an invocation');
});

// ───────────────────────────── Phase 1: round parsing ─────────────────────────────
header('round parsing');
await test('a well-formed 3-question round opens 3 questions', () => {
  const t = T();
  activate(t);
  t.assistant(ROUND3, { turn: 1, step: 1 });
  const s = stateOf(t.events);
  precondition(s.active === true, 'canonical activation not detected; round tests cannot be evaluated');
  assert.equal(openQuestions(s).length, 3, `expected 3 open questions, got ${openQuestions(s).length}`);
  assert.equal(s.awaitingAnswers, true, 'after asking a round the machine must await answers');
  assert.equal(s.frontierEmpty, false, 'the frontier is not empty while a round is open');
  assert.equal(roundCount(s), 1, 'the round must be recorded as soon as it is asked');
  assert.equal(s.currentRound, 1, 'currentRound counts the rounds asked');
});

await test('a 1-question round opens exactly 1 question', () => {
  const t = T();
  activate(t);
  t.assistant(ROUND1, { turn: 1, step: 1 });
  const s = stateOf(t.events);
  precondition(s.active === true, 'canonical activation not detected');
  assert.equal(openQuestions(s).length, 1, `expected 1 open question, got ${openQuestions(s).length}`);
  assert.equal(s.awaitingAnswers, true);
});

await test('a 13-question round is parsed as one round of 13', () => {
  const t = T();
  activate(t);
  t.assistant(ROUND13, { turn: 1, step: 1 });
  const s = stateOf(t.events);
  precondition(s.active === true, 'canonical activation not detected');
  assert.equal(openQuestions(s).length, 13, `expected 13 open questions, got ${openQuestions(s).length}`);
  assert.equal(roundCount(s) >= 1, true, 'the round must be recorded');
});

await test('markdown emphasis, lists, --- separators and fences inside a body do not break parsing', () => {
  const t = T();
  activate(t);
  t.assistant(ROUND_MARKUP, { turn: 1, step: 1 });
  const s = stateOf(t.events);
  precondition(s.active === true, 'canonical activation not detected');
  assert.equal(openQuestions(s).length, 2, `expected 2 open questions, got ${openQuestions(s).length}`);
});

await test('a Chinese-language round parses', () => {
  const t = T();
  activate(t);
  t.assistant(ROUND_ZH, { turn: 1, step: 1 });
  const s = stateOf(t.events);
  precondition(s.active === true, 'canonical activation not detected');
  assert.equal(openQuestions(s).length, 2, `expected 2 open questions, got ${openQuestions(s).length}`);
});

await test('prose ABOUT the format is not a round (regression: naive regex on ❓ **Q1**)', () => {
  const t = T();
  activate(t);
  t.assistant(
    'I will ask questions using the format `❓ **Q1** - **Title**: body` followed by a `➡️ recommendation` line, in rounds.',
    { turn: 1, step: 1 },
  );
  const s = stateOf(t.events);
  precondition(s.active === true, 'canonical activation not detected');
  assert.equal(openQuestions(s).length, 0, `prose about the format must not open questions, got ${openQuestions(s).length}`);
  assert.equal(s.awaitingAnswers, false, 'prose about the format must not make the machine await answers');
});

await test('a fenced example round is not a real round', () => {
  const t = T();
  activate(t);
  t.assistant('Here is what a round looks like:\n\n```\n' + ROUND3 + '\n```\n\nShall I start?', { turn: 1, step: 1 });
  const s = stateOf(t.events);
  precondition(s.active === true, 'canonical activation not detected');
  assert.equal(openQuestions(s).length, 0, 'a round shown inside a code fence is documentation, not a round');
});

await test('an assistant message with no text blocks is not a round', () => {
  const t = T();
  activate(t);
  t.assistant(null, { turn: 1, step: 1, toolCalls: [{ name: 'subagent', arguments: { prompt: 'look up the facts' } }] });
  const s = stateOf(t.events);
  precondition(s.active === true, 'canonical activation not detected');
  assert.equal(openQuestions(s).length, 0, 'a tool-only assistant message is not a round');
});

// ───────────────────────────── Phase 1: answer detection ─────────────────────────────
header('answer detection');
await test('the user message that triggered the round does NOT answer it', () => {
  const t = T();
  activate(t);
  t.assistant(ROUND3, { turn: 1, step: 1 });
  const s = stateOf(t.events);
  precondition(s.active === true, 'canonical activation not detected');
  assert.equal(s.awaitingAnswers, true, 'must still await answers right after asking');
  assert.equal(roundCount(s), 1, 'the open round is already recorded in state.rounds');
  assert.equal(openQuestions(s).length, 3, 'the round must still be open');
});

await test('the first real user message after a round answers it', () => {
  const t = T();
  activate(t);
  t.assistant(ROUND3, { turn: 1, step: 1 });
  t.user('1. yes CLI only. 2. JSON. 3. no auth.', { kind: 'user' });
  const s = stateOf(t.events);
  precondition(s.active === true, 'canonical activation not detected');
  assert.equal(s.awaitingAnswers, false, 'a delivered answer batch closes the wait');
  assert.equal(s.completeRounds, 1, 'the round is settled once the user answers');
  assert.equal(openQuestions(s).length, 0, 'answered questions are no longer open');
});

await test('a NON-user-source message between round and answer does not count as the answer', () => {
  // The plugin's own directive, the runtime-context snapshot and skill-catalog messages are
  // all appended as 'user/message' events by dsh-agent-loop:1061 (firstAttempt).
  const t = T();
  activate(t);
  t.assistant(ROUND3, { turn: 1, step: 1 });
  t.injected('[grill-me] directive: wait for the user before acting', 'grill-me', { form: 'directive' });
  t.injected('runtime context snapshot', 'runtime-context');
  t.injected(SKILL_CONTENT('grilling'), 'skill-catalog', { form: 'catalog' });
  const s = stateOf(t.events);
  precondition(s.active === true, 'canonical activation not detected');
  assert.equal(s.awaitingAnswers, true, 'injected user-role messages must not satisfy the round');
  assert.equal(openQuestions(s).length, 3, 'the round must still be open after injected messages');
});

await test('a real answer later still counts after injected messages intervened', () => {
  const t = T();
  activate(t);
  t.assistant(ROUND3, { turn: 1, step: 1 });
  t.injected('[grill-me] directive', 'grill-me', { form: 'directive' });
  t.user('yes to all three', { kind: 'user' });
  const s = stateOf(t.events);
  precondition(s.active === true, 'canonical activation not detected');
  assert.equal(s.awaitingAnswers, false, 'the user answer after the injections must be recognized');
  assert.equal(openQuestions(s).length, 0, 'the answer settles the round');
});

await test('a user message that itself quotes the question format is not a new round', () => {
  const t = T();
  activate(t);
  t.assistant(ROUND1, { turn: 1, step: 1 });
  t.user('About your Q: ❓ **Q1** - **Scope**: Only the CLI?\n➡️ CLI only — but make it ❓ **Q2** - **X**: y?', { kind: 'user' });
  const s = stateOf(t.events);
  precondition(s.active === true, 'canonical activation not detected');
  assert.equal(openQuestions(s).length, 0, 'a user message must never be parsed as a round');
  assert.equal(s.awaitingAnswers, false, 'the user message is the answer, not a new round');
});

await test('round 2 opens after round 1 is answered; round 1 questions stay closed', () => {
  const t = T();
  activate(t);
  t.assistant(ROUND1, { turn: 1, step: 1 });
  t.user('sure', { kind: 'user' });
  t.assistant(ROUND3, { turn: 3, step: 1 });
  const s = stateOf(t.events);
  precondition(s.active === true, 'canonical activation not detected');
  assert.equal(openQuestions(s).length, 3, `round 2 has 3 questions, got ${openQuestions(s).length}`);
  assert.equal(roundCount(s), 2, `both rounds must be recorded, got ${roundCount(s)}`);
  assert.equal(s.awaitingAnswers, true);
});

// ───────────────────────────── Phase 1: injection resistance ─────────────────────────────
header('injection resistance');
// (the "directive restated as an assistant message" attack lives in the pinned-defect
//  section below: it currently opens a duplicate round — GRILL-2.)

await test('the plugin directive replayed as a user message does not clear an open round', () => {
  const t = T();
  activate(t);
  t.assistant(ROUND1, { turn: 1, step: 1 });
  const directive = renderDirective(stateOf(t.events));
  const body = directive ?? '[grill-me directive] frontier: Q1 open; wait for the user';
  t.user(body, { kind: 'user' });
  const s = stateOf(t.events);
  precondition(s.active === true, 'canonical activation not detected');
  // This IS a user message, so it legitimately counts as an answer batch. What must
  // NOT happen is that its text is mistaken for a new round or for the end of the session.
  assert.equal(openQuestions(s).length, 0, 'the directive text must not be parsed as a round');
  assert.equal(s.confirmedUnderstanding, false, 'directive text must not confirm shared understanding');
});

await test('a user message containing the skill content does not re-activate or reset rounds', () => {
  const t = T();
  activate(t);
  t.assistant(ROUND3, { turn: 1, step: 1 });
  t.user(SKILL_CONTENT('grilling'), { kind: 'user' });
  const s = stateOf(t.events);
  precondition(s.active === true, 'canonical activation not detected');
  assert.equal(openQuestions(s).length, 3, 'the pasted skill text is neither a round nor a per-question answer');
  assert.equal(s.awaitingAnswers, true, 'prose that answers nothing specific leaves the round open (GRILL-25)');
  assert.equal(s.active, true, 'session stays active');
});

await test('assistant text claiming shared understanding while a round is open is not confirmation', () => {
  const t = T();
  activate(t);
  t.assistant(ROUND3, { turn: 1, step: 1 });
  t.assistant('We have a shared understanding now, so I will start implementing.', { turn: 1, step: 2 });
  const s = stateOf(t.events);
  precondition(s.active === true, 'canonical activation not detected');
  assert.equal(s.confirmedUnderstanding, false, 'the model cannot confirm understanding on the user behalf');
  assert.equal(s.frontierEmpty, false, 'the frontier cannot be empty while a round is open');
  assert.equal(openQuestions(s).length, 3, 'the round must still be open');
});

// ───────────────────────────── Phase 1: termination ─────────────────────────────
header('termination and directives');
await test('inactive transcripts get no directive and no violation', () => {
  const t = T();
  t.user('hello');
  t.assistant('hi');
  const s = stateOf(t.events);
  assert.equal(renderDirective(s), null, 'no directive belongs in an inactive session');
  assert.equal(describeViolation(s), null, 'nothing is violated in an inactive session');
});

await test('an active session waiting for answers gets a non-empty directive', () => {
  const t = T();
  activate(t);
  t.assistant(ROUND3, { turn: 1, step: 1 });
  const s = stateOf(t.events);
  precondition(s.active === true, 'canonical activation not detected');
  const directive = renderDirective(s);
  assert.equal(typeof directive, 'string', 'an active, waiting session needs a directive');
  assert.ok(directive.trim().length > 0, 'the directive must not be empty');
});

await test('frontierEmpty is never true while a round is open', () => {
  const t = T();
  activate(t);
  t.assistant(ROUND3, { turn: 1, step: 1 });
  const s = stateOf(t.events);
  precondition(s.active === true, 'canonical activation not detected');
  assert.equal(s.frontierEmpty, false);
  assert.equal(roundOpen(s) && s.frontierEmpty, false, 'round open and frontier empty is a contradiction');
});

await test('frontierEmpty implies zero open questions (checked across a whole interview)', () => {
  const t = T();
  activate(t);
  const snapshots = [];
  const check = (label) => {
    const s = stateOf(t.events, label);
    snapshots.push(`${label}: frontierEmpty=${s.frontierEmpty} open=${openQuestions(s).length} awaiting=${s.awaitingAnswers}`);
    if (s.frontierEmpty) assert.equal(openQuestions(s).length, 0, `frontierEmpty with ${openQuestions(s).length} open questions at ${label}`);
    if (s.frontierEmpty) assert.equal(s.awaitingAnswers, false, `frontierEmpty while awaiting answers at ${label}`);
  };
  check('after activation');
  t.assistant(ROUND1, { turn: 1, step: 1 });
  check('after round 1');
  t.user('yes', { kind: 'user' });
  check('after answer 1');
  t.assistant(ROUND3, { turn: 3, step: 1 });
  check('after round 2');
  t.user('yes to all', { kind: 'user' });
  check('after answer 2');
});

await test('describeViolation is null for a well-behaved waiting session', () => {
  const t = T();
  activate(t);
  t.assistant(ROUND3, { turn: 1, step: 1 });
  const s = stateOf(t.events);
  precondition(s.active === true, 'canonical activation not detected');
  assert.equal(describeViolation(s), null, 'asking a round and waiting is exactly the protocol');
});

await test('describeViolation fires when the model takes action after asking a round', () => {
  const t = T();
  activate(t);
  t.assistant(ROUND3, { turn: 1, step: 1 });
  t.assistant(null, { turn: 1, step: 2, toolCalls: [{ name: 'write', arguments: { file_path: 'src/x.js', content: '// started' } }] });
  t.toolCall('write', { file_path: 'src/x.js', content: '// started' }, { turn: 1, step: 2 });
  const s = stateOf(t.events);
  precondition(s.active === true, 'canonical activation not detected');
  const v = describeViolation(s);
  assert.equal(typeof v, 'string', 'acting on the plan while the frontier is open is a protocol violation');
  assert.ok(v.trim().length > 0);
});

await test('describeViolation fires on an edit in a later step of the same turn', () => {
  const t = T();
  activate(t);
  t.assistant(ROUND1, { turn: 1, step: 1 });
  t.assistant(null, { turn: 1, step: 2, toolCalls: [{ name: 'edit', arguments: { file_path: 'src/x.js', old_string: 'a', new_string: 'b' } }] });
  t.toolCall('edit', { file_path: 'src/x.js', old_string: 'a', new_string: 'b' }, { turn: 1, step: 2 });
  const s = stateOf(t.events);
  precondition(s.active === true, 'canonical activation not detected');
  const v = describeViolation(s);
  assert.equal(typeof v, 'string', 'a mutating tool call after an open round must be corrected');
  assert.match(v, /ran edit instead of waiting for the answers/, 'the correction must name the offending action');
});

await test('describeViolation is null for a non-blocking fact lookup after the round', () => {
  // Facts are the agent's job: subagent lookup must stay allowed.
  const t = T();
  activate(t);
  t.assistant(ROUND3, { turn: 1, step: 1 });
  t.assistant(null, { turn: 1, step: 2, toolCalls: [{ name: 'subagent', arguments: { prompt: 'look up the numbers' } }] });
  t.toolCall('subagent', { prompt: 'look up the numbers' }, { turn: 1, step: 2 });
  const s = stateOf(t.events);
  precondition(s.active === true, 'canonical activation not detected');
  assert.equal(describeViolation(s), null, 'a read-only fact lookup is explicitly allowed by the protocol and must not be corrected');
});

await test('describeViolation is null once the round is answered and closed', () => {
  const t = T();
  activate(t);
  t.assistant(ROUND1, { turn: 1, step: 1 });
  t.user('yes', { kind: 'user' });
  const s = stateOf(t.events);
  precondition(s.active === true, 'canonical activation not detected');
  assert.equal(describeViolation(s), null, 'after the user answered there is nothing to correct');
});

await test('the machine cannot end (frontierEmpty) without a user confirmation', () => {
  const t = T();
  activate(t);
  t.assistant(ROUND1, { turn: 1, step: 1 });
  // The reply is a labelled answer, not a bare token: since GRILL-28 a whole-message
  // acceptance token ("yes", "确认") is the human's own confirmation, so this fixture must
  // answer the round *without* uttering one to keep testing the model's claim alone.
  t.user('1 yes', { kind: 'user' });
  t.assistant('All decisions are settled. Starting now.', { turn: 3, step: 1 });
  const s = stateOf(t.events);
  precondition(s.active === true, 'canonical activation not detected');
  assert.equal(s.confirmedUnderstanding, false, 'the model alone cannot confirm shared understanding');
});

// ───────────────────────────── Phase 1: robustness ─────────────────────────────
header('robustness');
await test('analyze survives degenerate inputs without throwing', () => {
  const circular = { type: 'user/message', seq: 0, time: 0, data: {} };
  circular.data.message = circular; // circular-ish junk
  const cases = [
    ['[]', []],
    ['null', null],
    ['undefined', undefined],
    ['a non-array object', { type: 'user/message' }],
    ['an unknown event type', [{ type: 'weird/thing', seq: 0, time: 0, data: { a: 1 } }]],
    ['an event with no data', [{ type: 'user/message', seq: 0, time: 0 }]],
    ['an event with null data', [{ type: 'assistant/message', seq: 0, time: 0, data: null }]],
    ['an assistant message with no content array', [{ type: 'assistant/message', seq: 0, time: 0, data: { turn: 1, step: 1, message: { role: 'assistant' } } }]],
    ['an assistant message with a hostile tool-call arguments string', [{ type: 'assistant/message', seq: 0, time: 0, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'tool-call', name: 'x', arguments: '{"a":' }] } } }]],
    ['a truncated tool/call arguments string', [{ type: 'tool/call', seq: 0, time: 0, data: { turn: 1, step: 1, name: 'skill', arguments: '{"name":' } }]],
    ['an array of nulls', [null, undefined, null]],
    ['circular-ish junk', [circular]],
    ['a non-string text block', [{ type: 'user/message', seq: 0, time: 0, data: { id: 'u', role: 'user', content: [{ type: 'text', text: 42 }], source: { kind: 'user' } } }]],
    ['a user message with no source', [{ type: 'user/message', seq: 0, time: 0, data: { id: 'u', role: 'user', content: [{ type: 'text', text: '/grilling' }] } }]],
  ];
  for (const [label, input] of cases) {
    const s = stateOf(input, label);
    assert.equal(typeof s.active, 'boolean', `analyze(${label}).active must be a boolean`);
    assert.equal(typeof renderStatus(s), 'string', `renderStatus must not throw for ${label}`);
    const d = renderDirective(s);
    assert.ok(d === null || typeof d === 'string', `renderDirective must not throw for ${label}`);
    const v = describeViolation(s);
    assert.ok(v === null || typeof v === 'string', `describeViolation must not throw for ${label}`);
  }
});

await test('projectEvents survives the same degenerate inputs', () => {
  for (const input of [[], null, undefined, [{ type: 'x', seq: 0, time: 0, data: {} }], [null]]) {
    const out = projectEvents(input);
    assert.ok(Array.isArray(out), `projectEvents(${String(input)}) must return an array`);
  }
});

await test('analyze does not mutate its input', () => {
  const t = T();
  activate(t);
  t.assistant(ROUND3, { turn: 1, step: 1 });
  t.user('yes', { kind: 'user' });
  t.assistant(ROUND1, { turn: 3, step: 1 });
  t.toolCall('read', { file: 'x' }, { turn: 3, step: 2 });
  const before = JSON.stringify(t.events);
  const frozen = Object.freeze(t.events.map((e) => Object.freeze({ ...e })));
  analyze(frozen); // strict-mode ESM: a write into a frozen event throws
  analyze(t.events);
  assert.equal(JSON.stringify(t.events), before, 'analyze() mutated the transcript it was given');
});

await test('analyze is deterministic for identical input', () => {
  const t = T();
  activate(t);
  t.assistant(ROUND3, { turn: 1, step: 1 });
  t.user('yes', { kind: 'user' });
  t.assistant(ROUND1, { turn: 3, step: 1 });
  const a = JSON.stringify(analyze(t.events));
  const b = JSON.stringify(analyze(t.events));
  assert.equal(a, b, 'analyze() must be a pure function of the transcript');
});

await test('analyze tolerates a >=5000-event transcript in under 2s', () => {
  const t = T();
  activate(t);
  let turn = 1;
  while (t.events.length < 5200) {
    t.assistant(ROUND3, { turn, step: 1 });
    t.user(`answers for turn ${turn}: yes yes yes`, { kind: 'user' });
    t.toolCall('read', { file: `f${turn}` }, { turn, step: 2 });
    t.toolResult('ok', { turn, step: 2 });
    turn += 1;
  }
  const started = performance.now();
  const s = analyze(t.events);
  const elapsed = performance.now() - started;
  assert.equal(typeof s.active, 'boolean');
  assert.ok(elapsed < 2000, `analyze() on ${t.events.length} events took ${elapsed.toFixed(0)}ms (quadratic blowup?)`);
  if (!FILTER) console.log(`       (${t.events.length} events in ${elapsed.toFixed(0)}ms)`);
});

// ───────────────────────────── Phase 1: cross-module + property ─────────────────────────────
header('cross-module and properties');
await test('analyze(raw) and analyze(projectEvents(raw)) agree', () => {
  const t = T();
  activate(t);
  t.assistant(ROUND3, { turn: 1, step: 1 });
  t.user('1 yes 2 json 3 no', { kind: 'user' });
  t.assistant(ROUND1, { turn: 3, step: 1 });
  t.toolCall('read', { file: 'x' }, { turn: 3, step: 2 });
  const viaRaw = analyze(t.events);
  const viaProjected = analyze(projectEvents(t.events));
  const pick = (s) => ({ active: s.active, awaitingAnswers: s.awaitingAnswers, open: openQuestions(s).length, frontierEmpty: s.frontierEmpty, anyAnswerSinceRound: s.anyAnswerSinceRound, confirmedUnderstanding: s.confirmedUnderstanding, currentRound: s.currentRound });
  assert.deepEqual(pick(viaProjected), pick(viaRaw), 'the glue passes RAW session events; projection must not change the verdict');
});

await test('projectEvents is order-preserving and stable', () => {
  const t = T();
  activate(t);
  t.assistant(ROUND1, { turn: 1, step: 1 });
  t.user('yes', { kind: 'user' });
  const a = projectEvents(t.events);
  const b = projectEvents(t.events);
  assert.equal(a.length, b.length, 'projectEvents must be deterministic in length');
  assert.equal(JSON.stringify(a), JSON.stringify(b), 'projectEvents must be deterministic');
});

// seeded PRNG so a failure is reproducible
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let r = Math.imul(a ^ (a >>> 15), 1 | a);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

await test('200 randomized transcripts never throw and never break the invariants', () => {
  const rand = mulberry32(0x6772696c);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  let activated = 0;
  let rounds = 0;
  for (let i = 0; i < 200; i += 1) {
    const t = T();
    let sawActivation = false;
    const steps = 6 + Math.floor(rand() * 14);
    let turn = 1;
    for (let k = 0; k < steps; k += 1) {
      switch (pick(['user', 'activate', 'round', 'answer', 'action', 'tool', 'junk', 'inject'])) {
        case 'user':
          // No activation marker may hide in this pool: the explicit 'activate' case
          // is the ONLY way a random transcript can arm the machine, which is what
          // makes the "active without a marker" assertion below meaningful.
          t.user(pick(['ok', 'yes', 'no', 'do it', 'hmm', 'grilling sounds useful', 'what about tests?', '/grill-stop maybe']), { kind: 'user' });
          break;
        case 'activate':
          if (rand() < 0.34) activate(t, pick(['grilling', 'grill-me']));
          else if (rand() < 0.5) activateViaTool(t);
          else t.injected(SKILL_CONTENT('grilling'), 'skill-invocation', { name: 'grilling', form: 'instructions' });
          sawActivation = true;
          break;
        case 'round':
          t.assistant(pick([ROUND1, ROUND3, ROUND13, ROUND_ZH, ROUND_MARKUP]), { turn, step: 1 });
          rounds += 1;
          break;
        case 'answer':
          t.user(pick(['yes to all', '1 yes 2 no 3 maybe', 'here are my answers']), { kind: 'user' });
          turn += 1;
          break;
        case 'action':
          t.assistant(pick(['Starting now.', 'We have a shared understanding.', 'Done.']), { turn, step: 2 });
          break;
        case 'tool':
          t.toolCall(pick(['write', 'read', 'subagent', 'edit']), { file: 'x' }, { turn, step: 2 });
          break;
        case 'junk':
          t.push(pick(['weird/thing', 'step/start', 'turn/end']), { turn, step: 3 });
          break;
        case 'inject':
          t.injected(pick(['[grill-me] directive', 'runtime context snapshot', SKILL_CONTENT('other-skill')]), pick(['grill-me', 'runtime-context', 'skill-catalog', 'skill-invocation']));
          break;
      }
      const s = stateOf(t.events, `random transcript #${i} step ${k}`);
      if (s.active) activated += 1;
      if (!sawActivation) assert.equal(s.active, false, `random #${i} step ${k}: active without any activation marker`);
      assert.equal(s.mode === 'inactive', s.active === false, `random #${i} step ${k}: mode and active disagree`);
      const open = openQuestions(s);
      assert.equal(roundOpen(s) && s.frontierEmpty === true, false, `random #${i} step ${k}: awaitingAnswers/open questions while frontierEmpty`);
      if (s.awaitingAnswers) assert.notEqual(s.mode, 'confirmed', `random #${i} step ${k}: awaiting answers while the state says confirmed`);
      if (s.frontierEmpty) assert.equal(open.length, 0, `random #${i} step ${k}: frontierEmpty with ${open.length} open questions`);
      if (s.confirmedUnderstanding) assert.equal(roundOpen(s), false, `random #${i} step ${k}: confirmed understanding while a round is open`);
      const d = renderDirective(s);
      assert.ok(d === null || typeof d === 'string', `random #${i} step ${k}: renderDirective must return string|null`);
      assert.equal(typeof renderStatus(s), 'string', `random #${i} step ${k}: renderStatus must return a string`);
      const v = describeViolation(s);
      assert.ok(v === null || typeof v === 'string', `random #${i} step ${k}: describeViolation must return string|null`);
    }
  }
  if (!FILTER) console.log(`       (200 transcripts, ${rounds} rounds, ${activated} active snapshots)`);
});

// ═══════════════ fixed semantics (state.js v2: 5 root-cause fixes) ═══════════════
// Each test below pins one of the claims the fixes make, so a silent regression
// shows up as a red test instead of as a greener suite.
header('parseQuestions body extraction (post-fix)');

await test('no parsed question body still carries its own Q header', () => {
  const fixtures = [['ROUND1', ROUND1, 1], ['ROUND3', ROUND3, 3], ['ROUND13', ROUND13, 13], ['ROUND_ZH', ROUND_ZH, 2], ['ROUND_MARKUP', ROUND_MARKUP, 2]];
  for (const [name, text, count] of fixtures) {
    const questions = parseQuestions(text);
    assert.equal(questions.length, count, `${name} must parse into ${count} questions`);
    for (const question of questions) {
      assert.ok(
        !/(?:^|\n)\s*(?:❓\s*)?\*{0,2}Q\s?\d{1,3}\*{0,2}/.test(question.body),
        `${name} Q${question.number} body still contains a Q header: ${JSON.stringify(question.body.slice(0, 60))}`,
      );
    }
  }
});

await test('the directive, replayed verbatim by the model, is no longer a round', () => {
  const t = T();
  activate(t);
  t.assistant(ROUND3, { turn: 1, step: 1 });
  const directive = renderDirective(stateOf(t.events));
  precondition(typeof directive === 'string' && directive.length > 0, 'no directive rendered for an open round');
  t.assistant(directive, { turn: 2, step: 1 });
  const s = stateOf(t.events);
  assert.equal(roundCount(s), 1, 'echoing the directive must not add a round');
  assert.equal(openQuestions(s).length, 3, 'echoing the directive must not change the open question set');
  assert.equal(describeViolation(s), null, 'a verbatim restatement is not by itself a violation');
});

await test('a nested ❓ Q marker line splits into separate questions with clean bodies', () => {
  const text = '❓ **Q1** - **Cache**: Which store?\n   ❓ **Q2** - **TTL**: How long?\n➡️ Recommended: Redis, 1h';
  const questions = parseQuestions(text);
  assert.equal(questions.length, 2);
  assert.equal(questions[0].title, 'Cache');
  assert.equal(questions[0].body, 'Which store?');
  assert.equal(questions[1].title, 'TTL');
  assert.match(questions[1].body, /How long\?/);
});

await test('a 13-question round keeps all 13 questions, numbers, titles and recommendations', () => {
  const questions = parseQuestions(ROUND13);
  assert.equal(questions.length, 13);
  assert.deepEqual(questions.map((x) => x.number), Array.from({ length: 13 }, (_, i) => i + 1));
  assert.deepEqual(questions.map((x) => x.title), Array.from({ length: 13 }, (_, i) => `Topic ${i + 1}`));
  assert.equal(questions.every((x) => x.hasRecommendation), true, 'every question keeps its ➡️ recommendation');
});

header('anyAnswerSinceRound and action flagging (v2 semantics)');

await test('anyAnswerSinceRound tracks a reply on the NEWEST round only', () => {
  const t = T();
  activate(t);
  t.assistant(ROUND1, { turn: 1, step: 1 });
  let s = stateOf(t.events);
  assert.equal(s.anyAnswerSinceRound, false, 'a round that was just asked has no reply yet');
  t.user('1 yes', { kind: 'user' });
  s = stateOf(t.events);
  assert.equal(s.anyAnswerSinceRound, true, 'the newest round was answered');
  t.assistant(ROUND3, { turn: 2, step: 1 });
  s = stateOf(t.events);
  assert.equal(s.anyAnswerSinceRound, false, 'a new round resets the flag until IT is answered');
  assert.equal(s.awaitingAnswers, true);
  t.user('1 yes 2 json 3 no auth', { kind: 'user' });
  s = stateOf(t.events);
  assert.equal(s.anyAnswerSinceRound, true);
  assert.equal(s.frontierEmpty, true, 'every round answered and nothing open');
});

await test('a mutating call reported twice (message block + tool/call event) is flagged once', () => {
  const t = T();
  activate(t);
  t.assistant(ROUND1, { turn: 1, step: 1 });
  t.assistant(null, { turn: 1, step: 2, toolCalls: [{ name: 'write', arguments: { file_path: 'a.js' } }] });
  t.toolCall('write', { file_path: 'a.js' }, { turn: 1, step: 2 });
  const s = stateOf(t.events);
  assert.equal(s.actionsAfterRound.length, 1, `the host reports one call twice; got ${s.actionsAfterRound.length} violations`);
});

await test('a tool/call event alone is enough to flag a violation', () => {
  const t = T();
  activate(t);
  t.assistant(ROUND1, { turn: 1, step: 1 });
  t.toolCall('pwsh', { command: 'git commit -am x' }, { turn: 2, step: 1 });
  const s = stateOf(t.events);
  assert.equal(s.actionsAfterRound.length, 1);
  assert.match(describeViolation(s) ?? '', /ran pwsh/, 'the correction must name the offending tool');
});

await test('a round bundled with a mutating call is still flagged through its tool/call event', () => {
  const t = T();
  activate(t);
  t.assistant(ROUND1, { turn: 1, step: 1, toolCalls: [{ name: 'write', arguments: { file_path: 'a.js' } }] });
  t.toolCall('write', { file_path: 'a.js' }, { turn: 1, step: 1 });
  const s = stateOf(t.events);
  assert.equal(roundCount(s), 1);
  assert.equal(s.actionsAfterRound.length, 1, 'a mutation bundled with the round must not hide behind it');
});

await test('read-only tool/call events during an open round are never violations', () => {
  const t = T();
  activate(t);
  t.assistant(ROUND1, { turn: 1, step: 1 });
  for (const name of ['read', 'grep', 'glob', 'search_context', 'web_search', 'web_fetch', 'task', 'subagent', 'subagent_fork', 'cordis_inspect_query', 'memos_search', 'get_weather']) {
    t.toolCall(name, {}, { turn: 2, step: 1 });
  }
  const s = stateOf(t.events);
  assert.deepEqual(s.actionsAfterRound.map((a) => a.toolNames), [], 'fact-finding is the agent job during an open round');
});

await test('separate steps are flagged separately; two calls in one step count once', () => {
  const t = T();
  activate(t);
  t.assistant(ROUND1, { turn: 1, step: 1 });
  t.toolCall('write', {}, { turn: 1, step: 2 });
  t.toolCall('edit', {}, { turn: 1, step: 2 });
  t.toolCall('pwsh', { command: 'rm -rf build' }, { turn: 1, step: 3 });
  const s = stateOf(t.events);
  assert.equal(s.actionsAfterRound.length, 2, `expected 2 flagged steps, got ${s.actionsAfterRound.length}`);
});

await test('the Chinese triggers that ARE wired up still activate the interview', () => {
  const t = T();
  t.user('拷问我吧，关于这个方案', { kind: 'user' });
  assert.equal(stateOf(t.events).active, true);
});

// ═════════════════════════ regression: pins that flipped on the v3 fix ═════════════════════════
// These were executable pins in the v2 suite. src/state.js v3 (sha256 C007E954AADEDAC7,
// 37448 bytes, mtime 2026-10-11 14:57:08) fixes them, so each now asserts the CORRECT
// behaviour and guards against the regression coming back.
header('regression: fixed pins (v3)');

await test('FIXED GRILL-1: a user reply drains every round that is still open', () => {
  const t = T();
  activate(t);
  t.assistant(ROUND1, { turn: 1, step: 1 });
  t.assistant(ROUND3, { turn: 2, step: 1 }); // asked without waiting: both rounds stay open BY DESIGN
  t.user('1 yes 2 json 3 no auth', { kind: 'user' });
  let s = stateOf(t.events);
  assert.equal(roundCount(s), 2);
  assert.equal(s.answeredQuestions.length, 4, 'one reply drains both rounds');
  assert.equal(openQuestions(s).length, 0);
  assert.equal(s.awaitingAnswers, false);
  assert.equal(s.frontierEmpty, true);
  assert.equal(s.mode, 'awaiting-confirmation');
  // overreach guard: a round asked AFTER the reply must not be pre-settled
  t.assistant(ROUND_ZH, { turn: 3, step: 1 });
  s = stateOf(t.events);
  assert.equal(s.openQuestions.length > 0, true, 'a later round stays open');
  assert.equal(s.awaitingAnswers, true);
  assert.equal(s.frontierEmpty, false);
});

await test("FIXED GRILL-3: an injected message does not hide the human's confirmation", () => {
  const t = T();
  activate(t);
  t.assistant(ROUND1, { turn: 1, step: 1 });
  t.user('yes to all', { kind: 'user' });
  t.assistant('We have a shared understanding.', { turn: 2, step: 1 });
  t.injected('runtime context: plan mode is off, cwd /workspace', 'runtime-context');
  const s = stateOf(t.events);
  assert.equal(s.claimedSharedUnderstanding, true);
  assert.equal(s.frontierEmpty, true);
  assert.equal(s.confirmedUnderstanding, true, 'the human confirmation survives an injected context message');
  assert.equal(s.mode, 'confirmed');
});

await test('FIXED GRILL-4: an injected message cannot confirm the design for the user', () => {
  const t = T();
  activate(t);
  t.assistant(ROUND1, { turn: 1, step: 1 });
  t.user('1 yes', { kind: 'user' });
  t.assistant('We have a shared understanding.', { turn: 2, step: 1 });
  t.injected('runtime context: no more questions to ask here', 'runtime-context');
  let s = stateOf(t.events);
  assert.equal(s.confirmedUnderstanding, false, 'CONFIRM_RE must only ever see a user-authored message');
  assert.equal(s.mode, 'awaiting-confirmation');
  // control: the human's own confirmation still works
  t.user('no more questions, go ahead', { kind: 'user' });
  s = stateOf(t.events);
  assert.equal(s.confirmedUnderstanding, true);
  assert.equal(s.mode, 'confirmed');
});

// GRILL-28 came from live acceptance: the user typed exactly "确认" to close the
// interview and nothing happened. CONFIRM_RE lists 确认理解 / 全部确认 / 都确认 but not
// the bare word the user actually reaches for first.
await test('FIXED GRILL-28: a bare "确认" closes the interview, with no ritual phrasing from the assistant', () => {
  const t = T();
  activate(t);
  t.assistant(ROUND1, { turn: 1, step: 1 });
  t.user('1 yes', { kind: 'user' });
  let s = stateOf(t.events);
  assert.equal(s.frontierEmpty, true);
  assert.equal(s.claimedSharedUnderstanding, false, 'the fixture never claims a shared understanding');
  assert.equal(s.claimedDone, false, 'and never announces the design is settled');
  assert.equal(s.confirmedUnderstanding, false);
  assert.equal(s.mode, 'awaiting-confirmation');
  t.user('确认', { kind: 'user' });
  s = stateOf(t.events);
  assert.equal(s.confirmedUnderstanding, true, "a whole-message acceptance token is the human's own word");
  assert.equal(s.mode, 'confirmed');
  assert.match(renderDirective(s), /COMPLETE/);
});

await test('GRILL-28: a bare token still cannot close the interview while a question is open', () => {
  const t = T();
  activate(t);
  t.assistant(ROUND3, { turn: 1, step: 1 });
  t.user('1 确认', { kind: 'user' });
  let s = stateOf(t.events);
  assert.equal(s.frontierEmpty, false);
  assert.equal(s.confirmedUnderstanding, false, 'the frontier is not empty, so nothing is confirmed');
  assert.equal(s.mode, 'awaiting-answers');
  assert.equal(openQuestions(s).length, 2);
  assert.equal(s.answeredQuestions[0].disposition, 'accepted', 'the same word still settles a question');
  // trailing punctuation and a mixed reply must not defeat either reading
  t.user('2 用 JSON\n3 确认。', { kind: 'user' });
  s = stateOf(t.events);
  assert.equal(openQuestions(s).length, 0);
  assert.equal(s.frontierEmpty, true);
  assert.equal(s.mode, 'awaiting-confirmation');
  t.user('确认。', { kind: 'user' });
  s = stateOf(t.events);
  assert.equal(s.confirmedUnderstanding, true, 'trailing punctuation is stripped before the token test');
  assert.equal(s.mode, 'confirmed');
});

// GRILL-31 also came from live acceptance, and it is the mirror of GRILL-23: the
// ledger of recorded acts lives for the whole session, and the gate corrected
// whatever its newest entry was — so an act from turn 24 was still reported as a
// live breach at the end of turn 33, a turn whose directive said the opposite (all
// questions answered, frontier empty). The live transcript carried the same
// correction text twice, `turn 30 step 6` and `turn 33 step 190`, both citing
// `(turn 24, step 4)`, and its recovery steps ordered the model to re-ask a round
// the user had answered long before.

/** Activation + one open round + one mutating act while that round waits. */
function violationFixture() {
  const t = T();
  activate(t);
  t.assistant(ROUND1, { turn: 1, step: 1 });
  t.toolCall('write', {}, { turn: 1, step: 2 });
  return t;
}

await test('FIXED GRILL-31: an act from an earlier turn is history, not a live breach', () => {
  const t = violationFixture();
  const s = stateOf(t.events);
  precondition(s.active === true, 'canonical activation not detected');
  assert.equal(s.actionsAfterRound.length, 1, 'the act stays on the record');
  assert.equal(s.awaitingAnswers, true, 'the round is still open, so only the turn can make it history');
  const violation = s.actionsAfterRound[0];
  assert.equal(violationKey(s, 1), `action:${violation.seq}`, 'the turn that committed the act is corrected');
  assert.equal(violationKey(s, 2), null, 'a later turn must not report the old act again');
  assert.equal(violationKey(s), `action:${violation.seq}`, 'a caller that does not know the turn keeps the old reading');
});

await test('FIXED GRILL-31: once the round is answered the recorded act is no longer corrected', () => {
  const t = violationFixture();
  const correction = describeViolation(stateOf(t.events));
  precondition(typeof correction === 'string' && /Re-ask the pending round/.test(correction), 'fixture must carry a correction');
  t.user('1 yes', { kind: 'user' });
  const s = stateOf(t.events);
  assert.equal(s.actionsAfterRound.length, 1, 'the act stays on the record');
  assert.equal(s.awaitingAnswers, false);
  assert.equal(describeViolation(s), null, 'the recovery steps would order a re-ask of an answered round');
  assert.equal(violationKey(s, 1), null, 'no key means no correction');
  assert.match(renderStatus(s), /Protocol violations recorded: 1/, 'the record itself stays visible');
});

await test('GRILL-31: the transcript is the durable record of a correction already delivered', () => {
  const t = violationFixture();
  const text = describeViolation(stateOf(t.events));
  precondition(typeof text === 'string' && text.length > 0, 'fixture must carry a correction');
  assert.equal(correctionDelivered(t.events, text), false, 'nothing has been steered yet');
  t.user(text, { kind: 'grill-me', form: 'correction' });
  assert.equal(correctionDelivered(t.events, text), true, 'the record outlives the plugin instance that wrote it');
  assert.equal(correctionDelivered(t.events, `\n  ${text}  \n`), true, 'comparison is whitespace-insensitive');
  assert.equal(correctionDelivered(t.events, `${text} and one more thing`), false, 'a different text is a different correction');
  const directive = makeUserMessage(text, { kind: 'grill-me', form: 'directive' });
  assert.equal(
    correctionDelivered([{ seq: 99, type: 'user/message', data: directive }], text),
    false,
    'only a correction counts as one: a directive with the same text is not a delivered correction',
  );
  assert.equal(correctionDelivered(t.events, ''), false, 'an empty text cannot have been delivered');
});

// GRILL-30 is the mirror of GRILL-28 and it also came from live acceptance: the
// confirmation was re-read off the *newest* human message on every projection, so
// the next thing the user said withdrew it. The live session read
// `seq 5809 确认 -> mode=confirmed` and `seq 6335 重启了 -> mode=awaiting-confirmation`,
// after which the plugin went back to telling the agent to wait for a confirmation
// the user had already given.
await test('FIXED GRILL-30: chatter after a confirmation does not reopen the interview', () => {
  const t = T();
  activate(t);
  t.assistant(ROUND1, { turn: 1, step: 1 });
  t.user('1 yes', { kind: 'user' });
  t.user('确认', { kind: 'user' });
  let s = stateOf(t.events);
  assert.equal(s.confirmedUnderstanding, true);
  assert.equal(s.mode, 'confirmed');
  const confirmedAt = s.confirmedAtSeq;
  assert.equal(typeof confirmedAt, 'number', 'the confirmation is latched to the seq that carried it');
  t.user('重启了', { kind: 'user' });
  s = stateOf(t.events);
  assert.equal(s.confirmedUnderstanding, true, 'the confirmation belongs to the message that carried it');
  assert.equal(s.mode, 'confirmed', 'unrelated chatter is not a withdrawal');
  assert.equal(s.confirmedAtSeq, confirmedAt, 'and it is still the same confirmation');
  assert.match(renderDirective(s), /COMPLETE/);
  // the live check reads grill_status, so the evidence has to be in its output
  assert.match(renderStatus(s), /confirmed=true confirmedAt=\d+/, 'grill_status names the message the confirmation came from');
  // control: the latch is not a blanket "once confirmed, always confirmed"
  const other = T();
  activate(other);
  other.assistant(ROUND1, { turn: 1, step: 1 });
  other.user('1 yes', { kind: 'user' });
  other.user('重启了', { kind: 'user' });
  assert.equal(stateOf(other.events).confirmedUnderstanding, false, 'chatter alone never confirms');
});

await test('GRILL-30: a new round re-arms the confirmation; chatter still cannot stand in for one', () => {
  const t = T();
  activate(t);
  t.assistant(ROUND1, { turn: 1, step: 1 });
  t.user('1 yes', { kind: 'user' });
  t.user('确认', { kind: 'user' });
  assert.equal(stateOf(t.events).mode, 'confirmed');
  // the user comes back with a decision of their own, which opens a new round
  t.assistant(q(2, 'Retries', 'How many retries?', 'Three'), { turn: 2, step: 1 });
  let s = stateOf(t.events);
  assert.equal(s.frontierEmpty, false);
  assert.equal(s.confirmedUnderstanding, false, 'an open round is never confirmed');
  assert.equal(s.mode, 'awaiting-answers');
  t.user('2 three retries', { kind: 'user' });
  s = stateOf(t.events);
  assert.equal(s.frontierEmpty, true);
  assert.equal(s.confirmedUnderstanding, false, 'settling a new round re-arms the requirement');
  assert.equal(s.mode, 'awaiting-confirmation');
  t.user('重启了', { kind: 'user' });
  assert.equal(stateOf(t.events).confirmedUnderstanding, false, 'and chatter cannot stand in for the confirmation');
  t.user('确认', { kind: 'user' });
  s = stateOf(t.events);
  assert.equal(s.confirmedUnderstanding, true, 'a fresh confirmation closes it again');
  assert.equal(s.mode, 'confirmed');
});

await test('GRILL-30: a brand-new interview in the same session does not inherit the old confirmation', () => {
  const t = T();
  activate(t);
  t.assistant(ROUND1, { turn: 1, step: 1 });
  t.user('1 yes', { kind: 'user' });
  t.user('确认', { kind: 'user' });
  assert.equal(stateOf(t.events).mode, 'confirmed');
  // the latch lives in the fold, and a later activation starts a fresh fold: otherwise
  // a stale `confirmed=true` would muzzle the gate for the whole new interview
  activate(t, 'grilling', 'Interview me about something else');
  const s = stateOf(t.events);
  assert.equal(s.confirmedUnderstanding, false, 'a new activation must not inherit the old latch');
  assert.notEqual(s.mode, 'confirmed');
  assert.doesNotMatch(renderDirective(s), /COMPLETE/, 'the new interview is not "done" before it started');
});

await test('FIXED GRILL-5: only a round that is still open gets the missing-recommendation correction', () => {
  const t = T();
  activate(t);
  t.assistant('❓ **Q1** - **Cache**: Which store?\n❓ **Q2** - **TTL**: How long?', { turn: 1, step: 1 });
  assert.match(describeViolation(stateOf(t.events)) ?? '', /recommended answer for every question/, 'an OPEN round without recommendations must still be corrected');
  t.user('1 redis 2 one hour', { kind: 'user' });
  const s = stateOf(t.events);
  assert.equal(s.awaitingAnswers, false);
  assert.equal(openQuestions(s).length, 0);
  assert.equal(describeViolation(s), null, 'no stale correction for a round the user already answered');
});

await test('FIXED GRILL-6: a fenced quote does not arm the interview; the same words outside a fence do', () => {
  const fenced = T();
  fenced.user('Here is what the docs say:\n```\n/grill-me 拷问我\n```\nThat is all.', { kind: 'user' });
  assert.equal(stateOf(fenced.events).active, false, 'activation must read the un-fenced text');
  const live = T();
  live.user('docs are clear, /grill-me now', { kind: 'user' });
  assert.equal(stateOf(live.events).active, true);
});

await test('FIXED GRILL-7: "Q1 …" prose is not a round; protocol shapes still are', () => {
  const t = T();
  activate(t);
  t.assistant('Q1 revenue was up 20%.\nQ2 revenue was down 5%.\nNothing to decide here.', { turn: 1, step: 1 });
  let s = stateOf(t.events);
  assert.equal(roundCount(s), 0, 'the revenue quarter labels must not become a round');
  assert.equal(s.awaitingAnswers, false);
  // the header shape registers even without the ❓ marker
  assert.equal(parseQuestions('Q1 - **Scope**: which scope?\n➡️ Recommended: the CLI only').length, 1, 'header shape without ❓ must still parse');
  t.assistant(ROUND1, { turn: 2, step: 1 });
  s = stateOf(t.events);
  assert.equal(roundCount(s), 1);
  assert.equal(s.awaitingAnswers, true);
});

await test('FIXED GRILL-9: the documented Chinese triggers activate and the dead constant is gone', () => {
  const source = readFileSync(new URL('../src/state.js', import.meta.url), 'utf8');
  assert.equal(/ACTIVATE_HINT_RE/.test(source), false, 'the dead constant must be gone');
  for (const text of ['帮我压力测试一下这个方案', '帮我盘问一下这个方案', '帮我质询一下这个方案', '拷问我']) {
    const t = T();
    t.user(text, { kind: 'user' });
    assert.equal(stateOf(t.events).active, true, `"${text}" must activate`);
  }
  // overreach guard: a bare mention is still not a gesture
  const mention = T();
  mention.user('the docs mention grill-me in passing', { kind: 'user' });
  assert.equal(stateOf(mention.events).active, false);
});

await test('FIXED GRILL-10: titles come from each question own header', () => {
  const questions = parseQuestions(`**Round 2** — two things.\n\n${ROUND3}`);
  assert.equal(questions.length, 3);
  assert.deepEqual(questions.map((x) => x.title), ['Scope', 'Storage', 'Auth'], 'titles must not shift onto an earlier bold run');
});

await test('FIXED GRILL-11: full-width and em-dash separators are stripped off the body', () => {
  const colon = parseQuestions('❓ **Q1**：**Cache**：Which store?\n❓ **Q2**：**TTL**：How long?');
  assert.equal(colon.length, 2);
  assert.deepEqual(colon.map((x) => x.title), ['Cache', 'TTL']);
  assert.deepEqual(colon.map((x) => x.body), ['Which store?', 'How long?']);
  const dash = parseQuestions('❓ **Q1** — **Cache**: Which store?\n❓ **Q2** — **TTL**: How long?');
  assert.deepEqual(dash.map((x) => x.body), ['Which store?', 'How long?']);
});

await test('FIXED GRILL-12: a >60-question round is capped, not discarded', () => {
  const huge = Array.from({ length: 61 }, (_, i) => q(i + 1, `Topic ${i + 1}`, `Decision ${i + 1}?`, `Recommendation ${i + 1}`)).join('\n\n');
  assert.equal(parseQuestions(huge).length, 60, 'keep the first 60 questions');
  const t = T();
  activate(t);
  t.assistant(huge, { turn: 1, step: 1 });
  const s = stateOf(t.events);
  assert.equal(roundCount(s), 1, 'the round must still register');
  assert.equal(openQuestions(s).length, 60);
  assert.equal(s.awaitingAnswers, true);
});

await test("FIXED GRILL-14: obeying the correction's own recovery step no longer deadlocks the interview", () => {
  const t = T();
  activate(t);
  t.assistant(ROUND1, { turn: 1, step: 1 });
  t.toolCall('write', {}, { turn: 1, step: 2 }); // violation -> correction: "Re-ask the pending round (restate it, unchanged) and stop."
  const correction = describeViolation(stateOf(t.events));
  precondition(typeof correction === 'string' && /Re-ask the pending round/.test(correction), 'correction text changed');
  t.assistant(ROUND1, { turn: 2, step: 1 }); // the model obeys the plugin's own instruction
  t.user('1 yes', { kind: 'user' }); // the human answers the restatement
  const s = stateOf(t.events);
  assert.equal(openQuestions(s).length, 0, 'one reply drains the restated round too');
  assert.equal(s.awaitingAnswers, false);
  assert.equal(s.frontierEmpty, true, 'following the plugin instruction must not end the interview for good');
  assert.equal(s.mode, 'awaiting-confirmation');
});

// ═════════════════════════ lead-directed attacks (v3 hardening) ═════════════════════════
// Attack the three areas the v3 fix rewrote (activation, round shape, directive/status
// agreement) with the shapes a real adversarial session produces.
header('lead-directed attacks (v3)');

await test('a bare "grill-me" mention never arms the session', () => {
  const t = T();
  t.user('the docs mention grill-me in passing', { kind: 'user' });
  t.user('yes, grill-me is a plugin name in this repo', { kind: 'user' });
  t.assistant('I read the grill-me plugin source, nothing to do here.', { turn: 1, step: 1 });
  const s = stateOf(t.events);
  assert.equal(s.active, false, 'a mention is not a gesture');
  assert.equal(roundCount(s), 0);
});

await test('a relayed / quoted directive does not arm, and a later real gesture still does', () => {
  const relayed = 'Team message from lead:\n\n[[grill-me]]\n\nGrilling is ACTIVE — 0 round(s) so far, no round is open.\n\nThis step: work the design tree in rounds.';
  const t = T();
  t.user(relayed, { kind: 'user' });
  assert.equal(stateOf(t.events).active, false, 'replaying the directive text must not arm the session');
  t.assistant(relayed, { turn: 1, step: 1 });
  assert.equal(roundCount(stateOf(t.events)), 0, 'the directive replayed by the model is not a round');
  t.user('/grill-me', { kind: 'user' });
  assert.equal(stateOf(t.events).active, true, 'a real gesture after the relay still arms');
});

await test('host runtime-context text mentioning the gesture does not arm (tagged or untagged)', () => {
  const tagged = T();
  tagged.injected('Current runtime context. The user typed /grill-me earlier in another session.', 'runtime-context');
  assert.equal(stateOf(tagged.events).active, false, 'a tagged runtime-context snapshot must not arm');
  const untagged = T();
  untagged.push('user/message', {
    id: 'rc1',
    role: 'user',
    content: [{ type: 'text', text: 'Current runtime context. Plan mode is off; /grill-me was mentioned.' }],
    source: undefined,
  });
  assert.equal(stateOf(untagged.events).active, false, 'an untagged runtime-context snapshot must not arm either');
});

await test('a markdown quiz is not a protocol round', () => {
  const t = T();
  activate(t);
  t.assistant('# Quiz\n\nQ1: What is a monad?\nQ2: What is a functor?\nQ3: Explain currying.', { turn: 1, step: 1 });
  const s = stateOf(t.events);
  assert.equal(roundCount(s), 0, 'plain "Qn: …" lines are not a round');
  assert.equal(s.awaitingAnswers, false);
});

await test('a report restating the questions in prose is not a new round', () => {
  const t = T();
  activate(t);
  t.assistant(ROUND1, { turn: 1, step: 1 });
  t.user('1 yes', { kind: 'user' });
  const before = roundCount(stateOf(t.events));
  t.assistant('Summary: Q1 was answered yes. Q2: TTL is one hour. Nothing left to decide.', { turn: 2, step: 1 });
  const s = stateOf(t.events);
  assert.equal(roundCount(s), before, 'restating answers must not open a new round');
  assert.equal(s.awaitingAnswers, false);
  assert.equal(s.frontierEmpty, true);
});

await test('a valid Chinese round still registers (❓ form and header form)', () => {
  const headerForm = '**Q1** - **缓存**: 用哪个存储？\n➡️ 推荐答案: Redis\n**Q2** - **过期**: 多久？\n➡️ 推荐答案: 一小时';
  assert.equal(parseQuestions(headerForm).length, 2, 'a Chinese header-form round must register');
  const t = T();
  activate(t);
  t.assistant(ROUND_ZH, { turn: 1, step: 1 });
  const s = stateOf(t.events);
  assert.equal(roundCount(s), 1, 'the Chinese fixture round must register');
  assert.equal(s.openQuestions.length > 0, true);
  assert.equal(s.awaitingAnswers, true);
});

await test('a 13-question round still registers as one open round', () => {
  assert.equal(parseQuestions(ROUND13).length, 13);
  const t = T();
  activate(t);
  t.assistant(ROUND13, { turn: 1, step: 1 });
  const s = stateOf(t.events);
  assert.equal(roundCount(s), 1);
  assert.equal(openQuestions(s).length, 13);
  assert.equal(s.awaitingAnswers, true);
});

await test('the directive and grill_status never disagree across a whole interview', () => {
  const t = T();
  const snap = (label) => {
    const s = stateOf(t.events);
    assert.equal(s.awaitingAnswers, s.openQuestions.length > 0, `${label}: awaitingAnswers vs openQuestions`);
    assert.equal(s.frontierEmpty, !s.awaitingAnswers && s.completeRounds > 0 && s.openQuestions.length === 0, `${label}: frontierEmpty derivation`);
    const status = renderStatus(s);
    if (!s.active) {
      assert.equal(renderDirective(s), null, `${label}: an inactive session must get no directive`);
      assert.match(status, /not active/, `${label}: grill_status must say the session is not active`);
      return s;
    }
    assert.match(status, new RegExp(`awaitingAnswers=${s.awaitingAnswers}`), `${label}: status flag`);
    if (s.awaitingAnswers) {
      assert.match(renderDirective(s) ?? '', /round \d+ of \d+ is open and the user has not answered/, `${label}: directive understates the open round`);
      assert.match(status, /open=[1-9]/, `${label}: status claims no open questions while answers are pending`);
    } else {
      assert.doesNotMatch(renderDirective(s) ?? '', /has not answered yet/, `${label}: directive claims pending answers while status has none`);
      assert.match(status, /open=0/);
    }
    return s;
  };
  snap('inactive');
  t.user('/grill-me', { kind: 'user' });
  snap('armed, no round yet');
  t.assistant(ROUND3, { turn: 1, step: 1 });
  snap('round 1 open');
  t.user('1 a 2 b 3 c', { kind: 'user' });
  snap('round drained');
  t.assistant('We have a shared understanding.', { turn: 2, step: 1 });
  snap('understanding claimed');
  t.user('all confirmed, proceed', { kind: 'user' });
  snap('confirmed');
});

// ═════════════════════════ pinned defects (state.js v3) ═════════════════════════
// A pin asserts the CURRENT (wrong) behaviour: green = still broken and listed at
// the end of the run, red = the behaviour changed and the pin must be promoted.
// Each one carries its own mechanism and suggested fix inline.
header('pinned defects');

await test('FIXED GRILL-13: a title containing an inner bold run keeps the inner run', () => {
  const questions = parseQuestions('❓ **Q1** - **Use **Redis**?**: do we?\n➡️ Recommended: yes');
  assert.equal(questions.length, 1);
  assert.equal(questions[0].title, 'Use **Redis**?');
  assert.equal(
    questions[0].body.startsWith('do we?'),
    true,
    `body was ${JSON.stringify(questions[0].body)}`,
  );
  // The fallback reading still applies where no `**` is followed by a separator.
  const plain = parseQuestions('❓ **Q1** - **Cache** which store?\n➡️ Recommended: redis');
  assert.equal(plain[0].title, 'Cache');
  assert.equal(plain[0].body.startsWith('which store?'), true, `body was ${JSON.stringify(plain[0].body)}`);
});

await defect('GRILL-15', 'an untagged injected user-role message is treated as the human (it settles and can confirm)', () => {
  // HOST_CONTEXT_RE only recognises the host's own snapshot prefixes. Any other
  // injected user-role message with no source.kind falls back to "human-authored":
  // a teammate relay / deferred context can therefore answer a round and confirm it.
  const t = T();
  activate(t);
  t.assistant(ROUND1, { turn: 1, step: 1 });
  t.assistant('We have a shared understanding.', { turn: 2, step: 1 });
  t.push('user/message', {
    id: 'u99',
    role: 'user',
    content: [{ type: 'text', text: 'and btw: no more questions from my side' }],
    source: undefined,
  });
  const s = stateOf(t.events);
  // CORRECT: once any user message in the transcript carries a source, require
  // source.kind === 'user' for authoredness (keep the lenient rule only for
  // transcripts that carry no sources at all, e.g. hand-written fixtures).
  assert.equal(s.awaitingAnswers, false, 'the untagged message settled the round');
  assert.equal(s.confirmedUnderstanding, true, 'and it confirmed the design on the user behalf');
});

await defect('GRILL-16', 'a round in the plain "Q1: …" + ➡️ shape is ignored entirely', () => {
  // The v3 shape gate (HEADER_MARK_RE / ❓) is stricter than the rule documented on
  // parseQuestions ("a marker plus a recommendation or several questions"), so a model
  // that drops the ❓/bold header runs an un-governed interview: no round, no waiting
  // state, no correction.
  const text = 'Q1: Which scope?\n➡️ Recommended: the CLI\nQ2: Which store?\n➡️ Recommended: redis';
  assert.equal(parseQuestions(text).length, 0, 'plain Qn: + recommendation is not recognised');
  const t = T();
  activate(t);
  t.assistant(text, { turn: 1, step: 1 });
  const s = stateOf(t.events);
  assert.equal(roundCount(s), 0, 'the interview is invisible to the protocol');
  assert.equal(s.awaitingAnswers, false);
  assert.equal(describeViolation(s), null);
});

header('v4: activation matrix, reasoning blocks and the echo rule');

await test('activation: quoting the trigger list mid-sentence does not arm the interview', () => {
  // GRILL-18, promoted: the prose triggers are words, so a long lead-in makes them a
  // mention. The trigger only counts when it opens the message or its own line.
  const quotedList = T();
  quotedList.user('the Chinese prose triggers (拷问/盘问/质询/逼问/压力测试/grill 我) must be in a human message', { kind: 'user' });
  assert.equal(stateOf(quotedList.events).active, false, 'quoting the trigger list must not arm the interview');
  const buried = T();
  buried.user('I read that the word 拷问 used to make the plugin start an interview.', { kind: 'user' });
  assert.equal(stateOf(buried.events).active, false, 'a mid-sentence mention is not a gesture');
  const relayed = T();
  relayed.user('Lead says the plugin is armed by [[grill-me]] now', { kind: 'user' });
  assert.equal(stateOf(relayed.events).active, false, 'naming the marker is not a gesture');
});

await test('activation: the slash command counts anywhere in the user\'s own speech', () => {
  const midSentence = T();
  midSentence.user('docs are clear, /grill-me now', { kind: 'user' });
  assert.equal(stateOf(midSentence.events).active, true);
  const bare = T();
  bare.user('/grill-me', { kind: 'user' });
  assert.equal(stateOf(bare.events).active, true);
  const invite = T();
  invite.user('帮我盘问一下这个方案', { kind: 'user' });
  assert.equal(stateOf(invite.events).active, true, 'a short Chinese lead-in is an invitation');
});

await test('activation: a host snapshot that mentions the command never arms the session', () => {
  const tagged = T();
  tagged.injected('Current runtime context. The user asked for /grill-me earlier in this session.', 'runtime-context');
  assert.equal(stateOf(tagged.events).active, false, 'the host is not the human');
  const catalog = T();
  catalog.injected('Available skills: grilling — interview the user in rounds about /grill-me.', 'skill-catalog');
  assert.equal(stateOf(catalog.events).active, false, 'a catalog is not a gesture');
});

await test('rounds: a round quoted inside a reasoning block is not speech', () => {
  const t = T();
  activate(t, 'grilling');
  t.push('assistant/message', {
    turn: 1,
    step: 1,
    message: {
      id: 'a-reasoning',
      role: 'assistant',
      content: [
        { type: 'reasoning', text: ROUND3 },
        { type: 'text', text: 'Let me draft the questions before asking them.' },
      ],
      source: { kind: 'model' },
    },
    stream: [],
  });
  const s = stateOf(t.events);
  assert.equal(roundCount(s), 0, 'reasoning is not speech (live phantom-round fix)');
  assert.equal(openQuestions(s).length, 0);
  assert.equal(s.awaitingAnswers, false);
});

await test('rounds: restating the open round does not open a second one', () => {
  const t = T();
  activate(t, 'grilling');
  t.assistant(ROUND3, { turn: 1, step: 1 });
  t.assistant(ROUND3, { turn: 1, step: 2 });
  const s = stateOf(t.events);
  assert.equal(roundCount(s), 1, 'the directive itself invites a restatement; it must not buy another round');
  assert.equal(openQuestions(s).length, 3);
});

await test('rounds: re-asking the same questions after the user answered opens a new round', () => {
  const t = T();
  activate(t, 'grilling');
  t.assistant(ROUND3, { turn: 1, step: 1 });
  t.user('1 CLI only 2 JSON 3 no auth', { kind: 'user' });
  t.assistant(ROUND3, { turn: 1, step: 3 });
  const s = stateOf(t.events);
  assert.equal(roundCount(s), 2, 'a deliberate re-ask must open a new round');
  assert.equal(s.awaitingAnswers, true);
});

await test('rounds: a question repeated inside one round collapses by identity', () => {
  const t = T();
  activate(t, 'grilling');
  const dup = [q(1, 'Scope', 'Only the CLI?', 'CLI only'), q(1, 'Scope', 'Only the CLI?', 'CLI only'), q(2, 'Auth', 'Needed?', 'No')].join('\n\n');
  t.assistant(dup, { turn: 1, step: 1 });
  const s = stateOf(t.events);
  assert.equal(roundCount(s), 1);
  assert.equal(openQuestions(s).length, 2, 'the repeated question must collapse');
});

await test('analyze: an internal failure is surfaced instead of looking inactive', () => {
  // GRILL-17, hardening half: projectEvents() now runs inside analyze's try and the catch
  // reports internalError, so a broken analysis can no longer masquerade as "not armed".
  // The machine has to be ACTIVE for a hostile fact to be inspected at all (an inactive
  // transcript returns before the main pass), so the fixture arms it first.
  const activation = {
    kind: 'user', type: 'user/message', seq: 1, text: '/grill-me', activation: true, plugin: false, source: { kind: 'user' },
  };
  const control = stateOf([
    activation,
    { kind: 'assistant', type: 'assistant/message', seq: 2, confirms: false, announcesDone: false, installs: [], toolNames: [], questions: [] },
  ], 'healthy normalized facts');
  assert.equal(control.active, true, 'the control transcript must be active');
  assert.equal(control.internalError, undefined, 'a healthy analysis must not report an internal error');
  const hostile = [
    activation,
    {
      kind: 'assistant',
      type: 'assistant/message',
      seq: 2,
      confirms: false,
      announcesDone: false,
      installs: [],
      toolNames: [],
      get questions() { throw new Error('hostile fact'); },
    },
  ];
  const s = stateOf(hostile, 'hostile normalized fact');
  assert.equal(s.active, false, 'a failed analysis is not an armed interview');
  assert.ok(typeof s.internalError === 'string' && s.internalError.length > 0, 'a crash must be reported through internalError');
  assert.match(String(renderStatus(s)), /FAILED/, 'grill_status must tell the user the analysis failed');
});

await defect('GRILL-17', 'a non-string source.kind silently disarms a real gesture (accepted limitation)', () => {
  // The Lead accepts this half as a documented limitation: a message whose source.kind is
  // present but not the string 'user' is never treated as human-authored, even when it is.
  const t = T();
  t.user('/grill-me', { kind: { kind: 'user' } });
  assert.equal(stateOf(t.events).active, false, 'a non-string source.kind is treated as not human');
});

await defect('GRILL-29', 'a single-line numbered reply that does not start at 1 is read as one item', () => {
  // Found while writing the GRILL-28 tests. `collectAnswerItems` only accepts a bare label at
  // a list position (start / after a newline / after `,.;!?`), and `sequentialAnswerRun` only
  // adopts a strictly ascending run that starts at 1 — deliberately, so prose numbers never
  // become answers. The cost: replying "2 用 JSON 3 确认。" on ONE line (continuing a round
  // after Q1 was already answered) yields a single item for Q2 whose text swallows Q3, and the
  // newline-separated form of the same reply is needed instead. Widening the boundary rule was
  // judged riskier than the gap; the pinned assertion documents today's behaviour.
  const t = T();
  activate(t);
  t.assistant(ROUND3, { turn: 1, step: 1 });
  t.user('1 yes', { kind: 'user' });
  t.user('2 用 JSON 3 确认。', { kind: 'user' });
  const s = stateOf(t.events);
  assert.equal(openQuestions(s).length, 1, 'Q3 is left open although the user numbered it');
  assert.equal(s.awaitingAnswers, true);
  // the same reply, one label per line, drains the round
  const lined = T();
  activate(lined);
  lined.assistant(ROUND3, { turn: 1, step: 1 });
  lined.user('1 yes', { kind: 'user' });
  lined.user('2 用 JSON\n3 确认。', { kind: 'user' });
  const linedState = stateOf(lined.events);
  assert.equal(openQuestions(linedState).length, 0, 'the newline-separated form is understood');
  assert.equal(linedState.frontierEmpty, true);
});

await test('activation: an inline-code or blockquoted command never arms the interview', () => {
  // GRILL-18, promoted on sha 2C408C0BD6BB2084: `strippedOf` (src/state.js:433-442) now calls
  // stripQuotedBlocks unconditionally, so inline-code spans and blockquote lines are removed
  // before the trigger scan. A teammate relaying "`/grill-me`" is noise again.
  const inlineCode = T();
  inlineCode.user('Activation now needs an explicit gesture: `/grill-me`, `/grilling`, or the Chinese prose triggers.', { kind: 'user' });
  assert.equal(stateOf(inlineCode.events).active, false, 'an inline-code quote of the command must not arm the interview');
  const blockquote = T();
  blockquote.user('> /grill-me\n> Grilling is ACTIVE — round 1 is open', { kind: 'user' });
  assert.equal(stateOf(blockquote.events).active, false, 'a blockquoted directive must not arm the interview');
  // Controls: the same words as plain speech are still the human's own gesture.
  const plain = T();
  plain.user('/grill-me', { kind: 'user' });
  assert.equal(stateOf(plain.events).active, true, 'the plain command must still arm');
  const mixed = T();
  mixed.user('whatever, /grill-me this design', { kind: 'user' });
  assert.equal(stateOf(mixed.events).active, true, 'stripping quotes must not disarm plain speech');
});

await test('activation: the English invitation arms, and talking about grilling does not', () => {
  // GRILL-21, promoted on sha 2C408C0BD6BB2084: GESTURE_TRIGGER_RE (src/state.js:68) now
  // carries `grill\s+(?:me|us)\b`, still bounded by the 8-char lead-in (GESTURE_LEAD_MAX,
  // src/state.js:72). Talking ABOUT grilling must stay inert.
  const invite = T();
  invite.user('please grill me about this plan', { kind: 'user' });
  assert.equal(stateOf(invite.events).active, true, 'the English prose invitation must arm');
  const plural = T();
  plural.user('grill us on the storage design', { kind: 'user' });
  assert.equal(stateOf(plural.events).active, true, 'the plural invitation must arm');
  const chatter = T();
  chatter.user('I read a blog post about grilling people', { kind: 'user' });
  assert.equal(stateOf(chatter.events).active, false, 'talking about grilling must not arm');
  const buried = T();
  buried.user('the regex will grill me later if the input is malformed', { kind: 'user' });
  assert.equal(stateOf(buried.events).active, false, 'a long lead-in still makes it a mention, not an invitation');
});

// ═══════════════════════ phase 2: glue contracts (lib/index.js) ═══════════════════════
// The glue is checked against the contracts the SHIPPED host actually provides
// (ToolRuntime.register / SkillRegistry.register / CommandRegistry.register / ctx.on /
// ctx.effect / agent.session.snapshotEvents / agent.steer), through a fake host that is
// deliberately no more capable than the real one. Nothing here imports the glue's
// internals: every claim is observed at the boundary the host sees.

const GLUE_PATH = path.join(ROOT, 'lib', 'index.js');

/** Messages the plugin owns, judged by the host-visible marker only. */
function pluginOwned(messages) {
  return (Array.isArray(messages) ? messages : []).filter((m) => m && m.source && m.source.kind === 'grill-me');
}

function fakeHost() {
  const listeners = new Map();
  const registered = { skills: [], tools: [], commands: [], effectDisposers: [], disposers: 0, effects: 0 };
  const ctx = {
    skills: {
      register(definition) {
        registered.skills.push(definition);
        return () => { registered.disposers += 1; };
      },
    },
    tools: {
      register(definition) {
        registered.tools.push(definition);
        return () => { registered.disposers += 1; };
      },
    },
    commands: {
      register(definition) {
        registered.commands.push(definition);
        return () => { registered.disposers += 1; };
      },
    },
    on(name, handler) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(handler);
      return () => {
        const list = listeners.get(name) ?? [];
        const at = list.indexOf(handler);
        if (at >= 0) list.splice(at, 1);
        registered.disposers += 1;
      };
    },
    effect(run) {
      registered.effects += 1;
      const disposer = run();
      registered.effectDisposers.push(() => { if (typeof disposer === 'function') disposer(); });
      return () => { registered.disposers += 1; };
    },
  };
  const host = { ctx, listeners, registered, events: [], steers: [] };
  host.agent = (over = {}) => ({
    id: 'agent-1',
    session: { snapshotEvents: () => host.events },
    steer(message) { host.steers.push(message); },
    ...over,
  });
  host.handlers = (name) => listeners.get(name) ?? [];
  host.preStep = async (decision, agent) => {
    const handler = host.handlers('agent/pre-step')[0];
    if (!handler) throw new Error('the glue registered no agent/pre-step listener');
    return handler({ agent: agent === undefined ? host.agent() : agent }, async () => decision);
  };
  host.turnStoppingWith = async (payload) => {
    const handler = host.handlers('agent/turn-stopping')[0];
    if (!handler) throw new Error('the glue registered no agent/turn-stopping listener');
    return handler(payload);
  };
  host.turnStopping = async (agent, turn = 1) =>
    host.turnStoppingWith({ agent: agent === undefined ? host.agent() : agent, turn });
  return host;
}

function userMessage(text, id) {
  return { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } };
}

/** Active transcript with a round open AND a mutating action after it (a violation). */
function violatedTranscript() {
  const t = T();
  activate(t, 'grilling');
  t.turnStart(1);
  t.assistant(ROUND3, { turn: 1, step: 1 });
  t.assistant(null, { turn: 1, step: 2, toolCalls: [{ name: 'write', arguments: { path: 'x' } }] });
  t.toolCall('write', { path: 'x' }, { turn: 1, step: 2 });
  t.toolResult('wrote x', { turn: 1, step: 2, name: 'write' });
  return t;
}

if (!existsSync(GLUE_PATH)) {
  console.log('\n── phase 2: glue SKIPPED (lib/index.js is not present) ──');
} else {
  const GLUE = await import(pathToFileURL(GLUE_PATH).href);

  header('phase 2: glue registration (lib/index.js)');

  await test('glue: exports the plugin shape and registers four skills, one tool and two commands', async () => {
    assert.equal(GLUE.name, 'grill-me', 'the plugin must keep its stable name');
    assert.ok(Array.isArray(GLUE.inject), 'inject must be an array of service ids');
    for (const service of ['skills', 'tools', 'commands']) {
      assert.ok(GLUE.inject.includes(service), `inject must require the ${service} service`);
    }
    assert.equal(typeof GLUE.apply, 'function');
    const host = fakeHost();
    const out = GLUE.apply(host.ctx, undefined);
    const disposers = Array.isArray(out) ? out : [out];
    assert.ok(disposers.some((d) => typeof d === 'function'), 'apply must hand back disposers');

    const skills = host.registered.skills;
    assert.equal(skills.length, 4, 'the plugin registers exactly four skills');
    assert.deepEqual(skills.map((s) => s.name).sort(), [
      'domain-modeling',
      'grill-me',
      'grill-with-docs',
      'grilling',
    ]);
    const userOnly = skills.filter((s) => s.invocation && s.invocation.modelInvocable === false);
    const modelFacing = skills.filter((s) => s.invocation && s.invocation.modelInvocable === true);
    assert.equal(userOnly.length, 2, 'both wrappers must be user-invocable only (they spawn the interview)');
    assert.deepEqual(userOnly.map((s) => s.name).sort(), ['grill-me', 'grill-with-docs']);
    assert.equal(modelFacing.length, 2, 'both primitives must stay model-invocable');
    assert.deepEqual(modelFacing.map((s) => s.name).sort(), ['domain-modeling', 'grilling']);
    for (const skill of skills) {
      assert.equal(skill.invocation.userInvocable, true);
      assert.ok(typeof skill.description === 'string' && skill.description.trim().length > 0, `${skill.name} needs a description`);
      assert.equal(typeof skill.provider, 'string');
    }

    assert.equal(host.registered.tools.length, 1, 'the plugin registers exactly one tool');
    const tool = host.registered.tools[0];
    assert.equal(tool.name, 'grill_status');
    assert.equal(typeof tool.execute, 'function');
    assert.equal(typeof tool.output?.render, 'function', 'output.render is required by ToolRuntime.register');
    assert.equal(tool.output?.schema?.type, 'string');
    assert.equal(tool.parameters?.type, 'object', 'register() stores parameters as JSON Schema, not as a property map');

    assert.equal(host.registered.commands.length, 2, 'the plugin registers exactly two commands');
    assert.deepEqual(host.registered.commands.map((c) => c.name).sort(), ['grill-me', 'grill-with-docs']);
    for (const command of host.registered.commands) {
      assert.equal(typeof command.handler, 'function');
      assert.ok(typeof command.input?.hint === 'string' && command.input.hint.trim().length > 0, 'a command needs a non-empty hint');
    }
  });

  await test('glue: grill_status renders the state and never throws without a session', async () => {
    const host = fakeHost();
    GLUE.apply(host.ctx, undefined);
    const tool = host.registered.tools[0];
    host.events = violatedTranscript().events;
    const active = await tool.execute({}, { agent: host.agent() });
    assert.equal(typeof active, 'string', 'the tool must always answer with text');
    assert.match(active, /mode=/, 'an active session must render the status summary');
    const rendered = tool.output.render({}, active);
    assert.ok(Array.isArray(rendered) && rendered[0]?.type === 'text', 'render must emit a text part');
    assert.ok(String(rendered[0].text).includes(active), 'render must not lose the status text');
    const hostile = [
      undefined,
      {},
      { id: 'a' },
      { id: 'a', session: {} },
      { id: 'a', session: { snapshotEvents: () => null } },
      { id: 'a', session: { snapshotEvents: () => { throw new Error('boom'); } } },
    ];
    for (const agent of hostile) {
      const text = await tool.execute({}, { agent });
      assert.equal(typeof text, 'string', 'a degraded session must still produce text, not a throw');
    }
  });

  await test('glue: the /grill-me command reports success even with a bare invocation', async () => {
    const host = fakeHost();
    GLUE.apply(host.ctx, undefined);
    const command = host.registered.commands[0];
    const armed = await command.handler({ agent: host.agent() });
    assert.equal(armed.kind, 'success');
    assert.ok(typeof armed.text === 'string' && armed.text.length > 0, 'the command must tell the user what is armed');
    const bare = await command.handler({});
    assert.equal(bare.kind, 'success', 'a bare invocation must not turn into an error result');
    assert.ok(typeof bare.text === 'string' && bare.text.length > 0);
  });

  header('phase 2: pre-step injection (lib/index.js)');

  await test('glue: an inactive session leaves the decision untouched', async () => {
    const host = fakeHost();
    GLUE.apply(host.ctx, undefined);
    host.events = T().events;
    const first = userMessage('hello', 'm1');
    const out = await host.preStep({ kind: 'enter', messages: [first] });
    assert.equal(out.messages.length, 1, 'no message may be appended to an inactive step');
    assert.equal(out.messages[0], first, 'the claimed batch must be returned as-is');
    assert.equal(pluginOwned(out.messages).length, 0);
  });

  await test('glue: the directive is one frozen host-shaped message that matches the state machine', async () => {
    const host = fakeHost();
    GLUE.apply(host.ctx, undefined);
    const t = violatedTranscript();
    host.events = t.events;
    const out = await host.preStep({ kind: 'enter', messages: [userMessage('hello', 'm1')] });
    assert.notEqual(out.kind, 'reject', 'the glue must never turn a live turn into a rejection');
    const owned = pluginOwned(out.messages);
    assert.equal(owned.length, 1, 'exactly one plugin-owned message per step');
    const directive = owned[0];
    assert.equal(directive.role, 'user');
    assert.equal(directive.source.kind, 'grill-me');
    assert.equal(directive.source.form, 'directive');
    assert.equal(typeof directive.id, 'string', 'injected messages need a host-style id');
    assert.equal(directive.content[0].type, 'text');
    assert.ok(directive.content[0].text.includes('[[grill-me]]'), 'the directive must carry its own marker');
    assert.equal(directive.content[0].text, renderDirective(stateOf(t.events)), 'the directive must be the state machine\'s own text');
    assert.ok(Object.isFrozen(directive), 'an injected message must be frozen like a host message');
    assert.equal(out.messages.length, 2, 'the human message must survive');
    assert.equal(out.messages[0].id, 'm1', 'the human message keeps its place');
  });

  await test('glue: a rejected pre-step decision is passed through, not reinforced', async () => {
    const host = fakeHost();
    GLUE.apply(host.ctx, undefined);
    host.events = violatedTranscript().events;
    const out = await host.preStep({ kind: 'reject', messages: [userMessage('hello', 'm1')] });
    assert.equal(out.kind, 'reject', 'the glue must not resurrect a rejected turn');
    assert.equal(out.messages.length, 1);
    assert.equal(pluginOwned(out.messages).length, 0, 'a rejected turn must not receive a directive');
  });

  await test('glue: a stale directive is refreshed in place, keeping the batch order', async () => {
    const host = fakeHost();
    GLUE.apply(host.ctx, undefined);
    const t = violatedTranscript();
    host.events = t.events;
    const a = userMessage('first', 'm1');
    const stale = makeUserMessage('[[grill-me]]\nstale directive', { kind: 'grill-me', form: 'directive' });
    const b = userMessage('second', 'm3');
    const out = await host.preStep({ kind: 'enter', messages: [a, stale, b] });
    assert.equal(out.messages.length, 3, 'replacement must not append a fourth message');
    assert.equal(out.messages[0], a);
    assert.equal(out.messages[2], b);
    assert.equal(pluginOwned(out.messages).length, 1);
    assert.equal(out.messages[1].content[0].text, renderDirective(stateOf(t.events)), 'the stale directive must be refreshed');
  });

  await test('FIXED GRILL-19: a second plugin-owned directive in the batch does not survive the rewrite', async () => {
    // The rewrite puts the fresh directive in the first directive slot and drops every
    // later directive, so exactly one ever reaches the model.
    const host = fakeHost();
    GLUE.apply(host.ctx, undefined);
    host.events = violatedTranscript().events;
    const staleDirective = makeUserMessage('[[grill-me]]\nstale directive', { kind: 'grill-me', form: 'directive' });
    const secondDirective = makeUserMessage('[[grill-me]]\nsecond directive', { kind: 'grill-me', form: 'directive' });
    const out = await host.preStep({ kind: 'enter', messages: [staleDirective, secondDirective] });
    assert.equal(pluginOwned(out.messages).length, 1, 'exactly one plugin-owned message may reach the model');
    assert.equal(
      textOfMessage(out.messages[0]),
      renderDirective(stateOf(host.events)),
      'and it is the fresh directive, not the stale one',
    );
  });

  await test('FIXED GRILL-27: a steered correction survives the rewrite instead of being absorbed', async () => {
    // Live, the gate steered its correction onto the next step and this rewrite
    // replaced it with a fresh directive, so the model never read the rule it had
    // just broken and no `form=correction` message ever reached the transcript.
    const host = fakeHost();
    GLUE.apply(host.ctx, undefined);
    host.events = violatedTranscript().events;
    await host.turnStopping(host.agent(), 1);
    assert.equal(host.steers.length, 1, 'the violation is corrected once');
    const correction = host.steers[0];
    assert.equal(correction.source.form, 'correction');

    // The host claims exactly that steered message as the input of the next step.
    const out = await host.preStep({ kind: 'enter', messages: [correction] });
    assert.ok(out.messages.includes(correction), 'the model must receive the correction itself');
    assert.equal(textOfMessage(correction).includes('Protocol violation'), true);
    const directives = out.messages.filter((m) => m.source?.kind === 'grill-me' && m.source?.form === 'directive');
    assert.equal(directives.length, 1, 'and still exactly one directive');
    assert.equal(textOfMessage(directives[0]), renderDirective(stateOf(host.events)));
  });

  await test('FIXED GRILL-20: an id-less plugin message cannot swallow an unrelated id-less message', async () => {
    // Matching is by `source.kind`, never by `message.id`, so a claimed message that merely
    // lacks an id is kept and the plugin message is still replaced exactly once.
    const host = fakeHost();
    GLUE.apply(host.ctx, undefined);
    host.events = violatedTranscript().events;
    const unrelated = { role: 'user', content: [{ type: 'text', text: 'unrelated host message' }], source: { kind: 'runtime-context' } };
    const idlessPlugin = { role: 'user', content: [{ type: 'text', text: '[[grill-me]]\nstale' }], source: { kind: 'grill-me', form: 'directive' } };
    const out = await host.preStep({ kind: 'enter', messages: [unrelated, idlessPlugin] });
    assert.ok(
      out.messages.some((m) => textOfMessage(m).includes('unrelated host message')),
      'the unrelated claimed message must stay in the turn',
    );
    assert.equal(pluginOwned(out.messages).length, 1, 'and exactly one plugin-owned message remains');
    assert.equal(out.messages[0], unrelated, 'the unrelated message keeps its slot');
  });

  header('phase 2: turn-stopping steering (lib/index.js)');

  await test('glue: turn-stopping is inert without an agent, without steer, or without a violation', async () => {
    const host = fakeHost();
    GLUE.apply(host.ctx, undefined);
    host.events = violatedTranscript().events;
    await host.turnStoppingWith({ turn: 1 });
    await host.turnStoppingWith({ agent: { id: 'a', session: { snapshotEvents: () => host.events } }, turn: 1 });
    assert.equal(host.steers.length, 0, 'no capability must mean no steering, not a throw');
    const clean = T();
    activate(clean, 'grilling');
    clean.assistant(ROUND3, { turn: 1, step: 1 });
    host.events = clean.events;
    await host.turnStopping(host.agent(), 1);
    assert.equal(host.steers.length, 0, 'a clean open round must not be corrected');
    host.events = T().events;
    await host.turnStopping(host.agent(), 1);
    assert.equal(host.steers.length, 0, 'an inactive session must not be corrected');
  });

  await test('glue: an action after an open round steers one frozen correction per violation (GRILL-23)', async () => {
    const host = fakeHost();
    GLUE.apply(host.ctx, undefined);
    const t = violatedTranscript();
    host.events = t.events;
    const agent = host.agent();
    for (let i = 0; i < 6; i += 1) {
      await host.turnStopping(agent, 1);
      if (host.steers.length > i) {
        // Exactly what the host does with a steered message: it lands in the next step.
        t.push('user/message', host.steers[host.steers.length - 1]);
      }
      t.assistant(null, { turn: 1, step: 10 + i });
    }
    // GRILL-23: the budget belongs to the *violation*. Budgeting it per
    // `(agent, turn)` let every steer — which starts a new turn — buy the next
    // one, so a single recorded act re-corrected itself forever.
    assert.equal(host.steers.length, 1, 'one violation is corrected exactly once');
    const first = host.steers[0];
    assert.equal(first.role, 'user');
    assert.equal(first.source.kind, 'grill-me');
    assert.equal(first.source.form, 'correction', 'the correction must be told apart from a directive');
    assert.ok(first.content[0].text.length > 0);
    assert.ok(Object.isFrozen(first));
    await host.turnStopping(agent, 2);
    assert.equal(host.steers.length, 1, 'a new turn must not re-correct the same violation');
    await host.turnStopping(agent, 9);
    assert.equal(host.steers.length, 1, 'and neither may any later step of it');
  });

  await test('glue: the correction ledger is bounded and evicts the oldest (agent, turn) key', async () => {
    // CORRECTION_TRACK_LIMIT = 128 with a FIFO sweep (lib/index.js:253-264). Documented here:
    // once the ledger is full the OLDEST key is forgotten, so that (agent, turn) can be
    // corrected again. Bounded memory is the intent; the reset only matters in a session
    // that accumulates >128 keys inside one turn, which the host never does.
    const host = fakeHost();
    GLUE.apply(host.ctx, undefined);
    host.events = violatedTranscript().events;
    // Ids must not collide with the keys other tests already inserted: the ledger lives with
    // the plugin instance (per-instance since the GRILL-22 fix, so each fakeHost starts empty).
    for (let i = 0; i < 129; i += 1) await host.turnStopping(host.agent({ id: `ledger-${i}` }), 1);
    assert.equal(host.steers.length, 129, 'every fresh (agent, turn) gets exactly one correction');
    await host.turnStopping(host.agent({ id: 'ledger-0' }), 1);
    assert.equal(host.steers.length, 130, 'the oldest key is evicted, so its budget resets');
  });

  await test('FIXED GRILL-22: a fresh plugin instance starts with a full correction budget', async () => {
    // The ledger is per plugin instance now, so a reloaded/re-enabled plugin — or any later
    // instance in the same process — does not inherit a spent budget from an earlier one.
    const first = fakeHost();
    const firstDisposers = GLUE.apply(first.ctx, undefined);
    first.events = violatedTranscript().events;
    for (let i = 0; i < 4; i += 1) await first.turnStopping(first.agent({ id: 'reused-agent' }), 1);
    assert.equal(first.steers.length, 1, 'the first instance spends its only correction on the violation');
    const disposers = (Array.isArray(firstDisposers) ? firstDisposers : [firstDisposers]).filter((d) => typeof d === 'function');
    for (const dispose of disposers) await dispose();
    const second = fakeHost();
    GLUE.apply(second.ctx, undefined);
    second.events = violatedTranscript().events;
    await second.turnStopping(second.agent({ id: 'reused-agent' }), 1);
    assert.equal(second.steers.length, 1, 'the fresh instance gets its own budget');
  });

  await test('glue: grill_status survives hostile agents instead of throwing into the turn', async () => {
    const host = fakeHost();
    GLUE.apply(host.ctx, undefined);
    const tool = host.registered.tools[0];
    assert.ok(tool && typeof tool.execute === 'function', 'the registered tool must expose execute');
    const hostile = [
      undefined,
      null,
      {},
      { session: {} },
      { session: { snapshotEvents: () => 'not an array' } },
      { session: { snapshotEvents: () => [null, 42, 'junk'] } },
      { session: { snapshotEvents() { throw new Error('boom'); } } },
      { get session() { throw new Error('hostile session getter'); } },
    ];
    for (let i = 0; i < hostile.length; i += 1) {
      const value = await tool.execute({}, { agent: hostile[i] });
      assert.ok(typeof value === 'string' && value.length > 0, `grill_status must answer for hostile agent #${i}`);
    }
  });

  await test('glue: an unanswered correction suppresses a duplicate steer', async () => {
    const host = fakeHost();
    GLUE.apply(host.ctx, undefined);
    const t = violatedTranscript();
    t.push('user/message', makeUserMessage('[[grill-me:correction]]\nstop and re-ask', { kind: 'grill-me', form: 'correction' }));
    host.events = t.events;
    await host.turnStopping(host.agent(), 1);
    assert.equal(host.steers.length, 0, 'the pending correction must not be repeated');
  });

  header('phase 2: cross-module agreement (glue messages vs the state machine)');

  await test('glue: the plugin\'s own traffic never answers, confirms or violates its own round', async () => {
    const t = T();
    activate(t, 'grilling');
    t.assistant(ROUND3, { turn: 1, step: 1 });
    const before = stateOf(t.events);
    assert.equal(before.awaitingAnswers, true, 'precondition: the round is open');
    t.push('user/message', makeUserMessage('[[grill-me]]\nGrilling is ACTIVE', { kind: 'grill-me', form: 'directive' }));
    t.push('user/message', makeUserMessage('[[grill-me:correction]]\nstop', { kind: 'grill-me', form: 'correction' }));
    const after = stateOf(t.events);
    assert.equal(after.awaitingAnswers, true, 'plugin traffic must not settle the round');
    assert.equal(openQuestions(after).length, openQuestions(before).length, 'the question frontier must not move');
    assert.equal(after.confirmedUnderstanding, false, 'plugin traffic must not confirm the design');
    assert.equal(describeViolation(after), null, 'plugin traffic must not create a violation');
  });

  await test('glue: raw and normalized views of a plugin-tainted transcript agree', async () => {
    const t = violatedTranscript();
    t.push('user/message', makeUserMessage('[[grill-me]]\nre-ask', { kind: 'grill-me', form: 'directive' }));
    const raw = stateOf(t.events);
    const normalized = stateOf(projectEvents(t.events), 'normalized transcript');
    assert.equal(raw.active, normalized.active);
    assert.equal(roundCount(raw), roundCount(normalized));
    assert.equal(openQuestions(raw).length, openQuestions(normalized).length);
    assert.equal(String(renderStatus(raw)), String(renderStatus(normalized)));
    assert.equal(String(renderDirective(raw)), String(renderDirective(normalized)));
    assert.equal(String(describeViolation(raw)), String(describeViolation(normalized)));
  });

  if (typeof S.isReadOnlyTool === 'function') {
    await test('glue: grill_status is classified read-only, so a status check is never a violation', () => {
      assert.equal(S.isReadOnlyTool('grill_status'), true);
      assert.equal(S.isReadOnlyTool('write'), false);
    });
  }

  header('phase 2: hygiene and teardown (lib/index.js)');

  await test('glue: the module imports only relative sources and never a host package', () => {
    const source = readFileSync(GLUE_PATH, 'utf8');
    const specifiers = [...source.matchAll(/(?:^|\n)\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    assert.ok(specifiers.length > 0, 'the glue must import the state machine');
    for (const specifier of specifiers) {
      assert.ok(
        specifier.startsWith('./') || specifier.startsWith('../'),
        `the bundle must not depend on host packages, found: ${specifier}`,
      );
    }
    // The docstring deliberately names the host scope to explain why the bundle must not
    // import it, so the scan ignores comment-only lines and then looks at real code.
    const code = source.split('\n').filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line)).join('\n');
    assert.ok(!/@deepseek-ai/.test(code), 'no @deepseek-ai import or reference outside comments');
    assert.ok(!/\brequire\s*\(/.test(code), 'the plugin must stay ESM');
  });

  await test('glue: every listener and registration is torn down by its disposers', async () => {
    const host = fakeHost();
    const out = GLUE.apply(host.ctx, undefined);
    assert.equal(host.handlers('agent/pre-step').length, 1, 'one pre-step listener');
    assert.equal(host.handlers('agent/turn-stopping').length, 1, 'one turn-stopping listener');
    const disposers = (Array.isArray(out) ? out : [out]).filter((d) => typeof d === 'function');
    for (const disposer of disposers) {
      await disposer();
      await disposer();
    }
    for (const disposer of host.registered.effectDisposers) await disposer();
    assert.ok(host.registered.disposers >= 5, `expected every registration to be disposable, saw ${host.registered.disposers}`);
    assert.equal(host.handlers('agent/pre-step').length, 0, 'the pre-step listener must be gone after teardown');
    assert.equal(host.handlers('agent/turn-stopping').length, 0, 'the turn-stopping listener must be gone after teardown');
  });
}

// ═══════════════════════ per-question settlement (v4) ═══════════════════════
// A reply that numbers its answers decides exactly those questions: the frontier is
// per decision, so a round whose Q2 is unanswered stays open and only Q2 is asked
// again. Anything without per-question structure stays a single batch answer.
header('per-question settlement (v4)');

await test('a numbered reply settles only the questions it answers', () => {
  const t = T();
  activate(t);
  t.assistant(ROUND3, { turn: 1, step: 1 });
  t.user('1 yes\n3 no auth at all', { kind: 'user' });
  const s = stateOf(t.events);
  assert.equal(s.awaitingAnswers, true, 'Q2 is undecided, so the round is still open');
  assert.equal(openQuestions(s).length, 1, 'exactly one question is still open');
  assert.equal(openQuestions(s)[0].number, 2);
  const round = s.waitingForAnswers;
  const q1 = round.questions.find((question) => question.number === 1);
  const q2 = round.questions.find((question) => question.number === 2);
  const q3 = round.questions.find((question) => question.number === 3);
  assert.equal(q1.disposition, 'accepted', 'a bare yes accepts the recommendation');
  assert.equal(q1.answered, true);
  assert.equal(q2.disposition, 'open');
  assert.equal(q2.answered, false);
  assert.equal(q3.disposition, 'overridden', 'extra words are the decision, not a yes');
  assert.match(q3.answer, /no auth/);
  assert.deepEqual(s.questionStats, { total: 3, open: 1, accepted: 1, overridden: 1, batch: 0 });
});

await test('an unstructured affirmative reply accepts the whole round', () => {
  const t = T();
  activate(t);
  t.assistant(ROUND3, { turn: 1, step: 1 });
  t.user('都可以', { kind: 'user' });
  const s = stateOf(t.events);
  assert.equal(s.awaitingAnswers, false);
  assert.equal(s.frontierEmpty, true);
  assert.equal(s.questionStats.accepted, 3, 'every question is settled as accepted');
  assert.equal(s.questionStats.batch, 0);
  assert.equal(isAffirmativeAll('都可以'), true);
  assert.equal(isAffirmativeAll('let us keep it small for now'), false);
  assert.equal(isAffirmativeAll('yes to all three'), true, 'a quantifier does not stop an all-accepting reply');
});

await test('an unstructured non-affirmative reply leaves the round open instead of deciding it (GRILL-25)', () => {
  const t = T();
  activate(t);
  t.assistant(ROUND3, { turn: 1, step: 1 });
  t.user('let us keep it small for now and revisit later', { kind: 'user' });
  const s = stateOf(t.events);
  assert.equal(s.awaitingAnswers, true, 'prose that answers nothing specific must not discharge the round');
  assert.equal(openQuestions(s).length, 3);
  assert.equal(s.questionStats.batch, 0, 'nothing may be settled as a batch behind the user back');
});

await test('numbering that does not address the round is never guessed onto it', () => {
  const t = T();
  activate(t);
  t.assistant(ROUND3, { turn: 1, step: 1 });
  t.user('7 yes\n9 no', { kind: 'user' });
  const s = stateOf(t.events);
  assert.equal(s.awaitingAnswers, true, 'numbers that are not this round questions never map onto them');
  assert.equal(openQuestions(s).length, 3);
  assert.equal(s.questionStats.accepted, 0);
});

await test('per-question settlement drains the frontier one decision at a time', () => {
  const t = T();
  activate(t);
  t.assistant(ROUND3, { turn: 1, step: 1 });
  t.user('1 yes', { kind: 'user' });
  let s = stateOf(t.events);
  assert.equal(openQuestions(s).length, 2, 'two questions are still undecided');
  t.user('2 use sqlite instead\n3 no auth', { kind: 'user' });
  s = stateOf(t.events);
  assert.equal(openQuestions(s).length, 0, 'the rest of the round settles it');
  assert.equal(s.frontierEmpty, true);
  assert.equal(s.questionStats.accepted, 2, 'Q1 said yes and Q3 restated the recommendation');
  assert.equal(s.questionStats.overridden, 1, 'Q2 chose something else than the recommendation');
});

await test('the directive of a partially answered round re-asks only what is open', () => {
  const t = T();
  activate(t);
  t.assistant(ROUND3, { turn: 1, step: 1 });
  t.user('1 yes\n3 auth is needed now', { kind: 'user' });
  const directive = renderDirective(stateOf(t.events));
  assert.match(directive, /2 of 3 questions are settled, 1 still open/);
  assert.match(directive, /Already settled in this round/);
  assert.match(directive, /Q1 — Scope — accepted your recommendation/);
  assert.match(directive, /Q3 — Auth — overridden: "auth is needed now"/);
  assert.match(directive, /Still open \(this is the whole remaining frontier of this round\)/);
  assert.equal(
    (directive.match(/^\d+\. Q\d+/gm) ?? []).length,
    1,
    'exactly one question may be re-asked',
  );
  assert.match(directive, /Q2 — Storage/);
});

await test('grill_status reports the per-question settlement', () => {
  const t = T();
  activate(t);
  t.assistant(ROUND3, { turn: 1, step: 1 });
  t.user('1 yes\n3 no auth', { kind: 'user' });
  // GRILL-26: "no auth" restates the recommendation "No auth yet", so it is an
  // acceptance — the classifier used to file every real answer as an override.
  const status = renderStatus(stateOf(t.events));
  assert.match(status, /questions: total=3 open=1 accepted=2 overridden=0 batch=0/);
  assert.match(status, /- Q1 Scope \[accepted\]/);
  assert.match(status, /- Q2 Storage \[open\]/);
  assert.match(status, /- Q3 Auth \[accepted\]/);
});

await test('re-asking only the open question keeps the round, and answering it drains it', () => {
  const t = T();
  activate(t);
  t.assistant(ROUND3, { turn: 1, step: 1 });
  t.user('1 yes\n3 no auth', { kind: 'user' });
  t.assistant(q(2, 'Storage', 'JSON or SQLite?', 'JSON'), { turn: 2, step: 1 });
  let s = stateOf(t.events);
  assert.equal(roundCount(s), 1, 'restating the open question is not a new round');
  assert.equal(openQuestions(s).length, 1, 'and the settled questions stay settled');
  assert.equal(openQuestions(s)[0].number, 2);
  t.user('2 yes', { kind: 'user' });
  s = stateOf(t.events);
  assert.equal(s.frontierEmpty, true, 'answering the re-ask drains the interview');
  assert.equal(s.questionStats.accepted, 3);
  assert.equal(s.questionStats.overridden, 0);
});

// ═════════════ GRILL-25 / GRILL-26: the replies a real user actually sent ═════════════
// These two are verbatim answers from the live acceptance of 0.2.0: numbers glued
// to their answers with no separator at all, and a single numbered answer followed
// by a condition. Both used to fall through to the batch reading and settle every
// open question at once (GRILL-25), with `accepted`/`overridden` permanently 0
// because the classifier only knew a closed list of accept words (GRILL-26).

const MARKET_ROUND = [
  q(1, '账号', '用哪个 GitHub 账号？', '个人账号 dsh-plugin-grill-me'),
  q(2, '渠道', '发到哪边？', '两边都发'),
  q(3, '显示名', '市场里叫什么？', '拷问我（Grill Me）'),
].join('\n\n');

await test('GRILL-26: numbers glued to their answers still settle per question', () => {
  const t = T();
  activate(t);
  t.assistant(MARKET_ROUND, { turn: 1, step: 1 });
  t.user('1是2两边都发3同意', { kind: 'user' });
  const s = stateOf(t.events);
  assert.equal(openQuestions(s).length, 0, 'all three answers must land');
  assert.equal(s.questionStats.accepted, 3, 'restating the recommendation is an acceptance');
  assert.equal(s.questionStats.overridden, 0);
  assert.equal(s.questionStats.batch, 0, 'no question may be settled as a batch');
  assert.equal(s.frontierEmpty, true);
});

await test('GRILL-25: one numbered answer leaves the questions it did not answer open', () => {
  const t = T();
  activate(t);
  t.assistant(MARKET_ROUND, { turn: 1, step: 1 });
  t.user('1是看，但我现在还没github账号，先不管这个', { kind: 'user' });
  const s = stateOf(t.events);
  assert.equal(s.questionStats.overridden, 1, 'Q1 was answered, with a condition attached');
  assert.equal(s.questionStats.open, 2, 'Q2 and Q3 were never answered');
  assert.equal(s.awaitingAnswers, true);
  const directive = renderDirective(s);
  assert.match(directive, /1 of 3 questions are settled, 2 still open/);
  assert.match(directive, /Q1 — 账号 — overridden/);
  assert.match(directive, /Still open \(this is the whole remaining frontier of this round\)/);
});

// ═════════════ GRILL-32: a comma between numbered answers is a list separator ═════════════
// The same round answered on one line with a comma between the items: the comma was
// invisible to the label pass, so only the first item was read, the round stayed open and
// Q1 was filed as an override even though every answer was right there. A comma only opens
// a list position when the number behind it reads as a label — `2 周` is an amount.

await test('GRILL-32: a comma between numbered answers settles every question', () => {
  const t = T();
  activate(t);
  t.assistant(MARKET_ROUND, { turn: 1, step: 1 });
  t.user('1 是，2 两边都发，3 同意', { kind: 'user' });
  const s = stateOf(t.events);
  assert.equal(openQuestions(s).length, 0, 'all three answers must land');
  assert.equal(s.questionStats.accepted, 3, 'the separator must not poison the classifier');
  assert.equal(s.questionStats.overridden, 0);
  assert.equal(s.questionStats.batch, 0);
  assert.equal(s.frontierEmpty, true);

  const directive = renderDirective(s);
  assert.match(directive, /Settled so far: 3 accepted your recommendation, 0 overridden/);
  assert.match(directive, /wait for the user to confirm the shared understanding/);
});

await test('GRILL-32: ASCII commas and 、 separate items the same way', () => {
  for (const reply of ['1 是,2 两边都发,3 同意', '1 是、2 两边都发、3 同意', '1 是; 2 两边都发; 3 同意']) {
    const t = T();
    activate(t);
    t.assistant(MARKET_ROUND, { turn: 1, step: 1 });
    t.user(reply, { kind: 'user' });
    const s = stateOf(t.events);
    assert.equal(s.questionStats.accepted, 3, `"${reply}" must settle all three as accepted`);
    assert.equal(openQuestions(s).length, 0);
  }
});

await test('GRILL-32: a comma before an amount is not a list separator', () => {
  const t = T();
  activate(t);
  t.assistant(MARKET_ROUND, { turn: 1, step: 1 });
  t.user('1 是看，2 周后再定', { kind: 'user' });
  const s = stateOf(t.events);
  assert.equal(s.questionStats.overridden, 1, 'only Q1 was answered');
  assert.equal(s.questionStats.open, 2, '"2 周" is an amount, so Q2 and Q3 stay open');
  assert.equal(s.awaitingAnswers, true);
  assert.match(renderDirective(s), /1 of 3 questions are settled, 2 still open/);
});

// ═══════════════════════ incremental projection (v4) ═══════════════════════
// The production path memoises the projection per agent; it has to agree with the
// stateless reference at every point, including when the transcript is not
// append-only.
header('incremental projection (v4)');

await test('the projector agrees with analyze at every prefix of a growing transcript', () => {
  const t = T();
  activate(t);
  t.assistant(ROUND3, { turn: 1, step: 1 });
  t.user('1 yes\n2 json', { kind: 'user' });
  t.assistant(ROUND_ZH, { turn: 2, step: 1 });
  t.user('1 只做命令行\n2 用 JSON', { kind: 'user' });
  t.assistant('All decisions are settled.', { turn: 3, step: 1 });
  const projector = createProjector();
  for (let index = 0; index <= t.events.length; index += 1) {
    const slice = t.events.slice(0, index);
    assert.deepEqual(
      projector.analyze(slice),
      analyze(slice),
      `the memoised projection must equal analyze() at a prefix of ${index} event(s)`,
    );
  }
});

await test('a rewritten transcript forces a full re-projection', () => {
  const t = T();
  activate(t);
  t.assistant(ROUND3, { turn: 1, step: 1 });
  const projector = createProjector();
  assert.equal(projector.analyze(t.events).awaitingAnswers, true);
  const rewritten = t.events.slice();
  const last = rewritten.length - 1;
  rewritten[last] = {
    type: 'assistant/message',
    seq: rewritten[last].seq,
    time: rewritten[last].time,
    data: { message: { id: 'rewritten', role: 'assistant', content: [{ type: 'text', text: 'nothing to see here' }] } },
  };
  assert.deepEqual(projector.analyze(rewritten), analyze(rewritten));
  assert.equal(
    projector.analyze(rewritten).awaitingAnswers,
    false,
    'the in-place edit must not be served from the memo',
  );
});

await test('a truncated transcript resets the memo instead of serving a longer state', () => {
  const t = T();
  activate(t);
  t.assistant(ROUND3, { turn: 1, step: 1 });
  const projector = createProjector();
  projector.analyze(t.events);
  const truncated = t.events.slice(0, 2);
  assert.deepEqual(projector.analyze(truncated), analyze(truncated));
  const fresh = createProjector();
  assert.deepEqual(fresh.analyze(t.events), analyze(t.events), 'a fresh projector must agree too');
});

// ═══════════════════ end-to-end through the glue (v4) ═══════════════════
// The two surfaces a user actually looks at once the module loads: the directive
// the plugin injects into the next step, and the grill_status text. Both are
// exercised here through the real `lib/index.js` against the fake host, so the
// live acceptance after a restart is a formality rather than a first contact.
header('end-to-end through the glue (v4)');

// A second module instance of the glue, loaded here rather than reusing the
// phase-2 `GLUE` (which lives inside that section's scope). Loading it twice is
// itself the GRILL-22 scenario: each instance must keep its own state.
const E2E_GLUE = await import(pathToFileURL(GLUE_PATH).href);

await test('the injected directive of a partially answered round re-asks only what is open', async () => {
  const host = fakeHost();
  E2E_GLUE.apply(host.ctx, undefined);
  const t = T();
  activate(t);
  t.assistant(ROUND3, { turn: 1, step: 1 });
  t.user('1 yes\n3 no auth', { kind: 'user' });
  host.events = t.events;
  const claimed = { role: 'user', content: [{ type: 'text', text: 'anything else?' }], source: { kind: 'user' } };
  const out = await host.preStep({ kind: 'enter', messages: [claimed] });
  const injected = pluginOwned(out.messages);
  assert.equal(injected.length, 1, 'exactly one directive reaches the model');
  const text = textOfMessage(injected[0]);
  assert.match(text, /2 of 3 questions are settled, 1 still open/);
  assert.match(text, /Already settled in this round/);
  assert.match(text, /Still open \(this is the whole remaining frontier of this round\)/);
  assert.equal((text.match(/^\d+\. Q\d+/gm) ?? []).length, 1, 'only the open question may be re-asked');
  assert.match(text, /Q2 — Storage/);
  assert.doesNotMatch(text, /^\d+\. Q1/m, 'a settled question must never reappear as a question');
});

await test('grill_status prints the per-question settlement', async () => {
  const host = fakeHost();
  E2E_GLUE.apply(host.ctx, undefined);
  const t = T();
  activate(t);
  t.assistant(ROUND3, { turn: 1, step: 1 });
  t.user('1 yes\n3 no auth', { kind: 'user' });
  host.events = t.events;
  const tool = host.registered.tools[0];
  assert.equal(tool.name, 'grill_status');
  const text = await tool.execute({}, { agent: host.agent() });
  assert.match(text, /questions: total=3 open=1 accepted=2 overridden=0 batch=0/);
  assert.match(text, /- Q1 Scope \[accepted\]/);
  assert.match(text, /- Q2 Storage \[open\]/);
  assert.match(text, /- Q3 Auth \[accepted\]/);
});

// ═══════════════════ the documentation channel (v5) ═══════════════════
// `grill-with-docs` is the only mode that owes documents, and upstream's own docs
// record the failure it exists to prevent: "the file write silently does not
// happen". Every test below pins one link of the chain — the marker books a debt,
// a write pays it, and the hand-off stays blocked while one is outstanding.
header('the documentation channel (grill-with-docs, v5)');

const DOCS_ROUND = q(1, 'Storage', 'How should the plan store its state?', 'Use JSON on disk');
const ADR_DECL = '📄 ADR: Use JSON for storage';
const TERM_DECL = '📄 术语: 决策树';

const docsActivated = () => {
  const t = T();
  activate(t, 'grill-with-docs');
  return t;
};

// One round, answered, then the user's confirmation: the frontier is empty and
// the acceptance stands, so the *only* thing that can block the hand-off is the
// documentation channel.
const settledDocsInterview = () => {
  const t = docsActivated();
  t.assistant(DOCS_ROUND, { turn: 1, step: 1 });
  t.user('1 yes', { kind: 'user' });
  t.user('确认', { kind: 'user' });
  return t;
};

await test('grilling never opens the documentation channel', () => {
  const t = T();
  activate(t);
  t.assistant(DOCS_ROUND, { turn: 1, step: 1 });
  t.user('1 yes', { kind: 'user' });
  t.user('确认', { kind: 'user' });
  const s = stateOf(t.events);
  assert.equal(s.docsMode, false);
  assert.equal(s.mode, 'confirmed');
  assert.deepEqual(s.docDebts, []);
  assert.match(S.renderDirective(s), /Grilling is COMPLETE/);
});

await test('grill-with-docs latches the channel without changing the interview itself', () => {
  const t = docsActivated();
  t.assistant(DOCS_ROUND, { turn: 1, step: 1 });
  const s = stateOf(t.events);
  assert.equal(s.docsMode, true, 'the docs entry point is what turns the channel on');
  assert.equal(s.mode, 'awaiting-answers', 'asking and waiting is unchanged');
  assert.deepEqual(s.docDebts, [], 'nothing is owed until something is declared');
});

await test('loading domain-modeling inside a grilling interview opens nothing', () => {
  const t = T();
  activate(t);
  t.toolCall('skill', { name: 'domain-modeling' }, { turn: 1, step: 1 });
  const s = stateOf(t.events);
  assert.equal(s.docsMode, false, 'the primitive is documentation, not an interview mode');
  assert.deepEqual(s.docDebts, []);
});

await test('a 📄 declaration books a debt, and an ADR write pays it', () => {
  const t = settledDocsInterview();
  t.assistant(`Settled.\n\n${ADR_DECL}`, { turn: 1, step: 2 });
  let s = stateOf(t.events);
  assert.deepEqual(
    s.docDebts.map((debt) => [debt.kind, debt.title]),
    [['adr', 'Use JSON for storage']],
  );
  assert.equal(s.openDocDebts.length, 1);
  assert.equal(s.confirmedUnderstanding, false, 'a declared, unwritten document blocks the hand-off');
  assert.equal(s.mode, 'awaiting-docs');
  const directive = S.renderDirective(s);
  assert.match(directive, /\[adr\] Use JSON for storage/);
  assert.doesNotMatch(directive, /Grilling is COMPLETE/);

  t.toolCall('write', { file_path: 'docs/adr/0001-use-json-storage.md' }, { turn: 1, step: 3 });
  s = stateOf(t.events);
  assert.equal(s.openDocDebts.length, 0, 'the write is the redemption');
  assert.equal(s.docDebts[0].dischargedPath, 'docs/adr/0001-use-json-storage.md');
  assert.equal(s.mode, 'confirmed');
  assert.match(S.renderDirective(s), /Grilling is COMPLETE/);
});

await test('📄 术语 books a glossary debt, and only a GLOSSARY.md pays it', () => {
  const t = settledDocsInterview();
  t.assistant(TERM_DECL, { turn: 1, step: 2 });
  let s = stateOf(t.events);
  assert.deepEqual(s.docDebts.map((debt) => debt.kind), ['glossary']);
  assert.equal(s.openDocDebts.length, 1);

  t.toolCall('write', { file_path: 'src/glossary.js' }, { turn: 1, step: 3 });
  s = stateOf(t.events);
  assert.equal(s.openDocDebts.length, 1, 'a source file that merely says "glossary" is not a glossary');
  assert.equal(s.docViolations.length, 1, 'writing code with the glossary unwritten is the breach');
  assert.equal(s.confirmedUnderstanding, false, 'and the hand-off stays blocked');

  t.toolCall('write', { file_path: 'docs/GLOSSARY.md' }, { turn: 1, step: 4 });
  s = stateOf(t.events);
  assert.equal(s.openDocDebts.length, 0);
  assert.equal(s.confirmedUnderstanding, true, 'the breach is over once the document exists');
});

await test('a debt is paid by the file whose slug matches its title', () => {
  const t = settledDocsInterview();
  t.assistant('📄 ADR: Use JSON for storage', { turn: 1, step: 2 });
  t.assistant('📄 ADR: Rate limiting', { turn: 1, step: 3 });
  let s = stateOf(t.events);
  assert.equal(s.openDocDebts.length, 2);

  t.toolCall('write', { file_path: 'docs/adr/0002-rate-limiting.md' }, { turn: 1, step: 4 });
  s = stateOf(t.events);
  assert.deepEqual(
    s.docDebts.filter((debt) => debt.dischargedAtSeq !== undefined).map((debt) => debt.title),
    ['Rate limiting'],
    'the matching title is paid, not the oldest debt',
  );
  assert.deepEqual(s.openDocDebts.map((debt) => debt.title), ['Use JSON for storage']);
});

await test('declaring the same document twice books one debt', () => {
  const t = settledDocsInterview();
  t.assistant(ADR_DECL, { turn: 1, step: 2 });
  t.assistant(`Still owed, I know.\n\n${ADR_DECL}`, { turn: 1, step: 3 });
  const s = stateOf(t.events);
  assert.equal(s.docDebts.length, 1);
  assert.equal(s.openDocDebts.length, 1);
});

await test('a declaration inside a fenced block or blockquote books nothing', () => {
  const t = settledDocsInterview();
  t.assistant('```\n📄 ADR: Quoted example\n```\n\n> 📄 术语: quoted term', { turn: 1, step: 2 });
  const s = stateOf(t.events);
  assert.deepEqual(s.docDebts, [], 'the protocol being quoted is not the protocol being used');
  assert.equal(s.mode, 'confirmed');
});

await test('a 📄 declaration in a plain grilling interview books nothing', () => {
  const t = T();
  activate(t);
  t.assistant(DOCS_ROUND, { turn: 1, step: 1 });
  t.user('1 yes', { kind: 'user' });
  t.user('确认', { kind: 'user' });
  t.assistant(ADR_DECL, { turn: 1, step: 2 });
  const s = stateOf(t.events);
  assert.equal(s.docsMode, false);
  assert.deepEqual(s.docDebts, []);
  assert.equal(s.mode, 'confirmed', 'the plain modes stay exactly as they were');
});

await test('writing the documents is part of the interview, not acting after an unanswered round', () => {
  const t = docsActivated();
  t.assistant(DOCS_ROUND, { turn: 1, step: 1 });
  // Upstream writes a term down the moment it settles, i.e. while the round is
  // still open — so a document-only write must not be corrected for.
  t.toolCall('write', { file_path: 'docs/GLOSSARY.md' }, { turn: 1, step: 2 });
  let s = stateOf(t.events);
  assert.equal(s.actionsAfterRound.length, 0);

  // Anything else in the same position still is.
  t.toolCall('pwsh', { command: 'npm test' }, { turn: 1, step: 3 });
  s = stateOf(t.events);
  assert.equal(s.actionsAfterRound.length, 1);
});

await test('a documentation breach produces a correction naming every outstanding debt', () => {
  const t = settledDocsInterview();
  t.assistant(ADR_DECL, { turn: 1, step: 2 });
  t.toolCall('pwsh', { command: 'npm test' }, { turn: 1, step: 3 });
  const s = stateOf(t.events);
  assert.equal(s.docViolations.length, 1);
  assert.equal(s.actionsAfterRound.length, 0, 'the round is answered: this is a documentation breach');

  const key = S.violationKey(s, 1);
  assert.equal(key, `docs:${s.docViolations[0].seq}`);
  assert.equal(S.violationKey(s, 2), null, 'a correction belongs to the turn it happened in');

  const text = S.describeViolation(s);
  assert.ok(text, 'a breach must produce a correction');
  assert.ok(text.startsWith(S.CORRECTION_MARKER));
  assert.match(text, /documentation channel still owed 1 document\(s\)/);
  assert.match(text, /- \[adr\] Use JSON for storage/);
  assert.match(text, /Recover now, in this step:/);

  const status = S.renderStatus(s);
  assert.match(status, /mode=awaiting-docs/);
  assert.match(status, /documentation channel: on — 1 declared, 1 outstanding/);
  assert.match(status, /- \[adr\] Use JSON for storage \[outstanding\]/);
  assert.match(status, /Protocol violations recorded: 1/);
});

await test('the directive lists the debts while a round is still open', () => {
  const t = docsActivated();
  t.assistant(DOCS_ROUND, { turn: 1, step: 1 });
  t.assistant(TERM_DECL, { turn: 1, step: 2 });
  const s = stateOf(t.events);
  assert.equal(s.mode, 'awaiting-answers');
  const directive = S.renderDirective(s);
  assert.match(directive, /Documentation channel \(grill-with-docs\): 1 declared document\(s\) are still unwritten/);
  assert.match(directive, /- \[glossary\] 决策树/);
  assert.match(directive, /stays allowed even/, 'the write half is exempt from the wait');
});

await test('the /grill-with-docs command reports the channel through the glue', () => {
  const host = fakeHost();
  E2E_GLUE.apply(host.ctx, undefined);
  const command = host.registered.commands.find((entry) => entry.name === 'grill-with-docs');
  assert.ok(command, 'the docs command must be registered');
  const t = settledDocsInterview();
  t.assistant(ADR_DECL, { turn: 1, step: 2 });
  host.events = t.events;
  const out = command.handler({ agent: host.agent(), rawInput: '' });
  assert.equal(out.kind, 'success');
  assert.match(out.text, /documentation channel: on — 1 declared, 1 outstanding/);
});

await test('the injected directive blocks the hand-off until the declared document exists', async () => {
  const host = fakeHost();
  E2E_GLUE.apply(host.ctx, undefined);
  const t = settledDocsInterview();
  t.assistant(ADR_DECL, { turn: 1, step: 2 });
  host.events = t.events;
  const claimed = {
    role: 'user',
    content: [{ type: 'text', text: 'go on then' }],
    source: { kind: 'user' },
  };

  const firstOut = await host.preStep({ kind: 'enter', messages: [claimed] });
  const before = pluginOwned(firstOut.messages);
  assert.equal(before.length, 1, 'exactly one directive reaches the model');
  const text = textOfMessage(before[0]);
  assert.match(text, /channel still owes what the interviewer declared/);
  assert.match(text, /- \[adr\] Use JSON for storage/);
  assert.doesNotMatch(text, /Grilling is COMPLETE/, 'the hand-off is the debt\'s to grant');

  t.toolCall('write', { file_path: 'docs/adr/0001-use-json-storage.md' }, { turn: 1, step: 3 });
  host.events = t.events;
  const secondOut = await host.preStep({ kind: 'enter', messages: [claimed] });
  const after = pluginOwned(secondOut.messages);
  assert.equal(after.length, 1, 'the directive keeps reaching the model after the debt is paid');
  assert.match(textOfMessage(after[0]), /Grilling is COMPLETE/);
});

header('the documentation channel: defects the adversarial review found (v6)');

// An independent adversarial pass attacked the channel with 20 probes; these
// tests are the six defects it found, each one a case where the gate either paid
// the wrong document or accused a model that had written the right one.

await test('a short title cannot steal the write that pays a longer one', () => {
  const t = docsActivated();
  t.assistant('📄 ADR: Use JSON', { turn: 1, step: 1 });
  t.assistant('📄 ADR: Use JSON for storage', { turn: 1, step: 2 });
  t.toolCall('write', { file_path: 'docs/adr/0007-use-json-for-storage.md' }, { turn: 1, step: 3 });
  const s = stateOf(t.events);
  assert.deepEqual(s.openDocDebts.map((debt) => debt.title), ['Use JSON']);
  const paid = s.docDebts.find((debt) => debt.title === 'Use JSON for storage');
  assert.equal(paid.dischargedPath, 'docs/adr/0007-use-json-for-storage.md');
});

await test('a title that only appears in the directory name pays nothing', () => {
  const t = docsActivated();
  t.assistant('📄 ADR: docs', { turn: 1, step: 1 });
  t.assistant('📄 ADR: Redis cache', { turn: 1, step: 2 });
  t.toolCall('write', { file_path: 'docs/adr/0002-redis-cache.md' }, { turn: 1, step: 3 });
  const s = stateOf(t.events);
  assert.deepEqual(
    s.openDocDebts.map((debt) => debt.title),
    ['docs'],
    'the file is slugged by its own name, not by docs/adr',
  );
});

await test('one file pays one debt when the host reports the write twice', () => {
  const t = docsActivated();
  t.assistant('📄 ADR: Alpha thing', { turn: 1, step: 1 });
  t.assistant('📄 ADR: Beta thing', { turn: 1, step: 2 });
  // The same call, reported both ways a host reports it: on the assistant message
  // and as a tool/call event.
  t.assistant('Writing it now.', {
    turn: 1,
    step: 3,
    toolCalls: [{ name: 'write', arguments: { file_path: 'docs/adr/0005-beta-thing.md' } }],
  });
  t.toolCall('write', { file_path: 'docs/adr/0005-beta-thing.md' }, { turn: 1, step: 3 });
  const s = stateOf(t.events);
  assert.deepEqual(
    s.openDocDebts.map((debt) => debt.title),
    ['Alpha thing'],
    'one file is one payment, however many events carry it',
  );
});

await test('a nested multi_edit target pays the debt', () => {
  const t = docsActivated();
  t.assistant('📄 ADR: Use JSON', { turn: 1, step: 1 });
  t.toolCall('multi_edit', { edits: [{ file_path: 'docs/adr/0003-use-json.md' }] }, { turn: 1, step: 2 });
  const s = stateOf(t.events);
  assert.equal(s.openDocDebts.length, 0, 'the target is nested, not top level');
});

await test('an apply_patch payload names the file it writes', () => {
  const t = docsActivated();
  t.assistant('📄 ADR: Use JSON', { turn: 1, step: 1 });
  t.toolCall(
    'apply_patch',
    { input: '*** Begin Patch\n*** Add File: docs/adr/0004-use-json.md\n+body\n*** End Patch' },
    { turn: 1, step: 2 },
  );
  const s = stateOf(t.events);
  assert.equal(s.openDocDebts.length, 0, 'the path lives in the payload text');
});

await test('a write whose target cannot be read neither pays nor accuses', () => {
  const t = settledDocsInterview();
  t.assistant('📄 ADR: Use JSON', { turn: 1, step: 2 });
  t.toolCall('write', { opaque: true }, { turn: 1, step: 3 });
  const s = stateOf(t.events);
  assert.equal(s.openDocDebts.length, 1, 'nothing was paid');
  assert.deepEqual(s.docViolations, [], 'and nothing was accused: silence beats a false correction');
});

await test('a mention of /grill-with-docs opens nothing', () => {
  const t = T();
  activate(t);
  t.user('最后记得用 /grill-with-docs 复查一遍文档', { kind: 'user' });
  assert.equal(stateOf(t.events).docsMode, false, 'a sentence is not a mode');

  const u = T();
  activate(u);
  u.injected('Available skills: grilling, /grill-with-docs, grill-me', 'skill-invocation', { form: 'instructions' });
  assert.equal(stateOf(u.events).docsMode, false, 'a catalogue lists every skill; it opens nothing');
});

await test('a spent action violation no longer hides a live documentation breach', () => {
  const t = docsActivated();
  t.assistant(DOCS_ROUND, { turn: 1, step: 1 });
  t.toolCall('pwsh', { command: 'echo hi' }, { turn: 1, step: 2 });
  t.user('1 yes', { kind: 'user' });
  t.assistant('📄 ADR: Use JSON', { turn: 2, step: 1 });
  t.toolCall('pwsh', { command: 'echo again' }, { turn: 2, step: 2 });
  const s = stateOf(t.events);
  assert.equal(s.actionsAfterRound.length, 1, 'the early act is on the ledger');
  assert.equal(s.docViolations.length, 1, 'so is the breach');
  assert.match(String(S.violationKey(s, 2)), /^docs:/);
  assert.match(String(S.describeViolation(s)), /documentation channel still owed/);
});

await test('a paid documentation breach no longer hides a round without recommendations', () => {
  const t = docsActivated();
  t.assistant(DOCS_ROUND, { turn: 1, step: 1 });
  t.user('1 yes', { kind: 'user' });
  t.assistant('📄 ADR: Use JSON', { turn: 1, step: 2 });
  t.toolCall('pwsh', { command: 'echo hi' }, { turn: 1, step: 3 });
  t.toolCall('write', { file_path: 'docs/adr/0001-use-json.md' }, { turn: 1, step: 4 });
  // Two marks, no ➡️ anywhere: the round parses (a lone recommendation-less
  // question would be dropped — `recommends === 0 && marks.length < 2`).
  t.assistant('❓ **Q2** - **Where?**: Where?\n\n❓ **Q3** - **When?**: When?', { turn: 2, step: 1 });
  const s = stateOf(t.events);
  assert.equal(s.docViolations.length, 1, 'the breach is history once the file exists');
  assert.equal(s.openDocDebts.length, 0);
  assert.match(String(S.violationKey(s, 2)), /^round:/, 'the round still lacks a recommendation');
});

await test('the glossary map is documentation, but it pays no term', () => {
  const t = settledDocsInterview();
  t.assistant(TERM_DECL, { turn: 1, step: 2 });
  t.toolCall('write', { file_path: 'GLOSSARY-MAP.md' }, { turn: 1, step: 3 });
  const s = stateOf(t.events);
  assert.equal(s.openDocDebts.length, 1, 'the index is not the glossary');
  assert.deepEqual(s.docViolations, [], 'writing the index is not running on to the work');
  assert.equal(s.mode, 'awaiting-docs');
});

await test('a step that writes both the document and the code nets out to a paid debt', () => {
  const t = settledDocsInterview();
  t.assistant('📄 ADR: Use JSON', { turn: 1, step: 2 });
  t.toolCall('write', { file_path: 'docs/adr/0001-use-json.md' }, { turn: 1, step: 3 });
  t.toolCall('write', { file_path: 'src/app.js' }, { turn: 1, step: 3 });
  const s = stateOf(t.events);
  assert.deepEqual(s.docViolations, [], 'the document exists by the end of the step');
  assert.equal(s.mode, 'confirmed');
});

afterAll();

function afterAll() {
  const total = passed.length + failed.length;
  console.log(`\n${'='.repeat(70)}`);
  if (defects.length > 0) {
    console.log(`PINNED DEFECTS still present (not counted as failures): ${defects.length}`);
    for (const d of defects) console.log(`  ${d.id} [${d.section}] ${d.name}`);
    console.log('  (each is documented at its defect() registration, with the suggested fix)');
  }
  if (failed.length === 0) {
    console.log(`PASS ${passed.length}/${total} tests${defects.length > 0 ? ` (+${defects.length} pinned defects)` : ''}`);
    process.exit(0);
  }
  console.log(`FAIL ${failed.length}/${total} tests`);
  for (const f of failed) console.log(`  [${f.section}] ${f.name}\n    ${f.message.split('\n')[0]}`);
  process.exit(1);
}
