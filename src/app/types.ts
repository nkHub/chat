// AG-UI 布局协议（从设计项目移植，见 components/agui/index.ts）
import type { AGUILayout } from "@/components/agui";
import type { AgentMessage, ContextWarning } from "@/lib/agent-api";
import type { LucideIcon } from "lucide-react";

type ThemePreset = {
  key: string;
  label: string;
  primary: string;
  secondary: string;
  accent: string;
  // 深色模式下的主题配色：primary 保持主题色，secondary/accent 用暗色调避免刺眼。
  dark: { primary: string; secondary: string; accent: string };
};

// 外观模式：system=跟随系统、light=浅色、dark=深色。默认跟随系统。
type ThemeMode = "system" | "light" | "dark";

type MessageStatus = "success" | "sending" | "send_failed" | "recv_failed" | "asking";

type Citation = {
  index: number;
  title: string;
  domain: string;
};

type FunctionCall = {
  name: string;
  params: Record<string, unknown>;
  result: unknown;
  status: "running" | "success" | "error";
};

// 助手消息内容按"发生顺序"组织的段序列：text=正文段、thinking=思考段、tool=工具调用段。
// 各段按序叠加展示（正文→思考→工具调用→下一段正文…），避免多轮正文互相覆盖。
// 注：流式进行中的 text 段 content 可能含有尚未闭合的代码围栏原文（正文全量累积），
// 渲染层按围栏状态切分：围栏前正文走 markdown、开放围栏代码走渐进式展示（见 chat.tsx）。
// 注 2：thinking / tool 段可带 startedAt / endedAt（毫秒时间戳），来源优先取服务端
// 事件的 ts 字段（真实执行时刻，不含网络抖动），缺失时由 App.tsx 用浏览器打点兜底。
// 过程时间线（lib/process-groups.ts）据此计算每步与整轮耗时；字段缺失不报错，只是不显示时长。
type MessageSegment =
  | { type: "text"; content: string }
  | { type: "thinking"; content: string; startedAt?: number; endedAt?: number }
  | {
      type: "tool";
      name: string;
      params: Record<string, unknown>;
      result: unknown;
      status: "running" | "success" | "error";
      startedAt?: number;
      endedAt?: number;
    };

// 消息携带附件的元数据（仅存名称/类型/大小，不保存文件内容，随会话持久化）。
// previewUrl 为图片的临时 Blob URL，仅在当前页面会话内有效，持久化时会被剔除。
type AttachmentMeta = { name: string; type: string; size: number; previewUrl?: string };

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  time: string;
  status: MessageStatus;
  streamStatus?: string;
  error?: string;
  thinking?: string;
  citations?: Citation[];
  functionCalls?: FunctionCall[];
  segments?: MessageSegment[];
  // 本轮处理耗时（毫秒）：runStartedAt=首个事件到达时刻（服务端 ts 优先），
  // runEndedAt=final 事件时刻。过程时间线的折叠头部「已处理完 X.Xs」用它，
  // 比组内首末步跨度更接近用户感知的整轮耗时（含最后一次模型输出）。
  runStartedAt?: number;
  runEndedAt?: number;
  // 过程时间线的折叠状态：true=展开看步骤、false=收起只看标题行。
  // 用户手动切换后写入消息并随会话持久化（IndexedDB 整体存 StoredChatState）。
  processOpen?: boolean;
  // 结构化布局（AG-UI）：由服务端 `custom` 事件下发，已在服务端过 layout_schema 校验。
  // 它只是**增强层**——content 始终是完整 markdown；布局缺失/校验失败/版本不认，
  // 甚至整个前端回退到旧版本，都会按 content 正常渲染（见「兼容约定」条目）。
  layout?: AGUILayout;
  files?: AttachmentMeta[];
  // 上下文管理信息：contextWarning 为占用告警（后端 context_warning 事件），
  // compacted 为本次回复运行期间自动压缩上下文的次数（final 事件携带）。
  contextWarning?: ContextWarning;
  compacted?: number;
  // 手动压缩上下文后的摘要提示消息：content 存放该轮压缩生成的摘要文本，
  // 渲染成带锁图标的摘要卡片，作为会话中被替换掉的早期历史的纸面记录；
  // 保留此标记是为了在向模型重发历史时仍能看到摘要文字。
  compactSummary?: boolean;
  // AI 调用 akm_ask_user 工具时的澄清问题：question 为问题原文，options/multiple
  // 对应三模式（无 options=自由文本、有 options 单选、options+multiple 多选），
  // messages 为后端返回的完整工作消息（用户在下面回答后拼接该上下文续跑同一轮 Agent）。
  askUser?: { question: string; options?: string[]; multiple?: boolean; messages: AgentMessage[] };
  // 发送时携带的引用：skillRef 为唯一 Skill（chip「生图」），sessionRefs 为引用的
  // 其他会话（chip 可多个，上限 3）。只存引用元数据，不在气泡里摊开摘录/模板全文；
  // P1 发送展开阶段再据 template 与被引会话内容组装请求正文。
  skillRef?: { id: string; name: string };
  sessionRefs?: { id: string; title: string }[];
};

type Session = { id: string; title: string; time: string; tools?: string[]; modelKey?: string; instructions?: string; autoTitled?: boolean };

type ChatModel = {
  key: string;
  label: string;
};

type StoredChatState = {
  sessions?: Session[];
  allMessages?: Record<string, Message[]>;
  activeSession?: string;
  selectedModelKey?: string;
  assistants?: Omit<AssistantDef, "icon" | "color">[];
};

type AssistantDef = {
  id: string;
  name: string;
  description: string;
  prompt?: string;
  icon: LucideIcon;
  color: string;
};

export type {
  ThemePreset,
  ThemeMode,
  MessageStatus,
  Citation,
  FunctionCall,
  MessageSegment,
  AttachmentMeta,
  Message,
  Session,
  ChatModel,
  StoredChatState,
  AssistantDef,
};
