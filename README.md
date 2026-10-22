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
- 流式输出：思考（reasoning）与正文分段展示；一轮内的思考与工具调用聚合为一条**可折叠过程时间线**（`N 个步骤 已处理完 X.Xs`，每步为人话动作 + 结果摘要 + 耗时，点开可看原始参数/结果）
- 支持附件上传（图片转 `image_url`、文本按 UTF-8 读取，经 multipart 提交）
- 消息懒渲染 + 向上加载历史；失败可重试
- 回复进行中禁止再次发送，避免并发请求打乱上下文
- 上下文自动压缩提示（服务端压缩后展示次数）

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
- 气泡与层次：用户消息气泡最宽 `80%`（长消息不会与整列齐平）；过程时间线展开的思考正文与工具 JSON 用 `text-muted-foreground` 一档更灰，与正文拉开层次
- 卡片暗色适配：自绘卡片（stats / cards / kanban / alert / progress / map / chart）的配色映射表全部补 `dark:`（`bg-*-50` → `dark:bg-*-500/10`、`text-*-700` → `dark:text-*-300`），卡片壳 `bg-white` → `bg-card`；图表色改用 `stroke-chart-N`/`fill-chart-N` 类（SVG 的 `fill`/`stroke` attribute 不认 `var()`），轴标签 `fill="currentColor"` + `text-muted-foreground`，图例与 tooltip 走 `--muted-foreground` / `--popover`；地图 4 套 6 档热力色阶在暗色下改为同色相透明度叠层
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
