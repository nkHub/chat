# AetherAI · 对话窗口

AetherAI 的聊天窗口前端（React 18 + Vite + TypeScript + Tailwind CSS 4 + Radix UI），
对接同级项目 [AKM](https://github.com/nkHub/akm)（`/Users/nk/Desktop/Ecology/ccs`）的
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

开发 / 预览服务器会把 `/akm-api` 前缀代理到 AKM 服务（`http://127.0.0.1:8800`），
并去掉 `/akm-api` 前缀转发。若 AKM 运行在其他端口，修改 `vite.config.ts` 中的
`akmProxy.target` 即可。

## 功能

### 对话
- 流式输出：思考（reasoning）与正文分段展示，工具调用内联折叠
- 支持附件上传（图片转 `image_url`、文本按 UTF-8 读取，经 multipart 提交）
- 消息懒渲染 + 向上加载历史；失败可重试
- 回复进行中禁止再次发送，避免并发请求打乱上下文
- 上下文自动压缩提示（服务端压缩后展示次数）

### 会话管理
- 新建 / 切换 / 重命名 / 删除会话，侧栏直接拖拽排序
- 会话数据持久化到 `localStorage`（`aether-ai-chat-state`），刷新不丢失
- 时间智能显示（刚刚 / 具体时间）

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

## 自动生成会话标题（默认关闭）

`src/app/App.tsx` 中 `AUTO_TITLE_ENABLED` 默认为 `false`。
开启后，会话消息每满 10 条会调用一次 `/v1/agent` 生成标题并自动覆盖初始标题；
用户手动改过的标题不会被覆盖。

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
