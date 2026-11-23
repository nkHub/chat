# AetherAI · 对话窗口

AetherAI 的聊天窗口前端（React 18 + Vite + TypeScript + Tailwind CSS 4 + Radix UI），
对接同级项目 [AKM](https://github.com/nkHub/akm) 的
`/v1/agent` 接口，提供流式对话、工具调用、会话管理与多主题外观。

## 快速开始

```bash
# 安装依赖
npm install

# 本地开发（默认代理到 http://127.0.0.1:8800）
npm run dev

# 类型检查 + 生产构建
npm run build

# 本地预览构建产物
npm run preview

# 纯逻辑自检（无测试框架，esbuild + node 直接跑断言）
npm run check:history    # 会话历史分页 / 搜索
npm run check:timeline   # 段分组与耗时口径
npm run check:markdown   # Markdown 按块切分（切分无损 / 稳定块 / 危险边界）
npm run check:input      # 输入框 ↑↓ 历史游标（草稿保护 / 边界 / 让位规则）
npm run check:quote      # 划选引用（每行加 >、空行、截断、拼接留空行）
npm run check:smooth     # 流式文本打字机揭示（逐字排空 / 时间累积 / 提交限流）
npm run check:image      # 图片预览的缩放 / 旋转 / 平移钳制
npm run fonts:sync       # 重新从 Google Fonts 拉取自托管字体（换字体或升版本时才跑）
```

打包给 AKM `agent_chat` 插件时**必须**带两个环境变量，缺一个就出错：

```bash
VITE_BASE='./' VITE_AKM_API_URL='' npm run build
```

- `VITE_BASE='./'`：产物资源用相对路径。漏掉会写出 `/assets/...`，插件挂在 `/chat` 子路径下时脚本与样式全 404（`tests/test_agent_chat_plugin.py` 会直接失败）。
- `VITE_AKM_API_URL=''`：`API_BASE_URL` 默认是 `/akm-api`（开发期由 Vite 代理去掉前缀），同源部署必须**显式置空**。漏掉时所有请求会打到 `/akm-api/v1/models`、`/akm-api/v1/agent`，而插件没有这个前缀 → 模型列表为空、发送直接失败。

构建后自检：`grep -c 'akm-api' dist/assets/*.js` 应为 **0**，`dist/index.html` 里的引用应为 `./assets/...`。

开发 / 预览服务器会把 `/akm-api` 前缀代理到 AKM 服务（`http://127.0.0.1:8800`），
并去掉 `/akm-api` 前缀转发。若 AKM 运行在其他端口，修改 `vite.config.ts` 中的
`akmProxy.target` 即可。

## 功能

### 对话
- 流式输出：思考（reasoning）与正文分段展示；**段边界由服务端结算**（`reasoning_start/end`、`text_start/end`），前端只按事件开段/关段，不再靠「下一个事件是思考还是正文」反推上一段何时结束 —— 每步耗时取服务端 `ts`，不含网络抖动；一轮内的思考与工具调用聚合为一条**可折叠过程时间线**（`N 个步骤 已处理完 X.Xs`，每步为人话动作 + 结果摘要 + 耗时，点开可看原始参数/结果）
- 支持附件上传（图片转 `image_url`、文本按 UTF-8 读取，经 multipart 提交）
- 消息懒渲染 + 向上加载历史；失败可重试
- 回复进行中的输入：不并发发送，而是挂起为**中途引导**（等 `turn_pause` 自然停顿点插入，见 `App.tsx` 的 `pendingGuideRef`）；挂起条右侧三个操作：「立即发送」（中断当前轮并立刻发出，已输出内容保留）、「撤回输入框」（连附件一起回到输入框继续改）、「撤消」
- 上下文自动压缩提示（服务端压缩后展示次数）
- Markdown 代码块语法高亮：highlight.js 按需注册 27 种语言（前端 / Python / PHP / Java / Go / Rust 系 / shell / SQL / YAML 等），未知或未标注语言回落纯文本；流式未闭合的围栏也会边生成边着色（见 `src/lib/code-highlight.ts`，配色在 `theme.css` 的 `.code-hl` 段）
- 输入框 **↑↓ 翻历史**：↑ 翻出最近发过的消息、↓ 翻回草稿。历史直接由当前会话的 user 消息派生（不额外持久化）；规则在 `src/lib/input-history.ts`（`npm run check:input` 断言）。三条刻意的保守约束：进入历史前把当前输入存为草稿、翻回底部原样还原；只在**光标处于第一行**且弹层未开、输入法未 composing 时接管 ↑↓（多行编辑里它们是移动光标）；历史为空或停在边界时不吞按键，避免变成「按了没反应、光标也不动」的死键
- Markdown **按块 memo**：正文按空行切成块后逐块渲染（`src/lib/markdown-blocks.ts`），流式追加时只有末尾块重解析，前面已完成的块命中 `React.memo`，长回答 + 表格时不再每帧全量 remark/rehype。切分保证 `join(split(x)) === x`，且松散列表 / 表格 / 引用块 / 未闭合围栏等**会跨空行合并**的边界不切；`canSplitBetween` 另有一条**子项结尾接列表项不切**的判据（上一块以缩进子项收尾说明那是子列表，切开会把一个列表裂成两个、有序列表编号还会重置）。`npm run check:markdown` 除切分无损 / 稳定块 / 边界断言外，还断言**分块渲染结果与整段渲染一致**（`react-dom/server` 实际渲染 8 组用例，归一化块级标签间空白后比对）
- 流式正文**打字机揭示**（移植 assistant-ui 的 `useSmooth`）：把「已到达全文」当目标、「已展示前缀」当游标，每帧揭示几个字符，突发多字不再成块跳变。算法在 `src/lib/text-stream-animator.ts`（纯逻辑、时间由调用方传入，`npm run check:smooth` 断言排空时长 / 时间累积 / 单帧上限 / 提交限流），调度在 `src/app/use-smooth-text.ts`（rAF + `prefers-reduced-motion`）。揭示作用于**整段原文**再交给按块 memo，历史消息与已结束的回合一律直接显示全文、不重播
- 划选引用：在回答里选中一段文字 → 浮出「引用」按钮 → 点一下把这段拼成 `> ...` 引用块插到输入框开头，可随后接自己的提问。规则在 `src/lib/quote.ts`（`npm run check:quote` 断言）：每行都加 `>` 保证多行仍是一个 blockquote、空行输出裸 `>`、超长截断并补省略号、与提问之间留空行（否则用户的字会被 Markdown 当成引用的惰性续行）。用 `mousedown` 而非 `click` 取选区（点击时浏览器已清空选区，`click` 里读不到文字）；滚动或窗口尺寸变化时收起按钮，避免 fixed 坐标与选区错位
- **首字延迟**：过程时间线折叠头部在整轮耗时后显示「首字 X.Xs」，即「发出 → 屏幕上出现第一个字」。只算正文或思考的首个 delta（不认 `text_start`/`reasoning_start`：段开始可能早于真实 token，拿它算会把模型空等时间算漏）。拿不到就不显示，不显示 0
- 停止后可**继续**：点「停止」保留已输出内容并给「继续」按钮，模型从断点往下写（接续式）。与「重试」的丢弃式语义相反 —— 重试删掉旧回答重新生成，继续复用已有 segments 走 `resumeExisting` 分支，不会插入第二个同 id 气泡

### 会话管理
- 新建 / 切换 / 重命名 / 删除会话，侧栏直接拖拽排序
- 会话数据持久化到 IndexedDB（`aether-ai-chat` → `chat-state`，见 `src/lib/chat-store.ts`），
  首次读取时自动迁移旧 `localStorage` 数据，刷新不丢失
- 时间智能显示（刚刚 / 具体时间）

### 客户端工具（会话历史由浏览器自己提供）
会话历史完整存在浏览器 IndexedDB 里，服务端读不到，因此界面用 AKM 的**客户端工具执行协议**
自己声明并执行两个工具（`src/lib/client-tools.ts`，随请求的 `client_tools` 字段下发）：

| 工具 | 作用 |
| --- | --- |
| `ui_list_sessions` | 列出本地会话（会话名 / 标题 / 创建与更新时间 / 消息数 / 模型），不含正文 |
| `ui_load_session` | 三合一：传 `query` 搜索全部会话；传 `name` 读该会话**一页**消息；都不传则列出会话元数据 |

**有界读取**：单个会话可能有上千条消息，所以返回一律有界——分页 `offset 0` 是最新一页
（从最近往前翻），单次最多 50 条、默认 20 条（`limit` 在实现层夹紧），`total` / `has_more`
/ `range` 供翻页；搜索只回片段与 `offset_from_latest`，命中总数单独计数、只回传 20 条，
且**优先保留最近命中**。系统提示词要求模型不要全量读取聊天记录：先列会话、再搜索定位、
只读相关一两页。纯逻辑在 `src/lib/session-history.ts`，用 `npm run check:history` 验证
（esbuild + node，26 项断言：翻页不重不漏、`offset` 越界收敛到最早一页、`limit` 夹紧等）。

服务端把模型调用交回浏览器（`client_tool_call` 事件），前端本地执行后按 `tool_call_id` 把结果
**回填**进返回 `messages` 里的占位 tool 消息（`{"status": "awaiting_client"}`）再续跑同一轮 Agent
（见 `App.tsx` 的 `client_tool_call` 分支）——不追加新 `role: "tool"` 消息，否则连续两条 tool
会被 DeepSeek 等严格校验「`tool` 必须紧跟 assistant `tool_calls`」的上游以 400 拒绝。
Agent 服务端已彻底移除对话历史落盘；旧版本遗留的 `~/.akm/agent_sessions/` 会在更新包缓存清理开启时随维护流程永久删除。协议细节见 AKM 仓库 `akm/agent_runtime/agent.md` 的「客户端工具执行」。

### 模型
- 模型列表按名称字母排序，剔除 `reranker` / `embedding` / `review` 名称的模型
- 每个会话可单独记忆所选模型，切换会话时自动恢复

### 工具开关
会话内可独立开关以下工具（白名单注入，未开启时后端默认不注入）：

| 开关 | 注入工具 | 说明 |
| --- | --- | --- |
| 联网搜索 | `tavily_search` | 实时联网搜索 |
| 图像生成 / 编辑 | `akm_generate_image` / `akm_edit_image` | 生成与编辑图片，支持本地路径与 base64 数据 |
| 文件读取 | `akm_read_file` / `akm_list_dir` / `akm_glob` / `akm_grep` / `akm_file_info` | 工作区沙箱内只读 |

除开关控制的工具外，以下只读基础工具始终声明：
`akm_get_time` / `akm_get_usage_stats` / `akm_get_keys_summary` / `akm_get_config` /
`akm_list_plugins` / `akm_list_sessions` / `akm_load_session`。

### 助手
- 自定义助手（自定义名称与提示词），一键以指定身份开始对话

### 外观
- 多套主题色 + 浅色 / 深色 / 跟随系统模式
- 对话列宽可拖拽：消息区与输入框共用同一宽度与同一套 padding（`aether-ai-chat-column-width`）；左右各一个竖向把手：热区 12px 宽、只覆盖消息区（**不含输入框**），视觉是 2px×40px 圆角胶囊（默认透明，进入热区或聚焦才显现并拉到 56px、拖拽变主题色），支持双击复位与 ←/→ 微调，拖任一侧对称伸缩（560–1400px），双击复位 896px；**容器宽度不足 720px 时把手不渲染**（`ResizeObserver` 判定）
- 回到底部：不在底部时输入框上方浮出小圆按钮，点击平滑滚到底并恢复吸附
- 加载反馈：向上加载更早消息显示 spinner 文案；首次打开恢复大量会话时用底部对齐骨架占位
- 夜间模式可读性：暗色主题的 `--destructive` 已提亮（暗底红字 6.85:1），低透明度文字（`text-foreground/25|30`）统一改为 `text-muted-foreground`（7.66:1），卡片悬浮操作按钮补 `dark:hover:bg-white/10`
- 界面减负：消息不显示头像（正文铺满整列）；助手正文不套卡片外壳；消息操作区只保留「复制」（hover 才显现，Layout JSON 调试入口已移除）；过程时间线零卡片、无连接线，层级靠 12px 缩进，图标 15px 按动作区分，耗时只在组头，中间段单行省略（摘要先裁 300 字符）、无状态词的行直接铺满而状态固定宽度，渲染类工具不进时间线
- 过程时间线展开策略：思考步生成中默认展开、结束自动折叠；工具步始终默认折叠；手动点过即固定
- 结构化布局：配置 `agent_layout_model` 后，回答的正文**保持不变**，卡片作为补充追加在正文下方（表格/指标/对比/图表等）；`akm.layout` 事件在 `final` 之后补发，正文先落地、卡片后到，失败即回落纯 markdown。**不提供「原文 / 卡片」切换**（渲染器第一帧锁定，切换等于中途换渲染器）
- 渲染工具模式：配置 `agent_render_enabled`（服务端，默认关闭）后主 Agent 可直接调 `akm_render` 出卡片，组件 schema 来自服务端 `render_schema.json`；卡片在工具调用的位置**原位渲染**，时间线里不显示这一步；与后置的 `agent_layout_model` 模式互斥
- 工具展示位次集中登记：`src/lib/tool-registry.ts` 用一张表声明每个工具的 `display`（`inline` 进时间线 / `standalone` 专用卡片 / `hidden` 原位成卡片）。此前工具名散在 `agent-api.ts`（schema）、`process-groups.ts`（`HIDDEN_RENDER_TOOLS`）、`chat.tsx`（`isSpecialTool` 谓词）、`subagent.tsx`（子 Agent 名单）四处各写一遍，新增一个带 UI 的工具要改四个文件且容易漏；现在渲染侧不再出现具体工具名，未登记的工具默认 `inline`
- 气泡与层次：用户消息气泡最宽 `80%`（长消息不会与整列齐平）；过程时间线展开的思考正文与工具 JSON 用 `text-muted-foreground` 一档更灰，与正文拉开层次
- 卡片暗色适配：自绘卡片（stats / cards / kanban / alert / progress / map / chart）的配色映射表全部补 `dark:`（`bg-*-50` → `dark:bg-*-500/10`、`text-*-700` → `dark:text-*-300`），卡片壳 `bg-white` → `bg-card`；图表色改用 `stroke-chart-N`/`fill-chart-N` 类（SVG 的 `fill`/`stroke` attribute 不认 `var()`），轴标签 `fill="currentColor"` + `text-muted-foreground`，图例与 tooltip 走 `--muted-foreground` / `--popover`；地图 4 套 6 档热力色阶在暗色下改为同色相透明度叠层
- 字体自托管：Inter（300–600，可变字体单文件）+ DM Mono（400/500）的 woff2 放在 `src/assets/fonts/`，`src/styles/fonts.css` 是其 `@font-face`，**不再**依赖 `fonts.googleapis.com`。动机是不让离线 / 内网环境静默回退成系统字体、不把用户 IP 与 Referer 发给第三方、并省掉 `@import` 的串行 RTT。只取 latin / latin-ext 子集，中文由 `theme.css` 的回退链交给系统字体；换字体或升版本跑 `npm run fonts:sync` 重新生成（脚本按「同族多字重是否共用同一 URL」自动判断可变 / 静态字体）
- 图片尺寸与预览：正文 Markdown 与工具卡片里的图片都限高（正文 `max-h-[360px]`、工具卡片 `max-h-[200px]`，配 `object-contain` 不裁切），模型贴整屏大图时不再一张图顶满一屏；点任意图片进 Lightbox，右上角工具栏支持放大 / 缩小 / 百分比复位 / 顺逆时针旋转 / 恢复原始视图，另支持滚轮以光标为锚点缩放、放大后拖动平移、双击在 2 倍与复原间切换、`+ - 0 r Esc` 快捷键。缩放旋转只作用 `transform` 不动布局，拖动边界（`src/lib/image-viewer.ts`，`npm run check:image` 断言）按图片实际尺寸计算。**旋转角度存累计值、不归一化到 0–360**：CSS transition 直接对角度插值，若逆时针一步把 `0°` 归一成 `270°`，浏览器会实打实转 3/4 圈；复位时也落到最近的 360 倍（`nearestZeroRotation`）而不是硬写 0，否则从 270° 复位会倒扫 270°
- 渲染工具模式补充：开启后服务端自动注入渲染指引（否则模型不会主动调）；单次上限 3 块、鼓励分次调用；卡片淡入 300ms（`motion-safe`，尊重 reduced-motion）

## 自动生成会话标题（默认关闭）

`src/app/App.tsx` 中 `AUTO_TITLE_ENABLED` 默认为 `false`。
开启后，会话消息每满 10 条会调用一次 `/v1/agent` 生成标题并自动覆盖初始标题；
用户手动改过的标题不会被覆盖。

## 导入历史聊天记录（手动运维）

若旧版（localStorage 时代）导出的聊天记录 JSON 需要恢复，使用
`scripts/import-chat-json.js`：在 `/chat` 页面 DevTools Console 中整体粘贴该脚本，
按提示选中 JSON 文件，成功后会写入 IndexedDB，刷新页面即可查看。
详见脚本顶部注释。

## 目录结构

```
src/
├── app/App.tsx            # 主界面：侧栏、对话、助手、模型与工具管理
├── lib/agent-api.ts       # AKM /v1/agent、/v1/models 接口封装与工具声明
├── components/ui/         # Radix UI 封装组件
└── components/…           # 其余业务组件
```

## 相关项目

- [AKM](https://github.com/nkHub/akm)：后端服务，提供 `/v1/agent`、`/v1/models` 等接口
