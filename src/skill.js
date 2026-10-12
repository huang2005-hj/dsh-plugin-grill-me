/**
 * The two skills this plugin registers.
 *
 * The split mirrors upstream `mattpocock/skills` exactly:
 *
 *   - `grill-me` and `grill-with-docs` are the user-invoked wrappers. Upstream
 *     marks both `disable-model-invocation: true`, which in DSH is
 *     `{ modelInvocable: false, userInvocable: true }`: the model must never
 *     fire an interview on its own. `grill-with-docs` is the same interview
 *     with the documentation channel switched on (`src/state.js` reads the
 *     name back out of the transcript to decide that).
 *   - `grilling` and `domain-modeling` are the model-invocable primitives those
 *     wrappers load: the interview protocol, and the documentation protocol.
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

/** The user-invoked entry point of the documentation variant. */
export const DOCS_WRAPPER_NAME = 'grill-with-docs'

/** The model-invocable documentation primitive `grill-with-docs` loads. */
export const DOCS_PRIMITIVE_NAME = 'domain-modeling'

export const DOCS_WRAPPER_DESCRIPTION =
  '拷问 + 文档：一场不留情面的访谈，并把定下来的决策与术语当场写成 ADR 与术语表（由用户主动发起）。'

export const DOCS_PRIMITIVE_DESCRIPTION =
  '把对话里定下来的决策与术语立刻落成文档：术语一落定就写进 GLOSSARY.md，值得留痕的决策写成 docs/adr/ 下的 ADR。'

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

/**
 * Upstream `grill-with-docs` body: load both primitives, then the one rule the
 * docs variant adds — everything settled gets written down as it settles.
 *
 * Upstream is a two-line chainloader and leaves the documentation protocol to
 * `domain-modeling`; this body keeps that split and adds only what the plugin's
 * deterministic half needs: the declaration markers it books and the paths that
 * count as paying them off.
 */
export const DOCS_WRAPPER_CONTENT = `用 \`skill\` 工具加载 "grilling"，再加载 "domain-modeling"（两次调用；宿主若一步只允许一次，就先 grilling、紧接着 domain-modeling）。

之后就是正常的 grill-me 访谈，只是多了一条文档通道：

- 一个术语的含义一落定，**当场**写进 \`GLOSSARY.md\`（不许攒批），只写这个项目里这个词是什么意思。
- 一个决策同时满足"很难回退""没有上下文的人会困惑""是一次真实的取舍"三条时，提议写一条 ADR，落在 \`docs/adr/\` 下，文件名 \`NNNN-slug.md\`，序号递增。
- 文件惰性创建：真的有东西可写时才建。

**承诺即债务。** 你打算写的文档，用一行正文明确声明出来：\`📄 ADR: <标题>\` 或 \`📄 术语: <词>\`（写在正文里，不要写进代码块 —— 代码块里的一切都只是引用）。声明之后必须真的落盘：写 \`docs/adr/**\` 或 \`**/GLOSSARY.md\` 才算兑现，别的动作都不算。

本插件会记账这些声明。访谈收尾时若还有欠账，你不会收到"访谈完成、开始动手"，只会收到"先把这些文档落盘"，而且跑去做实现会被拉回来 —— 上游那个"文件写入静默不发生"的故障，就是这条通道要挡的东西。`

/**
 * Upstream `domain-modeling` body, with upstream's `GLOSSARY-FORMAT.md` and
 * `ADR-FORMAT.md` inlined.
 *
 * DSH skill registration here carries a single `content` string (upstream ships
 * the two formats as sibling files next to `SKILL.md`), so the formats are
 * folded into the body rather than referenced as resources.
 */
export const DOCS_PRIMITIVE_CONTENT = `把对话里定下来的东西，当场变成仓库里的文档。

## 术语表

一个术语的含义一落定，就**立刻**写下来 —— 不攒批、不等"回头一起整理"，那正是大多数文档悄悄消失的地方。

- 单上下文：根目录 \`GLOSSARY.md\`；多上下文：根目录 \`GLOSSARY-MAP.md\` 指向各上下文自己的 \`GLOSSARY.md\` 与 \`docs/adr/\`。
- 惰性创建：真的有词可写时才建文件。
- 只写词汇本身：这个词在这个项目里是什么意思。**不写实现细节** —— 它不是设计稿，也不是草稿纸。
- 已经有术语表时，用它来挑战用户的用词：同一个词换了意思、或两个词其实在说同一件事，都要当场指出来。

## ADR

只有三条同时成立，才值得写一条 ADR：① 这个决定很难回退；② 没有上下文的人看到代码会困惑；③ 它是一个真实的取舍（不是唯一合理的选择）。**多数决策不配 ADR** —— 一次访谈下来一条 ADR 都没有，是按设计工作，不是失败。

格式：\`docs/adr/NNNN-slug.md\`，序号递增。正文只有标题 + 一到三句（上下文 / 决定了什么 / 为什么）；Status、Considered Options、Consequences 都是可选段，不需要就删掉。

## 声明与兑现

你打算写的文档，用一行正文声明出来：\`📄 ADR: <标题>\` 或 \`📄 术语: <词>\`。声明就是债务，必须真的落盘；写 \`docs/adr/**\` 或 \`**/GLOSSARY.md\` 才算兑现。

这个技能由 DSH 的 grill-me-plugin 承载：它会记账你声明过什么、兑现了没有，并在还有欠账时拦住"访谈完成、开始动手"。`

