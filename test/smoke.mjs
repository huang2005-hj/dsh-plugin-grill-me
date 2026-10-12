/**
 * Smoke test for the grill-me Cordis half.
 *
 * Drives `apply()` against a hand-built fake context (no DSH runtime, no test
 * framework) and asserts the observable contract:
 *
 *   1. both skills register, with the upstream invocation policies;
 *   2. the `grill_status` tool and the `grill-me` command register, and neither
 *      throws on a hostile/absent transcript;
 *   3. `agent/pre-step` appends exactly one plugin directive for an ACTIVE
 *      session, replaces an existing one in place, is a no-op when inactive,
 *      and never rejects;
 *   4. `agent/turn-stopping` steers a correction on a protocol violation, caps
 *      at 3 per `(agent, turn)`, and no-ops otherwise;
 *   5. the module imports nothing but `node:` builtins and its own sources.
 *
 * Run: node test/smoke.mjs
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { apply, inject, name } from '../lib/index.js'
import {
  CORRECTION_MARKER,
  DIRECTIVE_MARKER,
  SOURCE_KIND,
  analyze,
  describeViolation,
  makeUserMessage,
} from '../src/state.js'

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const ACTIVATION_TEXT = '拷问我这个插件的设计'
const INACTIVE_TEXT = '帮我看看这个正则怎么写'

const ROUND_TEXT = [
  '❓ **Q1 - 目标**：这次要做到什么程度？',
  '',
  '➡️ 推荐：先做最小可用版本。',
  '',
  '❓ **Q2 - 范围**：包含哪些部分？',
  '',
  '➡️ 推荐：只做状态机与重放。',
].join('\n')

function userEvent(seq, text) {
  return {
    seq,
    type: 'user/message',
    data: { id: `u${seq}`, role: 'user', content: [{ type: 'text', text }] },
  }
}

function assistantEvent(seq, text, toolNames = []) {
  const content = [{ type: 'text', text }]
  for (const toolName of toolNames) {
    content.push({ type: 'tool-call', callId: `call-${seq}-${toolName}`, name: toolName, arguments: '{}' })
  }
  return {
    seq,
    type: 'assistant/message',
    data: { turn: 1, step: seq, message: { id: `a${seq}`, role: 'assistant', content } },
  }
}

/** Active session, no round open yet: the directive tells it to open one. */
const ACTIVE_TRANSCRIPT = [userEvent(1, ACTIVATION_TEXT)]

/** Ordinary chatter: the machine must stay inactive. */
const INACTIVE_TRANSCRIPT = [userEvent(1, INACTIVE_TEXT)]

/**
 * Active session with a recorded violation: round 1 is closed unanswered by
 * round 2, and the assistant then runs a mutating tool.
 */
const VIOLATING_TRANSCRIPT = [
  userEvent(1, ACTIVATION_TEXT),
  assistantEvent(2, ROUND_TEXT),
  assistantEvent(3, ROUND_TEXT),
  assistantEvent(4, '好，那我先把代码写起来。', ['write']),
]

function agentFor(events, id = 'agent-smoke') {
  return {
    id,
    session: { snapshotEvents: () => events },
    steered: [],
    steer(message) {
      this.steered.push(message)
    },
  }
}

/* ------------------------------------------------------------------ *
 * Fake Cordis context
 * ------------------------------------------------------------------ */

function createFakeCtx() {
  const log = { skills: [], tools: [], commands: [], events: [], effects: 0, disposed: 0 }

  const ctx = {
    skills: {
      register(definition) {
        log.skills.push(definition)
        return () => {
          log.disposed += 1
        }
      },
    },
    tools: {
      register(definition) {
        log.tools.push(definition)
        return () => {
          log.disposed += 1
        }
      },
    },
    commands: {
      register(definition) {
        log.commands.push(definition)
        return () => {
          log.disposed += 1
        }
      },
    },
    on(event, listener) {
      log.events.push({ event, listener })
      return () => {
        log.disposed += 1
      }
    },
    get(service) {
      return ctx[service]
    },
    effect(factory) {
      log.effects += 1
      return factory()
    },
  }

  return { ctx, log }
}

function listenerFor(log, event) {
  const entry = log.events.find((candidate) => candidate.event === event)
  assert.ok(entry, `expected a listener for ${event}`)
  return entry.listener
}

/** Drive the pre-step waterfall with the host's default continuation. */
async function drivePreStep(listener, agent, messages = []) {
  return listener({ agent, messages, turn: 1, step: 1, signal: {} }, async () => ({
    kind: 'enter',
    messages,
  }))
}

/* ------------------------------------------------------------------ *
 * Test runner
 * ------------------------------------------------------------------ */

const results = []

async function test(title, body) {
  try {
    await body()
    results.push({ title, ok: true })
    console.log(`  ok  ${title}`)
  } catch (error) {
    results.push({ title, ok: false, error })
    console.log(`FAIL  ${title}`)
    console.log(String(error?.stack ?? error))
  }
}

const { ctx, log } = createFakeCtx()
const disposers = apply(ctx, {})

/* -- 1. module shape + skills -------------------------------------- */

await test('plugin exports name/inject and returns disposers', () => {
  assert.equal(name, 'grill-me')
  assert.deepEqual(inject, ['skills', 'tools', 'commands'])
  assert.ok(Array.isArray(disposers))
  assert.equal(disposers.length, 9, 'four skills + tool + two commands + two listeners')
})

await test('all four skills register with upstream invocation policies', () => {
  assert.equal(log.skills.length, 4)
  const wrapper = log.skills.find((skill) => skill.name === 'grill-me')
  const primitive = log.skills.find((skill) => skill.name === 'grilling')
  const docsWrapper = log.skills.find((skill) => skill.name === 'grill-with-docs')
  const docsPrimitive = log.skills.find((skill) => skill.name === 'domain-modeling')
  assert.ok(wrapper, 'wrapper skill missing')
  assert.ok(primitive, 'primitive skill missing')
  assert.ok(docsWrapper, 'grill-with-docs skill missing')
  assert.ok(docsPrimitive, 'domain-modeling skill missing')
  assert.deepEqual(wrapper.invocation, { modelInvocable: false, userInvocable: true })
  assert.deepEqual(primitive.invocation, { modelInvocable: true, userInvocable: true })
  // Upstream marks both wrappers `disable-model-invocation: true`; the two
  // primitives are what a model is allowed to load on its own.
  assert.deepEqual(docsWrapper.invocation, { modelInvocable: false, userInvocable: true })
  assert.deepEqual(docsPrimitive.invocation, { modelInvocable: true, userInvocable: true })
  for (const skill of [wrapper, primitive, docsWrapper, docsPrimitive]) {
    assert.equal(skill.provider, 'grill-me')
    assert.ok(skill.description.length > 0, `${skill.name} needs a description`)
    assert.ok(skill.content.length > 0, `${skill.name} needs a body`)
  }
  // The docs channel is keyed on this exact name, so the registration and the
  // state machine cannot drift apart silently (src/state.js isDocsSkillName).
  assert.ok(docsWrapper.content.includes('📄'), 'the docs wrapper must document the declaration marker')
  assert.ok(docsPrimitive.content.includes('GLOSSARY.md'), 'the docs primitive must name the glossary')
})

/* -- 2. tool + command --------------------------------------------- */

await test('grill_status registers and reports an active session', async () => {
  assert.equal(log.tools.length, 1)
  const tool = log.tools[0]
  assert.equal(tool.name, 'grill_status')
  assert.equal(tool.parameters.type, 'object')
  // Direct registration takes a *compiled* JSON Schema here, not defineTool's
  // author-facing property map (dsh-tools lib/types/index.js:459-480).
  assert.equal(typeof tool.parameters.properties, 'object')
  assert.equal(tool.parameters.properties.type, undefined)
  assert.equal(tool.output.schema.type, 'string')
  assert.equal(typeof tool.output.render, 'function')
  // The runtime calls this as a function (dsh-tools lib/index.js:3059-3061);
  // a bare boolean would throw "isConcurrencySafe is not a function".
  assert.equal(typeof tool.isConcurrencySafe, 'function')
  assert.equal(tool.isConcurrencySafe({}), true)

  const status = await tool.execute({}, { agent: agentFor(ACTIVE_TRANSCRIPT) })
  assert.equal(typeof status, 'string')
  assert.ok(status.includes('mode=active'), `unexpected status: ${status}`)
  assert.deepEqual(tool.output.render({}, status), [{ type: 'text', text: status }])
})

await test('grill_status never throws on an unreadable transcript', async () => {
  const tool = log.tools[0]
  const broken = {
    session: {
      snapshotEvents() {
        throw new Error('session exploded')
      },
    },
  }
  const status = await tool.execute({}, { agent: broken })
  assert.equal(typeof status, 'string')
  assert.ok(status.length > 0)
  const noAgent = await tool.execute({}, undefined)
  assert.equal(typeof noAgent, 'string')
})

await test('/grill-me command registers, arms, and reports status', () => {
  assert.equal(log.commands.length, 2)
  const command = log.commands.find((entry) => entry.name === 'grill-me')
  assert.ok(command, 'the /grill-me command must be registered')
  assert.equal(typeof command.handler, 'function')
  assert.ok(command.description.length > 0)

  const active = command.handler({ agent: agentFor(ACTIVE_TRANSCRIPT), rawInput: '' })
  assert.equal(active.kind, 'success')
  assert.ok(active.text.includes('mode=active'), `unexpected text: ${active.text}`)

  const inactive = command.handler({ agent: agentFor(INACTIVE_TRANSCRIPT), rawInput: '' })
  assert.equal(inactive.kind, 'success')
  assert.ok(inactive.text.includes('not active'))

  const broken = command.handler({
    agent: {
      session: {
        snapshotEvents() {
          throw new Error('session exploded')
        },
      },
    },
  })
  assert.equal(broken.kind, 'success')
  assert.ok(broken.text.length > 0)
})

/* -- 3. pre-step ---------------------------------------------------- */

await test('pre-step appends exactly one directive for an active session', async () => {
  const preStep = listenerFor(log, 'agent/pre-step')
  const hostMessage = {
    id: 'host-1',
    role: 'user',
    content: [{ type: 'text', text: 'runtime context' }],
  }
  const decision = await drivePreStep(preStep, agentFor(ACTIVE_TRANSCRIPT), [hostMessage])

  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages.length, 2, 'host message + one directive')
  assert.equal(decision.messages[0], hostMessage, 'host messages must be preserved')

  const injected = decision.messages.filter((message) => message?.source?.kind === SOURCE_KIND)
  assert.equal(injected.length, 1)
  assert.equal(injected[0].source.form, 'directive')
  assert.ok(injected[0].content[0].text.includes(DIRECTIVE_MARKER))
})

await test('pre-step replaces an existing plugin message in place', async () => {
  const preStep = listenerFor(log, 'agent/pre-step')
  const existing = {
    id: 'stale-directive',
    role: 'user',
    content: [{ type: 'text', text: 'stale' }],
    source: { kind: SOURCE_KIND, form: 'directive' },
  }
  const decision = await drivePreStep(preStep, agentFor(ACTIVE_TRANSCRIPT), [existing])

  assert.equal(decision.messages.length, 1, 'replaced, not appended')
  assert.notEqual(decision.messages[0].id, 'stale-directive')
  assert.ok(decision.messages[0].content[0].text.includes(DIRECTIVE_MARKER))
})

await test('pre-step is a no-op when the step claimed no input', async () => {
  const preStep = listenerFor(log, 'agent/pre-step')
  const decision = await drivePreStep(preStep, agentFor(ACTIVE_TRANSCRIPT), [])
  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages.length, 0, 'no directive without a user turn to grill')
})

await test('pre-step is a no-op when the session is inactive', async () => {
  const preStep = listenerFor(log, 'agent/pre-step')
  const decision = await drivePreStep(preStep, agentFor(INACTIVE_TRANSCRIPT), [])
  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages.length, 0)
})

await test('pre-step never rejects and survives a hostile transcript', async () => {
  const preStep = listenerFor(log, 'agent/pre-step')

  const rejection = await preStep({ agent: agentFor(ACTIVE_TRANSCRIPT), messages: [] }, async () => ({
    kind: 'reject',
  }))
  assert.deepEqual(rejection, { kind: 'reject' })

  const hostile = {
    session: {
      snapshotEvents() {
        throw new Error('session exploded')
      },
    },
  }
  const decision = await drivePreStep(preStep, hostile, [])
  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages.length, 0)
})

/* -- 4. turn-stopping ----------------------------------------------- */

await test('turn-stopping steers a correction on a violation', async () => {
  const turnStopping = listenerFor(log, 'agent/turn-stopping')
  const agent = agentFor(VIOLATING_TRANSCRIPT)

  const fixtureState = analyze(VIOLATING_TRANSCRIPT)
  assert.equal(fixtureState.active, true, 'fixture must be an active session')
  assert.ok(describeViolation(fixtureState), 'fixture must carry a violation')

  await turnStopping({ agent, turn: 1, signal: {} })

  assert.equal(agent.steered.length, 1)
  const correction = agent.steered[0]
  assert.equal(correction.role, 'user')
  assert.equal(correction.source.kind, SOURCE_KIND)
  assert.equal(correction.source.form, 'correction')
  assert.ok(correction.content[0].text.includes(CORRECTION_MARKER))
})

await test('turn-stopping corrects one recorded violation exactly once (GRILL-23)', async () => {
  const turnStopping = listenerFor(log, 'agent/turn-stopping')
  const agent = agentFor(VIOLATING_TRANSCRIPT, 'agent-once')

  for (let attempt = 0; attempt < 6; attempt += 1) {
    await turnStopping({ agent, turn: 1, signal: {} })
  }

  // The budget belongs to the violation, not to `(agent, turn)`: keying it by the
  // turn let every steer — which starts a new turn — buy the next one, so a single
  // recorded act re-corrected itself until the session was disabled by hand.
  assert.equal(agent.steered.length, 1, 'one recorded act is corrected once')
})

await test('turn-stopping does not re-correct the same violation in a later turn', async () => {
  const turnStopping = listenerFor(log, 'agent/turn-stopping')
  const agent = agentFor(VIOLATING_TRANSCRIPT, 'agent-later-turn')

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await turnStopping({ agent, turn: 1, signal: {} })
  }
  assert.equal(agent.steered.length, 1, 'still one correction')

  await turnStopping({ agent, turn: 2, signal: {} })
  assert.equal(agent.steered.length, 1, 'a new turn must not re-correct the same violation')
});

/* -- GRILL-31: only a live breach is corrected ---------------------- */

await test('turn-stopping ignores a violation from an earlier turn (GRILL-31)', async () => {
  const turnStopping = listenerFor(log, 'agent/turn-stopping')
  const agent = agentFor(VIOLATING_TRANSCRIPT, 'agent-stale-turn')

  // The live session's shape: the act sits in turn 1 and the turn that ends is 33.
  // Both real corrections cited `acted after an unanswered round (turn 24, step 4)`
  // at the end of turns 30 and 33, turns whose directive said the opposite.
  const fixtureState = analyze(VIOLATING_TRANSCRIPT)
  assert.equal(fixtureState.actionsAfterRound[0].turn, 1, 'fixture must carry the act in turn 1')

  await turnStopping({ agent, turn: 33, signal: {} })
  assert.equal(agent.steered.length, 0, 'history is not a live breach')
})

await test('turn-stopping ignores a violation whose round has since been answered (GRILL-31)', async () => {
  const turnStopping = listenerFor(log, 'agent/turn-stopping')
  // Any item separator works (newline, `;`, or a comma since GRILL-32): the reply must
  // settle the round.
  const answered = [...VIOLATING_TRANSCRIPT, userEvent(90, '1 先做最小可用版本。\n2 只做状态机与重放。')]
  assert.equal(analyze(answered).awaitingAnswers, false, 'fixture: the reply must settle the round')

  const agent = agentFor(answered, 'agent-answered-late')
  await turnStopping({ agent, turn: 1, signal: {} })
  assert.equal(agent.steered.length, 0, 'there is nothing left to re-ask')
})

await test('turn-stopping does not re-steer a correction the transcript already carries (GRILL-31)', async () => {
  const turnStopping = listenerFor(log, 'agent/turn-stopping')
  const text = describeViolation(analyze(VIOLATING_TRANSCRIPT))
  assert.ok(typeof text === 'string' && text.length > 0, 'fixture must carry a correction')

  // A reloaded plugin starts with a fresh budget, so the transcript is the only
  // durable record that this correction has already been delivered.
  const events = [
    ...VIOLATING_TRANSCRIPT,
    { seq: 90, type: 'user/message', data: makeUserMessage(text, { kind: SOURCE_KIND, form: 'correction' }) },
    assistantEvent(91, '收到，我先等答案。'),
  ]
  const agent = agentFor(events, 'agent-restarted')

  await turnStopping({ agent, turn: 1, signal: {} })
  assert.equal(agent.steered.length, 0, 'the same correction must not be bought twice')
})

await test('turn-stopping no-ops without a violation, an active session, or steer()', async () => {
  const turnStopping = listenerFor(log, 'agent/turn-stopping')

  const clean = agentFor(ACTIVE_TRANSCRIPT)
  await turnStopping({ agent: clean, turn: 31, signal: {} })
  assert.equal(clean.steered.length, 0)

  const inactive = agentFor(INACTIVE_TRANSCRIPT)
  await turnStopping({ agent: inactive, turn: 31, signal: {} })
  assert.equal(inactive.steered.length, 0)

  const broken = {
    id: 'agent-broken',
    session: {
      snapshotEvents() {
        throw new Error('session exploded')
      },
    },
  }
  await turnStopping({ agent: broken, turn: 31, signal: {} })

  await turnStopping({ agent: { id: 'no-steer', session: { snapshotEvents: () => VIOLATING_TRANSCRIPT } }, turn: 31, signal: {} })
  await turnStopping({})
})

await test('turn-stopping does not stack duplicates on its own correction', async () => {
  const turnStopping = listenerFor(log, 'agent/turn-stopping')
  const events = [...VIOLATING_TRANSCRIPT]
  const agent = {
    id: 'agent-echo',
    session: { snapshotEvents: () => events },
    steered: [],
    steer(message) {
      this.steered.push(message)
      events.push({ seq: 90 + this.steered.length, type: 'user/message', data: message })
    },
  }

  await turnStopping({ agent, turn: 1, signal: {} })
  await turnStopping({ agent, turn: 1, signal: {} })
  assert.equal(agent.steered.length, 1, 'the model has not answered the correction yet')
})

await test('turn-stopping corrects a fresh breach of the same round', async () => {
  const turnStopping = listenerFor(log, 'agent/turn-stopping')
  const events = [...VIOLATING_TRANSCRIPT]
  const agent = {
    id: 'agent-reoffend',
    session: { snapshotEvents: () => events },
    steered: [],
    steer(message) {
      this.steered.push(message)
      events.push({ seq: 90 + this.steered.length, type: 'user/message', data: message })
    },
  }

  await turnStopping({ agent, turn: 1, signal: {} })
  assert.equal(agent.steered.length, 1)

  // The model read the correction and then breached the same open round again,
  // this time in turn 2: a new act, so a new violation and a new correction.
  // (The durable record only ever dedupes the *same* act — see GRILL-31.)
  events.push({
    seq: 63,
    type: 'assistant/message',
    data: {
      turn: 2,
      step: 3,
      message: {
        id: 'a63',
        role: 'assistant',
        content: [
          { type: 'text', text: '好，继续改代码。' },
          { type: 'tool-call', callId: 'call-63-write', name: 'write', arguments: '{}' },
        ],
      },
    },
  })
  await turnStopping({ agent, turn: 2, signal: {} })
  assert.equal(agent.steered.length, 2, 'a fresh act is corrected again')
})

await test('a steered correction never reads as the user answering the round', async () => {
  const turnStopping = listenerFor(log, 'agent/turn-stopping')
  const agent = agentFor(VIOLATING_TRANSCRIPT, 'agent-correction-form')
  await turnStopping({ agent, turn: 1, signal: {} })
  const correction = agent.steered[0]
  assert.equal(correction.source.form, 'correction')

  const before = analyze(VIOLATING_TRANSCRIPT)
  const after = analyze([...VIOLATING_TRANSCRIPT, { seq: 99, type: 'user/message', data: correction }])
  assert.equal(after.active, true)
  assert.equal(after.awaitingAnswers, before.awaitingAnswers, 'a correction is not an answer')
  assert.equal(after.openQuestions.length, before.openQuestions.length)

  const directive = makeUserMessage('指令', { kind: SOURCE_KIND, form: 'directive' })
  const withDirective = analyze([...VIOLATING_TRANSCRIPT, { seq: 100, type: 'user/message', data: directive }])
  assert.equal(withDirective.awaitingAnswers, before.awaitingAnswers, 'a directive is not an answer')
  assert.equal(withDirective.openQuestions.length, before.openQuestions.length)
})

/* -- 5. hygiene ------------------------------------------------------ */

await test('module imports only node: builtins and relative sources', async () => {
  const source = await readFile(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')
  const specifiers = [...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((match) => match[1])
  assert.ok(specifiers.length >= 2, 'expected imports to be found')
  for (const specifier of specifiers) {
    const allowed = specifier.startsWith('node:') || specifier.startsWith('../') || specifier.startsWith('./')
    assert.ok(allowed, `forbidden import specifier: ${specifier}`)
  }
  // Static or dynamic import of a scoped package would fail at runtime: the
  // desktop profile ships no `@deepseek-ai` scope. (Prose in comments is fine.)
  assert.ok(!/\b(?:from|import)\s*\(?\s*['"]@/.test(source), 'must not import scoped packages')
  assert.ok(!/\brequire\s*\(/.test(source), 'must stay ESM')
})

await test('disposers tear every registration down', () => {
  const before = log.disposed
  for (const dispose of disposers) dispose()
  assert.ok(log.disposed > before, 'disposers must reach the host registrations')
  assert.equal(log.effects, 1, 'apply must register an effect for teardown')
})

/* ------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------ */

const failed = results.filter((result) => !result.ok)
console.log('')
console.log(`smoke: ${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) {
  for (const result of failed) console.log(`  FAILED: ${result.title}`)
  process.exitCode = 1
}
