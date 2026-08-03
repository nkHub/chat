import { Children, createContext, isValidElement, memo, useContext, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
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
  Clock,
  Copy,
  Cpu,
  ExternalLink,
  ImageIcon,
  Loader2,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Paperclip,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Send,
  Settings,
  Share2,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
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
import { fetchModels, runAgentStream, type AgentMessage, type ApiModel } from "@/lib/agent-api";

type ThemePreset = {
  key: string;
  label: string;
  primary: string;
  secondary: string;
  accent: string;
};

type MessageStatus = "success" | "sending" | "send_failed" | "recv_failed";

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
};

type Session = { id: string; title: string; time: string; tools?: string[]; modelKey?: string };

type ChatModel = {
  key: string;
  label: string;
  badge: string;
  badgeVariant: "blue" | "green" | "secondary";
};

type StoredChatState = {
  sessions?: Session[];
  allMessages?: Record<string, Message[]>;
  activeSession?: string;
  selectedModelKey?: string;
};

const CHAT_STORAGE_KEY = "aether-ai-chat-state";
const AGENT_INSTRUCTIONS = "你是 AetherAI 内置助手，请用中文回复，回答要清晰、准确、可执行。";

const THEMES: ThemePreset[] = [
  { key: "blue", label: "蓝色", primary: "#1a56db", secondary: "#eef2ff", accent: "#dbeafe" },
  { key: "violet", label: "紫色", primary: "#7c3aed", secondary: "#f5f3ff", accent: "#ede9fe" },
  { key: "rose", label: "玫瑰", primary: "#e11d48", secondary: "#fff1f2", accent: "#ffe4e6" },
  { key: "emerald", label: "翠绿", primary: "#059669", secondary: "#ecfdf5", accent: "#d1fae5" },
  { key: "amber", label: "琥珀", primary: "#d97706", secondary: "#fffbeb", accent: "#fef3c7" },
  { key: "slate", label: "石墨", primary: "#334155", secondary: "#f1f5f9", accent: "#e2e8f0" },
];

const QUICK_PROMPTS = [
  { icon: Brain, label: "技术答疑", prompt: "帮我解释一下这段代码的含义和潜在问题。" },
  { icon: Zap, label: "效率提升", prompt: "帮我优化以下工作流程，让它更高效。" },
  { icon: Search, label: "深度研究", prompt: "帮我调研并总结该领域的最新进展。" },
  { icon: Wrench, label: "方案设计", prompt: "帮我设计一个可落地的技术方案，包含架构图和步骤。" },
];

const ASSISTANTS = [
  { id: "researcher", name: "研究助手", description: "梳理资料、提炼重点，快速形成研究结论。", icon: Search, color: "bg-blue-100 text-blue-600" },
  { id: "writer", name: "写作助手", description: "把零散想法整理成清晰、有说服力的文字。", icon: Pencil, color: "bg-violet-100 text-violet-600" },
  { id: "coder", name: "编码助手", description: "分析代码、定位问题，给出可落地的实现建议。", icon: Cpu, color: "bg-emerald-100 text-emerald-600" },
];

function readStoredChatState(): StoredChatState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(CHAT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredChatState;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function toChatModel(model: ApiModel): ChatModel {
  return {
    key: model.id,
    label: model.id,
    badge: model.owned_by || "可用",
    badgeVariant: "secondary",
  };
}

function formatTime(date = new Date()) {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(date);
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

function toAgentMessages(messages: Message[]): AgentMessage[] {
  return messages
    .filter(message => message.role === "user" || message.role === "assistant")
    .filter(message => message.status !== "send_failed" && message.status !== "recv_failed")
    .map(message => ({ role: message.role, content: message.content }));
}

function applyTheme(theme: ThemePreset) {
  const root = document.documentElement;
  root.style.setProperty("--primary", theme.primary);
  root.style.setProperty("--primary-foreground", "#ffffff");
  root.style.setProperty("--secondary", theme.secondary);
  root.style.setProperty("--secondary-foreground", theme.primary);
  root.style.setProperty("--accent", theme.accent);
  root.style.setProperty("--accent-foreground", theme.primary);
  root.style.setProperty("--ring", theme.primary);
  root.style.setProperty("--sidebar-primary", theme.primary);
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

function renderMarkdown(text: string) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={MARKDOWN_COMPONENTS}
    >
      {text}
    </ReactMarkdown>
  );
}

// 记忆化 Markdown 渲染：仅当内容变化时才重新解析，避免消息列表全量重渲染时重复解析未变化的消息。
const MemoMarkdown = memo(function MemoMarkdown({ content }: { content: string }) {
  return <div>{renderMarkdown(content)}</div>;
});

// 思考过程折叠块：默认展开状态由 defaultOpen 决定（最新消息默认展开），
// 展开/收起状态由组件内部记忆，重新渲染不会重置。
function ThinkingBlock({ text, defaultOpen = false }: { text: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details open={open} className="mb-2.5 overflow-hidden rounded-lg border border-violet-200 bg-violet-50/60">
      <summary onClick={event => { event.preventDefault(); setOpen(value => !value); }} className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-left text-xs text-violet-600">
        <Brain size={12} className="shrink-0 text-violet-500" />
        <span className="font-medium">思考过程</span>
        <span className="ml-auto text-xs text-muted-foreground">{open ? "收起" : "展开"}</span>
      </summary>
      <div onClick={() => setOpen(false)} className="border-t border-violet-200 px-3 pb-3 pt-2 text-xs leading-relaxed text-violet-700/70">
        {text}
      </div>
    </details>
  );
}

// 把服务端返回的图片 http_url（http://127.0.0.1:{port}/agent-uploads/xxx）转成
// 经 Vite 代理的相对路径 /akm-api/agent-uploads/xxx，避免端口硬编码与跨源问题。
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
  return match ? `/akm-api${match[1]}` : url;
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
    <div className="mb-2.5 overflow-hidden rounded-lg border border-amber-200 bg-amber-50/70">
      <div className="flex items-center gap-2 border-b border-amber-200 px-3 py-2 text-xs font-medium text-amber-700">
        <Wrench size={12} />
        <span>工具调用</span>
        <span className="ml-auto text-xs text-amber-700/60">{calls.length} 项</span>
      </div>
      <div className="divide-y divide-amber-200/70">
        {calls.map((call, index) => {
          const imageUrls = extractGeneratedImages(call.result);
          return (
            <details key={`${call.name}-${index}`} className="group px-3 py-2">
              <summary className="flex cursor-pointer list-none items-center gap-2 text-xs text-amber-900/80">
                {call.status === "success" ? <Check size={12} className="text-emerald-600" /> : call.status === "running" ? <Loader2 size={12} className="animate-spin text-amber-600" /> : <AlertCircle size={12} className="text-red-500" />}
                <code className="font-mono">{call.name}</code>
                <ChevronRight size={12} className="ml-auto transition-transform group-open:rotate-90" />
              </summary>
              <pre className="mt-2 overflow-x-auto rounded bg-white/70 p-2 text-xs leading-relaxed text-amber-900/70">{JSON.stringify({ params: call.params, result: call.result }, null, 2)}</pre>
              {imageUrls.length > 0 && (
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {imageUrls.map((url, imageIndex) => (
                    <img key={imageIndex} src={url} alt={`生成图片 ${imageIndex + 1}`} className="w-full cursor-zoom-in rounded border border-amber-200/70 bg-white/70 object-contain" onClick={() => openPreview(url)} />
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
  onDeleteSession,
  activeTheme,
  onThemeChange,
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
  onDeleteSession: (id: string) => void;
  activeTheme: string;
  onThemeChange: (theme: ThemePreset) => void;
  onClose: () => void;
}) {
  const [editValue, setEditValue] = useState("");
  const links = [
    { icon: MessageSquare, label: "对话", page: "chat", plus: true },
    { icon: Cpu, label: "助手", page: "assistant", plus: false },
    { icon: Zap, label: "工作流", page: "workflow", plus: false },
    { icon: Clock, label: "自动化", page: "automation", plus: false },
  ];
  return (
    <>
      {open && <button type="button" aria-label="关闭侧栏" className="fixed inset-0 z-30 bg-black/20 md:hidden" onClick={onClose} />}
      <aside className={cn("fixed inset-y-0 left-0 z-40 flex shrink-0 flex-col overflow-hidden border-r border-black/[0.06] bg-[#f2f3f5] transition-all duration-200 md:relative md:inset-auto md:z-auto", open ? "w-[240px]" : "w-0 border-r-0") }>
        <div className={cn("flex h-full w-[240px] flex-col transition-opacity duration-150", open ? "opacity-100" : "opacity-0")}>
          <div className="flex items-center gap-2.5 border-b border-black/[0.06] px-4 py-[15px]">
            <Avatar className="h-7 w-7 rounded-md"><AvatarFallback className="rounded-md bg-primary text-primary-foreground"><Bot size={14} /></AvatarFallback></Avatar>
            <span className="text-sm font-semibold tracking-tight text-foreground">AetherAI</span>
            <button type="button" aria-label="收起侧栏" className="ml-auto rounded p-1 text-foreground/40 hover:bg-black/[0.06] hover:text-foreground md:hidden" onClick={onClose}><PanelLeftClose size={14} /></button>
          </div>
          <div className="space-y-0.5 px-2 pb-1 pt-3">
            {links.map(({ icon: Icon, label, page, plus }) => (
              <button key={page} type="button" onClick={() => onPageChange(page)} className={cn("group flex w-full items-center gap-2.5 rounded-md px-2.5 py-[7px] text-xs font-medium transition-colors", page === activePage ? "bg-black/[0.07] text-foreground" : "text-foreground/50 hover:bg-black/[0.05] hover:text-foreground/80")}>
                <Icon size={13} /><span className="flex-1 text-left">{label}</span>
                {plus && <span onClick={event => { event.stopPropagation(); onNewSession(); }} className="rounded p-0.5 opacity-40 transition-opacity hover:bg-black/[0.08] hover:opacity-100 group-hover:opacity-70"><Plus size={13} /></span>}
              </button>
            ))}
          </div>
          <ScrollArea className="min-h-0 flex-1 px-2">
            <p className="px-2.5 py-1.5 text-xs font-semibold uppercase tracking-widest text-foreground/30">最近对话</p>
            {sessions.map(session => (
              <ContextMenu key={session.id}>
                <ContextMenuTrigger asChild>
                  <div onClick={() => editingId !== session.id && onSessionChange(session.id)} className={cn("mb-0.5 flex w-full cursor-pointer select-none items-start justify-between rounded-md px-2.5 py-2 text-left transition-colors", session.id === activeSession ? "bg-primary/10 text-primary" : "text-foreground/55 hover:bg-black/[0.05] hover:text-foreground/80")}>
                    {editingId === session.id ? (
                      <input autoFocus value={editValue} onChange={event => setEditValue(event.target.value)} onBlur={() => onSaveEdit(session.id, editValue)} onKeyDown={event => { if (event.key === "Enter") onSaveEdit(session.id, editValue); if (event.key === "Escape") onSaveEdit(session.id, session.title); }} onClick={event => event.stopPropagation()} className="min-w-0 flex-1 rounded bg-black/[0.06] px-1.5 py-0.5 text-xs text-foreground outline-none focus:ring-1 focus:ring-primary/40" />
                    ) : <span className="line-clamp-2 min-w-0 flex-1 pr-2 text-xs leading-snug">{session.title}</span>}
                    <span className="mt-0.5 shrink-0 text-xs text-foreground/30">{session.time}</span>
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
            <div className="flex items-center gap-2"><Avatar className="h-7 w-7"><AvatarFallback className="bg-primary text-xs font-bold text-primary-foreground">测</AvatarFallback></Avatar><div><p className="text-xs font-medium leading-tight text-foreground">测试</p></div></div>
            <Popover><PopoverTrigger asChild><Button variant="ghost" size="icon-sm" className="h-7 w-7 text-foreground/40 hover:bg-black/[0.06] hover:text-foreground/70"><Settings size={13} /></Button></PopoverTrigger><PopoverContent side="right" align="end" sideOffset={10} className="w-52 p-3"><p className="mb-2.5 text-xs font-semibold text-foreground">主题色</p><div className="grid grid-cols-3 gap-2">{THEMES.map(theme => <button key={theme.key} type="button" onClick={() => onThemeChange(theme)} className={cn("flex flex-col items-center gap-1.5 rounded-lg border px-2 py-2 transition-all hover:bg-muted", activeTheme === theme.key ? "border-primary bg-primary/5" : "border-border")}><span className="h-5 w-5 rounded-full" style={{ background: theme.primary, boxShadow: activeTheme === theme.key ? `0 0 0 2px white, 0 0 0 4px ${theme.primary}` : "none" }} /><span className="text-xs leading-none text-muted-foreground">{theme.label}</span></button>)}</div></PopoverContent></Popover>
          </div>
        </div>
      </aside>
    </>
  );
}

function PageHeader({ title, subtitle, sidebarOpen, onToggle }: { title: string; subtitle: string; sidebarOpen: boolean; onToggle: () => void }) {
  return <header className="flex shrink-0 items-center gap-2 border-b border-black/[0.06] bg-white px-4 py-3"><Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-sm" className="h-7 w-7 text-foreground/40 hover:text-foreground/70" onClick={onToggle}>{sidebarOpen ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}</Button></TooltipTrigger><TooltipContent>{sidebarOpen ? "收起侧栏" : "展开侧栏"}</TooltipContent></Tooltip><div><h1 className="text-sm font-semibold leading-tight text-foreground">{title}</h1><p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p></div></header>;
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
          {modelsLoading ? <p className="px-2 py-3 text-xs text-muted-foreground">正在读取 /v1/models…</p> : models.length ? models.map(item => <button key={item.key} type="button" onClick={() => { onModelChange(item); setOpen(false); }} className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-2 text-left text-xs transition-colors hover:bg-muted"><span className="min-w-0 truncate">{item.label}</span><span className="flex shrink-0 items-center gap-1.5"><Badge variant={item.badgeVariant} className="h-4 max-w-24 truncate px-1.5 py-0 text-xs">{item.badge}</Badge>{model?.key === item.key && <Check size={12} className="text-primary" />}</span></button>) : <div className="px-2 py-3 text-xs text-muted-foreground">{modelsError || "暂无可用模型"}</div>}
        </div>
        {modelsError && <button type="button" className="mt-1 w-full border-t px-2 pt-2 text-left text-xs text-destructive underline underline-offset-2" onClick={onReloadModels}>重试读取模型</button>}

      </PopoverContent>
    </Popover>
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
  tools: string[];
  onToolsChange: (tools: string[]) => void;
}) {
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [stickToBottom, setStickToBottom] = useState(true);
  const modelLabel = model?.label || (modelsLoading ? "加载模型中…" : "未选择模型");

  // 最新一条 assistant 消息的索引，用于让它的思考区域默认展开。
  const lastAssistantIndex = messages.reduce((last, message, index) => (message.role === "assistant" ? index : last), -1);

  // 监听滚动位置：只有处于底部附近时才保持"吸附到底部"状态。
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const handleScroll = () => {
      const nearBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 40;
      setStickToBottom(nearBottom);
    };
    viewport.addEventListener("scroll", handleScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", handleScroll);
  }, []);

  // 切换会话后默认定位到底部。
  const prevSessionIdRef = useRef(session?.id);
  useEffect(() => {
    if (prevSessionIdRef.current === session?.id) return;
    prevSessionIdRef.current = session?.id;
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollTop = viewport.scrollHeight;
    setStickToBottom(true);
  }, [session?.id]);

  // 取最后一条助手消息的内容长度，用于感知流式输出增长。
  const lastAssistantContent = useMemo(() => {    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === "assistant") return messages[index].content;
    }
    return "";
  }, [messages]);

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
    if (!input.trim() && !attachments.length) return;
    onSend(input.trim() || attachments.map(file => file.name).join(", "), attachments, tools);
    setInput("");
    setAttachments([]);
    if (textareaRef.current) textareaRef.current.style.height = "44px";
  };

  return <div className="flex min-h-0 flex-1 flex-col">
    <header className="flex shrink-0 items-center justify-start border-b border-black/[0.06] bg-white px-4 py-3">
      <div className="flex items-center gap-2">
        <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-sm" className="h-7 w-7 text-foreground/40 hover:text-foreground/70" onClick={onToggleSidebar}>{sidebarOpen ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}</Button></TooltipTrigger><TooltipContent>{sidebarOpen ? "收起侧栏" : "展开侧栏"}</TooltipContent></Tooltip>
        <div><h1 className="text-sm font-semibold leading-tight text-foreground">{session?.title ?? "新对话"}</h1><p className="mt-0.5 text-xs text-muted-foreground">{messages.length} 条消息 · {modelLabel}</p></div>
      </div>
    </header>
        <ScrollArea viewportRef={viewportRef} className="min-h-0 flex-1 bg-white">
      <div className="mx-auto max-w-4xl space-y-6 px-4 py-6 sm:px-6">
        {messages.length === 0 && <EmptyChat onPrompt={prompt => onSend(prompt, [], [])} />}
        {messages.map((message, messageIndex) => message.role === "assistant" ? (
          <div key={message.id} className="group/msg flex gap-3">
            <Avatar className="mt-0.5 h-7 w-7 shrink-0"><AvatarFallback className="bg-primary text-primary-foreground"><Bot size={13} /></AvatarFallback></Avatar>
            <div className="min-w-0 max-w-[88%] flex-1 sm:max-w-[80%]">
              {message.segments?.length ? (
                <div className="space-y-2.5">
                  {message.segments.map((segment, segmentIndex) => {
                    if (segment.type === "text") {
                      return (
                        <div key={`text-${segmentIndex}`} className="rounded-xl border bg-card px-4 py-3 shadow-sm">
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
                    <div className="rounded-xl border bg-card px-4 py-3 shadow-sm">
                      <MemoMarkdown content={message.content} />
                      {message.citations && <CitationsBlock citations={message.citations} />}
                    </div>
                  ) : null}
                </>
              )}
              {message.status === "recv_failed" && <StatusNotice status="recv_failed" error={message.error} onRetry={() => onRetry(message.id)} />}
              {messageText(message) && <div className="mt-1.5 flex items-center justify-between px-0.5"><MessageActions text={messageText(message)} /><span className="text-xs text-muted-foreground">{message.status === "sending" ? message.streamStatus : message.time}</span></div>}
            </div>
          </div>
        ) : (
          <div key={message.id} className="flex flex-row-reverse gap-3">
            <Avatar className="mt-0.5 h-7 w-7 shrink-0"><AvatarFallback className="bg-blue-100 text-xs font-bold text-blue-600">测</AvatarFallback></Avatar>
            <div className="flex max-w-[88%] flex-col items-end sm:max-w-[72%]">
              <div className={cn("rounded-xl px-4 py-2.5 text-sm leading-relaxed transition-opacity", message.status === "send_failed" ? "border border-destructive/30 bg-destructive/5 text-destructive" : "bg-primary text-primary-foreground", message.status === "sending" && "opacity-60")}>{message.content}</div>
              {message.status === "sending" && <div className="mt-1 flex items-center gap-1"><Loader2 size={10} className="animate-spin text-muted-foreground" /><span className="text-xs text-muted-foreground">发送中…</span></div>}
              {message.status === "send_failed" && <StatusNotice status="send_failed" onRetry={() => onRetry(message.id)} />}
              {message.status === "success" && <span className="mt-1 text-xs text-muted-foreground">{message.time}</span>}
            </div>
          </div>
        ))}
      </div>
    </ScrollArea>
    <div className="shrink-0 bg-white px-3 py-3 sm:px-6 sm:py-4">
      <div className="mx-auto max-w-3xl">
        <div className="overflow-hidden rounded-xl border bg-card shadow-sm transition-all focus-within:border-primary/50 focus-within:ring-1 focus-within:ring-primary/30">
          {attachments.length > 0 && <div className="flex flex-wrap gap-1.5 px-4 pb-1 pt-3">{attachments.map((file, index) => <div key={`${file.name}-${index}`} className="flex max-w-[180px] items-center gap-1.5 rounded-lg border border-border bg-muted px-2.5 py-1 text-xs text-foreground/70"><Paperclip size={11} className="shrink-0 text-muted-foreground" /><span className="truncate">{file.name}</span><button type="button" aria-label={`移除${file.name}`} onClick={() => setAttachments(prev => prev.filter((_, itemIndex) => itemIndex !== index))} className="ml-0.5 shrink-0 text-muted-foreground hover:text-foreground"><X size={12} /></button></div>)}</div>}
          <textarea ref={textareaRef} value={input} rows={1} placeholder="发送消息… (Shift+Enter 换行)" onChange={event => { setInput(event.target.value); event.target.style.height = "auto"; event.target.style.height = `${Math.min(event.target.scrollHeight, 160)}px`; }} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(); } }} className="w-full resize-none bg-transparent px-4 pb-2 pt-3.5 text-sm text-foreground outline-none placeholder:text-muted-foreground" style={{ minHeight: 44, maxHeight: 160 }} />
          <div className="flex items-center justify-between px-3 pb-3 pt-1">
            <div className="flex min-w-0 items-center gap-0.5">
              <input ref={fileInputRef} type="file" multiple accept="image/*,.txt" className="hidden" onChange={event => { setAttachments(prev => [...prev, ...Array.from(event.target.files ?? [])]); event.target.value = ""; }} />
              <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="sm" className="h-7 gap-1.5 text-xs text-muted-foreground hover:text-foreground" onClick={() => fileInputRef.current?.click()}><Paperclip size={13} />附件</Button></TooltipTrigger><TooltipContent>上传文件</TooltipContent></Tooltip>
              <Separator orientation="vertical" className="mx-1 h-4" />
              {[{ id: "search", icon: Search, label: "联网搜索" }, { id: "image", icon: ImageIcon, label: "图像生成" }].map(({ id, icon: Icon, label }) => <Tooltip key={id}><TooltipTrigger asChild><Button variant={tools.includes(id) ? "secondary" : "ghost"} size="sm" className={cn("h-7 gap-1.5 text-xs", tools.includes(id) ? "text-primary" : "text-muted-foreground hover:text-foreground")} onClick={() => onToolsChange(tools.includes(id) ? tools.filter(item => item !== id) : [...tools, id])}><Icon size={13} /><span className="hidden lg:inline">{label}</span></Button></TooltipTrigger><TooltipContent>{label}</TooltipContent></Tooltip>)}
            </div>
            <div className="flex min-w-0 items-center gap-1">
              <ModelSettingsPopover model={model} models={models} modelsLoading={modelsLoading} modelsError={modelsError} onModelChange={onModelChange} onReloadModels={onReloadModels} />
              <Button size="icon-sm" className="h-7 w-7" onClick={send} disabled={!model || (!input.trim() && !attachments.length)}><Send size={13} /></Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>;
}

function AutomationPage({ sidebarOpen, onToggle }: { sidebarOpen: boolean; onToggle: () => void }) {
  return <><PageHeader title="自动化" subtitle="让重复任务在合适的时间自动运行" sidebarOpen={sidebarOpen} onToggle={onToggle} /><ScrollArea className="min-h-0 flex-1 bg-white"><div className="mx-auto max-w-4xl space-y-6 px-4 py-6 sm:px-8"><div className="flex flex-wrap items-end justify-between gap-4"><div><h2 className="text-xl font-semibold text-foreground">自动化任务</h2><p className="mt-1 text-sm text-muted-foreground">集中管理定时运行的任务和通知。</p></div><Button className="gap-2"><Plus size={15} />新建自动化</Button></div><div className="grid gap-3 sm:grid-cols-2"><div className="rounded-xl border bg-card p-4 shadow-sm"><div className="mb-5 flex items-center justify-between"><div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-100 text-blue-600"><Clock size={17} /></div><span className="rounded-full bg-emerald-100 px-2 py-1 text-xs font-semibold text-emerald-700">运行中</span></div><h3 className="text-sm font-semibold">每周研究摘要</h3><p className="mt-1 text-xs leading-relaxed text-muted-foreground">每周一上午 9:00 汇总订阅内容。</p><div className="mt-5 flex items-center justify-between border-t pt-3 text-xs text-muted-foreground"><span>下次运行：周一 09:00</span><button type="button" className="text-xs leading-none text-primary hover:underline">查看详情</button></div></div><div className="rounded-xl border bg-card p-4 shadow-sm"><div className="mb-5 flex items-center justify-between"><div className="flex h-9 w-9 items-center justify-center rounded-lg bg-violet-100 text-violet-600"><Zap size={17} /></div><span className="rounded-full bg-muted px-2 py-1 text-xs font-semibold text-muted-foreground">已暂停</span></div><h3 className="text-sm font-semibold">竞品价格监测</h3><p className="mt-1 text-xs leading-relaxed text-muted-foreground">每日抓取指定商品的价格变化。</p><div className="mt-5 flex items-center justify-between border-t pt-3 text-xs text-muted-foreground"><span>上次运行：昨天 18:00</span><button type="button" className="text-xs leading-none text-primary hover:underline">继续运行</button></div></div></div></div></ScrollArea></>;
}

function WorkflowPage({ sidebarOpen, onToggle }: { sidebarOpen: boolean; onToggle: () => void }) {
  const steps = [{ title: "接收输入", text: "从表单或 webhook 接收内容", icon: MessageSquare }, { title: "分析内容", text: "调用模型提取关键信息", icon: Brain }, { title: "执行动作", text: "将结果发送到目标服务", icon: Zap }];
  return <><PageHeader title="工作流" subtitle="把多个步骤连接成可重复使用的流程" sidebarOpen={sidebarOpen} onToggle={onToggle} /><ScrollArea className="min-h-0 flex-1 bg-white"><div className="mx-auto max-w-4xl space-y-6 px-4 py-6 sm:px-8"><div className="flex flex-wrap items-end justify-between gap-4"><div><h2 className="text-xl font-semibold">我的工作流</h2><p className="mt-1 text-sm text-muted-foreground">从一个清晰的流程开始自动化你的工作。</p></div><Button className="gap-2"><Plus size={15} />新建工作流</Button></div><div className="rounded-xl border bg-card p-5 shadow-sm"><div className="flex items-start justify-between"><div><div className="flex items-center gap-2"><h3 className="text-sm font-semibold">内容摘要流程</h3><Badge variant="green" className="h-4 px-1.5 py-0 text-xs">已启用</Badge></div><p className="mt-1 text-xs text-muted-foreground">将长文本整理成适合分享的要点摘要。</p></div><Button variant="ghost" size="icon-sm" className="h-7 w-7 text-muted-foreground"><Settings size={14} /></Button></div><div className="mt-6 grid gap-2 md:grid-cols-[1fr_auto_1fr_auto_1fr] md:items-center">{steps.map((step, index) => <><div key={step.title} className="rounded-lg border bg-background px-3 py-3"><div className="mb-2 flex h-7 w-7 items-center justify-center rounded-md bg-primary/10 text-primary"><step.icon size={14} /></div><p className="text-xs font-semibold">{step.title}</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">{step.text}</p></div>{index < steps.length - 1 && <ArrowRight key={`arrow-${step.title}`} size={15} className="mx-auto rotate-90 text-muted-foreground md:rotate-0" />}</>)}</div></div></div></ScrollArea></>;
}

function AssistantPage({ sidebarOpen, onToggle, onStart }: { sidebarOpen: boolean; onToggle: () => void; onStart: (id: string) => void }) {
  return <><PageHeader title="助手" subtitle="为不同任务准备一个专属的工作方式" sidebarOpen={sidebarOpen} onToggle={onToggle} /><ScrollArea className="min-h-0 flex-1 bg-white"><div className="mx-auto max-w-4xl px-4 py-6 sm:px-8"><div className="mb-6"><h2 className="text-xl font-semibold">选择一个助手</h2><p className="mt-1 text-sm text-muted-foreground">每个助手都有自己的重点和语气，你可以随时开始新的对话。</p></div><div className="grid gap-3 md:grid-cols-3">{ASSISTANTS.map(({ id, name, description, icon: Icon, color }) => <button key={id} type="button" onClick={() => onStart(id)} className="group rounded-xl border bg-card p-4 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md"><div className={cn("mb-5 flex h-9 w-9 items-center justify-center rounded-lg", color)}><Icon size={17} /></div><h3 className="text-sm font-semibold">{name}</h3><p className="mt-1.5 min-h-10 text-xs leading-relaxed text-muted-foreground">{description}</p><div className="mt-5 flex items-center gap-1 text-xs font-medium text-primary opacity-70 transition-opacity group-hover:opacity-100">开始使用<ArrowRight size={12} /></div></button>)}</div></div></ScrollArea></>;
}

export default function App() {
  const [storedState] = useState<StoredChatState | null>(() => readStoredChatState());
  const initialSessions = Array.isArray(storedState?.sessions) ? storedState.sessions : [];
  const initialMessages = storedState?.allMessages ?? {};
  const initialActiveSession = storedState?.activeSession && initialSessions.some(session => session.id === storedState.activeSession)
    ? storedState.activeSession
    : initialSessions[0]?.id || "";

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [activePage, setActivePage] = useState("chat");
  const [sessions, setSessions] = useState<Session[]>(initialSessions);
  const [activeSession, setActiveSession] = useState(initialActiveSession);
  const [allMessages, setAllMessages] = useState<Record<string, Message[]>>(initialMessages);
  const [models, setModels] = useState<ChatModel[]>([]);
  const [selectedModel, setSelectedModel] = useState<ChatModel | null>(null);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [activeTheme, setActiveTheme] = useState("blue");

  const messages = allMessages[activeSession] ?? [];
  const activeSessionData = sessions.find(session => session.id === activeSession);

  const loadModels = async () => {
    setModelsLoading(true);
    setModelsError(null);
    try {
      const loadedModels = (await fetchModels()).map(toChatModel);
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
    void loadModels();
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify({
        sessions,
        allMessages,
        activeSession,
        selectedModelKey: selectedModel?.key,
      } satisfies StoredChatState));
    } catch {
      // 本地存储不可用时仍保留当前会话，避免影响正在进行的请求。
    }
  }, [sessions, allMessages, activeSession, selectedModel]);

  const newSession = () => {
    const id = `new-${Date.now()}`;
    setSessions(prev => [{ id, title: "新对话", time: "刚刚" }, ...prev]);
    setAllMessages(prev => ({ ...prev, [id]: [] }));
    setActiveSession(id);
    setActivePage("chat");
  };

  const requestAgent = async (sessionId: string, userMessageId: string, assistantMessageId: string, requestHistory: Message[], files: File[] = [], tools: string[] = []) => {
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
      time: formatTime(),
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
        ? "\n用户已开启图像生成，如需生成图片请调用 akm_generate_image 工具；生成完成后请把返回的图片 URL 以 Markdown 图片语法 ![图片](url) 写进回复正文，方便用户直接查看。"
        : "";

      for await (const event of runAgentStream({
        model: modelKey,
        messages: toAgentMessages(requestHistory),
        instructions: AGENT_INSTRUCTIONS + searchHint + imageHint,
        files,
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
                time: formatTime(),
                status: "success" as const,
                streamStatus: undefined,
              };
            }),
          }));
          completed = true;
        }
      }

      // 冲刷末尾残留的流式增量，避免内容丢失。
      finalizeStream();
      if (segments.length) updateAssistant({ segments: segments.slice() });

      if (!completed) throw new Error("Agent 未返回最终消息");
    } catch (error) {
      // 出错时同样冲刷残留增量，尽量保留已输出的内容。
      finalizeStream();
      if (segments.length) updateAssistant({ segments: segments.slice() });
      const errorMessage = error instanceof Error ? error.message : "Agent 请求失败";
      setAllMessages(prev => ({
        ...prev,
        [sessionId]: (prev[sessionId] ?? []).map(message => {
          if (message.id === userMessageId) return { ...message, status: "success" as const };
          if (message.id === assistantMessageId) return { ...message, status: "recv_failed" as const, error: errorMessage, streamStatus: undefined };
          return message;
        }),
      }));
    }
  };

  const sendMessage = (content: string, attachments: File[] = [], tools: string[] = []) => {
    const sessionId = activeSession || `new-${Date.now()}`;
    const id = `${sessionId}-user-${Date.now()}`;
    const message: Message = { id, role: "user", content, time: formatTime(), status: "sending" };
    const requestHistory = [...(allMessages[sessionId] ?? []), message];
    setAllMessages(prev => ({ ...prev, [sessionId]: [...(prev[sessionId] ?? []), message] }));
    setSessions(prev => {
      if (!prev.some(session => session.id === sessionId)) {
        return [{ id: sessionId, title: content.slice(0, 22), time: "刚刚" }, ...prev];
      }
      return prev.map(session => session.id === sessionId && session.title === "新对话" ? { ...session, title: content.slice(0, 22) } : session);
    });
    if (!activeSession) setActiveSession(sessionId);
    void requestAgent(sessionId, id, `${sessionId}-assistant-${Date.now()}`, requestHistory, attachments, tools);
  };

  const retryMessage = (id: string) => {
    const sessionId = activeSession;
    const snapshot = allMessages[sessionId] ?? [];
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
    void requestAgent(sessionId, userMessage.id, assistantMessageId, requestHistory);
  };
  const startEdit = (id: string) => setEditingId(id);
  const saveEdit = (id: string, title: string) => { const value = title.trim(); if (value) setSessions(prev => prev.map(session => session.id === id ? { ...session, title: value } : session)); setEditingId(null); };
  const deleteSession = (id: string) => { setSessions(prev => prev.filter(session => session.id !== id)); setAllMessages(prev => { const next = { ...prev }; delete next[id]; return next; }); if (id === activeSession) { const next = sessions.find(session => session.id !== id); setActiveSession(next?.id ?? ""); } };
  const changeTheme = (theme: ThemePreset) => { setActiveTheme(theme.key); applyTheme(theme); };
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const content = useMemo(() => {
    if (activePage === "automation") return <AutomationPage sidebarOpen={sidebarOpen} onToggle={() => setSidebarOpen(value => !value)} />;
    if (activePage === "workflow") return <WorkflowPage sidebarOpen={sidebarOpen} onToggle={() => setSidebarOpen(value => !value)} />;
    if (activePage === "assistant") return <AssistantPage sidebarOpen={sidebarOpen} onToggle={() => setSidebarOpen(value => !value)} onStart={assistantId => { const id = `new-${Date.now()}`; const assistantName = ASSISTANTS.find(assistant => assistant.id === assistantId)?.name ?? "助手"; const message: Message = { id: `${id}-message`, role: "user", content: `你好，请以「${assistantName}」的身份来帮我。`, time: formatTime(), status: "success" }; setSessions(prev => [{ id, title: "新对话", time: "刚刚" }, ...prev]); setAllMessages(prev => ({ ...prev, [id]: [message] })); setActiveSession(id); setActivePage("chat"); }} />;
    return <ChatPage session={activeSessionData} messages={messages} model={selectedModel} models={models} modelsLoading={modelsLoading} modelsError={modelsError} sidebarOpen={sidebarOpen} onToggleSidebar={() => setSidebarOpen(value => !value)} onModelChange={model => { setSelectedModel(model); if (activeSession) setSessions(prev => prev.map(session => session.id === activeSession ? { ...session, modelKey: model.key } : session)); }} onReloadModels={() => { void loadModels(); }}     onSend={(contentValue, attachments, tools) => sendMessage(contentValue, attachments, tools)} onRetry={retryMessage} tools={activeSessionData?.tools ?? []} onToolsChange={tools => { if (!activeSession) return; setSessions(prev => prev.map(session => session.id === activeSession ? { ...session, tools } : session)); }} />;
  }, [activePage, activeSessionData, allMessages, messages, models, modelsLoading, modelsError, selectedModel, sidebarOpen]);

  return (
    <PreviewContext.Provider value={{ openPreview: setPreviewUrl }}>
      <TooltipProvider delayDuration={400}><div className="flex h-screen w-full overflow-hidden bg-background" style={{ fontFamily: "Inter, system-ui, sans-serif" }}><Sidebar open={sidebarOpen} activePage={activePage} sessions={sessions} activeSession={activeSession} editingId={editingId} onPageChange={setActivePage} onNewSession={newSession} onSessionChange={id => { setActiveSession(id); setActivePage("chat"); const target = sessions.find(session => session.id === id); if (target?.modelKey) { const savedModel = models.find(model => model.key === target.modelKey); if (savedModel) setSelectedModel(savedModel); } }} onStartEdit={startEdit} onSaveEdit={saveEdit} onDeleteSession={deleteSession} activeTheme={activeTheme} onThemeChange={changeTheme} onClose={() => setSidebarOpen(false)} /><main className="flex min-w-0 flex-1 flex-col overflow-hidden">{content}</main></div></TooltipProvider>
      {previewUrl && <Lightbox url={previewUrl} onClose={() => setPreviewUrl(null)} />}
    </PreviewContext.Provider>
  );
}
