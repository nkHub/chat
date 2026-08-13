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
type MessageSegment =
  | { type: "text"; content: string }
  | { type: "thinking"; content: string }
  | { type: "tool"; name: string; params: Record<string, unknown>; result: unknown; status: "running" | "success" | "error" };

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
  files?: AttachmentMeta[];
  // 上下文管理信息：contextWarning 为占用告警（后端 context_warning 事件），
  // compacted 为本次回复运行期间自动压缩上下文的次数（final 事件携带）。
  contextWarning?: ContextWarning;
  compacted?: number;
  // AI 调用 akm_ask_user 工具时的澄清问题：question 为问题原文，options/multiple
  // 对应三模式（无 options=自由文本、有 options 单选、options+multiple 多选），
  // messages 为后端返回的完整工作消息（用户在下面回答后拼接该上下文续跑同一轮 Agent）。
  askUser?: { question: string; options?: string[]; multiple?: boolean; messages: AgentMessage[] };
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
