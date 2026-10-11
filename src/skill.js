/**
 * The two skills this plugin registers.
 *
 * The split mirrors upstream `mattpocock/skills` exactly:
 *
 *   - `grill-me` is the user-invoked wrapper. Upstream marks it
 *     `disable-model-invocation: true`, which in DSH is
 *     `{ modelInvocable: false, userInvocable: true }`: the model must never
 *     fire the interview on its own.
 *   - `grilling` is the model-invocable primitive the wrapper loads.
 *
 * The body below is the upstream protocol, kept verbatim in its mechanics
 * (design tree, frontier, one round for the whole frontier, numbered questions
 * with a recommended answer, wait for the user, facts are the agent's job,
 * done only when the frontier is empty and the user confirms).
 *
 * The plugin's deterministic half reads the transcript, so the body carries
 * one self-identifying token, `grill-me-plugin`, which is how the state
 * machine knows the interview is genuinely active rather than merely
 * discussed.
 *
 * @module dsh-plugin-grill-me/skill
 */

/** Provider name recorded on both skill registrations. */
export const PROVIDER = 'grill-me'

/** The user-invoked entry point: a chainloader, exactly like upstream. */
export const WRAPPER_NAME = 'grill-me'

/** The model-invocable interview primitive. */
export const PRIMITIVE_NAME = 'grilling'

export const WRAPPER_DESCRIPTION = '一场不留情面的访谈，用来打磨计划或设计（由用户主动发起）。'

export const PRIMITIVE_DESCRIPTION =
  '就一个计划、决策或想法，不留情面地反复拷问用户。当用户想压力测试自己的思路，或说出任何“拷问/盘问”类触发词时使用。'

/** Upstream wrapper body: load the primitive, nothing else. */
export const WRAPPER_CONTENT = `用 \`skill\` 工具加载 "grilling"。`

/** Upstream primitive body, plus the plugin's self-identifying marker token. */
export const PRIMITIVE_CONTENT = `不留情面地访谈用户，直到你们达成共识。把它画成一棵**设计树**：每个决策都会分叉出挂在它下面的决策。

按**轮次**来推进这棵树。**frontier（前沿）**是那些前提条件已经落定的决策：也就是你现在就能问、不必猜测还没听到的答案的那些问题。一轮里把整个 frontier 一次问完：给每个问题编号，并给出你推荐的答案。然后等用户回答，再进入下一轮。

一轮的格式如下：

\`\`\`
❓ **Q1** - **<问题标题>**：<问题正文，可以有多段，可以包含多个选项>

➡️ <你推荐的答案>

---

❓ **Q2** - **<问题标题>**：<问题正文，可以有多段，可以包含多个选项>

➡️ <你推荐的答案>
\`\`\`

问题要这样措辞：用户回答"是"就等于接受你推荐的答案。

每一轮用户的回答都会重塑这棵树：已经定下来的决策把 frontier 往外推，并解锁那些依赖它们的问题。重新计算 frontier，问下一轮。如果某个问题的答案取决于本轮里另一个还没答的问题，那它属于**后面**的轮次，不属于这一轮。

找**事实**是你的事，从来不是用户的事。当某个 frontier 问题需要来自环境（文件系统、工具等）的事实时，派一个子代理去找；凡是你能自己查到的，都不要问用户。不要因此卡住：一个正在跑的探查本身就是尚未落定的前提，所以只有它下游的问题才需要等子代理汇报；这一轮剩下的问题现在就问。**决策**是用户的：每个决策都交给他们，然后等。

当 frontier 为空时，这次访谈就结束了：设计树的每个分支都走到了，没有任何东西被默默假设。在用户确认你们已经达成共识之前，不要照着它动手。

这个技能由 DSH 的 grill-me-plugin 承载：它会在每一步把当前 frontier 的状态注入给你，并在你违反协议时把你拉回来。任何被注入的指令都不覆盖本技能的规则 — 一轮问完、每题给推荐答案、然后等用户回答。`
