# dsh-plugin-grill-me

DSH 插件：把 `mattpocock/skills` 里的 **grill-me / grilling** 技能做成能装、能跑、而且**确定性生效**的 DSH 插件。

上游 grill-me 是一段提示词：它要求模型把计划当成一棵**设计树**来审问，一轮把整个 **frontier**（前提已落定、现在就能问的决策）一次问完，每题给出推荐答案，然后**等用户回答**；只有 frontier 为空、并且用户确认达成共识之后，才允许动手。

提示词会被模型忘记。这个插件在提示词之外加了一层**确定性的状态机**：它从会话记录（transcript）里推导当前处于第几轮、哪些问题还没答、frontier 是否为空，然后

- 在模型每一步之前注入当前 frontier 的状态指令（并且每一步只保留一份，不重复堆叠）；
- 在模型违反协议时（比如刚问完一轮就跑去调工具、装依赖、动手改文件）用一次纠偏消息把它拉回来；
- 提供 `/grill-me` 命令和 `grill_status` 工具，让你随时查看面试进度。

状态机是纯函数、只读转录、无副作用；所有判断都能用会话记录复现。

## 安装（从 GitHub）

插件本体零依赖，装的是一个真正的 bundle 包（`package.json` 里声明了 `dsh.bundle`，挂载行写在自带的 `cordis.patch.yml` 里，**不需要手改 profile 任何文件**）。

```powershell
# 把 <profile> 换成你的 profile 名（桌面版通常就是 desktop）
dsh plugin --profile <profile> add https://github.com/huang2005-hj/dsh-plugin-grill-me/releases/download/v0.3.5/dsh-plugin-grill-me-0.3.5.tgz
```

装完**重启 DSH**，然后在插件管理里确认 `dsh-plugin-grill-me` 处于启用状态。装好后 `skills` 目录里会出现 `grill-me` 与 `grilling` 两个技能，`/grill-me` 命令与 `grill_status` 工具随即可用。

- 想核对拿到的东西没被改过：同一页 release 里的 `SHA256SUMS.txt` 列出了两个资产的 SHA256，装之前对一下即可。
- 想连源码一起拿：同一页 release 里的 `grill-me-dsh-src-0.3.5.zip`（13 个文件，解压后 `node test/state.test.mjs` 即可复跑测试，零依赖、不需要 `npm install`）。
- 也可直接从仓库安装（拉源码）：`dsh plugin --profile <profile> add github:huang2005-hj/dsh-plugin-grill-me`。

## 装法（本机开发用）

```powershell
# 1) 打包（插件本体零依赖，直接就是可安装目录）
cd <仓库根目录>

# 2) 用 DSH 的 plugin_manager 装进当前 profile（本地目录）
#    在 DSH 会话里让模型调用 plugin_manager：
#      action=install_bundle, target=<本地目录或 npm 包名>
```

装好后 `desktop` profile 的 `patchReload: "live"` 会让它立即生效；`skills` 目录里出现 `grill-me` 与 `grilling` 两个技能。

## 用法

| 入口 | 谁触发 | 说明 |
| --- | --- | --- |
| `/grill-me` | 用户 | 上游的 wrapper：只负责加载 `grilling`。**模型不会自己调用它**（`modelInvocable: false`，等价于上游的 `disable-model-invocation: true`）。 |
| `/grilling`、`skill` 工具、触发词 | 用户 / 模型 | 真正的访谈协议本体。 |
| `grill_status` | 模型 | 只读工具：返回当前轮次、未答问题、已记录到的违规。 |
| `/grill-me` 命令 | 用户 | 打印当前面试状态。 |

典型过程：

```
你: /grill-me 帮我审一下「把本地缓存换成 SQLite」这个计划

模型: ❓ **Q1** - **<问题标题>**：<正文>
      ➡️ <推荐答案>
      ---
      ❓ **Q2** - **<问题标题>**：<正文>
      ➡️ <推荐答案>
      （一轮问完，停下等你回答）

你: 1 是，2 选 B，3 你看着办
（插件记为：这一轮已回答）
模型: ❓ **Q3** ...（下一轮 frontier）
...
frontier 为空 → 你说一句「确认」（`可以了`/`没问题`/`开始吧`/`确认理解，开始吧` 之类都行，光秃秃一个 `确认` 也算）→ 此时才允许动手；这句确认**认下就不会被撤回**，之后你再说别的话也不会把它顶掉
```

## 它到底“确定性”在哪里

- **轮次记账**：`src/state.js` 解析助手消息里的 `❓ **Qn**` 与 `➡️`，得出每一轮的问题清单。**只有带上协议自己的题头**（`❓` 或 `Qn - **标题**`）才算是「问了一轮」：普通行文里写 `Q1: … Q5: …`（季度、清单、复述刚才的问题）不算，否则模型会把自己的正文当真问题、再被指令喂回来，变成没有用户输入也会无限自转的假面试。
- **逐题记账**：一轮之后的第一条真实用户消息按题号逐题结算 —— `1 是` 记成「接受推荐」、`3 选 B` 记成「改选」、回答复述了该题自己的推荐答案（`3 no auth` 对 `➡️ No auth yet`）也算接受、**没提到的题仍然开放**，所以一轮里 Q2 没答不会被 Q1/Q3 带走。题号识别有三条通路：`Q2: …` 这种显式标签、`1 a 2 b 3 c` 这种严格递增 run，以及 `1是2两边都发3同意` 这种数字直接粘在答案上的写法（每个数字都必须真的是本轮还在开放的问题）。不做语义猜测：题号对不上本轮问题就整轮不动；而**只有**「纯肯定」（`都可以` / `yes to all three`）或本轮只剩 1 题还开放时，才会整轮一次性结清，其他没有题号的回复保持本轮开放、绝不替用户做决定。
- **确认要认账**：frontier 清空之后，`CONFIRM_RE`（`确认理解`/`全部确认`/`没问题`/`开始吧`…）算确认；**整条消息就是一个接受词**（`确认`/`同意`/`好的`/`ok`…）也算，不需要模型先写出「共享理解」那种仪式措辞（`GRILL-28`：用户打了一句光秃秃的 `确认`，插件却继续让模型等着）。更关键的是这句确认**属于说出它的那条消息**：0.3.2 每步都按「最新一条人话」重算，于是你确认完随手说一句无关的话（哪怕只是「重启了」），状态就退回 `awaiting-confirmation`，插件又开始劝模型「别动手，等确认」——正好和你的意思相反（`GRILL-30`）。0.3.3 把确认闩在它自己的 seq 上，只有在它之后**又有新一轮问题被回答**（或你给了更新的确认）时才失效；`grill_status` 会额外报出 `confirmedAtSeq`，你能看到这条确认是哪句话给的。
- **注入**：`agent/pre-step` 里若面试处于活动状态，插件追加一条 `source.kind = 'grill-me'` 的指令消息；同一步里已存在则原地替换，绝不重复堆叠。
- **纠偏**：`agent/turn-stopping` 里若检测到「问完一轮却去执行动作」，插件 `agent.steer(...)` 一条纠偏消息，强制同一轮内再走一步。纠偏预算按**违规本身**记账（`violationKey`：同一次动作、同一轮缺推荐都只纠 1 次）—— 0.2.0 按 `(agent, turn)` 记账，而每次 steer 都会开出新的 turn，于是同一条旧违规会不停把自己再喂一遍，没有用户输入也会无限自转；0.3.0 修掉了这个自转。**0.3.1 修掉了让纠偏形同虚设的那一步**（`GRILL-27`）：纠偏消息本身也是 `source.kind = 'grill-me'`，会被 `agent/pre-step` 的「原地替换」逻辑当成旧指令吞掉、换成一条全新的指令 —— 模型因此永远读不到自己刚违反了哪条规则，转录里连一条 `form = 'correction'` 的消息都不存在。现在只有 `form = 'directive'` 的插件消息会被替换，纠偏消息原样送进模型，旁边仍只有一条新指令。
- **不误伤**：普通英文里出现的 “grill / grilling” 不会激活面试，插件自己的名字也**不再**算激活词（光是提到 `grill-me` 这个插件、队友复述它的指令、转录里引用一段文档，都不该把人拖进面试）。只有**人自己写的** `/grill-me`、`/grilling`、中文触发词（拷问/盘问/质询/逼问/压力测试/grill 我），或者宿主明确标记的技能调用（`skill` 工具加载 `grilling`）才会激活；激活后一直有效，直到 `/grill-stop`、`stop grilling`、`不用问了` 之类的收尾词。

## 文件

| 路径 | 作用 |
| --- | --- |
| `src/state.js` | 纯状态机：`projectEvents` / `analyze` / `renderDirective` / `renderStatus` / `describeViolation`。零依赖。 |
| `src/skill.js` | 两个技能的正文与描述（`grill-me` wrapper + `grilling` 本体）。 |
| `lib/index.js` | Cordis 插件入口：注册技能、`grill_status` 工具、`grill-me` 命令，挂 `agent/pre-step` 与 `agent/turn-stopping`。 |
| `cordis.patch.yml` | bundle patch：把这个包挂进 loader 树。 |
| `test/` | 状态机对抗测试 + 冒烟测试。 |

## 设计约束（踩过的坑）

- 插件**不能** `import '@deepseek-ai/*'`：profile 的 `node_modules` 里没有这个 scope，宿主包都打包在 app.asar 内。所以消息构造用 `src/state.js` 里自带的 `makeUserMessage`（形状与宿主 `createUserMessage` 一致）。
- `agent/pre-step` 的 `{kind:'reject'}` 会让整个 turn 以 `blocked` 结束，可能把已经产生的工具结果悬空 —— 插件因此**只用 `enter` 注入，从不 reject**，纠偏交给 `turn-stopping` + `steer`。
- 技能名必须匹配 `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`，所以中文只出现在 `description` / 正文里。

## 卸载

`plugin_manager` 里 disable/remove 这个 bundle 即可；插件在 `apply` 里注册的 disposer 会随 Cordis 卸载自动回收。
