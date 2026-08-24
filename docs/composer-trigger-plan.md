# 输入框 `$` / `/` 触发与 Skill 计划

> 状态：评估完成，未改代码。对齐 Codex：`/` 命令、`$` Skill，选中后输入框上方上拉，回填高亮用 chip。

## 1. 目标

在对话输入框用 `$` / `/` 弹出 Codex 风格上拉列表：

- `$` 引用 **实体**（随消息发出）：Skill、其他会话、后期工作流。首个真 Skill 是「生图」。
- `/` 执行 **命令**（改当前会话或立刻动作，不把固定提示词塞进来）。切到某会话走 `/`，把某会话当上下文带进来走 `$`。手动压缩上下文也走 `/`（对齐 Codex `/compact`）。
- 选中后回填成 **chip**（胶囊），实现高亮；不在原生 textarea 里给文字上色。
- 发送时前端展开：Skill 展开模板；会话引用注入该会话摘录。模型看到的是展开后的内容，而不是裸 `$生图 xxx`。

工作流是 Skill 的一种执行后端，不是 `$` 的全部。助手（整段会话人格）不进 `$`。

## 2. 现状（约束）

| 点 | 现状 | 含义 |
|---|---|---|
| 输入框 | `src/app/chat.tsx` 原生 `<textarea>`，Enter 发送，无触发字符、无浮层 | 上拉和 chip 都要新做 |
| UI 基建 | 已有 Radix Popover / Dropdown | 上拉列表够用，不必引入 cmdk / Tiptap |
| 助手 | `AssistantPage` 开新会话，写入 `session.instructions` | 人格 ≠ 本轮 Skill，先不混 |
| 图像工具 | 工具栏开关声明 `akm_generate_image`；`imageHint` 只告诉模型「可以画」 | 提示词仍靠模型自由发挥 |
| 工作流 | `/v1/flow` 列表/编辑；Agent 已始终声明 `akm_flow_*` | 缺的是用户显式点选，不是后端能力 |
| 快捷提问 | 空会话卡片 `QUICK_PROMPTS` | 不能在输入中途组合 |
| 会话数据 | `sessions[]` + `allMessages[sessionId]` 已在 IndexedDB；侧栏可切换 | 引用其他会话不缺数据，缺的是输入框 mention + 发送时注入 |
| 上下文压缩 | 后端回复中途会自动 compact，`final.compacted` 在气泡底部提示「已自动压缩 N 次」；另有 `context_warning`（占用估算） | 用户不能主动触发。长会话只能等后端自己压，或新开对话 |

发送链路：`ChatPage.send` → `App.sendMessage` → `requestAgent` → `runAgentStream`。展开必须发生在 `sendMessage` / `requestAgent` 之前，用户气泡保留短引用。

## 3. 触发语义

| 触发 | 语义 | 选中后 | 例子 |
|---|---|---|---|
| `/` | 命令：立刻执行或改会话 | 从输入框清掉该 token | `/模型`、`/停止`、`/新对话`、`/压缩` |
| `$` | 引用：插入实体，随消息发出 | 回填为 chip + 光标落在后面 | `$生图`、`$某会话标题`、`$某工作流` |

触发规则（必须卡死，否则误弹）：

- 仅 **token 边界**：行首，或空白之后。
- **IME composing 期间不弹**（中文输入法）。
- 弹层打开时：↑↓ 选择、Enter 确认、Esc 关闭、点击选中；Enter 不再发送消息。
- 过滤：对名称 / 别名 / 描述做前缀或子串匹配。
- `$` 上拉按类型分组：**Skill** → **会话** → **工作流**（后期）。助手不进 `$`。
- 会话分组排除当前会话；按 `time` 新到旧；用标题过滤。空列表时该分组不出现。

## 4. Skill 模型

Skill = 本轮约束，不是整段会话人格。

```ts
type Skill = {
  id: string;                 // 如 "image-gen"
  name: string;               // 展示名，如「生图」
  trigger: string;            // 输入 token，如 "生图"
  description: string;        // 上拉副文案
  template: string;           // 发给模型的正文，含 {{input}}
  tools?: string[];           // 本轮强制打开的 UI 工具，如 ["image"]
  extraInstructions?: string; // 仅本轮追加到 instructions
  kind: "prompt" | "workflow";
  workflowId?: string;        // kind=workflow 时使用
};
```

首个真 Skill（生图）示意：

```
id: image-gen
trigger: 生图
tools: ["image"]
template:
请调用 akm_generate_image 生成图片。
约束：电影感、高细节、无文字水印、构图完整。
用户描述：{{input}}
生成完成后把返回的图片 URL 用 Markdown 图片语法 ![图片](url) 写进回复正文。
```

用户输入：`$生图` chip + `一只猫坐在月球上`  
气泡显示：chip「生图」+ 用户原文  
请求体：展开后的 template（`{{input}}` = 用户原文）

工作流后期挂同一套 `$`：`kind: "workflow"`，选中同样是 chip。第一期不实现执行，只留数据位。

会话引用 **不是 Skill**（没有 template / tools），是另一类 mention，见下一节。

## 5. 引用其他会话（对齐 Codex mention）

Codex 可在 composer 里 mention 其他 thread，把那段对话当本轮背景，而不是切过去继续聊。本项目对应能力：

| | `$会话`（引入） | `/打开` 或点侧栏（切换） |
|---|---|---|
| 当前会话 | 不变 | 切走 |
| 被点会话 | 内容摘录进本轮请求 | 成为新的当前会话 |
| 回填 | chip，可叉掉 | 无 chip，立刻跳转 |

不要做成 `/resume` 替代侧栏。用户要的是「带着另一段对话的结论，在这里继续问」。

### 5.1 交互

```
┌─────────────────────────────────────────┐
│ [生图 ×] [登录方案讨论 ×]               │  ← Skill 1 个 + 会话 chip 可多个
│  对照那个结论，帮我写接口文档            │
│ 附件  联网  图像生成          模型  发送 │
└─────────────────────────────────────────┘
```

- 打 `$` 后会话和 Skill 同一上拉，分组标题「会话」。
- 选中：去掉 `$登录方案` 这段字，生成会话 chip，焦点回 textarea。
- 可与 Skill chip 共存（一个管模板，一个管背景）。
- 会话 chip **允许多个**，上限 **3**（再选提示已满，或顶掉最早那个）。当前会话永不出现在列表里。
- 用户气泡：chip 标题 + 原文，不把整段历史摊在气泡里。

### 5.2 发送时注入（真正带进模型）

不要只把「会话：登录方案讨论」几个字发给模型。发送链路在 `sendMessage` / `requestAgent` 之前拼一段上下文：

```
[用户引用的对话「登录方案讨论」摘录，仅作背景，不要当成当前会话里的发言]
用户：我们决定用 JWT，过期 7 天。
助手：那刷新令牌放 HttpOnly Cookie……
……

[用户本轮]
对照那个结论，帮我写接口文档
```

拼进 **请求 messages**（user content 前的 context block，或独立一条 `role: user` 的背景说明），**不写进**当前会话的用户气泡 `content`。

摘录规则（必须有上限，否则长会话会撑爆上下文）：

- 只取被引会话里 `role === "user" | "assistant"` 的成功消息（跳过 sending / 失败 / askUser 中间态）。
- 默认取 **最近 8 条**（可与现有自动标题用的 `history.slice(-8)` 对齐）。
- 单条过长则截断（例如每条 1500 字），总字符再加一道硬顶（例如 8k）。
- 思考段 / 工具原始结果默认不带；只要正文。需要工具结论时，用助手回复文本即可。
- 被引会话已被删除：chip 标失效，发送时丢弃并提示。

`Message` 展示与持久化：

```ts
skillRef?: { id: string; name: string }
sessionRefs?: { id: string; title: string }[]
```

只存引用，不把摘录快照写进气泡。下次从历史重试时按 **当时** 的 `allMessages[id]` 再摘一遍（会话被删则退化为无引用）。

### 5.3 中途引导

`pendingGuide` 必须带着 `sessionRefs`（和 `skillRef` 一样），否则回复中途插入的「对照那个会话」会丢上下文。

### 5.4 明确不做

- 不把其他会话的 `instructions` / `tools` / `modelKey` 合并进当前会话（人格和工具仍以当前会话为准）。
- 不在 `$` 里提供「切换到该会话」——那是侧栏或 `/` 命令。
- 不递归展开：被引会话里若也有 `sessionRefs`，只注入它自己的正文，不再追下一层。
- 不做服务端会话检索；数据已在前端 IndexedDB。

## 6. 高亮方案：chip，不上镜像层

原生 textarea **不能**给其中一段字单独上色。两条路里只做 chip：

```
┌─────────────────────────────────────────┐
│ [附件…]                                 │
│ [生图 ×]  一只猫坐在月球上               │  ← chip 在 textarea 上方或同行
│                                         │
│ 附件  联网  图像生成          模型  发送 │
└─────────────────────────────────────────┘
```

- 选中 Skill / 会话：去掉 `$生图` / `$登录方案` 这段字，生成对应 chip，焦点回到 textarea。
- chip 可点 × 移除。
- Skill chip **同时只允许一个**（避免模板互相覆盖）；再选新 Skill 则替换。
- 会话 chip **允许多个，上限 3**；当前会话不可选。
- 用户消息展示：chip 名称 + 原文，不把锁定提示词或被引会话全文摊在气泡里。
- `/` 命令不回填 chip，选完即执行。

不做的：textarea 透明 + HTML 镜像叠层（滚动 / 换行 / IME / 光标同步成本高，Skill 作为整块引用也不该被拆着改）。

上拉列表本身的匹配字加粗，与输入框高亮无关，一起做。

## 7. 发送时展开（约束力来源）

不要把 `$生图 xxx` 或 `$登录方案讨论` 原样丢给模型。顺序：

1. 用户气泡：`skillRef` / `sessionRefs` + 用户原文（展示用）。
2. 若有 Skill：请求 user content = `skill.template` 替换 `{{input}}`。
3. 若有会话引用：在请求 messages 前插入摘录块（见 §5.2），不写进气泡。
4. 本轮 `tools`：与会话开关做并集（生图 Skill 强制带上 `image`）。会话引用不改 tools。
5. 本轮 `instructions`：会话原有 + `skill.extraInstructions`（不写回 session）。会话引用不改 instructions。
6. 中途引导（`pendingGuide`）同样走展开，避免回复中插入的 Skill / 会话引用失效。

持久化只留引用元数据；展开后的长模板和会话摘录都不进用户气泡。

## 8. `/` 命令（第一期最小集）

| 命令 | 行为 |
|---|---|
| `/停止` | 等同当前停止按钮（仅回复进行中） |
| `/新对话` | 等同侧栏新建会话 |
| `/模型` | 打开已有模型 Popover，或在上拉里列出模型 |
| `/压缩` | 立刻压缩当前会话发给模型的历史（对齐 Codex `/compact`），不发一条用户消息 |

固定提示词不进 `/`。切到其他会话继续用侧栏，不在 `/` 里再做一套会话选择器（避免和 `$会话` 抢语义）。

## 8.1 手动压缩上下文（`/压缩`）

对齐 Codex：`/compact` 把长对话收成摘要，腾出窗口，**同一条线程继续**，不是 `/新对话`。

自动压缩已经存在（后端在跑 Agent 时自己压，前端只展示次数）。缺的是用户主动压——占用已经很高、还不想等下一轮自动触发时。

| | `/压缩` | 后端自动 compact | `/新对话` |
|---|---|---|---|
| 触发 | 用户选命令 | 回复过程中后端自行决定 | 用户开新会话 |
| 当前会话 | 不变 | 不变 | 换成空会话 |
| 界面历史 | **保留全文**（侧栏/气泡不删） | 不改界面历史 | 新会话从空开始 |
| 下次请求 | 摘要 + 水位线之后的新消息 | 后端自己处理工作集 | 无历史 |
| 回填 | 无 chip，立刻执行 | 无 | 无 |

不要做成 `$压缩` Skill。这是对当前会话的立刻动作，选完从输入框清掉，不随下一条消息发出。

### 8.1.1 交互

- `/` 上拉里有「压缩上下文」，副文案：把较早对话收成摘要，腾出窗口。
- 别名：`压缩`、`compact`。
- 选中后立刻跑，输入框里的 `/压缩` 清掉。若输入框还有别的字，保留（命令 token 只吃掉 `/压缩` 这一段）。
- 回复进行中：禁用，上拉该项灰掉或选中后提示「等回复结束再压缩」。不要跟 `pendingGuide` 抢。
- 消息过少（例如成功的 user/assistant 合计 < 6 条）：提示「对话还短，不必压缩」，不发请求。
- 进行中：composer 或会话顶一条轻提示「正在压缩上下文…」，可取消（abort 这次 summarize 请求）。
- 完成后：气泡底部或会话顶提示「已手动压缩上下文」（可与现有 `ContextHint` 并列）。失败 toast，历史不动。

可选后期：`/压缩 只保留登录方案` —— 把后面的字当引导，让摘要偏向某主题（Codex 的 prompt-guided compact）。第一期只做无参 `/压缩`。

### 8.1.2 存什么、发给模型什么

界面历史和请求历史必须拆开。**不要**为了腾 token 把 IndexedDB 里的气泡删掉。

```ts
type Session = {
  // …现有字段
  compact?: {
    summary: string;          // 较早对话的摘要正文
    untilId: string;          // 水位线：该消息及之前的正文改由 summary 代替
    at: string;               // 压缩完成时间，展示用
  };
};
```

下次 `requestAgent` 组 messages：

1. 一条背景说明（role 可用 `user` 或并进 instructions，实现时选一种写死）：
   `以下是本会话较早对话的摘要，仅作背景，不要当成用户刚发的指令。\n{summary}`
2. `untilId` **之后** 的 user/assistant 成功消息（与现在一样走 `toAgentMessages`）。
3. 本轮用户新消息。

水位线之前的气泡仍渲染，只是不再进请求。用户滚动仍能看到当时说了什么。

再次 `/压缩`：对「当前 compact.summary + 水位线之后的全部新消息」再压一次，写出新的 summary 和 untilId（覆盖 `session.compact`）。不要无限叠多份摘要。

### 8.1.3 怎么压（实现策略）

本仓库前端 **没有** 独立 compact API，只有 Agent 跑完后的 `compacted` 计数。第一期用现有 `/v1/agent` 非流式（与自动标题 `runAgent` 同类）：

```
instructions: 把对话收成一份简洁摘要，保留已做决定、约束、未完成事项、关键文件/接口名。不要展开成新任务，不要寒暄。直接输出摘要正文。
messages: 水位线之前（若已有 compact，则先放旧 summary 再放其后消息）的 user/assistant 正文。
```

约束：

- 用当前会话模型；失败不改 `session.compact`。
- 摘要本身再截断（例如 4k 字），防止摘要比原文还长。
- 不声明 tools（压缩轮禁止搜图/工作流）。
- 不写进 `allMessages` 当用户气泡。
- 与自动标题一样：失败静默或 toast，不打断正在看的历史。

若后续后端提供显式 compact（query / 独立事件），再换成调用后端，前端仍用同一套 `session.compact` 水位线，避免两套存储。

### 8.1.4 和 `$会话` 的关系

- `/压缩` 只压 **当前** 会话的请求历史。
- `$` 引用其他会话时，摘录仍按 §5.2 从被引会话的 **界面全文** 取最近 8 条，不吃对方的 `compact`。被引会话自己压过不影响「带背景过来」的完整性。
- 当前会话压完之后，本轮若同时带了 `$某会话`，请求 = 当前摘要块 + 当前水位线后消息 + 被引会话摘录 + 用户原文。

### 8.1.5 明确不做

- 不删、不折叠界面气泡（压缩不是清屏）。
- 不在 `$` 里做压缩 Skill。
- 第一期不做 prompt-guided（`/压缩 聚焦 xxx`）。
- 不把压缩摘要存成一条 assistant 消息冒充模型回复。
- 回复进行中不压（避免和正在飞的 `requestHistory` 打架）。

## 9. 分期

### P0 — 交互骨架（可点、可回填、可高亮）

- 输入框监听 `$` / `/`，token 边界 + IME 保护。
- 输入框上方上拉：分组、过滤、键盘、点击。
- `$` 选中 → chip 回填；`/` 选中 → 执行或打开对应 UI。
- Skill 先内置 2～3 条（生图必有；可再加一条「翻译」验证非工具类模板）。
- `$` 会话分组：从现有 `sessions` 出列表（排除当前），选中回填会话 chip。
- `/` 命令含「压缩」项（可先只出现在列表，真正执行放到 P1）。
- 工作流 / 助手可以不出，或工作流出占位分组但不执行。

验证：打 `$` 弹出 Skill + 其他会话；选「生图」或某会话出现 chip；发送时气泡是短引用。打 `/` 能看到停止 / 新对话 / 模型 / 压缩。

### P1 — 发送展开（约束真正生效）

- `send` / `pendingGuide` 走 Skill 模板展开。
- 生图 Skill 本轮强制 `image` 工具 + 可选 extraInstructions。
- 会话引用按 §5.2 注入摘录（最近 8 条 + 截断）。
- `Message.skillRef` / `sessionRefs` 展示与持久化。
- `/压缩`：用非流式 `runAgent` 生成摘要，写入 `session.compact`；下次 `requestAgent` 只发摘要 + 水位线之后的消息。界面历史不动。

验证：
- 同一句「一只猫坐在月球上」，带 `$生图` 时模型走 `akm_generate_image` 且提示词含锁定约束；不带则行为与现在一致。
- 引用另一会话后，本轮请求里能看到该会话的用户/助手正文；当前会话气泡只有 chip + 用户原文。
- 引用当前会话不出现在列表；被删会话 chip 发送时丢弃。
- 长会话执行 `/压缩` 后：气泡仍在；下一条普通消息的请求体变短（水位线前变摘要）；会话上出现「已手动压缩」提示。消息过少或回复中执行则拒绝。

### P2 — 工作流进 `$`

- `$` 下分组拉取 `listWorkflows()`（缓存，不要每次击键打 API）。
- 选中回填 workflow chip。
- 执行策略二选一（实现前再定）：
  - A：展开成「请调用 `akm_flow_run`，workflow_id=…，prompt={{input}}」（改动小，沿用现有 Agent 工具）。
  - B：前端直接 run，另做运行态 UI（工作流页目前只有编辑）。

推荐先 A。

### P3 — Skill 可配置（非必须）

- 用户可新增/编辑 Skill（名称、trigger、template、tools）。
- 与助手页分开：助手 = 会话人格；Skill = 本轮模板。
- 存储可走 IndexedDB（与 `chat-store` 并列）或后端；P0/P1 用常量即可。

## 10. 建议改动面

不引入新依赖。主要文件：

| 文件 | 改动 |
|---|---|
| `src/app/chat.tsx` | 触发监听、上拉锚点、chip 区、Enter 与弹层抢键、把 skill / sessionRefs 交给 `onSend` |
| 新 `src/app/composer-suggest.tsx`（名称可再定） | 上拉列表 UI + 键盘；`$` 分组渲染 |
| 新 `src/app/skills.ts` | 内置 Skill 常量与 `expandSkill(skill, input)` |
| 新 `src/app/session-ref.ts`（名称可再定） | `excerptSession(messages)`：最近 N 条、截断、拼背景块 |
| `src/app/types.ts` | `Message.skillRef` / `sessionRefs`；`Session.compact`；`onSend` 签名带引用 |
| `src/app/App.tsx` | `sendMessage` / `pendingGuide` 展开模板 + 注入会话摘录；本轮 tools/instructions 合并；`/压缩` 写 `session.compact`，`requestAgent` 按水位线组 messages |
| `src/app/blocks.tsx` | `ContextHint` 区分自动 compact 次数与手动压缩提示 |
| `src/app/constants.ts` | 不把 Skill 塞进 `QUICK_PROMPTS` / `DEFAULT_ASSISTANTS` |

P0 会话列表直接读已有 `sessions` / `allMessages`，不必改 `chat-store`。P2 才动 `listWorkflows` 与 workflow 分组。

## 11. 明确不做（本计划）

- textarea 镜像层叠高亮。
- 把助手页改造成 Skill 管理。
- 第一期前端直接 `akm_flow_run` + 运行面板。
- 一条消息多个 Skill。
- 在 `$` 里混入 `/` 命令，或反过来。
- `$会话` 切换当前会话（那是侧栏）。
- 把被引会话的人格 / 工具 / 模型合并进当前轮。
- 递归展开被引会话自己的 `sessionRefs`。
- 为腾 token 删除或折叠界面气泡。
- 把压缩摘要写成一条假的 assistant 气泡。
- 回复进行中执行 `/压缩`。
- 第一期 prompt-guided compact（`/压缩 聚焦 xxx`）。
- 为上拉引入 Tiptap / Lexical / cmdk。

## 12. 风险

- **IME**：不挡 composing 会在拼音阶段乱弹。必须读 `event.isComposing` / `keyCode === 229`。
- **Enter 冲突**：弹层打开时 Enter 只确认选项。
- **中途引导**：`pendingGuide` 若只存原文、不带 skill / sessionRefs，回复插入时约束或背景丢失。
- **chip vs 纯文本编辑**：用户不能把「生图」改成半残 `$生`；要换就叉掉再选。这是有意的。
- **工具开关**：生图 Skill 强制 `image` 仅本轮，不改会话里用户手动关着的开关持久状态（或改了要在 UI 上能看出来，实现时选一种并写死）。
- **上下文膨胀**：引用长会话若不截断会挤掉当前对话。必须硬顶条数和字符。
- **重试语义**：`sessionRefs` 只存 id，重试时按最新 `allMessages` 再摘；被删则静默降级，不要把旧全文冻在气泡里。
- **压缩丢细节**：摘要会丢约束/文件名。水位线必须留在用户可见处，且允许再压覆盖，不能默默把全文从 IndexedDB 抹掉。
- **压缩与流式请求打架**：进行中的 `requestHistory` 仍是未压缩快照；所以回复中禁止 `/压缩`。
- **双重压缩**：手动水位线之后，后端仍可能自动 compact。两者可以共存；前端不要因为 `final.compacted > 0` 就清掉 `session.compact`。

## 13. 推荐落地顺序

1. P0 上拉 + chip（Skill 常量 + 会话列表；`/` 含压缩项）。
2. P1 发送展开：生图 Skill + 会话摘录注入 + `/压缩` 真正改请求历史。
3. P2 工作流挂进同一 `$` 列表。
4. P3 再考虑用户自定义 Skill。

`$` 从第一期就按「引用实体」设计（Skill / 会话 / 后期工作流），不要先做成工作流 mention 再改造。
