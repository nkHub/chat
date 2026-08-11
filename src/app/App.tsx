import { Children, Fragment, createContext, isValidElement, memo, useContext, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import {
  AlertCircle,
  ArrowRight,
  Bot,
  Brain,
  Check,
  ChevronLeft,
  ChevronDown,
  ChevronRight,
  CircleStop,
  Clock,
  Copy,
  Cpu,
  ExternalLink,
  HelpCircle,
  ImageIcon,
  Loader2,
  MessageSquare,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Paperclip,
  Pause,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Search,
  Send,
  Settings,
  Share2,
  Sun,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  Wrench,
  Workflow as WorkflowIcon,
  X,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { Background, BackgroundVariant, Controls, Handle, Position, ReactFlow, addEdge, useEdgesState, useNodesState, type Connection, type Edge, type Node, type NodeProps, type NodeTypes } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { fetchModels, runAgent, runAgentStream, resolveDeclaredTools, listTasks, createTask, updateTask, deleteTask, runTask, listWorkflows, createWorkflow, updateWorkflow, deleteWorkflow, listFlowTemplates, instantiateFlowTemplate, API_BASE_URL, type AgentMessage, type ApiModel, type ContextWarning, type ScheduledTask, type TaskPayload, type TaskType, type FlowNodeType, type NodeExecutor, type Workflow, type WorkflowEdge, type WorkflowNode, type WorkflowNodeData } from "@/lib/agent-api";
import { loadChatState, saveChatState } from "@/lib/chat-store";

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

// 外观模式独立持久化，与会话状态解耦（也方便 index.html 首屏脚本只读该键避免闪烁）。
// 注：聊天会话状态已迁移到 IndexedDB（见 src/lib/chat-store.ts），不再使用 localStorage。
const THEME_MODE_KEY = "aether-ai-theme-mode";
// 主题色独立持久化：key 对应 THEMES 中的 theme.key，读取失败/非法时回退到默认蓝色。
const THEME_KEY = "aether-ai-theme-key";
const AGENT_INSTRUCTIONS = "你是 AetherAI 内置助手，请用中文回复，回答要清晰、准确、可执行。";

// 是否启用「自动生成会话标题」：会话消息每满 10 条时用 /v1/agent 生成一次标题。
// 默认关闭（false），避免每次会话额外消耗一次模型请求；改为 true 可开启。
const AUTO_TITLE_ENABLED = false;

const THEME_MODES: { key: ThemeMode; label: string; icon: LucideIcon }[] = [
  { key: "system", label: "跟随系统", icon: Monitor },
  { key: "light", label: "浅色", icon: Sun },
  { key: "dark", label: "深色", icon: Moon },
];

const THEMES: ThemePreset[] = [
  { key: "blue", label: "蓝色", primary: "#1a56db", secondary: "#eef2ff", accent: "#dbeafe", dark: { primary: "#3b82f6", secondary: "oklch(0.3 0.08 264)", accent: "oklch(0.35 0.09 264)" } },
  { key: "violet", label: "紫色", primary: "#7c3aed", secondary: "#f5f3ff", accent: "#ede9fe", dark: { primary: "#8b5cf6", secondary: "oklch(0.3 0.08 294)", accent: "oklch(0.35 0.09 294)" } },
  { key: "rose", label: "玫瑰", primary: "#e11d48", secondary: "#fff1f2", accent: "#ffe4e6", dark: { primary: "#f43f5e", secondary: "oklch(0.3 0.07 10)", accent: "oklch(0.35 0.08 10)" } },
  { key: "emerald", label: "翠绿", primary: "#059669", secondary: "#ecfdf5", accent: "#d1fae5", dark: { primary: "#10b981", secondary: "oklch(0.3 0.07 160)", accent: "oklch(0.35 0.08 160)" } },
  { key: "amber", label: "琥珀", primary: "#d97706", secondary: "#fffbeb", accent: "#fef3c7", dark: { primary: "#f59e0b", secondary: "oklch(0.31 0.07 75)", accent: "oklch(0.36 0.08 75)" } },
  { key: "slate", label: "石墨", primary: "#334155", secondary: "#f1f5f9", accent: "#e2e8f0", dark: { primary: "#64748b", secondary: "oklch(0.29 0.01 250)", accent: "oklch(0.34 0.01 250)" } },
];

const QUICK_PROMPTS = [
  { icon: Brain, label: "技术答疑", prompt: "帮我解释一下这段代码的含义和潜在问题。" },
  { icon: Zap, label: "效率提升", prompt: "帮我优化以下工作流程，让它更高效。" },
  { icon: Search, label: "深度研究", prompt: "帮我调研并总结该领域的最新进展。" },
  { icon: Wrench, label: "方案设计", prompt: "帮我设计一个可落地的技术方案，包含架构图和步骤。" },
];

type AssistantDef = {
  id: string;
  name: string;
  description: string;
  prompt?: string;
  icon: LucideIcon;
  color: string;
};

const DEFAULT_ASSISTANTS: AssistantDef[] = [
  { id: "researcher", name: "研究助手", description: "梳理资料、提炼重点，快速形成研究结论。", icon: Search, color: "bg-blue-100 text-blue-600" },
  { id: "writer", name: "写作助手", description: "把零散想法整理成清晰、有说服力的文字。", icon: Pencil, color: "bg-violet-100 text-violet-600" },
  { id: "coder", name: "编码助手", description: "分析代码、定位问题，给出可落地的实现建议。", icon: Cpu, color: "bg-emerald-100 text-emerald-600" },
];

// ---- 工作流节点显示元信息（类型/颜色/执行器），flow 类型定义与 API 在 agent-api.ts ----
// 节点类型：与 flow 引擎的 10 种内置节点一致；节点显示元信息（中文名/颜色/描述）参考 flow 配置页。
const NODE_META: Record<FlowNodeType, { label: string; color: string; description: string }> = {
  intake: { label: "需求输入", color: "#22c55e", description: "接收需求或用户输入" },
  plan: { label: "方案规划", color: "#8b5cf6", description: "规划实现方案" },
  code: { label: "编码实现", color: "#3b82f6", description: "编写代码" },
  review: { label: "代码审查", color: "#f59e0b", description: "审查变更" },
  test: { label: "测试验证", color: "#06b6d4", description: "运行测试" },
  fix: { label: "修复迭代", color: "#ef4444", description: "修复失败项" },
  human: { label: "人工审批", color: "#ec4899", description: "人工审批门" },
  router: { label: "条件路由", color: "#14b8a6", description: "按条件分支" },
  merge: { label: "汇合", color: "#64748b", description: "合并多条路径" },
  output: { label: "交付输出", color: "#10b981", description: "汇总输出结果" },
};

// 节点执行器：决定该节点由谁执行，参考 flow 配置页的执行器下拉。
const EXECUTOR_META: Record<NodeExecutor, { label: string; description: string }> = {
  llm: { label: "LLM", description: "对话模型调用" },
  "pi-agent": { label: "Pi Agent", description: "编码代理" },
  human: { label: "人工", description: "人工审批门" },
  none: { label: "无", description: "透传 / 合并，不调模型" },
};

// 按节点数组顺序自动生成相邻连线（展示用；后端可自行解析）。
function buildFlowEdges(nodes: WorkflowNode[]): WorkflowEdge[] {
  return nodes.slice(0, -1).map((node, index) => ({
    id: `edge-${node.id}-${nodes[index + 1].id}`,
    source: node.id,
    target: nodes[index + 1].id,
  }));
}

// 构造一个流程节点（新建工作流时的起始节点链、表单内添加节点共用）。
function demoNode(id: string, type: FlowNodeType, label: string, data: Partial<WorkflowNodeData> = {}): WorkflowNode {
  return { id, type, position: { x: 0, y: 0 }, data: { label, modelId: "", systemPrompt: "", userPromptTemplate: "", ...data } };
}

// ---- 工作流可视化编辑器（@xyflow/react）辅助类型与组件 ----
// 画布节点：在 WorkflowNodeData 基础上合并 nodeType，供自定义节点渲染出类型色点/徽章。
type CanvasNode = Node<WorkflowNodeData & { nodeType: FlowNodeType }>;
// 画布边：condition/loop 等业务字段放在 data 里（React Flow 的边也支持 data）。
type CanvasEdge = Edge<{ condition?: string; loop?: boolean }>;

// WorkflowNode[] → 画布节点[]：把 type 合并进 data.nodeType。
function toCanvasNodes(nodes: WorkflowNode[]): CanvasNode[] {
  return nodes.map(node => ({
    id: node.id,
    position: node.position,
    type: "flowNode",
    data: { ...node.data, nodeType: node.type },
  }));
}

// 画布节点[] → WorkflowNode[]：从 data 解构回 type，其余字段作为节点数据。
function toWorkflowNodes(canvasNodes: CanvasNode[]): WorkflowNode[] {
  return canvasNodes.map(node => {
    const { nodeType, ...data } = node.data;
    return { id: node.id, type: nodeType, position: node.position, data };
  });
}

// 画布边[] → WorkflowEdge[]：取出 data 里的 condition/loop 业务字段，label 若为空不写入。
function toWorkflowEdges(edges: CanvasEdge[]): WorkflowEdge[] {
  return edges.map(edge => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    ...(typeof edge.label === "string" && edge.label ? { label: edge.label } : {}),
    ...(edge.data?.condition ? { condition: edge.data.condition } : {}),
    ...(edge.data?.loop ? { loop: true } : {}),
  }));
}

// 自定义画布节点：色点 + 名称 + 类型徽章 + 执行器徽章 + 模型名截断 + 左右连接点。
// 参考 flow 项目的 FlowNode 组件，配色适配本项目的浅色主题。
const WorkflowCanvasNode = memo(({ data, selected }: NodeProps<CanvasNode>) => {
  const meta = NODE_META[data.nodeType];
  const executorShort: Partial<Record<NodeExecutor, string>> = { "pi-agent": "Pi", human: "人工", none: "透传" };
  const executorText = data.executor ? (executorShort[data.executor] ?? "LLM") : "LLM";
  return (
    <div className={cn(
      "min-w-[180px] max-w-[240px] rounded-xl border bg-card px-3 py-2 shadow-sm transition-shadow",
      selected ? "border-primary ring-2 ring-primary/30" : "border-border",
    )}>
      <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border-0 !bg-muted-foreground" />
      <div className="flex items-center gap-1.5">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: meta.color }} />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">{data.label || meta.label}</span>
      </div>
      <div className="mt-1.5 flex items-center gap-1">
        <span className="rounded bg-muted px-1 py-px text-[10px] font-medium text-muted-foreground">{meta.label}</span>
        <span className="rounded bg-muted px-1 py-px text-[10px] text-muted-foreground">{executorText}</span>
        {data.modelId ? <span className="min-w-0 flex-1 truncate text-right text-[10px] text-muted-foreground/70">{data.modelId}</span> : null}
      </div>
      <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border-0 !bg-muted-foreground" />
    </div>
  );
});

// React Flow 自定义节点注册表：flowNode 用于渲染业务节点。
const workflowNodeTypes: NodeTypes = { flowNode: WorkflowCanvasNode };

// 规范化从存储层读出的聊天状态：
// 迁移旧数据：会话时间跟随最后一条消息的时间（空会话保留创建时间），
// 早期"刚刚"硬编码的会话补上当前时刻。非法/损坏数据返回 null。
function normalizeStoredState(parsed: unknown): StoredChatState | null {
  if (!parsed || typeof parsed !== "object") return null;
  const state = parsed as StoredChatState;
  if (Array.isArray(state.sessions)) {
    state.sessions = state.sessions.map(session => {
      const list = state.allMessages?.[session.id];
      const lastTime = list && list.length > 0 ? list[list.length - 1].time : "";
      const time = lastTime || (session.time === "刚刚" ? nowTime() : session.time);
      return { ...session, time };
    });
  }
  return state;
}

function toChatModel(model: ApiModel): ChatModel {
  return {
    key: model.id,
    label: model.id,
  };
}

// 存储用完整时间戳（ISO 字符串），保留日期信息以便会话时间按"今天/本周/更早"智能展示。
function nowTime(date = new Date()) {
  return date.toISOString();
}

// 会话时间智能展示：今天显示 HH:mm，本周内（非今天）显示周几，更早显示 MM:DD。
// 兼容无日期信息的旧数据（如 "14:30"），无法解析时原样返回。
function formatDisplayTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(date);
  }
  const startOfWeek = new Date(now);
  startOfWeek.setHours(0, 0, 0, 0);
  startOfWeek.setDate(startOfWeek.getDate() - ((startOfWeek.getDay() + 6) % 7));
  if (date >= startOfWeek) {
    return ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][date.getDay()];
  }
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${month}:${day}`;
}

// 会话列表使用的相对时间：随时间推进持续变化（配合侧栏的定时/回前台刷新）。
// 超过本周的会话用"MM-DD"（横杠分隔），避免与"时:分"歧义。
function formatRelativeTime(value: string, now: Date = new Date()) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const diffMs = now.getTime() - date.getTime();
  if (diffMs < 0) return "刚刚";
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "昨天";
  if (days < 7) return `${days} 天前`;
  const startOfWeek = new Date(now);
  startOfWeek.setHours(0, 0, 0, 0);
  startOfWeek.setDate(startOfWeek.getDate() - ((startOfWeek.getDay() + 6) % 7));
  if (date >= startOfWeek) {
    return ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][date.getDay()];
  }
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${month}-${day}`;
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map(item => {
        if (!item || typeof item !== "object") return "";
        const record = item as Record<string, unknown>;
        return typeof record.text === "string" ? record.text : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object") return JSON.stringify(content, null, 2);
  return "";
}

// 汇总一条助手消息的全部正文文本（segments 模式取所有 text 段，旧消息直接取 content），
// 用于占位判断、复制操作等。
function messageText(message: Message): string {
  if (message.segments?.length) {
    return message.segments
      .filter(segment => segment.type === "text")
      .map(segment => segment.content)
      .join("\n\n");
  }
  return message.content;
}

// 上下文管理提示条：展示本次回复的自动压缩次数。
// 压缩发生在服务端，前端仅消费 final.compacted 事件做展示。
function ContextHint({ compacted }: { compacted?: number }) {
  if (!compacted || compacted <= 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 px-0.5 text-[11px] text-muted-foreground">
      <span className="inline-flex items-center gap-1">
        <Check size={11} className="shrink-0 text-primary" />
        已自动压缩上下文 {compacted} 次
      </span>
    </div>
  );
}

function toAgentMessages(messages: Message[]): AgentMessage[] {
  return messages
    .filter(message => message.role === "user" || message.role === "assistant")
    .filter(message => message.status !== "send_failed" && message.status !== "recv_failed")
    .map(message => ({ role: message.role, content: message.content }));
}

function applyTheme(theme: ThemePreset, dark = false) {
  // 深色模式下使用 theme.dark 配色：primary 保持主题色，secondary/accent 用暗色避免刺眼。
  const colors = dark ? theme.dark : theme;
  const root = document.documentElement;
  root.style.setProperty("--primary", colors.primary);
  root.style.setProperty("--primary-foreground", "#ffffff");
  root.style.setProperty("--secondary", colors.secondary);
  root.style.setProperty("--secondary-foreground", dark ? "#f8fafc" : theme.primary);
  root.style.setProperty("--accent", colors.accent);
  root.style.setProperty("--accent-foreground", dark ? "#f8fafc" : theme.primary);
  root.style.setProperty("--ring", colors.primary);
  root.style.setProperty("--sidebar-primary", colors.primary);
}

// 清除 Radix modal 可能残留的背景滚动/交互锁定（body/html 的 overflow 与 pointer-events），避免页面无法滚动/点击。
function clearModalResidue() {
  const leftover = Array.from(document.body.classList).filter(c => c.startsWith("block-interactivity-") || c.startsWith("allow-interactivity-"));
  leftover.forEach(c => document.body.classList.remove(c));
  document.body.style.overflow = "";
  document.body.style.pointerEvents = "";
  document.documentElement.style.overflow = "";
  document.documentElement.style.pointerEvents = "";
}

function nodeToText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeToText).join("");
  if (isValidElement(node)) return nodeToText((node as ReactElement<{ children?: ReactNode }>).props.children);
  return "";
}

const MARKDOWN_COMPONENTS: Components = {
  h1: ({ node: _node, ...props }) => <h1 className="mb-1 mt-3 text-lg font-semibold text-foreground" {...props} />,
  h2: ({ node: _node, ...props }) => <h2 className="mb-1 mt-3 text-base font-semibold text-foreground" {...props} />,
  h3: ({ node: _node, ...props }) => <h3 className="mb-1 mt-3 text-sm font-semibold text-foreground" {...props} />,
  h4: ({ node: _node, ...props }) => <h4 className="mb-1 mt-2 text-sm font-semibold text-foreground" {...props} />,
  h5: ({ node: _node, ...props }) => <h5 className="mb-1 mt-2 text-sm font-semibold text-foreground" {...props} />,
  h6: ({ node: _node, ...props }) => <h6 className="mb-1 mt-2 text-sm font-semibold text-foreground" {...props} />,
  p: ({ node: _node, ...props }) => <p className="mb-1 text-sm leading-relaxed text-foreground/80" {...props} />,
  a: ({ node: _node, ...props }) => <a target="_blank" rel="noreferrer noopener" className="text-primary underline underline-offset-2 hover:opacity-80" {...props} />,
  strong: ({ node: _node, ...props }) => <strong className="font-semibold text-foreground" {...props} />,
  em: ({ node: _node, ...props }) => <em className="italic text-foreground/80" {...props} />,
  del: ({ node: _node, ...props }) => <del className="text-muted-foreground" {...props} />,
  ul: ({ node: _node, ...props }) => <ul className="my-2 list-disc space-y-1.5 pl-5" {...props} />,
  ol: ({ node: _node, ...props }) => <ol className="my-2 list-decimal space-y-1.5 pl-5" {...props} />,
  li: ({ node: _node, ...props }) => <li className="text-sm leading-relaxed text-foreground/80" {...props} />,
  blockquote: ({ node: _node, ...props }) => <blockquote className="my-2 border-l-2 border-primary/40 pl-3 italic text-muted-foreground" {...props} />,
  hr: ({ node: _node, ...props }) => <hr className="my-3 border-border" {...props} />,
  img: ({ node: _node, alt, ...props }) => {
    const { openPreview } = useContext(PreviewContext);
    return (
      <img
        alt={alt ?? ""}
        className="my-2 max-w-full cursor-zoom-in rounded-lg"
        {...props}
        onClick={() => { if (props.src) openPreview(props.src); }}
      />
    );
  },
  code: ({ node: _node, ...props }) => <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-primary" {...props} />,
  pre: ({ children }) => {
    const first = Children.toArray(children)[0];
    const className = isValidElement(first) ? (first.props as { className?: string })?.className : undefined;
    const language = /language-(\w+)/.exec(className ?? "")?.[1] ?? "";
    return <CodeBlock code={nodeToText(children)} language={language} />;
  },
  table: ({ node: _node, children, ...props }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-sm text-foreground/80" {...props}>{children}</table>
    </div>
  ),
  thead: ({ node: _node, ...props }) => <thead className="bg-muted/50" {...props} />,
  th: ({ node: _node, ...props }) => <th className="border border-border px-3 py-2 text-left text-xs font-semibold text-foreground" {...props} />,
  td: ({ node: _node, ...props }) => <td className="border border-border px-3 py-2 align-top text-sm text-foreground/80" {...props} />,
  input: ({ node: _node, ...props }) => <input className="mr-1.5 accent-primary" disabled {...props} />,
};

function CodeBlock({ code, language }: { code: string; language: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="my-3 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950 text-xs font-mono">
      <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900 px-3 py-1.5">
        <span className="text-xs uppercase tracking-wider text-zinc-500">{language || "code"}</span>
        <button
          type="button"
          className="flex items-center gap-1 text-xs text-zinc-500 transition-colors hover:text-zinc-200"
          onClick={() => {
            navigator.clipboard.writeText(code).catch(() => undefined);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1600);
          }}
        >
          {copied ? <Check size={11} /> : <Copy size={11} />}
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 leading-relaxed text-zinc-300"><code>{code}</code></pre>
    </div>
  );
}

function renderMarkdown(text: string, components: Components = MARKDOWN_COMPONENTS) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[[rehypeKatex, { strict: false, throwOnError: false }]]}
      components={components}
    >
      {text}
    </ReactMarkdown>
  );
}

// 记忆化 Markdown 渲染：仅当内容变化时才重新解析，避免消息列表全量重渲染时重复解析未变化的消息。
const MemoMarkdown = memo(function MemoMarkdown({ content, components }: { content: string; components?: Components }) {
  return <div>{renderMarkdown(content, components)}</div>;
});

// 思考过程的 Markdown 组件映射：与正文（MARKDOWN_COMPONENTS）区分，整体走淡紫色调，深色模式下同步加深。
const THINKING_COMPONENTS: Components = {
  h1: ({ node: _node, ...props }) => <h1 className="mb-1 mt-2 text-sm font-semibold text-violet-900 dark:text-violet-100" {...props} />,
  h2: ({ node: _node, ...props }) => <h2 className="mb-1 mt-2 text-sm font-semibold text-violet-900 dark:text-violet-100" {...props} />,
  h3: ({ node: _node, ...props }) => <h3 className="mb-1 mt-2 text-sm font-semibold text-violet-900 dark:text-violet-100" {...props} />,
  h4: ({ node: _node, ...props }) => <h4 className="mb-1 mt-2 text-sm font-semibold text-violet-900 dark:text-violet-100" {...props} />,
  h5: ({ node: _node, ...props }) => <h5 className="mb-1 mt-2 text-sm font-semibold text-violet-900 dark:text-violet-100" {...props} />,
  h6: ({ node: _node, ...props }) => <h6 className="mb-1 mt-2 text-sm font-semibold text-violet-900 dark:text-violet-100" {...props} />,
  p: ({ node: _node, ...props }) => <p className="mb-1 text-sm leading-relaxed text-violet-700/80 dark:text-violet-300/80" {...props} />,
  a: ({ node: _node, ...props }) => <a target="_blank" rel="noreferrer noopener" className="text-violet-600 underline underline-offset-2 hover:opacity-80 dark:text-violet-400" {...props} />,
  strong: ({ node: _node, ...props }) => <strong className="font-semibold text-violet-900 dark:text-violet-100" {...props} />,
  em: ({ node: _node, ...props }) => <em className="italic text-violet-700/80 dark:text-violet-300/80" {...props} />,
  del: ({ node: _node, ...props }) => <del className="text-violet-500 dark:text-violet-400" {...props} />,
  ul: ({ node: _node, ...props }) => <ul className="my-2 list-disc space-y-1.5 pl-5" {...props} />,
  ol: ({ node: _node, ...props }) => <ol className="my-2 list-decimal space-y-1.5 pl-5" {...props} />,
  li: ({ node: _node, ...props }) => <li className="text-sm leading-relaxed text-violet-700/80 dark:text-violet-300/80" {...props} />,
  blockquote: ({ node: _node, ...props }) => <blockquote className="my-2 border-l-2 border-violet-400/50 pl-3 italic text-violet-600 dark:border-violet-500/50 dark:text-violet-300" {...props} />,
  hr: ({ node: _node, ...props }) => <hr className="my-3 border-violet-200 dark:border-violet-800/40" {...props} />,
  img: ({ node: _node, alt, ...props }) => {
    const { openPreview } = useContext(PreviewContext);
    return (
      <img
        alt={alt ?? ""}
        className="my-2 max-w-full cursor-zoom-in rounded-lg"
        {...props}
        onClick={() => { if (props.src) openPreview(props.src); }}
      />
    );
  },
  code: ({ node: _node, ...props }) => <code className="rounded bg-violet-100 px-1.5 py-0.5 font-mono text-xs text-violet-800 dark:bg-violet-900/50 dark:text-violet-200" {...props} />,
  pre: ({ node: _node, children }) => (
    <pre className="my-2 overflow-x-auto rounded-lg border border-violet-200 bg-violet-100/60 p-2.5 font-mono text-xs leading-relaxed text-violet-800 dark:border-violet-800/40 dark:bg-violet-900/40 dark:text-violet-200">
      <code>{nodeToText(children)}</code>
    </pre>
  ),
  table: ({ node: _node, children, ...props }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-sm text-violet-700/80 dark:text-violet-300/80" {...props}>{children}</table>
    </div>
  ),
  thead: ({ node: _node, ...props }) => <thead className="bg-violet-100/60 dark:bg-violet-900/40" {...props} />,
  th: ({ node: _node, ...props }) => <th className="border border-violet-200 px-3 py-2 text-left text-xs font-semibold text-violet-900 dark:border-violet-800/40 dark:text-violet-100" {...props} />,
  td: ({ node: _node, ...props }) => <td className="border border-violet-200 px-3 py-2 align-top text-sm text-violet-700/80 dark:border-violet-800/40 dark:text-violet-300/80" {...props} />,
  input: ({ node: _node, ...props }) => <input className="mr-1.5 accent-violet-600 dark:accent-violet-400" disabled {...props} />,
};

// 思考过程折叠块：默认展开状态由 defaultOpen 决定（最新消息默认展开），
// 展开/收起状态由组件内部记忆，重新渲染不会重置。
function ThinkingBlock({ text, defaultOpen = false }: { text: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details open={open} className="mb-2.5 overflow-hidden rounded-lg border border-violet-200 bg-violet-50/60 dark:border-violet-800/40 dark:bg-violet-950/40">
      <summary onClick={event => { event.preventDefault(); setOpen(value => !value); }} className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-left text-xs text-violet-600 dark:text-violet-300">
        <Brain size={12} className="shrink-0 text-violet-500 dark:text-violet-400" />
        <span className="font-medium">思考过程</span>
        <span className="ml-auto text-xs text-muted-foreground">{open ? "收起" : "展开"}</span>
      </summary>
      <div onClick={() => setOpen(false)} className="border-t border-violet-200 px-3 pb-3 pt-2 leading-relaxed dark:border-violet-800/40">
        <MemoMarkdown components={THINKING_COMPONENTS} content={text} />
      </div>
    </details>
  );
}

// 把服务端返回的图片 http_url（http://127.0.0.1:{port}/agent-uploads/xxx）转成
// 可访问的相对路径：开发模式经 Vite 代理走 /akm-api/agent-uploads/xxx，
// 打包为 AKM 插件同源部署时 API_BASE_URL 为空串，直接走 /agent-uploads/xxx。
// 避免端口硬编码与跨源问题。
// 图片点击预览：通过 Context 向各图片渲染处暴露"打开大图预览"回调。
const PreviewContext = createContext<{ openPreview: (url: string) => void }>({ openPreview: () => {} });

// 全屏图片预览遮罩：点击遮罩或按 Esc 关闭，点击图片本身不关闭。
function Lightbox({ url, onClose }: { url: string; onClose: () => void }) {
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6" onClick={onClose}>
      <img src={url} alt="预览" className="max-h-full max-w-full rounded-lg object-contain shadow-2xl" onClick={event => event.stopPropagation()} />
    </div>
  );
}

function toImageSrc(url: string): string {
  const match = url.match(/^https?:\/\/[^/]+(\/agent-uploads\/[^/]+)/);
  return match ? `${API_BASE_URL}${match[1]}` : url;
}

// 提取图片生成/编辑工具返回的图片 URL 列表，用于直接预览。
// 优先使用 http_url（服务端已下载保存的本地访问地址），其次用上游 url。
function extractGeneratedImages(result: unknown): string[] {
  if (!result || typeof result !== "object") return [];
  const images = (result as { images?: unknown }).images;
  if (!Array.isArray(images)) return [];
  const urls: string[] = [];
  for (const item of images) {
    if (item && typeof item === "object") {
      const record = item as { http_url?: unknown; url?: unknown };
      const src = record.http_url ?? record.url;
      if (typeof src === "string" && src.trim()) urls.push(toImageSrc(src));
    }
  }
  return urls;
}

function FunctionCallBlock({ calls }: { calls: FunctionCall[] }) {
  const { openPreview } = useContext(PreviewContext);
  return (
    <div className="mb-2.5 overflow-hidden rounded-lg border border-amber-200 bg-amber-50/70 dark:border-amber-800/40 dark:bg-amber-950/40">
      <div className="flex items-center gap-2 border-b border-amber-200 px-3 py-2 text-xs font-medium text-amber-700 dark:border-amber-800/40 dark:text-amber-300">
        <Wrench size={12} />
        <span>工具调用</span>
        <span className="ml-auto text-xs text-amber-700/60 dark:text-amber-300/60">{calls.length} 项</span>
      </div>
      <div className="divide-y divide-amber-200/70 dark:divide-amber-800/40">
        {calls.map((call, index) => {
          const imageUrls = extractGeneratedImages(call.result);
          return (
            <details key={`${call.name}-${index}`} className="group px-3 py-2">
              <summary className="flex cursor-pointer list-none items-center gap-2 text-xs text-amber-900/80 dark:text-amber-200/80">
                {call.status === "success" ? <Check size={12} className="text-emerald-600 dark:text-emerald-400" /> : call.status === "running" ? <Loader2 size={12} className="animate-spin text-amber-600 dark:text-amber-400" /> : <AlertCircle size={12} className="text-red-500 dark:text-red-400" />}
                <code className="font-mono">{call.name}</code>
                <ChevronRight size={12} className="ml-auto transition-transform group-open:rotate-90" />
              </summary>
              <pre className="mt-2 overflow-x-auto rounded bg-white/70 p-2 text-xs leading-relaxed text-amber-900/70 dark:bg-black/30 dark:text-amber-200/70">{JSON.stringify({ params: call.params, result: call.result }, null, 2)}</pre>
              {imageUrls.length > 0 && (
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {imageUrls.map((url, imageIndex) => (
                    <img key={imageIndex} src={url} alt={`生成图片 ${imageIndex + 1}`} className="w-full cursor-zoom-in rounded border border-amber-200/70 bg-white/70 object-contain dark:border-amber-800/40 dark:bg-black/30" onClick={() => openPreview(url)} />
                  ))}
                </div>
              )}
            </details>
          );
        })}
      </div>
    </div>
  );
}

function CitationsBlock({ citations }: { citations: Citation[] }) {
  return (
    <div className="mt-3 border-t border-border pt-2.5">
      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        <ExternalLink size={11} /> 参考来源
      </div>
      <div className="flex flex-wrap gap-1.5">
        {citations.map(citation => (
          <button key={citation.index} type="button" className="inline-flex min-w-0 items-center gap-1 rounded-md border border-border bg-muted/50 px-2 py-1 text-left text-xs text-muted-foreground transition-colors hover:border-primary/30 hover:text-primary">
            <span className="font-semibold text-primary">[{citation.index}]</span>
            <span className="truncate">{citation.title}</span>
            <span className="text-foreground/30">{citation.domain}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function MessageActions({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text).catch(() => undefined);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };
  return (
    <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover/msg:opacity-100">
      <Tooltip><TooltipTrigger asChild><button type="button" className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" onClick={copy}>{copied ? <Check size={12} /> : <Copy size={12} />}</button></TooltipTrigger><TooltipContent>复制</TooltipContent></Tooltip>
      <Tooltip><TooltipTrigger asChild><button type="button" className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><ThumbsUp size={12} /></button></TooltipTrigger><TooltipContent>有帮助</TooltipContent></Tooltip>
      <Tooltip><TooltipTrigger asChild><button type="button" className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><ThumbsDown size={12} /></button></TooltipTrigger><TooltipContent>没帮助</TooltipContent></Tooltip>
      <Tooltip><TooltipTrigger asChild><button type="button" className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><Share2 size={12} /></button></TooltipTrigger><TooltipContent>分享</TooltipContent></Tooltip>
    </div>
  );
}

function StatusNotice({ status, error, onRetry }: { status: "send_failed" | "recv_failed"; error?: string; onRetry: () => void }) {
  const received = status === "recv_failed";
  return (
    <div className={cn("mt-1.5 flex items-center gap-2 text-xs", received ? "text-red-500" : "text-destructive")}>
      <AlertCircle size={11} />
      <span className="max-w-[min(70vw,360px)] truncate">{error || (received ? "回复加载失败" : "发送失败")}</span>
      <button type="button" className="inline-flex items-center gap-1 text-xs font-medium leading-none underline underline-offset-2" onClick={onRetry}><RotateCcw size={10} />重试</button>
    </div>
  );
}

function Sidebar({
  open,
  activePage,
  sessions,
  activeSession,
  editingId,
  onPageChange,
  onNewSession,
  onSessionChange,
  onStartEdit,
  onSaveEdit,
  onCloseEdit,
  onDeleteSession,
  onReorderSessions,
  activeTheme,
  onThemeChange,
  themeMode,
  onThemeModeChange,
  onClose,
}: {
  open: boolean;
  activePage: string;
  sessions: Session[];
  activeSession: string;
  editingId: string | null;
  onPageChange: (page: string) => void;
  onNewSession: () => void;
  onSessionChange: (id: string) => void;
  onStartEdit: (id: string) => void;
  onSaveEdit: (id: string, title: string) => void;
  onCloseEdit: () => void;
  onDeleteSession: (id: string) => void;
  onReorderSessions: (fromId: string, toId: string) => void;
  activeTheme: string;
  onThemeChange: (theme: ThemePreset) => void;
  themeMode: ThemeMode;
  onThemeModeChange: (mode: ThemeMode) => void;
  onClose: () => void;
}) {
  const [editValue, setEditValue] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  // 相对时间的"当前时刻"：每分钟刷新一次；从后台切回页面时（visibilitychange）立即刷新，
  // 保证会话列表的"x 分钟前/x 小时前"等时间显示保持新鲜。
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60000);
    const handleVisibility = () => {
      if (document.visibilityState === "visible") setNow(new Date());
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, []);
  const links = [
    { icon: MessageSquare, label: "对话", page: "chat", plus: true },
    { icon: Cpu, label: "助手", page: "assistant", plus: false },
    { icon: WorkflowIcon, label: "工作流", page: "workflow", plus: false },
    { icon: Zap, label: "自动化", page: "automation", plus: false },
  ];
  return (
    <>
      {open && <button type="button" aria-label="关闭侧栏" className="fixed inset-0 z-30 bg-black/20 md:hidden" onClick={onClose} />}
      <aside className={cn("fixed inset-y-0 left-0 z-40 flex shrink-0 flex-col overflow-hidden border-r border-black/[0.06] bg-[#f2f3f5] transition-all duration-200 md:relative md:inset-auto md:z-auto dark:bg-sidebar", open ? "w-[240px]" : "w-0 border-r-0") }>
        <div className={cn("flex h-full w-[240px] flex-col transition-opacity duration-150", open ? "opacity-100" : "opacity-0")}>
          <div className="flex items-center gap-2.5 border-b border-black/[0.06] px-4 py-[15px]">
            <Avatar className="h-7 w-7 rounded-md"><AvatarFallback className="rounded-md bg-primary text-primary-foreground"><Bot size={14} /></AvatarFallback></Avatar>
            <span className="text-sm font-semibold tracking-tight text-foreground">AetherAI</span>
            <button type="button" aria-label="收起侧栏" className="ml-auto rounded p-1 text-foreground/40 hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/10 md:hidden" onClick={onClose}><PanelLeftClose size={14} /></button>
          </div>
          <div className="space-y-0.5 px-2 pb-1 pt-3">
            {links.map(({ icon: Icon, label, page, plus }) => (
              <button key={page} type="button" onClick={() => onPageChange(page)} className={cn("group flex w-full items-center gap-2.5 rounded-md px-2.5 py-[7px] text-sm font-medium transition-colors", page === activePage ? "bg-black/[0.07] text-foreground dark:bg-white/10" : "text-foreground/50 hover:bg-black/[0.05] hover:text-foreground/80 dark:hover:bg-white/10 dark:hover:text-foreground")}>
                <Icon size={13} /><span className="flex-1 text-left">{label}</span>
                {plus && <span onClick={event => { event.stopPropagation(); onNewSession(); }} className="rounded p-0.5 opacity-40 transition-opacity hover:bg-black/[0.08] hover:opacity-100 group-hover:opacity-70 dark:hover:bg-white/10"><Plus size={13} /></span>}
              </button>
            ))}
          </div>
          <ScrollArea className="min-h-0 flex-1 px-2">
            <p className="px-2.5 py-1.5 text-sm font-semibold uppercase tracking-widest text-foreground/30">最近对话</p>
            {sessions.map(session => (
              <ContextMenu key={session.id}>
                <ContextMenuTrigger asChild>
                  <div
                    draggable
                    onDragStart={() => setDragId(session.id)}
                    onDragOver={event => {
                      event.preventDefault();
                      if (dragId && dragId !== session.id && overId !== session.id) setOverId(session.id);
                    }}
                    onDragLeave={() => { if (overId === session.id) setOverId(null); }}
                    onDrop={event => {
                      event.preventDefault();
                      if (dragId && dragId !== session.id) onReorderSessions(dragId, session.id);
                      setDragId(null);
                      setOverId(null);
                    }}
                    onDragEnd={() => { setDragId(null); setOverId(null); }}
                    onClick={() => onSessionChange(session.id)}
                    className={cn("mb-0.5 flex w-full cursor-pointer select-none items-center gap-1 rounded-md px-2.5 py-2 text-left transition-colors", dragId === session.id && "opacity-40", overId === session.id && "outline-2 outline-dashed outline-primary", session.id === activeSession ? "bg-primary/10 text-primary" : "text-foreground/55 hover:bg-black/[0.05] hover:text-foreground/80 dark:hover:bg-white/10 dark:hover:text-foreground")}
                  >
                    <span className="min-w-0 flex-1 truncate text-sm leading-snug">{session.title}</span>
                    <span className="shrink-0 whitespace-nowrap text-xs text-foreground/30">{formatRelativeTime(session.time, now)}</span>
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent className="w-44">
                  <ContextMenuItem onClick={() => { setEditValue(session.title); onStartEdit(session.id); }} className="cursor-pointer gap-2 text-xs"><Pencil size={13} className="text-muted-foreground" />编辑标题</ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem onClick={() => onDeleteSession(session.id)} className="cursor-pointer gap-2 text-xs text-destructive focus:bg-destructive/10 focus:text-destructive"><Trash2 size={13} />删除会话</ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            ))}
          </ScrollArea>
          <div className="flex items-center justify-between border-t border-black/[0.06] px-3 py-3">
            <div className="flex items-center gap-2"><Avatar className="h-7 w-7"><AvatarFallback className="bg-primary text-xs font-bold text-primary-foreground">测</AvatarFallback></Avatar><div><p className="text-sm font-medium leading-tight text-foreground">测试</p></div></div>
            <Popover><PopoverTrigger asChild><Button variant="ghost" size="icon-sm" className="h-7 w-7 text-foreground/40 hover:bg-black/[0.06] hover:text-foreground/70 dark:hover:bg-white/10"><Settings size={13} /></Button></PopoverTrigger><PopoverContent side="right" align="end" sideOffset={10} className="w-72 p-3"><p className="mb-2 text-xs font-semibold text-foreground">外观</p><div className="mb-3 grid grid-cols-3 gap-1 rounded-lg bg-muted p-1">{THEME_MODES.map(({ key, label, icon: Icon }) => <button key={key} type="button" onClick={() => onThemeModeChange(key)} className={cn("flex items-center justify-center gap-1 rounded-md px-1 py-1.5 text-xs transition-colors", themeMode === key ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}><Icon size={12} /><span>{label}</span></button>)}</div><p className="mb-2.5 text-xs font-semibold text-foreground">主题色</p><div className="grid grid-cols-3 gap-2">{THEMES.map(theme => <button key={theme.key} type="button" onClick={() => onThemeChange(theme)} className={cn("flex flex-col items-center gap-1.5 rounded-lg border px-2 py-2 transition-all hover:bg-muted", activeTheme === theme.key ? "border-primary bg-primary/5" : "border-border")}><span className="h-5 w-5 rounded-full" style={{ background: theme.primary, boxShadow: activeTheme === theme.key ? `0 0 0 2px white, 0 0 0 4px ${theme.primary}` : "none" }} /><span className="text-xs leading-none text-muted-foreground">{theme.label}</span></button>)}</div></PopoverContent></Popover>
          </div>
        </div>
      </aside>
      <Dialog
        open={editingId !== null}
        onOpenChange={open => {
          if (!open) onCloseEdit();
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>编辑会话标题</DialogTitle>
            <DialogDescription>修改后点击保存，或按 Esc / 点取消放弃。</DialogDescription>
          </DialogHeader>
          <input
            autoFocus
            value={editValue}
            onChange={event => setEditValue(event.target.value)}
            onKeyDown={event => {
              if (event.key === "Enter" && editingId) onSaveEdit(editingId, editValue);
            }}
            className="mt-2 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary/40"
          />
          <DialogFooter>
            <Button variant="ghost" onClick={onCloseEdit}>取消</Button>
            <Button onClick={() => editingId && onSaveEdit(editingId, editValue)}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function PageHeader({ title, subtitle, sidebarOpen, onToggle }: { title: string; subtitle: string; sidebarOpen: boolean; onToggle: () => void }) {
  return <header className="flex shrink-0 items-center gap-2 border-b border-black/[0.06] bg-white px-4 py-3 dark:border-border dark:bg-card"><Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-sm" className="h-7 w-7 text-foreground/40 hover:text-foreground/70" onClick={onToggle}>{sidebarOpen ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}</Button></TooltipTrigger><TooltipContent>{sidebarOpen ? "收起侧栏" : "展开侧栏"}</TooltipContent></Tooltip><div><h1 className="text-sm font-semibold leading-tight text-foreground">{title}</h1><p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p></div></header>;
}

function EmptyChat({ onPrompt }: { onPrompt: (prompt: string) => void }) {
  return <div className="flex flex-col items-center px-4 pb-6 pt-16"><div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10"><Bot size={22} className="text-primary" /></div><h2 className="mb-1 text-xl font-semibold text-foreground">开始对话</h2><p className="mb-10 text-sm text-muted-foreground">选择一个快捷提问，或直接输入你的问题</p><div className="grid w-full max-w-lg grid-cols-1 gap-3 sm:grid-cols-2">{QUICK_PROMPTS.map(({ icon: Icon, label, prompt }) => <button key={label} type="button" onClick={() => onPrompt(prompt)} className="group flex flex-col gap-2 rounded-xl border bg-card px-4 py-3.5 text-left shadow-sm transition-all hover:border-primary/40 hover:bg-primary/[0.02] hover:shadow-md"><div className="flex items-center gap-2"><div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10 transition-colors group-hover:bg-primary/15"><Icon size={14} className="text-primary" /></div><span className="text-xs font-semibold text-foreground/80">{label}</span></div><p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">{prompt}</p><ArrowRight size={12} className="self-end text-primary/40 transition-colors group-hover:text-primary/70" /></button>)}</div></div>;
}

function ModelSettingsPopover({
  model,
  models,
  modelsLoading,
  modelsError,
  onModelChange,
  onReloadModels,
}: {
  model: ChatModel | null;
  models: ChatModel[];
  modelsLoading: boolean;
  modelsError: string | null;
  onModelChange: (model: ChatModel) => void;
  onReloadModels: () => void;
}) {
  const modelLabel = model?.label || (modelsLoading ? "加载模型中…" : "未选择模型");
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" disabled={modelsLoading} className="h-7 max-w-[220px] gap-1.5 rounded-full bg-muted/60 px-2.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
          <Cpu size={13} className="shrink-0" />
          <span className="truncate">{modelLabel}</span>
          <ChevronDown size={11} className="shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" sideOffset={8} className="w-72 p-1.5">
        <div className="max-h-64 space-y-0.5 overflow-y-auto">
          {modelsLoading ? <p className="px-2 py-3 text-xs text-muted-foreground">正在读取 /v1/models…</p> : models.length ? models.map(item => <button key={item.key} type="button" onClick={() => { onModelChange(item); setOpen(false); }} className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-2 text-left text-xs transition-colors hover:bg-muted"><span className="min-w-0 truncate">{item.label}</span>{model?.key === item.key && <Check size={12} className="shrink-0 text-primary" />}</button>) : <div className="px-2 py-3 text-xs text-muted-foreground">{modelsError || "暂无可用模型"}</div>}
        </div>
        {modelsError && <button type="button" className="mt-1 w-full border-t px-2 pt-2 text-left text-xs text-destructive underline underline-offset-2" onClick={onReloadModels}>重试读取模型</button>}

      </PopoverContent>
    </Popover>
  );
}

// AI 通过 akm_ask_user 工具提出的澄清问题卡片：
// active 为 true（消息状态 asking）时显示回答区等待用户回答，提交后回调 onSubmit；
// 回答提交或历史记录恢复后 active 为 false，只读展示问题原文。
// 支持后端三模式：无 options 时自由文本输入框；options 单选点击即提交；
// options + multiple 时 checkbox 多选后点确认提交（选中项以「、」拼接）。
function AskUserCard({ question, options, multiple, active, onSubmit }: {
  question: string;
  options?: string[];
  multiple?: boolean;
  active: boolean;
  onSubmit: (answer: string) => void;
}) {
  const [answer, setAnswer] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const hasOptions = (options ?? []).length > 0;

  // 激活时仅自由文本模式自动聚焦输入框；选项模式靠点击操作，无需聚焦。
  useEffect(() => {
    if (active && !hasOptions) inputRef.current?.focus();
  }, [active, hasOptions]);

  // 自由文本模式提交。
  const submitText = () => {
    const value = answer.trim();
    if (!value) return;
    onSubmit(value);
    setAnswer("");
  };

  // 多选模式提交：选中项拼接后作为回答传给 AI。
  const submitMultiple = () => {
    if (selected.length === 0) return;
    onSubmit(selected.join("、"));
    setSelected([]);
  };

  // 切换某个选项的选中状态（多选）；单选直接提交该选项。
  const toggleOption = (option: string) => {
    if (multiple) {
      setSelected(prev => prev.includes(option) ? prev.filter(item => item !== option) : [...prev, option]);
    } else {
      onSubmit(option);
    }
  };

  return (
    <div className="mt-3 rounded-xl border border-primary/25 bg-primary/[0.04] px-3.5 py-3">
      <div className="flex items-start gap-2">
        <HelpCircle size={15} className="mt-0.5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-foreground">需要确认一下：</p>
          <p className="mt-1 text-sm leading-relaxed text-foreground/90">{question}</p>
          {active && hasOptions ? (
            <div className="mt-2.5 space-y-1.5">
              {options!.map(option => multiple ? (
                <label key={option} className="flex cursor-pointer items-center gap-2 rounded-lg border bg-background px-2.5 py-1.5 text-xs transition-colors hover:border-primary/40">
                  <input type="checkbox" checked={selected.includes(option)} onChange={() => toggleOption(option)} className="h-3.5 w-3.5 accent-primary" />
                  <span className="text-foreground/90">{option}</span>
                </label>
              ) : (
                <button key={option} type="button" onClick={() => toggleOption(option)} className="flex w-full items-center rounded-lg border bg-background px-2.5 py-1.5 text-left text-xs transition-colors hover:border-primary/40 hover:bg-primary/5">
                  <span className="text-foreground/90">{option}</span>
                </button>
              ))}
              {multiple ? (
                <Button size="sm" className="h-8 gap-1" onClick={submitMultiple} disabled={selected.length === 0}>确认</Button>
              ) : null}
            </div>
          ) : null}
          {active && !hasOptions ? (
            <div className="mt-2.5 flex items-center gap-2">
              <input
                ref={inputRef}
                value={answer}
                onChange={event => setAnswer(event.target.value)}
                onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing) submitText(); }}
                placeholder="在这里回答…"
                className="min-w-0 flex-1 rounded-lg border bg-background px-3 py-1.5 text-sm outline-none focus:border-primary/60"
              />
              <Button size="sm" className="h-8 shrink-0 gap-1" onClick={submitText} disabled={!answer.trim()}>回答</Button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ChatPage({
  session,
  messages,
  model,
  models,
  modelsLoading,
  modelsError,
  sidebarOpen,
  onToggleSidebar,
  onModelChange,
  onReloadModels,
  onSend,
  onRetry,
  onStop,
  onAnswer,
  tools,
  onToolsChange,
}: {
  session?: Session;
  messages: Message[];
  model: ChatModel | null;
  models: ChatModel[];
  modelsLoading: boolean;
  modelsError: string | null;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onModelChange: (model: ChatModel) => void;
  onReloadModels: () => void;
  onSend: (content: string, attachments: File[], tools: string[]) => void;
  onRetry: (id: string) => void;
  onAnswer: (assistantMessageId: string, answer: string) => void;
  onStop: () => void;
  tools: string[];
  onToolsChange: (tools: string[]) => void;
}) {
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<File[]>([]);
  const { openPreview } = useContext(PreviewContext);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [stickToBottom, setStickToBottom] = useState(true);
  const modelLabel = model?.label || (modelsLoading ? "加载模型中…" : "未选择模型");

  // ---- 懒渲染窗口：消息很多时默认只渲染最近 INITIAL_MESSAGE_COUNT 条 ----
  // 向上滚动到顶部会按 MESSAGE_BATCH 增量加载更早的消息，避免一次性挂载全部 DOM。
  const INITIAL_MESSAGE_COUNT = 50;
  const MESSAGE_BATCH = 30;
  const [extraCount, setExtraCount] = useState(0);
  const extraCountRef = useRef(0);
  useEffect(() => { extraCountRef.current = extraCount; }, [extraCount]);

  // 窗口始终以最近消息为尾部，保证流式输出与新增消息永远可见；未超过阈值时切片等于全量，零副作用。
  const windowSize = Math.min(INITIAL_MESSAGE_COUNT + extraCount, messages.length);
  const visibleMessages = messages.slice(-windowSize);
  const hasMoreEarly = messages.length > windowSize;

  // 滚动监听挂在组件挂载时（依赖 []），只能读取 ref，因此这里同步一份标志。
  const hasMoreEarlyRef = useRef(hasMoreEarly);
  useEffect(() => { hasMoreEarlyRef.current = hasMoreEarly; }, [hasMoreEarly]);

  // 顶部插入更早消息后，scrollTop 相对内容会偏移，需要按加载前后的 scrollHeight 差值补偿，
  // 避免"跳内容"。同时用 loadingEarlyRef 防止一次滚动触发多次加载。
  const prevScrollRef = useRef<{ top: number; height: number } | null>(null);
  const loadingEarlyRef = useRef(false);

  // 最新一条 assistant 消息在可见窗口内的索引，用于让它的思考区域默认展开。
  const lastAssistantIndex = visibleMessages.reduce((last, message, index) => (message.role === "assistant" ? index : last), -1);

  // 监听滚动位置：只有处于底部附近时才保持"吸附到底部"状态。
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const handleScroll = () => {
      const nearBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 40;
      setStickToBottom(nearBottom);
      // 接近顶部且还有更早消息未加载时，增量加载一批，并记录当前滚动位置用于补偿。
      if (viewport.scrollTop < 40 && hasMoreEarlyRef.current && !loadingEarlyRef.current) {
        loadingEarlyRef.current = true;
        prevScrollRef.current = { top: viewport.scrollTop, height: viewport.scrollHeight };
        setExtraCount(count => count + MESSAGE_BATCH);
      }
    };
    viewport.addEventListener("scroll", handleScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", handleScroll);
  }, []);

  // 顶部加载更早消息后，把滚动位置平移新插入的高度，保证正在阅读的内容不跳变。
  useEffect(() => {
    if (!prevScrollRef.current) return;
    const viewport = viewportRef.current;
    if (viewport) {
      viewport.scrollTop = prevScrollRef.current.top + (viewport.scrollHeight - prevScrollRef.current.height);
    }
    prevScrollRef.current = null;
    loadingEarlyRef.current = false;
  }, [extraCount]);

  // 切换会话后默认定位到底部。
  const prevSessionIdRef = useRef(session?.id);
  useEffect(() => {
    if (prevSessionIdRef.current === session?.id) return;
    prevSessionIdRef.current = session?.id;
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollTop = viewport.scrollHeight;
    setStickToBottom(true);
    // 切换到新会话时重置懒渲染窗口与加载状态。
    setExtraCount(0);
    extraCountRef.current = 0;
    loadingEarlyRef.current = false;
    prevScrollRef.current = null;
  }, [session?.id]);

  // 取最后一条助手消息的内容长度，用于感知流式输出增长。
  const lastAssistantContent = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === "assistant") return messages[index].content;
    }
    return "";
  }, [messages]);

  // 上一条回复尚未完成（用户消息仍在发送中，或助手消息仍在流式生成）时禁止再发，
  // 避免并发请求打乱会话顺序与上下文。
  const isReplyPending = useMemo(
    () => messages.some(message => message.status === "sending"),
    [messages],
  );

  // 新消息到达或流式内容增长时，仅在吸附状态下自动滚动到底部；用户上翻阅读历史时不打扰。
  useEffect(() => {
    if (!stickToBottom) return;
    const viewport = viewportRef.current;
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, [messages.length, lastAssistantContent, stickToBottom]);

  // 内容高度异步变化（图片加载、代码块重排、切会话布局未就绪等）时，
  // 若处于吸附状态则补一次滚动到底，避免"概率性停在中间"。
  const stickToBottomRef = useRef(stickToBottom);
  useEffect(() => { stickToBottomRef.current = stickToBottom; }, [stickToBottom]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const content = viewport.firstElementChild as HTMLElement | null;
    if (!content) return;
    const observer = new ResizeObserver(() => {
      if (!stickToBottomRef.current) return;
      viewport.scrollTop = viewport.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  const send = () => {
    // 回复未完成时不允许再发；空内容同样拦截
    if (isReplyPending || (!input.trim() && !attachments.length)) return;
    onSend(input.trim() || attachments.map(file => file.name).join(", "), attachments, tools);
    setInput("");
    setAttachments([]);
    if (textareaRef.current) textareaRef.current.style.height = "44px";
  };

  return <div className="flex min-h-0 flex-1 flex-col">
    <header className="flex shrink-0 items-center justify-start border-b border-black/[0.06] bg-white px-4 py-3 dark:border-border dark:bg-card">
      <div className="flex items-center gap-2">
        <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-sm" className="h-7 w-7 text-foreground/40 hover:text-foreground/70" onClick={onToggleSidebar}>{sidebarOpen ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}</Button></TooltipTrigger><TooltipContent>{sidebarOpen ? "收起侧栏" : "展开侧栏"}</TooltipContent></Tooltip>
        <div><h1 className="text-sm font-semibold leading-tight text-foreground">{session?.title ?? "新对话"}</h1><p className="mt-0.5 text-xs text-muted-foreground">{messages.length} 条消息 · {modelLabel}</p></div>
      </div>
    </header>
        <ScrollArea viewportRef={viewportRef} className="min-h-0 flex-1 bg-white dark:bg-card">
      <div className="mx-auto max-w-4xl space-y-6 px-4 py-6 sm:px-6">
        {messages.length === 0 && <EmptyChat onPrompt={prompt => { if (!isReplyPending) onSend(prompt, [], []); }} />}
        {visibleMessages.map((message, messageIndex) => message.role === "assistant" ? (
          <div key={message.id} className="group/msg flex gap-3">
            <Avatar className="mt-0.5 h-7 w-7 shrink-0"><AvatarFallback className="bg-primary text-primary-foreground"><Bot size={13} /></AvatarFallback></Avatar>
            <div className="min-w-0 max-w-[88%] flex-1 sm:max-w-[80%]">
              {message.segments?.length ? (
                <div className="space-y-2.5">
                  {message.segments.map((segment, segmentIndex) => {
                    if (segment.type === "text") {
                      return (
                        <div key={`text-${segmentIndex}`} className="min-w-0 rounded-xl border bg-card px-4 py-3 shadow-sm [overflow-wrap:anywhere]">
                          <MemoMarkdown content={segment.content} />
                          {message.citations && segmentIndex === message.segments!.length - 1 && <CitationsBlock citations={message.citations} />}
                        </div>
                      );
                    }
                    if (segment.type === "thinking") {
                      return <ThinkingBlock key={`think-${segmentIndex}`} text={segment.content} defaultOpen={messageIndex === lastAssistantIndex} />;
                    }
                    return (
                      <FunctionCallBlock
                        key={`tool-${segmentIndex}`}
                        calls={[{ name: segment.name, params: segment.params, result: segment.result, status: segment.status }]}
                      />
                    );
                  })}
                  {message.status === "sending" && !messageText(message) && (
                    <div className="flex items-center gap-2 rounded-xl border bg-card px-4 py-3 text-xs text-muted-foreground" aria-live="polite">
                      <Loader2 size={13} className="animate-spin text-primary" />
                      <span>{message.streamStatus || "正在生成回复…"}</span>
                    </div>
                  )}
                </div>
              ) : (
                <>
                  {message.thinking && <ThinkingBlock text={message.thinking} defaultOpen={messageIndex === lastAssistantIndex} />}
                  {message.functionCalls && <FunctionCallBlock calls={message.functionCalls} />}
                  {message.status === "sending" && !message.content ? (
                    <div className="flex items-center gap-2 rounded-xl border bg-card px-4 py-3 text-xs text-muted-foreground" aria-live="polite">
                      <Loader2 size={13} className="animate-spin text-primary" />
                      <span>{message.streamStatus || "正在生成回复…"}</span>
                    </div>
                  ) : message.content ? (
                    <div className="min-w-0 rounded-xl border bg-card px-4 py-3 shadow-sm [overflow-wrap:anywhere]">
                      <MemoMarkdown content={message.content} />
                      {message.citations && <CitationsBlock citations={message.citations} />}
                    </div>
                  ) : null}
                </>
              )}
              {message.status === "recv_failed" && <StatusNotice status="recv_failed" error={message.error} onRetry={() => onRetry(message.id)} />}
              <ContextHint compacted={message.compacted} />
              {/* AI 提出的澄清问题：asking 状态可输入回答，回答后只读展示 */}
              {message.askUser ? <AskUserCard question={message.askUser.question} options={message.askUser.options} multiple={message.askUser.multiple} active={message.status === "asking"} onSubmit={answer => onAnswer(message.id, answer)} /> : null}
              {messageText(message) && <div className="mt-1.5 flex items-center justify-between px-0.5"><MessageActions text={messageText(message)} /><span className="text-xs text-muted-foreground">{message.status === "sending" ? message.streamStatus : formatDisplayTime(message.time)}</span></div>}
            </div>
          </div>
        ) : (
          <div key={message.id} className="flex flex-row-reverse gap-3">
            <Avatar className="mt-0.5 h-7 w-7 shrink-0"><AvatarFallback className="bg-blue-100 text-xs font-bold text-blue-600">测</AvatarFallback></Avatar>
            <div className="flex max-w-[88%] flex-col items-end sm:max-w-[72%]">
              <div className={cn("min-w-0 rounded-xl px-4 py-2.5 text-sm leading-relaxed transition-opacity [overflow-wrap:anywhere]", message.status === "send_failed" ? "border border-destructive/30 bg-destructive/5 text-destructive" : "bg-primary text-primary-foreground", message.status === "sending" && "opacity-60")}>{message.content}</div>
              {message.files?.length ? <div className="mt-1.5 flex max-w-full flex-wrap justify-end gap-1.5">{message.files.map(file => file.type.startsWith("image/") && file.previewUrl ? <button key={`${file.name}-${file.size}`} type="button" aria-label={`预览${file.name}`} onClick={() => openPreview(file.previewUrl!)} className="overflow-hidden rounded-lg border border-primary/30 bg-white shadow-sm transition-transform hover:scale-105 dark:bg-muted"><img src={file.previewUrl} alt={file.name} className="h-12 w-12 object-cover" /></button> : <div key={`${file.name}-${file.size}`} className="flex max-w-[200px] items-center gap-1.5 rounded-lg border border-primary/30 bg-white px-2.5 py-1 text-xs font-medium text-primary dark:bg-muted"><ImageIcon size={11} className="shrink-0 text-primary/70" /><span className="truncate">{file.name}</span></div>)}</div> : null}
              {message.status === "sending" && <div className="mt-1 flex items-center gap-1"><Loader2 size={10} className="animate-spin text-muted-foreground" /><span className="text-xs text-muted-foreground">发送中…</span></div>}
              {message.status === "send_failed" && <StatusNotice status="send_failed" onRetry={() => onRetry(message.id)} />}
              {message.status === "success" && <span className="mt-1 text-xs text-muted-foreground">{formatDisplayTime(message.time)}</span>}
            </div>
          </div>
        ))}
      </div>
    </ScrollArea>
    <div className="shrink-0 bg-white px-3 py-3 sm:px-6 sm:py-4 dark:bg-card">
      <div className="mx-auto max-w-3xl">
        <div className="overflow-hidden rounded-xl border bg-card shadow-sm transition-all focus-within:border-primary/50 focus-within:ring-1 focus-within:ring-primary/30">
          {attachments.length > 0 && <div className="flex flex-wrap gap-1.5 px-4 pb-1 pt-3">{attachments.map((file, index) => <div key={`${file.name}-${index}`} className="flex max-w-[180px] items-center gap-1.5 rounded-lg border border-border bg-muted px-2.5 py-1 text-xs text-foreground/70"><Paperclip size={11} className="shrink-0 text-muted-foreground" /><span className="truncate">{file.name}</span><button type="button" aria-label={`移除${file.name}`} onClick={() => setAttachments(prev => prev.filter((_, itemIndex) => itemIndex !== index))} className="ml-0.5 shrink-0 text-muted-foreground hover:text-foreground"><X size={12} /></button></div>)}</div>}
          <textarea
            ref={textareaRef}
            value={input}
            rows={1}
            // 回复进行中时提示用户稍候，避免误以为可以连发
            placeholder={isReplyPending ? "上一条回复生成中，请稍候…" : "发送消息… (Shift+Enter 换行)"}
            disabled={isReplyPending}
            onChange={event => {
              setInput(event.target.value);
              event.target.style.height = "auto";
              event.target.style.height = `${Math.min(event.target.scrollHeight, 160)}px`;
            }}
            onKeyDown={event => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                send();
              }
            }}
            className={cn(
              "w-full resize-none bg-transparent px-4 pb-2 pt-3.5 text-sm text-foreground outline-none placeholder:text-muted-foreground",
              isReplyPending && "cursor-not-allowed opacity-60",
            )}
            style={{ minHeight: 44, maxHeight: 160 }}
          />
          <div className="flex items-center justify-between px-3 pb-3 pt-1">
            <div className="flex min-w-0 items-center gap-0.5">
              <input ref={fileInputRef} type="file" multiple accept="image/*,.txt" className="hidden" onChange={event => { setAttachments(prev => [...prev, ...Array.from(event.target.files ?? [])]); event.target.value = ""; }} />
              <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="sm" className="h-7 gap-1.5 text-xs text-muted-foreground hover:text-foreground" onClick={() => fileInputRef.current?.click()} disabled={isReplyPending}><Paperclip size={13} />附件</Button></TooltipTrigger><TooltipContent>上传文件</TooltipContent></Tooltip>
              <Separator orientation="vertical" className="mx-1 h-4" />
              {[{ id: "search", icon: Search, label: "联网搜索" }, { id: "image", icon: ImageIcon, label: "图像生成" }].map(({ id, icon: Icon, label }) => <Tooltip key={id}><TooltipTrigger asChild><Button variant={tools.includes(id) ? "secondary" : "ghost"} size="sm" className={cn("h-7 gap-1.5 text-xs", tools.includes(id) ? "text-primary" : "text-muted-foreground hover:text-foreground")} onClick={() => onToolsChange(tools.includes(id) ? tools.filter(item => item !== id) : [...tools, id])} disabled={isReplyPending}><Icon size={13} /><span className="hidden lg:inline">{label}</span></Button></TooltipTrigger><TooltipContent>{label}</TooltipContent></Tooltip>)}
            </div>
            <div className="flex min-w-0 items-center gap-2">
              <ModelSettingsPopover model={model} models={models} modelsLoading={modelsLoading} modelsError={modelsError} onModelChange={onModelChange} onReloadModels={onReloadModels} />
              {/* 回复生成中时按钮切换为"停止"：点击中断当前回复；否则为发送按钮 */}
              {isReplyPending
                ? <Button size="icon-sm" className="h-7 w-7" onClick={onStop} title="中断回复"><CircleStop size={13} /></Button>
                : <Button size="icon-sm" className="h-7 w-7" onClick={send} disabled={!model || (!input.trim() && !attachments.length)} title="发送消息"><Send size={13} /></Button>}
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>;
}

// 任务类型展示配置：图标与配色
const TASK_TYPE_META: Record<TaskType, { label: string; icon: LucideIcon; color: string }> = {
  agent_call: { label: "AI 对话", icon: Bot, color: "bg-blue-100 text-blue-600" },
  usage_query: { label: "用量查询", icon: Zap, color: "bg-violet-100 text-violet-600" },
};

// 把任务间隔秒数格式化为人类可读的周期描述（0 表示单次执行）
function formatInterval(intervalSec: number) {
  if (!intervalSec || intervalSec < 0) return "单次执行";
  if (intervalSec % 86400 === 0) return `每 ${intervalSec / 86400} 天`;
  if (intervalSec % 3600 === 0) return `每 ${intervalSec / 3600} 小时`;
  if (intervalSec % 60 === 0) return `每 ${intervalSec / 60} 分钟`;
  return `每 ${intervalSec} 秒`;
}

// 从任务 payload 生成卡片上的一行描述文字
function describeTask(task: ScheduledTask) {
  if (task.task_type === "usage_query") return `监控 Key：${task.payload.alias || "未设置"}`;
  const messages = task.payload.messages ?? [];
  const lastUser = [...messages].reverse().find(message => message.role === "user");
  const content = lastUser?.content || task.payload.instructions || "";
  return content.length > 60 ? `${content.slice(0, 60)}…` : content || "暂无描述";
}

// 后端返回的时间字符串为空时显示占位符
function formatTaskTime(value: string | null | undefined) {
  return value || "—";
}

function AutomationPage({ sidebarOpen, onToggle, models, defaultModelKey }: { sidebarOpen: boolean; onToggle: () => void; models: ChatModel[]; defaultModelKey: string }) {
  // 任务列表数据（null 表示尚未加载完成）
  const [tasks, setTasks] = useState<ScheduledTask[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 新建 / 编辑弹窗的表单状态
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ScheduledTask | null>(null);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [taskType, setTaskType] = useState<TaskType>("agent_call");
  const [intervalSec, setIntervalSec] = useState("3600");
  const [instruction, setInstruction] = useState("");
  const [userPrompt, setUserPrompt] = useState("");
  const [alias, setAlias] = useState("");
  // agent_call 任务使用的执行模型：新建时默认跟随聊天当前所选模型，
  // 后端若收到空 model 会退化为"第一个可用 Key 的模型"，这里显式带上更可控。
  const [modelKey, setModelKey] = useState(defaultModelKey);
  // agent_call 任务开启的工具开关（"search" 联网搜索 / "image" 图像生成）
  const [selectedTools, setSelectedTools] = useState<string[]>([]);

  // 删除确认弹窗的目标任务
  const [deleteTarget, setDeleteTarget] = useState<ScheduledTask | null>(null);

  // 正在执行操作的任务 id（用于按钮加载态，避免重复提交）
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);

  // 拉取任务列表
  const loadTasks = async () => {
    setLoading(true);
    setError(null);
    try {
      setTasks(await listTasks());
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载任务失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void loadTasks(); }, []);

  // 打开新建表单：清空编辑状态与所有字段
  const openCreate = () => {
    setEditTarget(null);
    setName("");
    setTaskType("agent_call");
    setIntervalSec("3600");
    setInstruction("");
    setUserPrompt("");
    setAlias("");
    setModelKey(defaultModelKey);
    setSelectedTools([]);
    setDialogOpen(true);
  };

  // 打开编辑表单：从任务记录还原各字段（agent_call 取最后一条 user 消息）
  const openEdit = (task: ScheduledTask) => {
    setEditTarget(task);
    setName(task.name);
    setTaskType(task.task_type);
    setIntervalSec(String(task.interval_sec ?? 0));
    setInstruction(task.payload.instructions ?? "");
    setUserPrompt((task.payload.messages ?? []).filter(message => message.role === "user").map(message => message.content ?? "").join("\n"));
    setAlias(task.payload.alias ?? "");
    setModelKey(task.payload.model || defaultModelKey);
    // 从 payload.tools 还原已开启的工具开关
    const toolNames = (task.payload.tools ?? []).map(tool => tool.function?.name);
    setSelectedTools([
      ...(toolNames.includes("tavily_search") ? (["search"] as string[]) : []),
      ...(toolNames.some(name => name === "akm_generate_image" || name === "akm_edit_image") ? (["image"] as string[]) : []),
    ]);
    setDialogOpen(true);
  };

  // 关闭弹窗并清空表单，避免残留上次的编辑/添加状态
  const closeDialog = () => {
    setDialogOpen(false);
    setEditTarget(null);
    window.setTimeout(clearModalResidue, 250);
  };

  // 关闭删除确认弹窗
  const closeDelete = () => {
    setDeleteTarget(null);
    window.setTimeout(clearModalResidue, 250);
  };

  // 提交保存：新建或更新任务
  const submit = async () => {
    if (!name.trim() || (taskType === "agent_call" ? !userPrompt.trim() : !alias.trim())) return;
    const messages: AgentMessage[] = [{ role: "user", content: userPrompt.trim() }];
    // 按类型构造 payload；编辑时在原始 payload 基础上覆盖表单字段，保留 last_result 等执行产物
    const nextPayload: TaskPayload = taskType === "agent_call"
      ? { model: modelKey, instructions: instruction.trim(), messages, tools: resolveDeclaredTools(selectedTools) }
      : { alias: alias.trim() };
    const payload = editTarget ? { ...editTarget.payload, ...nextPayload } : nextPayload;
    setSaving(true);
    setError(null);
    try {
      const input = { name: name.trim(), task_type: taskType, interval_sec: Math.max(0, Number(intervalSec) || 0), payload };
      if (editTarget) await updateTask(editTarget.id, input);
      else await createTask(input);
      closeDialog();
      void loadTasks();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  // 通用操作包装：锁定按钮避免重复提交，操作完成后刷新列表
  const runOperation = async (taskId: string, operation: () => Promise<unknown>) => {
    setBusyTaskId(taskId);
    setError(null);
    try {
      await operation();
      void loadTasks();
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setBusyTaskId(null);
    }
  };

  const toggleEnabled = (task: ScheduledTask) => void runOperation(task.id, () => updateTask(task.id, { enabled: !task.enabled }));
  const runNow = (task: ScheduledTask) => void runOperation(task.id, () => runTask(task.id));
  const confirmDelete = () => {
    if (deleteTarget) void runOperation(deleteTarget.id, () => deleteTask(deleteTarget.id));
    closeDelete();
  };

  return (
    <>
      <PageHeader title="自动化" subtitle="让重复任务在合适的时间自动运行" sidebarOpen={sidebarOpen} onToggle={onToggle} />
      <ScrollArea className="min-h-0 flex-1 bg-white dark:bg-card">
        <div className="mx-auto max-w-4xl space-y-6 px-4 py-6 sm:px-8">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold text-foreground">自动化任务</h2>
              <p className="mt-1 text-sm text-muted-foreground">集中管理定时运行的任务和通知。</p>
            </div>
            <Button className="gap-2" onClick={openCreate}><Plus size={15} />新建自动化</Button>
          </div>

          {/* 加载或操作失败时展示错误信息 */}
          {error && <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive"><AlertCircle size={15} className="mt-0.5 shrink-0" /><div className="min-w-0 flex-1">{error}</div></div>}

          {tasks === null && loading && (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground"><Loader2 size={16} className="animate-spin" />正在加载任务…</div>
          )}

          {tasks !== null && tasks.length === 0 && (
            <div className="rounded-xl border border-dashed py-14 text-center text-sm text-muted-foreground">还没有自动化任务，点击右上角「新建自动化」创建第一个。</div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            {(tasks ?? []).map(task => {
              const meta = TASK_TYPE_META[task.task_type];
              const busy = busyTaskId === task.id;
              return (
                <div key={task.id} className="group relative flex flex-col rounded-xl border bg-card p-4 shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md">
                  <div className="mb-4 flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg", meta.color)}><meta.icon size={17} /></div>
                      <div className="min-w-0">
                        <h3 className="truncate text-sm font-semibold">{task.name}</h3>
                        <div className="mt-1 flex items-center gap-1.5">
                          <Badge variant="secondary" className="h-4 px-1.5 py-0 text-[11px]">{meta.label}</Badge>
                          {task.enabled ? <Badge variant="green" className="h-4 px-1.5 py-0 text-[11px]">运行中</Badge> : <Badge variant="secondary" className="h-4 px-1.5 py-0 text-[11px]">已暂停</Badge>}
                        </div>
                      </div>
                    </div>
                    {/* 悬浮操作：立即运行 / 编辑 / 删除 */}
                    <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                      <button type="button" onClick={() => runNow(task)} disabled={busy} title="立即运行" className="rounded p-1 text-foreground/25 hover:bg-black/[0.06] hover:text-primary focus:outline-none disabled:opacity-50 dark:hover:bg-white/10">
                        {busy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                      </button>
                      <button type="button" onClick={() => openEdit(task)} title="编辑" className="rounded p-1 text-foreground/25 hover:bg-black/[0.06] hover:text-foreground focus:outline-none dark:hover:bg-white/10"><Pencil size={14} /></button>
                      <button type="button" onClick={() => setDeleteTarget(task)} title="删除" className="rounded p-1 text-foreground/25 hover:bg-black/[0.06] hover:text-red-500 focus:outline-none dark:hover:bg-white/10"><Trash2 size={14} /></button>
                    </div>
                  </div>
                  <p className="mb-2 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{describeTask(task)}</p>
                  {/* 上次执行结果摘要（agent_call 执行后写回 payload.last_result） */}
                  {task.payload.last_result && (
                    <div className="mt-3 rounded-lg bg-muted/50 px-3 py-2 text-xs">
                      <div className={cn("mb-1 flex items-center gap-1.5 font-medium", task.payload.last_result.ok ? "text-emerald-700" : "text-destructive")}>
                        {task.payload.last_result.ok ? <Check size={12} /> : <AlertCircle size={12} />}
                        上次执行{task.payload.last_result.ok ? "成功" : "失败"}
                        {task.payload.last_result_time ? <span className="font-normal text-muted-foreground">· {task.payload.last_result_time}</span> : null}
                      </div>
                      {task.payload.last_result.final_message && <p className="line-clamp-3 leading-relaxed text-muted-foreground">{task.payload.last_result.final_message}</p>}
                    </div>
                  )}
                  <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-xs text-muted-foreground">
                    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1">
                      <span className="inline-flex items-center gap-1"><Clock size={12} />{formatInterval(task.interval_sec)}</span>
                      <span>上次运行：{formatTaskTime(task.last_run_at)}</span>
                      <span>下次运行：{formatTaskTime(task.next_run_at)}</span>
                    </div>
                    <Button variant="ghost" size="sm" className="h-6 shrink-0 gap-1 text-xs" onClick={() => toggleEnabled(task)} disabled={busy} title={task.enabled ? "暂停该任务" : "启用该任务"}>
                      {task.enabled ? <Pause size={12} /> : <Play size={12} />}
                      {task.enabled ? "暂停" : "启用"}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </ScrollArea>

      <Dialog open={dialogOpen} onOpenChange={open => { if (!open) closeDialog(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editTarget ? "编辑自动化" : "新建自动化"}</DialogTitle>
            <DialogDescription>配置定时执行的任务；执行间隔为 0 表示只运行一次，运行后自动暂停。</DialogDescription>
          </DialogHeader>
          <div className="mt-4 space-y-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-foreground/70">名称</label>
              <input value={name} onChange={event => setName(event.target.value)} placeholder="例如：每周研究摘要" autoFocus className="w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:border-primary/60" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-foreground/70">任务类型</label>
              <div className="grid grid-cols-2 gap-2">
                {(["agent_call", "usage_query"] as TaskType[]).map(type => (
                  <button key={type} type="button" onClick={() => setTaskType(type)} className={cn("rounded-lg border px-3 py-2 text-left text-sm transition-colors", taskType === type ? "border-primary/60 bg-primary/[0.03]" : "border-border bg-background hover:border-primary/30")}>
                    <span className="block font-medium">{TASK_TYPE_META[type].label}</span>
                    <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">{type === "agent_call" ? "定时让模型完成一轮对话" : "定时执行指定 Key 的用量查询"}</span>
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-foreground/70">执行间隔（秒）</label>
              <input type="number" min={0} value={intervalSec} onChange={event => setIntervalSec(event.target.value)} placeholder="0 表示只执行一次" className="w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:border-primary/60" />
            </div>
            {taskType === "agent_call" ? (
              <>
                <div>
                  <label className="mb-1 block text-xs font-medium text-foreground/70">执行模型</label>
                  {/* 用原生 select 而非 Popover：modal Dialog 内嵌 Popover 存在点击选项被拦截的问题 */}
                  <select value={modelKey} onChange={event => setModelKey(event.target.value)} className="w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:border-primary/60">
                    <option value="">默认模型</option>
                    {models.map(model => <option key={model.key} value={model.key}>{model.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-foreground/70">任务内容（发给模型的消息）</label>
                  <textarea value={userPrompt} onChange={event => setUserPrompt(event.target.value)} rows={3} placeholder="例如：请汇总最近一周的订阅内容，输出一份要点摘要。" className="w-full resize-none rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:border-primary/60" />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-foreground/70">附加指令（可选）</label>
                  <textarea value={instruction} onChange={event => setInstruction(event.target.value)} rows={2} placeholder="例如：以简洁的 Markdown 列表输出。" className="w-full resize-none rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:border-primary/60" />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-foreground/70">启用工具</label>
                  <div className="flex flex-wrap gap-2">
                    {[{ id: "search", label: "联网搜索" }, { id: "image", label: "图像生成" }].map(tool => (
                      <button key={tool.id} type="button" onClick={() => setSelectedTools(prev => prev.includes(tool.id) ? prev.filter(item => item !== tool.id) : [...prev, tool.id])} className={cn("rounded-full border px-3 py-1.5 text-xs font-medium transition-colors", selectedTools.includes(tool.id) ? "border-primary/60 bg-primary/10 text-primary" : "border-border bg-background text-muted-foreground hover:border-primary/30")}>
                        {tool.label}
                      </button>
                    ))}
                  </div>
                  <p className="mt-1 text-[11px] leading-snug text-muted-foreground">开启后模型可在执行时调用对应能力，需要服务端已配置相应的 API Key。</p>
                </div>
              </>
            ) : (
              <div>
                <label className="mb-1 block text-xs font-medium text-foreground/70">Key 别名</label>
                <input value={alias} onChange={event => setAlias(event.target.value)} placeholder="例如：openai-main" className="w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:border-primary/60" />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={closeDialog}>取消</Button>
            <Button onClick={submit} disabled={!name.trim() || (taskType === "agent_call" ? !userPrompt.trim() : !alias.trim()) || saving}>
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
              {saving ? "保存中…" : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteTarget !== null} onOpenChange={open => { if (!open) closeDelete(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除自动化</DialogTitle>
            <DialogDescription>确定删除「{deleteTarget?.name}」吗？此操作不可撤销。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={closeDelete}>取消</Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={deleteTarget !== null && busyTaskId === deleteTarget.id}>
              {deleteTarget !== null && busyTaskId === deleteTarget.id ? <Loader2 size={14} className="animate-spin" /> : null}
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// 工作流页面：展示工作流列表，支持新建/编辑（弹窗内配置节点参数，字段组织参考 flow 配置页）、删除。
// 当前使用本地假数据（DEFAULT_WORKFLOWS），后续 ccs /v1/flow 稳定后切换到真实 API。
// 工作流可视化编辑器（三栏）：左侧节点库、中间 ReactFlow 画布（拖拽/连线/缩放）、
// 右侧属性面板（节点/边/工作流级参数）。整体参考 flow 项目的 StudioPage。
function WorkflowEditor({ models, initial, onCancel, onSave }: {
  models: ChatModel[];
  initial: { mode: "new" } | { mode: "edit"; workflow: Workflow };
  onCancel: () => void;
  onSave: (name: string, description: string, nodes: WorkflowNode[], edges: WorkflowEdge[], variables: Record<string, string>) => Promise<void>;
}) {
  const [name, setName] = useState(initial.mode === "edit" ? initial.workflow.name : "");
  const [description, setDescription] = useState(initial.mode === "edit" ? (initial.workflow.description ?? "") : "");
  const [variables, setVariables] = useState<Record<string, string>>(initial.mode === "edit" ? { ...initial.workflow.variables } : {});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);

  // 初始画布：编辑模式用现有定义；新建模式预置"输入 → 规划 → 输出"并水平排布。
  const initialCanvasNodes = useMemo<CanvasNode[]>(() => {
    if (initial.mode === "edit") return toCanvasNodes(initial.workflow.nodes);
    const now = Date.now();
    const nodes: WorkflowNode[] = [
      demoNode(`wfnode-${now}-1`, "intake", NODE_META.intake.label, { userPromptTemplate: "{{input.prompt}}", executor: "none" }),
      demoNode(`wfnode-${now}-2`, "plan", NODE_META.plan.label, { executor: "llm", temperature: 0.3, maxTokens: 2000 }),
      demoNode(`wfnode-${now}-3`, "output", NODE_META.output.label, { executor: "none" }),
    ];
    return toCanvasNodes(nodes.map((node, index) => ({ ...node, position: { x: index * 260, y: 0 } })));
  }, [initial]);

  const initialCanvasEdges = useMemo<CanvasEdge[]>(() => {
    if (initial.mode === "edit") {
      return (initial.workflow.edges ?? []).map(edge => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        ...(edge.label ? { label: edge.label } : {}),
        ...(edge.condition || edge.loop ? { data: { condition: edge.condition, loop: edge.loop } } : {}),
      }));
    }
    // 新建模式：预置的 intake→plan→output 起始链自动连线（与旧弹窗行为一致）。
    const now = Date.now();
    const nodes: WorkflowNode[] = [
      demoNode(`wfnode-${now}-1`, "intake", NODE_META.intake.label, { userPromptTemplate: "{{input.prompt}}", executor: "none" }),
      demoNode(`wfnode-${now}-2`, "plan", NODE_META.plan.label, { executor: "llm", temperature: 0.3, maxTokens: 2000 }),
      demoNode(`wfnode-${now}-3`, "output", NODE_META.output.label, { executor: "none" }),
    ];
    return buildFlowEdges(nodes).map(edge => ({ id: edge.id, source: edge.source, target: edge.target }));
  }, [initial]);

  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<CanvasNode>(initialCanvasNodes);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<CanvasEdge>(initialCanvasEdges);

  const selectedNode = rfNodes.find(node => node.id === selectedNodeId) ?? null;
  const selectedEdge = rfEdges.find(edge => edge.id === selectedEdgeId) ?? null;

  // 连线：新增边时补一个稳定 id，避免 React Flow 的占位 id 导致 key 不稳定。
  const onConnect = (connection: Connection) => {
    setRfEdges(edges => addEdge({ ...connection, id: `edge-${Date.now()}` }, edges));
  };

  // 更新选中节点的 data 字段。
  const patchNode = (patch: Partial<WorkflowNodeData>) => {
    if (!selectedNodeId) return;
    setRfNodes(nodes => nodes.map(node => node.id === selectedNodeId ? { ...node, data: { ...node.data, ...patch } } : node));
  };

  // 修改选中节点的类型（data.nodeType）。
  const changeNodeType = (type: FlowNodeType) => {
    if (!selectedNodeId) return;
    setRfNodes(nodes => nodes.map(node => node.id === selectedNodeId ? { ...node, data: { ...node.data, nodeType: type } } : node));
  };

  // 从节点库点击添加：放在画布内错落位置，避免与新节点完全重叠。
  const addNode = (type: FlowNodeType) => {
    const id = `wfnode-${Date.now()}-${rfNodes.length + 1}`;
    const canvas = toCanvasNodes([demoNode(id, type, NODE_META[type].label, { executor: type === "human" ? "human" : "llm" })])[0];
    setRfNodes(nodes => [...nodes, { ...canvas, position: { x: 80 + (nodes.length % 6) * 48, y: 60 + Math.floor(nodes.length / 6) * 48 } }]);
    setSelectedNodeId(id);
    setSelectedEdgeId(null);
  };

  const removeSelectedNode = () => {
    if (!selectedNodeId) return;
    setRfNodes(nodes => nodes.filter(node => node.id !== selectedNodeId));
    setRfEdges(edges => edges.filter(edge => edge.source !== selectedNodeId && edge.target !== selectedNodeId));
    setSelectedNodeId(null);
  };

  // 更新选中边的 label 与 data（condition/loop）。
  const patchEdge = (patch: { label?: string; condition?: string; loop?: boolean }) => {
    if (!selectedEdgeId) return;
    setRfEdges(edges => edges.map(edge => {
      if (edge.id !== selectedEdgeId) return edge;
      const next: CanvasEdge = { ...edge };
      if (patch.label !== undefined) next.label = patch.label;
      const data = { ...(edge.data ?? {}) };
      if (patch.condition !== undefined) data.condition = patch.condition || undefined;
      if (patch.loop !== undefined) data.loop = patch.loop;
      next.data = data;
      return next;
    }));
  };

  const removeSelectedEdge = () => {
    if (!selectedEdgeId) return;
    setRfEdges(edges => edges.filter(edge => edge.id !== selectedEdgeId));
    setSelectedEdgeId(null);
  };

  const submit = async () => {
    const trimmedName = name.trim();
    if (!trimmedName || rfNodes.length === 0 || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(trimmedName, description.trim(), toWorkflowNodes(rfNodes), toWorkflowEdges(rfEdges), variables);
      onCancel();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "保存工作流失败");
    } finally {
      setSaving(false);
    }
  };

  const selectClass = "w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:border-primary/60";
  const labelClass = "mb-1 block text-xs font-medium text-foreground/80";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 顶部工具条：返回 / 名称 / 错误提示 / 保存 */}
      <div className="flex shrink-0 items-center gap-3 border-b border-black/[0.06] bg-white px-4 py-2.5 dark:border-border dark:bg-card">
        <Button variant="ghost" size="sm" className="gap-1 text-xs" onClick={onCancel}><ChevronLeft size={14} />返回</Button>
        <input value={name} onChange={event => setName(event.target.value)} placeholder="工作流名称" className="w-56 rounded-lg border bg-background px-3 py-1.5 text-sm outline-none focus:border-primary/60" />
        {error ? <span className="min-w-0 flex-1 truncate text-xs text-destructive">{error}</span> : <span className="flex-1" />}
        <Button size="sm" className="gap-1" onClick={submit} disabled={!name.trim() || rfNodes.length === 0 || saving}>
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}保存
        </Button>
      </div>
      <div className="flex min-h-0 flex-1">
        {/* 左：节点库 */}
        <div className="w-44 shrink-0 overflow-y-auto border-r border-black/[0.06] bg-white p-2 dark:border-border dark:bg-card">
          <div className="px-1 pb-1 pt-0.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">节点库</div>
          <div className="space-y-1">
            {(Object.keys(NODE_META) as FlowNodeType[]).map(type => (
              <button key={type} type="button" onClick={() => addNode(type)} className="flex w-full items-center gap-2 rounded-lg border border-transparent px-2 py-1.5 text-left text-xs transition-colors hover:border-border hover:bg-muted/50" title={NODE_META[type].description}>
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: NODE_META[type].color }} />
                <span className="font-medium text-foreground">{NODE_META[type].label}</span>
                <span className="ml-auto text-[10px] text-muted-foreground">添加</span>
              </button>
            ))}
          </div>
        </div>
        {/* 中：画布 */}
        <div className="min-w-0 flex-1 bg-background">
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, node) => { setSelectedNodeId(node.id); setSelectedEdgeId(null); }}
            onEdgeClick={(_, edge) => { setSelectedEdgeId(edge.id); setSelectedNodeId(null); }}
            onPaneClick={() => { setSelectedNodeId(null); setSelectedEdgeId(null); }}
            nodeTypes={workflowNodeTypes}
            defaultEdgeOptions={{ style: { stroke: "#52525b", strokeWidth: 1.5 } }}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#d4d4d8" />
            <Controls />
          </ReactFlow>
        </div>
        {/* 右：属性面板 */}
        <div className="w-72 shrink-0 overflow-y-auto border-l border-black/[0.06] bg-white p-3 dark:border-border dark:bg-card">
          {selectedNode ? (
            <div className="space-y-3">
              <div className="text-xs font-semibold text-foreground/80">节点配置</div>
              <div>
                <label className={labelClass}>节点名称</label>
                <input value={selectedNode.data.label} onChange={event => patchNode({ label: event.target.value })} placeholder="节点在流程中的显示名称" className={selectClass} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelClass}>类型</label>
                  <select value={selectedNode.data.nodeType} onChange={event => changeNodeType(event.target.value as FlowNodeType)} className={selectClass}>
                    {(Object.keys(NODE_META) as FlowNodeType[]).map(type => <option key={type} value={type}>{NODE_META[type].label}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelClass}>执行器</label>
                  <select value={selectedNode.data.executor ?? "llm"} onChange={event => patchNode({ executor: event.target.value as NodeExecutor })} className={selectClass}>
                    {(Object.keys(EXECUTOR_META) as NodeExecutor[]).map(key => <option key={key} value={key}>{EXECUTOR_META[key].label}</option>)}
                  </select>
                </div>
              </div>
              {selectedNode.data.executor !== "none" ? (
                <>
                  <div>
                    <label className={labelClass}>模型</label>
                    <select value={selectedNode.data.modelId} onChange={event => patchNode({ modelId: event.target.value })} className={selectClass}>
                      <option value="">默认模型</option>
                      {models.map(model => <option key={model.key} value={model.key}>{model.label}</option>)}
                    </select>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className={labelClass}>温度</label>
                      <input type="number" step="0.1" min={0} max={2} value={selectedNode.data.temperature ?? ""} onChange={event => patchNode({ temperature: event.target.value ? Number(event.target.value) : undefined })} placeholder="0~2" className={selectClass} />
                    </div>
                    <div>
                      <label className={labelClass}>最大输出</label>
                      <input type="number" min={0} value={selectedNode.data.maxTokens ?? ""} onChange={event => patchNode({ maxTokens: event.target.value ? Number(event.target.value) : undefined })} placeholder="留空不限制" className={selectClass} />
                    </div>
                  </div>
                  <div>
                    <label className={labelClass}>系统提示 systemPrompt</label>
                    <textarea rows={3} value={selectedNode.data.systemPrompt} onChange={event => patchNode({ systemPrompt: event.target.value })} placeholder="角色设定与行为约束" className={cn(selectClass, "resize-y leading-relaxed")} />
                  </div>
                  <div>
                    <label className={labelClass}>用户提示模板 userPromptTemplate</label>
                    <textarea rows={2} value={selectedNode.data.userPromptTemplate} onChange={event => patchNode({ userPromptTemplate: event.target.value })} placeholder="支持 {{input.prompt}} / {{vars.*}} / {{artifacts.别名}}" className={cn(selectClass, "resize-y leading-relaxed")} />
                  </div>
                  <div>
                    <label className={labelClass}>产物别名 artifactKey</label>
                    <input value={selectedNode.data.artifactKey ?? ""} onChange={event => patchNode({ artifactKey: event.target.value })} placeholder="供下游模板引用，如 report" className={selectClass} />
                  </div>
                </>
              ) : (
                <p className="py-2 text-xs leading-relaxed text-muted-foreground">执行器为「无」时透传或合并，不调用模型。</p>
              )}
              <Button variant="outline" size="sm" className="w-full gap-1 text-xs text-destructive hover:text-destructive" onClick={removeSelectedNode}><Trash2 size={12} />删除节点</Button>
            </div>
          ) : selectedEdge ? (
            <div className="space-y-3">
              <div className="text-xs font-semibold text-foreground/80">连线配置</div>
              <div>
                <label className={labelClass}>标签 label</label>
                <input value={typeof selectedEdge.label === "string" ? selectedEdge.label : ""} onChange={event => patchEdge({ label: event.target.value })} placeholder="可选，如「通过」" className={selectClass} />
              </div>
              <div>
                <label className={labelClass}>条件 condition</label>
                <input value={selectedEdge.data?.condition ?? ""} onChange={event => patchEdge({ condition: event.target.value })} placeholder="如 pass / fail" className={selectClass} />
              </div>
              <label className="flex cursor-pointer items-center gap-2 text-xs text-foreground/80">
                <input type="checkbox" checked={Boolean(selectedEdge.data?.loop)} onChange={event => patchEdge({ loop: event.target.checked })} className="h-3.5 w-3.5 accent-primary" />
                回边 loop（有界迭代，不计入环检测）
              </label>
              <Button variant="outline" size="sm" className="w-full gap-1 text-xs text-destructive hover:text-destructive" onClick={removeSelectedEdge}><Trash2 size={12} />删除连线</Button>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="text-xs font-semibold text-foreground/80">工作流配置</div>
              <div>
                <label className={labelClass}>描述</label>
                <textarea rows={3} value={description} onChange={event => setDescription(event.target.value)} placeholder="这个工作流做什么？" className={cn(selectClass, "resize-y leading-relaxed")} />
              </div>
              <div>
                <label className={labelClass}>节点访问上限 maxNodeVisits</label>
                <input value={variables.maxNodeVisits ?? ""} onChange={event => setVariables(prev => ({ ...prev, maxNodeVisits: event.target.value }))} placeholder="留空不限制" className={selectClass} />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function WorkflowPage({ sidebarOpen, onToggle, models }: {
  sidebarOpen: boolean;
  onToggle: () => void;
  models: ChatModel[];
}) {
  // 列表数据：直接从 /v1/flow 拉取（ccs 后端 flow 已稳定）。
  const [workflows, setWorkflows] = useState<Workflow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // 可视化编辑器：null 表示停留在列表页；{mode:"new"} 新建，{mode:"edit",workflow} 编辑。
  const [editor, setEditor] = useState<{ mode: "new" } | { mode: "edit"; workflow: Workflow } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Workflow | null>(null);
  // 内置模板：后端只读模板列表，点击「使用」实例化为工作流（参考 flow 项目 Sidebar 模板区）。
  const [templates, setTemplates] = useState<Workflow[] | null>(null);
  const [templateBusy, setTemplateBusy] = useState<string | null>(null);

  // 拉取工作流列表；失败时顶部显示错误提示，不打断其它操作。
  const loadWorkflows = async () => {
    setLoading(true);
    try {
      setWorkflows(await listWorkflows());
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "加载工作流失败");
    } finally {
      setLoading(false);
    }
  };

  // 首次进入页面时加载工作流列表与内置模板。
  useEffect(() => {
    void loadWorkflows();
    listFlowTemplates().then(setTemplates).catch(() => setTemplates([]));
  }, []);

  // 实例化模板：成功后刷新列表，让新工作流出现在下方。
  const useTemplate = async (templateId: string) => {
    if (templateBusy !== null) return;
    setTemplateBusy(templateId);
    try {
      await instantiateFlowTemplate(templateId);
      setError(null);
      await loadWorkflows();
    } catch (templateError) {
      setError(templateError instanceof Error ? templateError.message : "实例化模板失败");
    } finally {
      setTemplateBusy(null);
    }
  };

  // 关闭删除弹窗：延迟清除 body 残留的滚动/交互锁定（与其他弹窗一致）。
  const closeDelete = () => {
    setDeleteTarget(null);
    window.setTimeout(clearModalResidue, 250);
  };

  // 新建 / 编辑：进入可视化编辑器（新建不带定义，编辑带入现有工作流）。
  const openCreate = () => setEditor({ mode: "new" });
  const openEdit = (workflow: Workflow) => setEditor({ mode: "edit", workflow });

  // 可视化编辑器保存回调：新建走 createWorkflow，编辑走 updateWorkflow，成功后刷新列表。
  // 保存失败会抛出，由编辑器内展示错误并停留在编辑页。
  const saveEditor = async (nameValue: string, descriptionValue: string, nodesValue: WorkflowNode[], edgesValue: WorkflowEdge[], variablesValue: Record<string, string>) => {
    if (editor?.mode === "edit") {
      await updateWorkflow(editor.workflow.id, { name: nameValue, description: descriptionValue, nodes: nodesValue, edges: edgesValue, variables: variablesValue });
    } else {
      await createWorkflow({ name: nameValue, description: descriptionValue, nodes: nodesValue, edges: edgesValue, variables: variablesValue });
    }
    setError(null);
    await loadWorkflows();
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    closeDelete();
    try {
      await deleteWorkflow(deleteTarget.id);
      setError(null);
      void loadWorkflows();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "删除工作流失败");
    }
  };

  return (
    <>
      {editor ? (
        <WorkflowEditor initial={editor} models={models} onCancel={() => setEditor(null)} onSave={saveEditor} />
      ) : (
        <>
      <PageHeader title="工作流" subtitle="把多个步骤连接成可重复使用的流程" sidebarOpen={sidebarOpen} onToggle={onToggle} />
      <ScrollArea className="min-h-0 flex-1 bg-white dark:bg-card">
        <div className="mx-auto max-w-4xl space-y-6 px-4 py-6 sm:px-8">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold">我的工作流</h2>
              <p className="mt-1 text-sm text-muted-foreground">把多个 AI 步骤连接成可重复使用的流程。</p>
            </div>
            <Button className="gap-2" onClick={openCreate}><Plus size={15} />新建工作流</Button>
          </div>
          {error ? (
            <div className="flex items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"><AlertCircle size={16} className="shrink-0" />{error}</div>
          ) : null}
          {templates && templates.length > 0 ? (
            <div>
              <div className="mb-2 text-sm font-semibold text-foreground/80">模板</div>
              <div className="space-y-2">
                {templates.map(template => (
                  <div key={template.name} className="flex items-center gap-3 rounded-xl border border-dashed border-border bg-card/40 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-foreground">{template.name}</div>
                      {template.description ? <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{template.description}</p> : null}
                    </div>
                    <span className="shrink-0 text-xs text-muted-foreground">{template.nodes.length} 个节点</span>
                    <Button size="sm" variant="outline" className="h-8 shrink-0 gap-1 px-2.5 text-xs" onClick={() => void useTemplate(template.name)} disabled={templateBusy !== null}>
                      {templateBusy === template.name ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}使用
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {loading && workflows === null ? (
            <div className="flex items-center justify-center rounded-xl border border-dashed border-border bg-card/50 py-16 text-muted-foreground"><Loader2 size={18} className="mr-2 animate-spin" />加载中…</div>
          ) : (workflows ?? []).length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card/50 px-6 py-16 text-center">
              <WorkflowIcon size={28} className="mb-3 text-foreground/25" />
              <p className="text-sm font-medium text-foreground/70">还没有工作流</p>
              <p className="mt-1 text-xs text-muted-foreground">点击「新建工作流」创建你的第一个自动化流程。</p>
            </div>
          ) : (
            <div className="space-y-3">
              {(workflows ?? []).map(workflow => (
                <div key={workflow.id} className="group relative rounded-xl border bg-card p-4 shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md">
                  <div className="absolute right-2.5 top-2.5 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                    <button type="button" onClick={() => openEdit(workflow)} className="rounded p-1 text-foreground/25 hover:bg-black/[0.06] hover:text-foreground focus:outline-none dark:hover:bg-white/10" title="编辑工作流"><Pencil size={14} /></button>
                    <button type="button" onClick={() => setDeleteTarget(workflow)} className="rounded p-1 text-foreground/25 hover:bg-black/[0.06] hover:text-red-500 focus:outline-none dark:hover:bg-white/10" title="删除工作流"><Trash2 size={14} /></button>
                  </div>
                  <div className="pr-16">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold text-foreground">{workflow.name}</h3>
                      <Badge variant="secondary" className="h-4 px-1.5 py-0 text-xs">v{workflow.version}</Badge>
                    </div>
                    {workflow.description ? <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{workflow.description}</p> : null}
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-1.5">
                    {workflow.nodes.map((node, index) => (
                      <Fragment key={node.id}>
                        {index > 0 && <ArrowRight size={12} className="shrink-0 text-muted-foreground/50" />}
                        <span className="inline-flex items-center gap-1 rounded-md border bg-background px-1.5 py-0.5 text-xs text-foreground/80">
                          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: NODE_META[node.type].color }} />
                          {node.data.label || NODE_META[node.type].label}
                        </span>
                      </Fragment>
                    ))}
                  </div>
                  <div className="mt-3 border-t border-border/60 pt-2 text-xs text-muted-foreground">{workflow.nodes.length} 个节点 · 更新于 {formatDisplayTime(workflow.updatedAt)}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </ScrollArea>

      {/* 删除工作流确认弹窗 */}
      <Dialog open={deleteTarget !== null} onOpenChange={value => { if (!value) closeDelete(); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>删除工作流</DialogTitle>
            <DialogDescription>确定要删除「{deleteTarget?.name}」吗？此操作不可撤销。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={closeDelete}>取消</Button>
            <Button variant="destructive" onClick={confirmDelete}>删除</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
        </>
      )}
    </>
  );
}


function AssistantPage({ sidebarOpen, onToggle, onStart, assistants, onAdd, onEdit, onDelete }: {
  sidebarOpen: boolean;
  onToggle: () => void;
  onStart: (id: string) => void;
  assistants: AssistantDef[];
  onAdd: (name: string, prompt: string) => void;
  onEdit: (id: string, name: string, prompt: string) => void;
  onDelete: (id: string) => void;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AssistantDef | null>(null);
  const [editTarget, setEditTarget] = useState<AssistantDef | null>(null);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");

  // 关闭删除助手弹窗：受控 Dialog 点按钮关闭时不会触发 onOpenChange，
  // 这里统一在关闭时延迟清除 body 残留的滚动/交互锁定。
  const closeDeleteTarget = () => {
    setDeleteTarget(null);
    window.setTimeout(clearModalResidue, 250);
  };

  // 关闭对话框并清空表单，避免残留上次的编辑/添加状态。
  const closeDialog = () => {
    setDialogOpen(false);
    setEditTarget(null);
    setName("");
    setPrompt("");
    window.setTimeout(clearModalResidue, 250);
  };

  // 打开编辑对话框：预填当前助手的名称与提示词。
  const openEdit = (assistant: AssistantDef) => {
    setEditTarget(assistant);
    setName(assistant.name);
    setPrompt(assistant.prompt ?? "");
    setDialogOpen(true);
  };

  const submit = () => {
    const trimmedName = name.trim();
    if (!trimmedName) return;
    if (editTarget) {
      // 编辑模式：名称必填，提示词可为空（为空时保留原提示词）。
      onEdit(editTarget.id, trimmedName, prompt.trim());
    } else {
      const trimmedPrompt = prompt.trim();
      if (!trimmedPrompt) return;
      onAdd(trimmedName, trimmedPrompt);
    }
    closeDialog();
  };

  return (
    <>
      <PageHeader title="助手" subtitle="为不同任务准备一个专属的工作方式" sidebarOpen={sidebarOpen} onToggle={onToggle} />
<ScrollArea className="min-h-0 flex-1 bg-white dark:bg-card">
        <div className="mx-auto max-w-4xl px-4 py-6 sm:px-8">
          <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold">选择一个助手</h2>
              <p className="mt-1 text-sm text-muted-foreground">每个助手都有自己的重点和语气，你可以随时开始新的对话。</p>
            </div>
            <Button className="gap-2" onClick={() => { setEditTarget(null); setName(""); setPrompt(""); setDialogOpen(true); }}><Plus size={15} />添加助手</Button>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            {assistants.map(assistant => {
              const { id, name: assistantName, description, icon: Icon, color } = assistant;
              return (
                <div key={id} className="group relative flex flex-col rounded-xl border bg-card p-4 shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md">
                  <div className="absolute right-2 top-2 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                    <button type="button" onClick={event => { event.stopPropagation(); openEdit(assistant); }} className="rounded p-1 text-foreground/25 hover:bg-black/[0.06] hover:text-foreground focus:outline-none dark:hover:bg-white/10" title="编辑助手"><Pencil size={14} /></button>
                    <button type="button" onClick={event => { event.stopPropagation(); setDeleteTarget(assistant); }} className="rounded p-1 text-foreground/25 hover:bg-black/[0.06] hover:text-red-500 focus:outline-none dark:hover:bg-white/10" title="删除助手"><Trash2 size={14} /></button>
                  </div>
                  <button type="button" onClick={() => onStart(id)} className="flex w-full flex-1 flex-col text-left">
                    <div className="mb-3 flex items-center gap-2">
                      <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg", color)}><Icon size={17} /></div>
                      <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">{assistantName}</h3>
                    </div>
                    <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">{description}</p>
                    <div className="mt-auto flex items-center gap-1 pt-5 text-xs font-medium text-primary opacity-70 transition-opacity group-hover:opacity-100">开始使用<ArrowRight size={12} /></div>
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </ScrollArea>
      <Dialog open={dialogOpen} onOpenChange={open => { if (!open) closeDialog(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editTarget ? "编辑助手" : "添加助手"}</DialogTitle>
            <DialogDescription>{editTarget ? "修改名称或提示词，提示词将作为该助手的系统指令。" : "填写名称和提示词，创建专属助手。提示词将作为该助手的系统指令。"}</DialogDescription>
          </DialogHeader>
          <div className="mt-4 space-y-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-foreground/70">名称</label>
              <input value={name} onChange={event => setName(event.target.value)} placeholder="例如：翻译助手" autoFocus className="w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:border-primary/60" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-foreground/70">提示词</label>
              <textarea value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="例如：你是资深翻译，请把用户内容译为地道的中文。" rows={4} className="w-full resize-none rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:border-primary/60" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={closeDialog}>取消</Button>
            <Button onClick={submit} disabled={!name.trim() || (!editTarget && !prompt.trim())}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={deleteTarget !== null} onOpenChange={open => { if (!open) closeDeleteTarget(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除助手</DialogTitle>
            <DialogDescription>确定删除助手「{deleteTarget?.name}」吗？已开始的会话不受影响，此操作不可撤销。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={closeDeleteTarget}>取消</Button>
            <Button variant="destructive" onClick={() => { if (deleteTarget) onDelete(deleteTarget.id); closeDeleteTarget(); }}>删除</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default function App() {
  // 已保存的聊天状态：IndexedDB 读取是异步的，故初始为 null，
  // 挂载后经 loadChatState 恢复；stateLoaded 标记恢复完成，
  // 在此之前不保存（避免用空数据覆盖已存记录）。
  const [storedState, setStoredState] = useState<StoredChatState | null>(null);
  const [stateLoaded, setStateLoaded] = useState(false);

  const [assistants, setAssistants] = useState<AssistantDef[]>(DEFAULT_ASSISTANTS);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [activePage, setActivePage] = useState("chat");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSession, setActiveSession] = useState("");
  const [allMessages, setAllMessages] = useState<Record<string, Message[]>>({});
  // 当前正在进行的流式回复对应的中断控制器；用户点击"停止"时 abort 该请求。
  const activeRequestRef = useRef<AbortController | null>(null);
  const [models, setModels] = useState<ChatModel[]>([]);
  const [selectedModel, setSelectedModel] = useState<ChatModel | null>(null);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  // 挂载后异步恢复已保存的聊天状态（IndexedDB 优先，旧 localStorage 数据自动迁移）。
  useEffect(() => {
    let cancelled = false;
    void loadChatState().then(parsed => {
      if (cancelled) return;
      const state = normalizeStoredState(parsed);
      setStoredState(state);
      if (state) {
        // 恢复助手列表：内置助手合并最新默认配置，自定义助手补齐图标与配色，
        // 并迁移早期"占位描述"为直接显示提示词。
        if (Array.isArray(state.assistants)) {
          setAssistants(state.assistants.map(storedAssistant => {
            const builtin = DEFAULT_ASSISTANTS.find(assistant => assistant.id === storedAssistant.id);
            if (builtin) return { ...builtin, ...storedAssistant };
            const migrated = { ...storedAssistant, icon: Bot, color: "bg-primary/10 text-primary" };
            if (migrated.prompt && migrated.description === "自定义助手 · 使用你设定的提示词工作。") {
              migrated.description = migrated.prompt;
            }
            return migrated;
          }));
        }
        const initialSessions = Array.isArray(state.sessions) ? state.sessions : [];
        setSessions(initialSessions);
        // 刷新时上一次回复可能仍在生成中，sending/asking 状态被持久化后会让
        // isReplyPending 永远为 true（发送按钮被"停止"卡死、无法继续发送）。这里把
        // 残留的 sending/asking 消息降级为 success（sending 保留已输出内容、asking
        // 保留 askUser 只读展示），因为刷新后不存在进行中的请求。
        const restoredMessages: Record<string, Message[]> = {};
        for (const [sessionId, sessionMessages] of Object.entries(state.allMessages ?? {})) {
          restoredMessages[sessionId] = sessionMessages.map(message => message.status === "sending" || message.status === "asking"
            ? { ...message, status: "success" as const, ...(message.role === "assistant" ? { streamStatus: undefined } : {}) }
            : message);
        }
        setAllMessages(restoredMessages);
        setActiveSession(
          state.activeSession && initialSessions.some(session => session.id === state.activeSession)
            ? state.activeSession
            : initialSessions[0]?.id || ""
        );
      }
      setStateLoaded(true);
    });
    return () => { cancelled = true; };
  }, []);
  // 主题色默认蓝色；从本地存储恢复，键非法时回退到默认。
  const [activeTheme, setActiveTheme] = useState(() => {
    try {
      const stored = window.localStorage.getItem(THEME_KEY);
      return THEMES.some(theme => theme.key === stored) ? stored as string : "blue";
    } catch {
      return "blue";
    }
  });
  // 外观模式默认跟随系统；读取独立存储键，读取失败时回退到 system。
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    try {
      const stored = window.localStorage.getItem(THEME_MODE_KEY);
      return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
    } catch {
      return "system";
    }
  });

  // 兜底：弹窗关闭后清除 radix modal 可能残留的背景滚动/交互锁定，避免页面无法滚动。
  useEffect(() => {
    if (editingId !== null) return;
    const timer = window.setTimeout(clearModalResidue, 250);
    return () => window.clearTimeout(timer);
  }, [editingId]);

  const messages = allMessages[activeSession] ?? [];
  const activeSessionData = sessions.find(session => session.id === activeSession);

  const loadModels = async () => {
    setModelsLoading(true);
    setModelsError(null);
    try {
      // 过滤掉不能用于聊天的专用模型：reranker（重排序）/ embedding（向量化）/ review（评审），
      // 其余按名称字母顺序排序。
      const loadedModels = (await fetchModels())
        .filter(model => !/(reranker|embedding|review)/i.test(model.id))
        .map(toChatModel)
        .sort((a, b) => a.label.localeCompare(b.label, "zh-CN"));
      setModels(loadedModels);
      setSelectedModel(previous => loadedModels.find(model => model.key === (previous?.key || storedState?.selectedModelKey)) || loadedModels[0] || null);
    } catch (error) {
      setModels([]);
      setSelectedModel(null);
      setModelsError(error instanceof Error ? error.message : "模型列表加载失败");
    } finally {
      setModelsLoading(false);
    }
  };

  useEffect(() => {
    // 等已保存状态恢复完成再加载模型，这样能正确恢复上次选中的模型
    // （storedState?.selectedModelKey 依赖异步恢复结果）。
    if (!stateLoaded) return;
    void loadModels();
  }, [stateLoaded]);

  // 依据外观模式切换深色模式：system 跟随系统偏好并监听其变化，light/dark 固定。
  // 同时按当前主题色 + 深浅模式应用内联 CSS 变量（深色用偏暗的 dark 配色）。
  useEffect(() => {
    const currentTheme = THEMES.find(theme => theme.key === activeTheme) ?? THEMES[0];
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = themeMode === "dark" || (themeMode === "system" && media.matches);
      document.documentElement.classList.toggle("dark", dark);
      applyTheme(currentTheme, dark);
    };
    apply();
    if (themeMode === "system") {
      media.addEventListener("change", apply);
      return () => media.removeEventListener("change", apply);
    }
  }, [themeMode, activeTheme]);

  // 持久化主题色，供刷新/下次启动恢复。
  useEffect(() => {
    try {
      window.localStorage.setItem(THEME_KEY, activeTheme);
    } catch {
      // 本地存储不可用时忽略，仅影响刷新后的主题色记忆。
    }
  }, [activeTheme]);

  // 持久化外观模式，供刷新/下次启动恢复（index.html 首屏脚本读取同一键防闪烁）。
  useEffect(() => {
    try {
      window.localStorage.setItem(THEME_MODE_KEY, themeMode);
    } catch {
      // 本地存储不可用时忽略，仅影响刷新后的外观记忆。
    }
  }, [themeMode]);

  useEffect(() => {
    // 状态恢复完成前不写，避免用初始空状态覆盖已保存的记录。
    if (!stateLoaded) return;
    // 持久化时剔除附件的 Blob 预览 URL（刷新即失效，避免残留无效字符串）。
    const cleanAllMessages = Object.fromEntries(Object.entries(allMessages).map(([sessionId, list]) => [sessionId, list.map(message => message.files ? { ...message, files: message.files.map(file => ({ name: file.name, type: file.type, size: file.size })) } : message)]));
    const state: StoredChatState = {
      sessions,
      allMessages: cleanAllMessages,
      activeSession,
      selectedModelKey: selectedModel?.key,
      assistants: assistants.map(({ icon: _icon, color: _color, ...rest }) => rest),
    };
    // IndexedDB 写入失败时给出可见提示，不再像 localStorage 那样静默丢数据。
    void saveChatState(state).catch(error => {
      console.warn("[chat] 聊天记录保存失败：", error);
    });
  }, [sessions, allMessages, activeSession, selectedModel, assistants, stateLoaded]);

  const newSession = () => {
    const id = `new-${Date.now()}`;
    setSessions(prev => [{ id, title: "新对话", time: nowTime(), autoTitled: false }, ...prev]);
    setAllMessages(prev => ({ ...prev, [id]: [] }));
    setActiveSession(id);
    setActivePage("chat");
  };

  // 根据会话历史生成简短标题（复用 /v1/agent 非流式接口）。
  // 仅在标题仍是自动生成的初始标题（autoTitled 为 true）且成功时覆盖，
  // 用户手动改过的标题不被覆盖。
  const generateSessionTitle = async (sessionId: string) => {
    const target = sessions.find(session => session.id === sessionId);
    if (!target?.autoTitled) return;
    const modelKey = selectedModel?.key;
    if (!modelKey) return;
    const history = (allMessages[sessionId] ?? []).filter(message => message.role === "user" || message.role === "assistant");
    if (history.length < 2) return;
    try {
      const payload = await runAgent({
        model: modelKey,
        messages: history.slice(-8).map(message => ({ role: message.role, content: messageText(message) })),
        instructions: "请用不超过 15 个汉字概括这段对话的主题，直接输出标题文本，不要引号、不要解释、不要前缀。",
      });
      const raw = extractTextContent(payload?.final_message?.content).trim();
      const title = raw.replace(/^["“”「」]+|["“”「」]+$/g, "").trim().slice(0, 30);
      if (title) {
        setSessions(prev => prev.map(session => session.id === sessionId ? { ...session, title } : session));
      }
    } catch {
      // 标题生成失败时静默保留原标题，不打断用户。
    }
  };

  // 会话消息累计到 10 / 20 / 30…（每满 10 条）时触发一次标题自动生成。
  // AUTO_TITLE_ENABLED 默认关闭；开启后才消耗一次 /v1/agent 请求用于生成标题。
  const maybeAutoTitle = (sessionId: string, messageCount: number) => {
    if (!AUTO_TITLE_ENABLED) return;
    if (messageCount >= 10 && messageCount % 10 === 0) void generateSessionTitle(sessionId);
  };

  const requestAgent = async (sessionId: string, userMessageId: string, assistantMessageId: string, requestHistory: Message[], files: File[] = [], tools: string[] = [], baseMessages?: AgentMessage[]) => {
    // baseMessages 为 akm_ask_user 续跑时后端返回的完整工作消息：回答会追加在其后，
    // 让同一轮 Agent 在原有上下文上继续，而不是另起新会话。
    // 为本次流式请求创建中断控制器：点击"停止"时 abort，前端停止读取流，
    // 后端检测到连接断开后也会主动停止生成，避免中断后继续烧 token。
    const controller = new AbortController();
    activeRequestRef.current = controller;
    const modelKey = selectedModel?.key;
    if (!modelKey) {
      setAllMessages(prev => ({
        ...prev,
        [sessionId]: (prev[sessionId] ?? []).map(message => message.id === userMessageId ? { ...message, status: "send_failed" } : message),
      }));
      return;
    }

    const pendingAssistant: Message = {
      id: assistantMessageId,
      role: "assistant",
      content: "",
      time: nowTime(),
      status: "sending",
      streamStatus: "正在连接 Agent…",
    };
    setAllMessages(prev => ({
      ...prev,
      [sessionId]: [...(prev[sessionId] ?? []), pendingAssistant],
    }));

    const updateAssistant = (changes: Partial<Message>) => {
      setAllMessages(prev => ({
        ...prev,
        [sessionId]: (prev[sessionId] ?? []).map(message => message.id === assistantMessageId ? { ...message, ...changes } : message),
      }));
    };

    // —— 段序列（segments）流式累积 ——
    // 每条消息的内容按发生顺序组织为若干段（正文/思考/工具调用段），
    // 这样工具轮正文与最终轮正文是各自独立的段，不会互相覆盖，而是顺序叠加展示。
    let segments: MessageSegment[] = [];
    let curText = "";
    let curThinking = "";
    let segMode: "text" | "thinking" | null = null;
    let segTimer: number | undefined;

    // 把当前正文/思考缓冲并入段列表：若最后一个同类型段存在则追加，否则新建一段。
    const pushBuffers = () => {
      if (curText) {
        const last = segments[segments.length - 1];
        if (last?.type === "text") last.content += curText;
        else segments.push({ type: "text", content: curText });
        curText = "";
      }
      if (curThinking) {
        const last = segments[segments.length - 1];
        if (last?.type === "thinking") last.content += curThinking;
        else segments.push({ type: "thinking", content: curThinking });
        curThinking = "";
      }
    };

    // 将缓冲写回消息（40ms 节流），可选更新 streamStatus，避免逐 token 全量渲染。
    const writeSegments = (streamStatus?: string) => {
      segTimer = undefined;
      pushBuffers();
      setAllMessages(prev => ({
        ...prev,
        [sessionId]: (prev[sessionId] ?? []).map(message => message.id === assistantMessageId
          ? { ...message, segments: segments.slice(), ...(streamStatus ? { streamStatus } : {}) }
          : message),
      }));
    };

    // 立即冲刷并结束当前正文/思考流（工具边界/错误前调用，保证内容顺序）。
    const finalizeStream = () => {
      if (segTimer) {
        window.clearTimeout(segTimer);
        segTimer = undefined;
      }
      segMode = null;
      pushBuffers();
    };

    try {
      let completed = false;
      // AI 询问用户（akm_ask_user）时暂存的澄清内容；有值说明本轮已转为等待回答。
      let askPending: { question: string; options?: string[]; multiple?: boolean; messages: AgentMessage[] } | null = null;
      // 收到第一条回复事件后立即把用户消息标记为已发送成功，不再显示"发送中"。
      let userMarked = false;

      const markUserSent = () => {
        if (userMarked) return;
        userMarked = true;
        setAllMessages(prev => ({
          ...prev,
          [sessionId]: (prev[sessionId] ?? []).map(message => message.id === userMessageId ? { ...message, status: "success" as const } : message),
        }));
      };

      const searchHint = tools.includes("search")
        ? "\n用户已开启联网搜索，如需最新/实时信息请优先调用 tavily_search 工具获取结果。"
        : "";
      const imageHint = tools.includes("image")
        ? "\n用户已开启图像生成/编辑：生成请调用 akm_generate_image；编辑可用 akm_edit_image（image_path 本地路径，或 image_base64 直接传对话中的 data URL）。生成/编辑完成后请把返回的图片 URL 以 Markdown 图片语法 ![图片](url) 写进回复正文，方便用户直接查看。"
        : "";
      // 按 UI 工具开关显式声明工具（白名单）：开启联网搜索/图像生成时只声明对应工具；
      // 全关时不传 tools，后端默认不会注入联网搜索/图片生成/编辑/文件写与 shell 工具，
      // 模型拿不到这些工具定义，不会自主联网、生成图片或读写文件。
      const declaredTools = resolveDeclaredTools(tools);

      for await (const event of runAgentStream({
        model: modelKey,
        // 续跑时把后端返回的工作消息作为基底，再追加当前请求的会话消息。
        messages: baseMessages ? [...baseMessages, ...toAgentMessages(requestHistory)] : toAgentMessages(requestHistory),
        instructions: (sessions.find(session => session.id === sessionId)?.instructions ?? AGENT_INSTRUCTIONS) + searchHint + imageHint,
        tools: declaredTools.length ? declaredTools : undefined,
        files,
        signal: controller.signal,
      })) {
        markUserSent();
        if (event.event === "model_delta") {
          if (event.data.content) {
            // 若此前在思考流，先把思考段封存，让正文另起一段。
            if (segMode === "thinking") finalizeStream();
            segMode = "text";
            curText += event.data.content;
            if (!segTimer) segTimer = window.setTimeout(() => writeSegments("正在输出…"), 40);
          }
        } else if (event.event === "reasoning_delta") {
          if (event.data.content) {
            // 若此前在正文流，先把正文段封存，让思考另起一段。
            if (segMode === "text") finalizeStream();
            segMode = "thinking";
            curThinking += event.data.content;
            if (!segTimer) segTimer = window.setTimeout(() => writeSegments(), 40);
          }
        } else if (event.event === "turn_start") {
          finalizeStream();
          updateAssistant({ streamStatus: `正在处理第 ${event.data.turn ?? ""} 轮…` });
        } else if (event.event === "context_warning") {
          // 上下文占用告警：记录到消息上，正文渲染完成后随回复一并展示。
          updateAssistant({
            contextWarning: {
              estimated_tokens: event.data.estimated_tokens ?? 0,
              max_tokens: event.data.max_tokens ?? 0,
              remaining_tokens: event.data.remaining_tokens ?? 0,
              ratio: event.data.ratio ?? 0,
            },
          });
        } else if (event.event === "tool_call") {
          finalizeStream();
          const name = event.data.name || "工具";
          segments.push({ type: "tool", name, params: event.data.arguments ?? {}, result: null, status: "running" });
          updateAssistant({ segments: segments.slice(), streamStatus: `正在调用 ${name}…` });
        } else if (event.event === "tool_result") {
          finalizeStream();
          const name = event.data.name || "工具";
          const hasError = Boolean(event.data.error);
          for (let index = segments.length - 1; index >= 0; index -= 1) {
            const segment = segments[index];
            if (segment.type === "tool") {
              segment.status = hasError ? "error" : "success";
              segment.result = event.data.error ?? event.data.result ?? null;
              break;
            }
          }
          updateAssistant({ segments: segments.slice(), streamStatus: `已完成 ${name}，正在整理回复…` });
        } else if (event.event === "ask_user") {
          // AI 通过 akm_ask_user 工具询问用户：记录问题与后端返回的完整工作消息，
          // 本轮不再走 final 收尾，把回复置为 asking，等待用户在界面回答问题后续跑。
          finalizeStream();
          askPending = {
            question: event.data.question || "请补充信息以继续。",
            options: event.data.options ?? [],
            multiple: Boolean(event.data.multiple),
            messages: event.data.messages ?? [],
          };
        } else if (event.event === "error") {
          throw new Error(event.data.error || "Agent 请求失败");
        } else if (event.event === "final") {
          finalizeStream();
          const finalMessage = event.data.final_message;
          const content = extractTextContent(finalMessage?.content);
          if (!content.trim()) throw new Error("Agent 返回了空消息");
          const thinking = extractTextContent(finalMessage?.reasoning_content);

          // 最终正文覆盖最后一个 text 段（该段即最终轮正文的流式累积）；
          // 若最终轮未实时输出正文（无 text 段），则追加一段。
          const textIndex = segments.map(segment => segment.type).lastIndexOf("text");
          if (textIndex >= 0) {
            (segments[textIndex] as { type: "text"; content: string }).content = content;
          } else {
            segments.push({ type: "text", content });
          }
          // 最终思考同样覆盖最后一个 thinking 段，否则追加。
          if (thinking.trim()) {
            const thinkingIndex = segments.map(segment => segment.type).lastIndexOf("thinking");
            if (thinkingIndex >= 0) {
              (segments[thinkingIndex] as { type: "thinking"; content: string }).content = thinking;
            } else {
              segments.push({ type: "thinking", content: thinking });
            }
          }

          setAllMessages(prev => ({
            ...prev,
            [sessionId]: (prev[sessionId] ?? []).map(message => {
               if (message.id === userMessageId) return { ...message, status: "success" as const };
               if (message.id !== assistantMessageId) return message;
               return {
                 ...message,
                 content,
                segments: segments.slice(),
                time: nowTime(),
                status: "success" as const,
                streamStatus: undefined,
                // final 事件携带本次运行自动压缩次数，>0 时在消息底部提示。
                compacted: event.data.compacted,
              };
            }),
          }));
          completed = true;
        }
      }

      // 冲刷末尾残留的流式增量，避免内容丢失。
      finalizeStream();
      if (segments.length) updateAssistant({ segments: segments.slice() });

      if (askPending) {
        // 交互澄清：保留已输出的内容，把回复标记为 asking（前端显示问题卡片等待回答）。
        setAllMessages(prev => ({
          ...prev,
          [sessionId]: (prev[sessionId] ?? []).map(message => {
            if (message.id === userMessageId) return { ...message, status: "success" as const };
            if (message.id !== assistantMessageId) return message;
            return { ...message, status: "asking" as const, streamStatus: undefined, askUser: askPending, segments: segments.slice() };
          }),
        }));
      } else {
        if (!completed) throw new Error("Agent 未返回最终消息");
        // 回复成功后按累计消息数触发标题自动生成（每满 10 条一次）。
        maybeAutoTitle(sessionId, requestHistory.length + 1);
      }
    } catch (error) {
      // 出错时同样冲刷残留增量，尽量保留已输出的内容。
      finalizeStream();
      if (segments.length) updateAssistant({ segments: segments.slice() });
      // 用户主动中断（点击"停止"）时 abort 抛出的 AbortError 不算失败：
      // 保留已输出的内容，把回复正常收尾即可，不显示错误提示。
      const isAbort = error instanceof Error && error.name === "AbortError";
      const errorMessage = error instanceof Error ? error.message : "Agent 请求失败";
      setAllMessages(prev => ({
        ...prev,
        [sessionId]: (prev[sessionId] ?? []).map(message => {
          if (message.id === userMessageId) return { ...message, status: "success" as const };
          if (message.id === assistantMessageId) return isAbort
            ? { ...message, status: "success" as const, streamStatus: undefined }
            : { ...message, status: "recv_failed" as const, error: errorMessage, streamStatus: undefined };
          return message;
        }),
      }));
    } finally {
      // 本次请求已结束（无论成功/失败/中断），释放中断控制器引用。
      if (activeRequestRef.current === controller) activeRequestRef.current = null;
    }
  };

  const sendMessage = (content: string, attachments: File[] = [], tools: string[] = []) => {
    // 当前会话仍有发送中/生成中的消息时禁止再发，防止并发请求打乱上下文
    const sessionId = activeSession || `new-${Date.now()}`;
    const existing = allMessages[sessionId] ?? [];
    if (existing.some(message => message.status === "sending")) return;

    const id = `${sessionId}-user-${Date.now()}`;
    const message: Message = {
      id, role: "user", content, time: nowTime(), status: "sending",
      files: attachments.length ? attachments.map(file => ({
        name: file.name, type: file.type, size: file.size,
        previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined,
      })) : undefined,
    };
    const requestHistory = [...existing, message];
    setAllMessages(prev => ({ ...prev, [sessionId]: [...(prev[sessionId] ?? []), message] }));
    setSessions(prev => {
      if (!prev.some(session => session.id === sessionId)) {
        return [{ id: sessionId, title: content.slice(0, 22), time: nowTime(), autoTitled: true }, ...prev];
      }
      return prev.map(session => session.id === sessionId && session.title === "新对话" ? { ...session, title: content.slice(0, 22), autoTitled: true } : session);
    });
    if (!activeSession) setActiveSession(sessionId);
    void requestAgent(sessionId, id, `${sessionId}-assistant-${Date.now()}`, requestHistory, attachments, tools);
  };

  // 中断当前正在生成的回复：abort 流式请求，保留已输出内容并收尾。
  const stopReply = () => { activeRequestRef.current?.abort(); };

  // 用户回答 AI 的澄清问题（akm_ask_user）：把回答作为新用户消息追加，
  // 并用后端返回的完整工作消息（ask.messages）作为基底续跑同一轮 Agent。
  const answerQuestion = (assistantMessageId: string, answer: string) => {
    const sessionId = activeSession;
    if (!sessionId) return;
    const snapshot = allMessages[sessionId] ?? [];
    const target = snapshot.find(message => message.id === assistantMessageId);
    // 只有仍处于 asking（等待回答）状态的澄清问题才允许作答，防止重复提交。
    if (!target?.askUser || target.status !== "asking") return;

    const answerMessage: Message = {
      id: `${sessionId}-user-${Date.now()}`,
      role: "user",
      content: answer,
      time: nowTime(),
      status: "success",
    };
    // 冻结原询问消息（回到 success，只读展示问题），并追加回答消息。
    setAllMessages(prev => ({
      ...prev,
      [sessionId]: (prev[sessionId] ?? [])
        .map(message => message.id === assistantMessageId ? { ...message, status: "success" as const, streamStatus: undefined } : message)
        .concat([answerMessage]),
    }));
    // 续跑沿用当前会话的工具开关，保持白名单声明一致。
    const sessionTools = sessions.find(session => session.id === sessionId)?.tools ?? [];
    void requestAgent(sessionId, answerMessage.id, `${sessionId}-assistant-${Date.now()}`, [answerMessage], [], sessionTools, target.askUser.messages);
  };

  const retryMessage = (id: string) => {
    const sessionId = activeSession;
    const snapshot = allMessages[sessionId] ?? [];
    // 回复进行中不允许重试，避免与进行中的请求并发
    if (snapshot.some(message => message.status === "sending")) return;
    const targetIndex = snapshot.findIndex(message => message.id === id);
    if (targetIndex < 0) return;

    const target = snapshot[targetIndex];
    let userIndex = target.role === "user" ? targetIndex : -1;
    for (let index = targetIndex - 1; index >= 0 && userIndex < 0; index -= 1) {
      if (snapshot[index].role === "user") userIndex = index;
    }
    if (userIndex < 0) return;

    const userMessage = { ...snapshot[userIndex], status: "sending" as const };
    const requestHistory = [...snapshot.slice(0, userIndex + 1).slice(0, -1), userMessage];
    const assistantMessageId = target.role === "assistant" ? target.id : `${sessionId}-assistant-${Date.now()}`;
    setAllMessages(prev => ({
      ...prev,
      [sessionId]: (prev[sessionId] ?? [])
        .filter(message => target.role !== "assistant" || message.id !== target.id)
        .map(message => message.id === userMessage.id ? userMessage : message),
    }));
    // 重试沿用当前会话的工具开关（联网搜索/图像生成），保持白名单声明一致。
    const sessionTools = sessions.find(session => session.id === sessionId)?.tools ?? [];
    void requestAgent(sessionId, userMessage.id, assistantMessageId, requestHistory, [], sessionTools);
  };
  const startEdit = (id: string) => setEditingId(id);
  const saveEdit = (id: string, title: string) => { const value = title.trim(); if (value) setSessions(prev => prev.map(session => session.id === id ? { ...session, title: value, autoTitled: false } : session)); setEditingId(null); };
  const deleteSession = (id: string) => { setSessions(prev => prev.filter(session => session.id !== id)); setAllMessages(prev => { const next = { ...prev }; delete next[id]; return next; }); if (id === activeSession) { const next = sessions.find(session => session.id !== id); setActiveSession(next?.id ?? ""); } };

  const reorderSessions = (fromId: string, toId: string) => {
    setSessions(prev => {
      const fromIndex = prev.findIndex(session => session.id === fromId);
      const toIndex = prev.findIndex(session => session.id === toId);
      if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return prev;
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
  };
  const changeTheme = (theme: ThemePreset) => { setActiveTheme(theme.key); applyTheme(theme, document.documentElement.classList.contains("dark")); };
  const changeThemeMode = (mode: ThemeMode) => setThemeMode(mode);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [deleteSessionTarget, setDeleteSessionTarget] = useState<Session | null>(null);

  // 关闭删除会话弹窗：受控 Dialog 点按钮关闭时不会触发 onOpenChange，
  // 这里统一在关闭时延迟清除 body 残留的滚动/交互锁定。
  const closeDeleteSessionDialog = () => {
    setDeleteSessionTarget(null);
    window.setTimeout(clearModalResidue, 250);
  };

  // 侧边栏会话时间显示为"最后聊天时间"：取该会话最后一条消息的时间，无消息的空会话用创建时间。
  const displaySessions = sessions.map(session => {
    const list = allMessages[session.id];
    return list && list.length > 0 ? { ...session, time: list[list.length - 1].time } : session;
  });

  const content = useMemo(() => {
    if (activePage === "automation") return <AutomationPage sidebarOpen={sidebarOpen} onToggle={() => setSidebarOpen(value => !value)} models={models} defaultModelKey={selectedModel?.key ?? ""} />;
    if (activePage === "workflow") return <WorkflowPage sidebarOpen={sidebarOpen} onToggle={() => setSidebarOpen(value => !value)} models={models} />;
    if (activePage === "assistant") return <AssistantPage sidebarOpen={sidebarOpen} onToggle={() => setSidebarOpen(value => !value)} assistants={assistants} onAdd={(name, prompt) => setAssistants(prev => [{ id: `custom-${Date.now()}`, name, description: prompt, prompt, icon: Bot, color: "bg-primary/10 text-primary" }, ...prev])} onEdit={(id, name, prompt) => setAssistants(prev => prev.map(assistant => assistant.id === id ? { ...assistant, name, ...(prompt ? { prompt, description: prompt } : {}) } : assistant))} onStart={assistantId => { const assistant = assistants.find(candidate => candidate.id === assistantId); const assistantName = assistant?.name ?? "助手"; const sessionId = `${assistantId}-${Date.now()}`; const message: Message = { id: `${assistantId}-message`, role: "user", content: `你好，请以「${assistantName}」的身份来帮我。`, time: nowTime(), status: "success" }; setSessions(prev => [{ id: sessionId, title: assistantName, time: nowTime(), ...(assistant?.prompt ? { instructions: assistant.prompt } : {}) }, ...prev]); setAllMessages(prev => ({ ...prev, [sessionId]: [message] })); setActiveSession(sessionId); setActivePage("chat"); }} onDelete={assistantId => setAssistants(prev => prev.filter(assistant => assistant.id !== assistantId))} />;
    return <ChatPage session={activeSessionData} messages={messages} model={selectedModel} models={models} modelsLoading={modelsLoading} modelsError={modelsError} sidebarOpen={sidebarOpen} onToggleSidebar={() => setSidebarOpen(value => !value)} onModelChange={model => { setSelectedModel(model); if (activeSession) setSessions(prev => prev.map(session => session.id === activeSession ? { ...session, modelKey: model.key } : session)); }} onReloadModels={() => { void loadModels(); }}     onSend={(contentValue, attachments, tools) => sendMessage(contentValue, attachments, tools)} onRetry={retryMessage} onStop={stopReply} onAnswer={answerQuestion} tools={activeSessionData?.tools ?? []} onToolsChange={tools => { if (!activeSession) return; setSessions(prev => prev.map(session => session.id === activeSession ? { ...session, tools } : session)); }} />;
  }, [activePage, activeSessionData, allMessages, messages, models, modelsLoading, modelsError, selectedModel, sidebarOpen, assistants]);

  return (
    <PreviewContext.Provider value={{ openPreview: setPreviewUrl }}>
      <TooltipProvider delayDuration={400}><div className="flex h-screen w-full overflow-hidden bg-background" style={{ fontFamily: "Inter, system-ui, sans-serif" }}><Sidebar open={sidebarOpen} activePage={activePage} sessions={displaySessions} activeSession={activeSession} editingId={editingId} onPageChange={setActivePage} onNewSession={newSession} onSessionChange={id => { setActiveSession(id); setActivePage("chat"); const target = sessions.find(session => session.id === id); if (target?.modelKey) { const savedModel = models.find(model => model.key === target.modelKey); if (savedModel) setSelectedModel(savedModel); } }} onStartEdit={startEdit} onSaveEdit={saveEdit} onCloseEdit={() => setEditingId(null)} onDeleteSession={id => setDeleteSessionTarget(sessions.find(session => session.id === id) ?? null)} onReorderSessions={reorderSessions} activeTheme={activeTheme} onThemeChange={changeTheme} themeMode={themeMode} onThemeModeChange={changeThemeMode} onClose={() => setSidebarOpen(false)} /><main className="flex min-w-0 flex-1 flex-col overflow-hidden">{content}</main></div></TooltipProvider>
      <Dialog open={deleteSessionTarget !== null} onOpenChange={open => { if (!open) closeDeleteSessionDialog(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除会话</DialogTitle>
            <DialogDescription>确定删除会话「{deleteSessionTarget?.title}」吗？其中的消息将被一并删除，此操作不可撤销。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={closeDeleteSessionDialog}>取消</Button>
            <Button variant="destructive" onClick={() => { if (deleteSessionTarget) deleteSession(deleteSessionTarget.id); closeDeleteSessionDialog(); }}>删除</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {previewUrl && <Lightbox url={previewUrl} onClose={() => setPreviewUrl(null)} />}
    </PreviewContext.Provider>
  );
}
