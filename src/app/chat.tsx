import { Fragment, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { ArrowDown, CircleStop, ImageIcon, Loader2, Lock, Paperclip, PanelLeftClose, PanelLeftOpen, Search, Send, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { AskUserCard, CitationsBlock, ContextHint, FunctionCallBlock, MessageActions, StatusNotice } from "./blocks";
import { ComposerSuggest, type SuggestGroup } from "./composer-suggest";
import { formatDisplayTime, messageText, splitSegmentForRender } from "./helpers";
import { MemoMarkdown, StreamingCodeBlock, ThinkingBlock } from "./markdown";
import { PreviewContext } from "./preview";
import { EmptyChat, ModelSettingsPopover, ThemeSettingsPopover } from "./sidebar";
import { BUILTIN_SKILLS, filterSkills, type Skill } from "./skills";
import { collectSubagentList, collectSubagentRuns, findSubagentRun, isSubagentTool, SubagentCard, SubagentListCard, SubagentListPanel, SubagentPanel, type SubagentListTask, type SubagentRun } from "./subagent";
import { groupSegments } from "@/lib/process-groups";
import { AGUIRenderer } from "@/components/agui";
import type { AGUILayout } from "@/components/agui/types";
import { ProcessTimeline } from "./process-timeline";
import type { ChatModel, Message, Session } from "./types";

// `/` 上拉的命令列表（第一期最小集）：选中即执行，不回填 chip。
const SLASH_COMMANDS: { id: string; name: string; aliases: string[]; description: string }[] = [
  { id: "stop", name: "停止", aliases: ["停止", "stop"], description: "中断当前回复" },
  { id: "new", name: "新对话", aliases: ["新对话", "new"], description: "开启一个全新的会话" },
  { id: "compact", name: "压缩上下文", aliases: ["压缩", "compact"], description: "把较早对话收成摘要，保留最近的消息" },
];

// 触发式建议面板的状态：trigger 为触发字符（$ / ），query 为触发后到光标的连续文本，
// start 为触发字符在输入文本中的下标，供选中后精确删除 `$token` 这段字。
type SuggestState = { trigger: "$" | "/"; query: string; start: number } | null;

// 输入区待发送附件：图片类生成 objectURL 用于缩略图预览，非图片仅携带文件本体。
type Attachment = { file: File; previewUrl?: string };

// 检测输入文本光标位置处是否需要弹出建议面板。规则（卡死，否则误弹）：
// - 触发字符必须是 token 边界：行首，或前一个字符是空白；
// - 触发字符到光标之间不能有空白（一旦继续输入了正文就不弹）；
// - 跨行（\n）不触发。
// IME composing 期间由调用方传 false，本函数不感知。
function detectTrigger(text: string, pos: number): SuggestState {
  for (let index = pos - 1; index >= 0; index -= 1) {
    const char = text[index];
    if (char === "\n") return null;
    if (char === "$" || char === "/") {
      const boundary = index === 0 || /\s/.test(text[index - 1]);
      if (!boundary) return null;
      const token = text.slice(index + 1, pos);
      // token 内含空白说明触发词已结束（进入了正文），不再弹。
      if (/\s/.test(token)) return null;
      return { trigger: char, query: token, start: index };
    }
  }
  return null;
}

// ---- 对话列宽（可拖拽，同时作用于消息区与输入框） ----
// 交互与常见 Chat 界面一致：主内容是一列居中区域，两侧各有一个竖向把手，
// 拖动任一侧即对称改变列宽（列居中，所以边缘位移与列宽增量是 2:1）。
// 宽度是界面偏好、与会话无关，存 localStorage；双击把手复位默认宽度。
const COLUMN_WIDTH_KEY = "aether-ai-chat-column-width";
const COLUMN_WIDTH_DEFAULT = 896; // 与原来的 max-w-4xl（56rem）一致，升级后默认视觉不变
const COLUMN_WIDTH_MIN = 560;
const COLUMN_WIDTH_MAX = 1400;

/** 把任意输入夹到允许的列宽范围（NaN / 越界都收敛到合法值）。 */
function clampColumnWidth(value: number): number {
  if (!Number.isFinite(value)) return COLUMN_WIDTH_DEFAULT;
  return Math.min(COLUMN_WIDTH_MAX, Math.max(COLUMN_WIDTH_MIN, Math.round(value)));
}

/** 读取上次保存的列宽；隐私模式下 localStorage 抛错时回落默认值。 */
function readStoredColumnWidth(): number {
  try {
    const raw = window.localStorage.getItem(COLUMN_WIDTH_KEY);
    if (!raw) return COLUMN_WIDTH_DEFAULT;
    return clampColumnWidth(Number(raw));
  } catch {
    return COLUMN_WIDTH_DEFAULT;
  }
}

/**
 * 列宽拖拽把手：贴在对话列左右边缘（列居中，位置由列宽反推）。
 *
 * 参数对照 pi-desktop 的 `ConversationWidthHandles`（`apps/desktop/src/components/`
 * 与 `styles/chat-shell.css` 的 `.chat-width-handle`）：
 * - 热区 12px 宽、**只在消息区内贯穿**（外层 wrapper 用 inset-y-0：上到 header 下、下到输入框上，
 *   绝不覆盖输入框，否则拖拽热区会挡住打字/点击）；
 * - 视觉是一个 2px × 40px 的圆角胶囊，hover / 键盘聚焦时拉到 56px 并加深，
 *   拖拽时变主题色；
 * - 与 pi-desktop 一致：**胶囊默认 `opacity: 0` 完全透明**，鼠标进入 12px 热区（或键盘聚焦）
 *   才浮现实体线——热区就是「外层那条看不见的线」，hover 外层即显示里面的实体线；
 * - 支持键盘：Tab 聚焦后 ←/→ 每次 16px 微调，双击复位默认宽度；
 * - 悬停/聚焦状态用 React state 而非 Tailwind `hover:` 变体：后者外层包了
 *   `@media (hover: hover)`，在触屏或某些内嵌 WebView 里完全不生效。
 */
function ColumnResizeHandle({
  side,
  columnWidth,
  dragging,
  onStart,
  onReset,
  onStep,
}: {
  side: "left" | "right";
  columnWidth: number;
  dragging: boolean;
  onStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onReset: () => void;
  /** 键盘 ←/→ 微调（正数表示变宽） */
  onStep: (delta: number) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  // 列居中：边缘位置 = 50% - 列宽/2，再向内收 6px（胶囊中心落在列边外侧 6px）；
  // 外层 max(6px, …) 保证窗口比列宽还窄时把手不会跑到容器外点不到。
  const edge = `max(6px, calc(50% - ${Math.round(columnWidth / 2)}px - 6px))`;
  const emphasized = dragging || hovered || focused;
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="拖拽调整对话宽度（双击复位，方向键微调）"
      aria-valuemin={COLUMN_WIDTH_MIN}
      aria-valuemax={COLUMN_WIDTH_MAX}
      aria-valuenow={columnWidth}
      title="拖拽调整宽度 · 双击复位 · 方向键微调"
      tabIndex={0}
      onPointerDown={onStart}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onDoubleClick={onReset}
      onKeyDown={event => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        // 左把手按 ← 变宽、右把手按 → 变宽，与拖拽方向的直觉一致
        const wider = side === "left" ? event.key === "ArrowLeft" : event.key === "ArrowRight";
        onStep(wider ? 16 : -16);
      }}
      style={side === "left" ? { left: edge } : { right: edge }}
      className="absolute inset-y-0 z-20 w-3 cursor-col-resize touch-none select-none outline-none"
    >
      {/* 2px 圆角胶囊：默认完全透明；只要鼠标进入外层 12px 热区（或键盘聚焦）就浮现实体线，
          拖拽时再拉长并变成主题色 */}
      <span
        className={cn(
          "absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full transition-all duration-150",
          emphasized ? "h-14 w-0.5 opacity-100" : "h-10 w-0.5 opacity-0",
          dragging ? "bg-primary/60" : "bg-muted-foreground/45",
        )}
      />
    </div>
  );
}

function ChatPage({
  session,
  sessions,
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
  onNewSession,
  onRetry,
  onStop,
  onAnswer,
  tools,
  onToolsChange,
  pendingGuide,
  onCancelGuide,
  onCompact,
  messagesLoading,
  // 过程时间线的手动展开/收起：由 App 写回 message.processOpen 并随会话持久化
  onToggleProcess,
}: {
  session?: Session;
  sessions: Session[];
  messages: Message[];
  model: ChatModel | null;
  models: ChatModel[];
  modelsLoading: boolean;
  modelsError: string | null;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onModelChange: (model: ChatModel) => void;
  onReloadModels: () => void;
  onSend: (content: string, attachments: File[], tools: string[], skillRef?: { id: string; name: string }, sessionRefs?: { id: string; title: string }[]) => void;
  onNewSession: () => void;
  onRetry: (id: string) => void;
  onAnswer: (assistantMessageId: string, answer: string) => void;
  onStop: () => void;
  tools: string[];
  onToolsChange: (tools: string[]) => void;
  pendingGuide?: string;
  onCancelGuide?: () => void;
  onCompact: () => Promise<string | null>;
  // 过程时间线的展开/收起：把用户选择写回消息（随会话持久化），而非只存在组件内 state
  onToggleProcess?: (messageId: string, open: boolean) => void;
  // 结构化布局（AG-UI）的视图切换：toText=true 切成原文，false 切回卡片
  // 首次打开时会话历史仍在从 IndexedDB 恢复：用骨架占位，避免先闪一下「开始对话」
  messagesLoading?: boolean;
}) {
  const [input, setInput] = useState("");
  // —— 对话列宽（可拖拽）——
  // columnWidth 同时作用于消息区与输入框的 max-width，保证两者等宽；
  // resizing 只用于把手的拖拽高亮，null 表示当前没在拖。
  const [columnWidth, setColumnWidth] = useState(readStoredColumnWidth);
  const [resizing, setResizing] = useState<"left" | "right" | null>(null);

  // 宽度变化即写回 localStorage（界面偏好，刷新与重开都保持）。
  useEffect(() => {
    try {
      window.localStorage.setItem(COLUMN_WIDTH_KEY, String(columnWidth));
    } catch {
      // 隐私模式 / 存储被禁用：忽略即可，不影响本次会话内的拖拽
    }
  }, [columnWidth]);

  /**
   * 开始拖拽列宽。
   *
   * 用 window 上的 pointermove/pointerup 而不是把手自身的合成事件：指针移出把手
   * （甚至移出窗口）时仍能继续拖动，松手也不会残留监听。位移乘 2 是因为列居中、
   * 拖一侧时两侧同时扩张（用户看到的边缘位移是列宽增量的一半）。
   */
  const startColumnResize = (side: "left" | "right") => (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = columnWidth;
    setResizing(side);

    const onMove = (moveEvent: PointerEvent) => {
      const delta = (side === "left" ? startX - moveEvent.clientX : moveEvent.clientX - startX) * 2;
      setColumnWidth(clampColumnWidth(startWidth + delta));
    };
    const onEnd = () => {
      setResizing(null);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
  };

  /** 双击把手复位默认列宽。 */
  const resetColumnWidth = () => setColumnWidth(COLUMN_WIDTH_DEFAULT);

  /** 键盘 ←/→ 微调列宽（每次 16px，夹在允许范围内）。 */
  const stepColumnWidth = (delta: number) => setColumnWidth(current => clampColumnWidth(current + delta));
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  // —— `$` / `/` 触发式建议面板状态 ——
  // suggest 非空时弹出上拉列表；suggestIndex 为跨分组的扁平选中索引；
  // skillChip 为已选 Skill（唯一，再选新 Skill 替换）；sessionChips 为已引用会话（上限 3，满则顶掉最早）。
  const [suggest, setSuggest] = useState<SuggestState>(null);
  const [suggestIndex, setSuggestIndex] = useState(0);
  const [skillChip, setSkillChip] = useState<Skill | null>(null);
  const [sessionChips, setSessionChips] = useState<{ id: string; title: string }[]>([]);
  // 轻提示（如命令不可用、下一期实现等），数秒后自动消失。
  const [notice, setNotice] = useState("");
  // 删除 `$token` 把光标放回触发点：记录待设置的光标位置，input 更新后由 effect 落位。
  const pendingCaretRef = useRef<number | null>(null);
  // 右侧子进程面板：activeSubagent 为当前选中的子进程（null 时面板关闭）。
  // 数据从消息的工具调用段聚合而来，不额外请求后端。
  const [activeSubagent, setActiveSubagent] = useState<SubagentRun | null>(null);
  // 子任务列表面板：activeSubagentList 非 null 时打开，展示 akm_subagent_list 聚合出的全部子任务。
  const [activeSubagentList, setActiveSubagentList] = useState<SubagentListTask[] | null>(null);
  const subagentRuns = useMemo(() => collectSubagentRuns(messages), [messages]);
  const subagentList = useMemo(() => collectSubagentList(messages), [messages]);
  const { openPreview } = useContext(PreviewContext);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [stickToBottom, setStickToBottom] = useState(true);
  // —— 主内容区宽度观测：窗口缩放或侧栏收放后判断是否还值得显示列宽把手 ——
  // 太窄时把手贴在边上既不好拖也没意义（列已经被容器压到最小），直接不渲染。
  const layoutRef = useRef<HTMLDivElement>(null);
  const [layoutWidth, setLayoutWidth] = useState(0);
  // —— 增量加载更早消息的可见加载态（此前是静默 setExtraCount，没有任何反馈）——
  const [loadingEarly, setLoadingEarly] = useState(false);
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

  // 观测主内容区宽度：窗口缩放、侧栏收放都会改变它。
  // 只有宽度够用时才渲染列宽把手（窄屏下列已被压到最小，把手贴边既难点也没意义）。
  useEffect(() => {
    const element = layoutRef.current;
    if (!element) return;
    const sync = () => setLayoutWidth(element.clientWidth);
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  /** 平滑滚到底部并恢复「吸附」状态（不在底部时输入框上方会出现这个按钮）。 */
  const scrollToBottom = () => {
    const viewport = viewportRef.current;
    if (viewport) viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" });
    setStickToBottom(true);
  };

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
        // 打开可见加载态：此前是静默加载，用户只看到列表「卡一下」
        setLoadingEarly(true);
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
    setLoadingEarly(false);
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

  // 当前会话有回复进行中时拦截刷新/关闭：浏览器弹出原生确认框，防止回复被手滑刷新刷断。
  useEffect(() => {
    if (!isReplyPending) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [isReplyPending]);

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

  // 上拉列表的分组内容：按 trigger 分两类。
  // `$` → Skill / 会话（排除当前会话，按标题过滤，会话过多时只取最近 8 个）；
  // `/` → 命令 / 模型（模型直接列出可选，对齐计划「/模型」的清单式实现）。
  // 空分组不参与渲染。
  const suggestGroups = useMemo<SuggestGroup[]>(() => {
    if (!suggest) return [];
    const hit = (value: string) => !suggest.query.trim() || value.toLowerCase().includes(suggest.query.trim().toLowerCase());
    if (suggest.trigger === "$") {
      const groups: SuggestGroup[] = [];
      const skills = filterSkills(suggest.query);
      if (skills.length > 0) {
        groups.push({ label: "Skill", items: skills.map(skill => ({ id: skill.id, name: skill.name, description: skill.description })) });
      }
      const others = sessions
        .filter(sessionItem => sessionItem.id !== session?.id)
        .filter(sessionItem => hit(sessionItem.title))
        .slice(0, 8)
        .map(sessionItem => ({ id: sessionItem.id, name: sessionItem.title || "新对话", description: "会话" }));
      if (others.length > 0) {
        groups.push({ label: "会话", items: others });
      }
      return groups;
    }
    const commands: SuggestGroup[] = [];
    const matchedCommands = SLASH_COMMANDS
      .filter(command => hit(command.name) || command.aliases.some(alias => hit(alias)))
      .map(command => ({ id: command.id, name: command.name, description: command.description }));
    if (matchedCommands.length > 0) {
      commands.push({ label: "命令", items: matchedCommands });
    }
    if (models.length > 0) {
      commands.push({ label: "模型", items: models.map(modelItem => ({ id: `model:${modelItem.key}`, name: modelItem.label, description: "模型" })) });
    }
    return commands;
  }, [suggest, sessions, session?.id, models]);

  // 触发词或 trigger 变化时重置选中索引到 0，避免残留越界高亮。
  useEffect(() => {
    setSuggestIndex(0);
  }, [suggest?.trigger, suggest?.query]);

  // 删除 `$token` 后把光标落回触发点（input 更新后执行）。
  useEffect(() => {
    if (pendingCaretRef.current === null || !textareaRef.current) return;
    const caret = pendingCaretRef.current;
    textareaRef.current.focus();
    textareaRef.current.setSelectionRange(caret, caret);
    pendingCaretRef.current = null;
  }, [input]);

  // 轻提示数秒后自动消失。
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 2400);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // 从输入文本删除 `$token` 段（触发字符 + 后续连续文本），光标回落到触发点。
  // `/` 命令同样只吃掉这一个 token，输入框里其余文字原样保留。
  const removeSuggestToken = () => {
    if (!suggest) return;
    pendingCaretRef.current = suggest.start;
    setInput(previous => previous.slice(0, suggest.start) + previous.slice(suggest.start + suggest.trigger.length + suggest.query.length));
    setSuggest(null);
    setSuggestIndex(0);
  };

  // 上拉某一项的选中处理。`$` 触发的项回填成 chip；`/` 触发的项即时执行动作。
  const selectSuggestItem = (item: { id: string; name: string }) => {
    if (!suggest) return;
    if (suggest.trigger === "$") {
      const skill = filterSkills(suggest.query).find(candidate => candidate.id === item.id) ?? BUILTIN_SKILLS.find(candidate => candidate.id === item.id);
      if (skill) {
        // Skill chip 同时只允许一个：再选新 Skill 直接替换掉旧的。
        setSkillChip(skill);
      } else {
        // 会话引用 chip 可多个、上限 3，满则顶掉最早；重复选择跳过。
        setSessionChips(previous => {
          if (previous.some(ref => ref.id === item.id)) return previous;
          return [...previous.filter(ref => ref.id !== item.id), { id: item.id, title: item.name }].slice(-3);
        });
      }
      removeSuggestToken();
      return;
    }
    // `/` 命令：选中即执行，不回填 chip。
    if (item.id.startsWith("model:")) {
      const modelItem = models.find(candidate => candidate.key === item.id.slice("model:".length));
      if (modelItem) onModelChange(modelItem);
    } else if (item.id === "stop") {
      if (isReplyPending) onStop();
      else setNotice("当前没有进行中的回复");
    } else if (item.id === "new") {
      onNewSession();
    } else if (item.id === "compact") {
      // 压缩前后给足界面反馈：进行中与完成/失败都会滚动提示，摘要卡片本身也已展示在消息区。
      if (isReplyPending) {
        setNotice("回复生成中，请稍后再压缩上下文");
      } else {
        setNotice("正在压缩上下文…");
        void onCompact().then(error => {
          if (error) setNotice(error);
          else setNotice("压缩完成：较早的对话已归纳为摘要");
        });
      }
    }
    removeSuggestToken();
  };

  // 追加附件（文件选择器选择 / 剪贴板粘贴共用）：图片类生成预览 URL，按 name+size 去重。
  const appendAttachmentFiles = (files: File[]) => {
    setAttachments(prev => {
      const incoming = files
        .filter(file => !prev.some(item => item.file.name === file.name && item.file.size === file.size))
        .map<Attachment>(file => ({ file, previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined }));
      return incoming.length > 0 ? [...prev, ...incoming] : prev;
    });
  };

  // 清空附件并释放所有图片预览 URL，避免 objectURL 泄漏。
  const clearAttachments = () => {
    setAttachments(prev => {
      prev.forEach(item => { if (item.previewUrl) URL.revokeObjectURL(item.previewUrl); });
      return [];
    });
  };

  const send = () => {
    // 空内容拦截；回复进行中时点击发送视为"中途引导"（POST 由 App 层挂起，等自然停顿点插入），
    // 不再整条拦截，避免打断用户输入节奏。
    if (!input.trim() && !attachments.length) return;
    onSend(
      input.trim() || attachments.map(item => item.file.name).join(", "),
      attachments.map(item => item.file),
      tools,
      skillChip ? { id: skillChip.id, name: skillChip.name } : undefined,
      sessionChips.length > 0 ? sessionChips.map(ref => ({ id: ref.id, title: ref.title })) : undefined,
    );
    // 发送新消息即重新吸附到底部：即使用户此前上翻阅读历史，也应回到最新消息。
    setStickToBottom(true);
    setSkillChip(null);
    setSessionChips([]);
    setSuggest(null);
    setSuggestIndex(0);
    setInput("");
    clearAttachments();
    if (textareaRef.current) textareaRef.current.style.height = "44px";
  };

  // relative：两个列宽把手用 absolute 定位贴在这块内容区的左右边缘（相对它居中）
  // 宽度不足时不渲染把手：MIN 列宽 + 两侧留白 + 把手热区，再窄下去拖拽没有实际收益。
  // layoutWidth 首帧为 0（尚未测量）时先不显示，避免窄屏闪一下把手。
  const canResize = layoutWidth > COLUMN_WIDTH_MIN + 160;
  // relative：把手用 absolute 贴在这块内容区左右边缘（相对它居中）
  return <div ref={layoutRef} className="relative flex min-h-0 flex-1 flex-col">
    <header className="flex shrink-0 items-center justify-start border-b border-black/[0.06] bg-white px-4 py-3 dark:border-border dark:bg-card">
        <div className="flex items-center gap-2">
          <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-sm" className="h-7 w-7 text-foreground/40 hover:text-foreground/70" onClick={onToggleSidebar}>{sidebarOpen ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}</Button></TooltipTrigger><TooltipContent>{sidebarOpen ? "收起侧栏" : "展开侧栏"}</TooltipContent></Tooltip>
          <div><h1 className="text-sm font-semibold leading-tight text-foreground">{session?.title ?? "新对话"}</h1><p className="mt-0.5 text-xs text-muted-foreground">{messages.length} 条消息 · {modelLabel}</p></div>
        </div>
        <div className="ml-auto"><ThemeSettingsPopover /></div>
    </header>
        {/* 列宽把手只覆盖「消息区」：外层再包一个 relative，把手 inset-y-0 正好卡在
            header 下方与输入框上方之间，热区不会压在输入框上（那里点了会打断打字） */}
        <div className="relative flex min-h-0 flex-1">
          {canResize ? (
            <>
              <ColumnResizeHandle side="left" columnWidth={columnWidth} dragging={resizing === "left"} onStart={startColumnResize("left")} onReset={resetColumnWidth} onStep={stepColumnWidth} />
              <ColumnResizeHandle side="right" columnWidth={columnWidth} dragging={resizing === "right"} onStart={startColumnResize("right")} onReset={resetColumnWidth} onStep={stepColumnWidth} />
            </>
          ) : null}
        <ScrollArea viewportRef={viewportRef} className="min-h-0 flex-1 bg-white dark:bg-card">
      {/* 消息区与输入框共用同一个 maxWidth（columnWidth），拖拽时一起变宽/变窄 */}
      <div className="mx-auto space-y-6 px-4 py-6 sm:px-6" style={{ maxWidth: columnWidth }}>
        {/* 向上增量加载更早消息：给出可见反馈（此前是静默 setExtraCount，界面只「卡一下」） */}
        {loadingEarly ? (
          <div className="flex items-center justify-center gap-2 py-1 text-xs text-muted-foreground" aria-live="polite">
            <Loader2 size={12} className="animate-spin" />
            <span>正在加载更早的消息…</span>
          </div>
        ) : null}
        {/* 首次打开（从 IndexedDB 恢复大量会话）时给骨架，避免先闪一下「开始对话」 */}
        {messagesLoading && messages.length === 0 ? (
          // 底部对齐（justify-end）+ 14px 块：会话正在恢复时贴住底部显示骨架，
          // 恢复完成后内容从底部接上，不会出现「骨架在上、内容突然跳到下方」的错位。
          <div className="flex flex-col justify-end gap-4 py-8" aria-live="polite" aria-busy="true">
            {[0, 1, 2].map(index => (
              <div key={index} className="space-y-2">
                <div className="h-3.5 w-24 animate-pulse rounded bg-muted" />
                <div className="h-3.5 w-full max-w-[520px] animate-pulse rounded bg-muted" />
                <div className="h-3.5 w-2/3 max-w-[380px] animate-pulse rounded bg-muted" />
              </div>
            ))}
          </div>
        ) : null}
        {messages.length === 0 && !messagesLoading && <EmptyChat onPrompt={prompt => { if (!isReplyPending) onSend(prompt, [], []); }} />}
        {visibleMessages.map((message, messageIndex) => message.role === "assistant" ? (
          <div key={message.id} className="group/msg min-w-0">
            {/* 不显示助手小头像（信息量低且挤占宽度）：内容直接铺满整列 */}
            <div className="min-w-0">
              {message.segments?.length ? (
                <div className="space-y-2.5">
                  {groupSegments(message.segments, {
                    // 子 Agent / 子任务列表有专用卡片，不进过程时间线（否则会丢卡片功能）
                    isSpecialTool: name => name === "akm_subagent_list" || isSubagentTool(name),
                  }).map(block => {
                    if (block.kind === "process") {
                      // 过程时间线：连续的思考/工具段聚合为一条可折叠步骤流。
                      // 展开策略：进行中默认展开（能看到当前做到哪一步），
                      // 结束后默认收起（只留「N 个步骤 已处理完 X.Xs」一行）；
                      // 用户手动切换后写回 message.processOpen，随会话一起持久化。
                      const processOpen = message.processOpen ?? message.status === "sending";
                      const runDurationMs = message.runStartedAt && message.runEndedAt && message.runEndedAt > message.runStartedAt
                        ? message.runEndedAt - message.runStartedAt
                        : 0;
                      return (
                        <ProcessTimeline
                          key={`process-${block.segmentIndexes[0]}`}
                          block={block}
                          open={processOpen}
                          onToggle={() => onToggleProcess?.(message.id, !processOpen)}
                          runDurationMs={runDurationMs}
                        />
                      );
                    }
                    if (block.kind === "render") {
                      // 渲染工具（akm_render）的产物：**原位替换**成卡片，不占时间线一行。
                      // 形状已在 process-groups 的 extractRenderLayout 里校验过（ok=true 且 blocks 非空），
                      // 这里只负责画；画不出来也只是少一张卡片，正文照常显示。
                      return (
                        <div key={`render-${block.segmentIndex}`} className="min-w-0">
                          <AGUIRenderer layout={block.layout as unknown as AGUILayout} />
                        </div>
                      );
                    }
                    if (block.kind === "special") {
                      const segment = block.segment;
                      if (segment.name === "akm_subagent_list") {
                        // 子任务列表工具段：渲染为列表卡片，点击在右侧面板查看全部子任务概要
                        return (
                          <SubagentListCard
                            key={`sublist-${block.segmentIndex}`}
                            tasks={subagentList}
                            onOpen={() => setActiveSubagentList(subagentList.length > 0 ? subagentList : [])}
                          />
                        );
                      }
                      // 子 Agent 工具段：渲染为子进程状态卡片，点击在右侧面板查看聚合信息
                      return (
                        <SubagentCard
                          key={`sub-${block.segmentIndex}`}
                          run={findSubagentRun(subagentRuns, segment) ?? null}
                          onOpen={() => setActiveSubagent(findSubagentRun(subagentRuns, segment) ?? null)}
                        />
                      );
                    }
                    // —— 正文块：拆出可能存在的"流式开放围栏" ——
                    // renderable 为定稿正文，openFence 为还在生成的代码块（闭合前灰化显示 + ▌光标）。
                    const view = splitSegmentForRender(block.content);
                    // 正文没有可见字符（空 / 纯空白）时不渲染空白气泡，避免出现空框。
                    if (!view.renderable.trim() && !view.openFence) return null;
                    return (
                      <Fragment key={`text-${block.segmentIndex}`}>
                        {view.renderable.trim() ? (
                          <div className="min-w-0 [overflow-wrap:anywhere]">
                            <MemoMarkdown content={view.renderable} />
                          </div>
                        ) : null}
                        {/* 仍在流式生成的代码块：渐进式展示（灰化 + 尾部 ▌ 光标闪烁） */}
                        {view.openFence && message.status === "sending" ? (
                          <StreamingCodeBlock fenceLine={view.openFence.fenceLine} code={view.openFence.code} />
                        ) : null}
                        {message.citations && block.segmentIndex === message.segments!.length - 1 ? <CitationsBlock citations={message.citations} /> : null}
                      </Fragment>
                    );
                  })}
                  {/* 结构化布局（AG-UI）：卡片是正文的**补充**，不是替代品。
                      规范 2.2 要求正文必须保留（解释能力 / 降级兜底 / 流式感知三项职责），
                      所以这里在正文之后**追加**卡片，不再跳过上面的正文段：从第一帧到结束
                      正文始终由 markdown 渲染器负责，不会出现「先 md、随后整块换成卡片」的闪烁。 */}
                  {message.layout ? (
                    <div className="min-w-0">
                      <AGUIRenderer layout={message.layout} />
                    </div>
                  ) : null}
                </div>
              ) : (
                <>
                  {message.thinking && <ThinkingBlock text={message.thinking} defaultOpen={messageIndex === lastAssistantIndex} />}
                  {message.functionCalls && <FunctionCallBlock calls={message.functionCalls} />}
                  {message.compactSummary ? (
                    <div className="min-w-0 rounded-xl border border-dashed border-primary/40 bg-primary/5 px-4 py-3 shadow-sm [overflow-wrap:anywhere]">
                      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-primary">
                        <Lock size={12} className="shrink-0" />
                        <span>压缩过渡：此卡之上的较早对话已收纳为摘要</span>
                      </div>
                      <div className="text-sm text-muted-foreground [overflow-wrap:anywhere]">{message.content}</div>
                      <div className="mt-2 text-[11px] leading-relaxed text-primary/60">此卡上方的完整对话记录仍保留在本地（不会删除），但发往模型时已折叠为上述摘要；从下方消息起为最近保留的原文与会话继续。</div>
                    </div>
                  ) : message.content.trim() ? (
                    <div className="min-w-0 [overflow-wrap:anywhere]">
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
              {messageText(message) && (
                <div className="mt-1.5 flex items-center justify-between px-0.5">
                  {/* 操作区：复制 +（有布局时）Layout JSON。
                      按《AG-UI 渲染架构 · 实现规范》2.1「第一帧锁定渲染器」，这里不再提供
                      「原文 / 卡片」切换 —— 正文与卡片是共存关系（正文解释、卡片给数据），
                      切换会让同一段内容在两种排版间来回跳，正是规范要消除的行为。 */}
                  {/* 操作区只保留复制：Layout JSON 的入口已去掉（调试信息对用户无价值） */}
                  <MessageActions text={messageText(message)} />
                  <span className="text-xs text-muted-foreground">{message.status === "sending" ? message.streamStatus : formatDisplayTime(message.time)}</span>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div key={message.id} className="min-w-0">
            {/* 不显示用户小头像：气泡右对齐即可区分角色，省下的宽度留给正文 */}
            <div className="flex min-w-0 flex-col items-end">
              {/* 消息携带的 Skill / 会话引用 chip：气泡只显示短引用，不摊开摘录全文 */}
              {(message.skillRef || message.sessionRefs?.length) ? (
                <div className="mb-1 flex max-w-full flex-wrap justify-end gap-1.5">
                  {message.skillRef ? <span className="inline-flex items-center rounded-md bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">{message.skillRef.name}</span> : null}
                  {message.sessionRefs?.map(ref => <span key={ref.id} className="inline-flex items-center rounded-md bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">{ref.title}</span>)}
                </div>
              ) : null}
              {/* 气泡最宽占 80%：再宽就会和整列齐平，看不出「这是我说的」那层收缩感 */}
              <div className={cn("min-w-0 max-w-[80%] rounded-xl px-4 py-2.5 text-sm leading-relaxed transition-opacity [overflow-wrap:anywhere]", message.status === "send_failed" ? "border border-destructive/30 bg-destructive/5 text-destructive" : "bg-primary text-primary-foreground", message.status === "sending" && "opacity-60")}>{message.content}</div>
              {message.files?.length ? <div className="mt-1.5 flex max-w-full flex-wrap justify-end gap-1.5">{message.files.map(file => file.type.startsWith("image/") && file.previewUrl ? <button key={`${file.name}-${file.size}`} type="button" aria-label={`预览${file.name}`} onClick={() => openPreview(file.previewUrl!)} className="overflow-hidden rounded-lg border border-primary/30 bg-white shadow-sm transition-transform hover:scale-105 dark:bg-muted"><img src={file.previewUrl} alt={file.name} className="h-12 w-12 object-cover" /></button> : <div key={`${file.name}-${file.size}`} className="flex max-w-[200px] items-center gap-1.5 rounded-lg border border-primary/30 bg-white px-2.5 py-1 text-xs font-medium text-primary dark:bg-muted"><ImageIcon size={11} className="shrink-0 text-primary/70" /><span className="truncate">{file.name}</span></div>)}</div> : null}
              {message.status === "sending" && <div className="mt-1 flex items-center gap-1"><Loader2 size={10} className="animate-spin text-muted-foreground" /><span className="text-xs text-muted-foreground">发送中…</span></div>}
              {message.status === "send_failed" && <StatusNotice status="send_failed" onRetry={() => onRetry(message.id)} />}
              {message.status === "success" && <span className="mt-1 text-xs text-muted-foreground">{formatDisplayTime(message.time)}</span>}
            </div>
          </div>
        ))}
      </div>
    </ScrollArea>
        </div>
    {/* 外层去掉水平 padding：宽度对齐交给内层与消息列共用同一套 px，否则输入框会比正文宽一圈 */}
    <div className="relative shrink-0 bg-white py-3 sm:py-4 dark:bg-card">
      {/* 不在底部时给一个回到底部的小圆按钮，浮在输入框上方（滚动跟随用户操作，不强制吸附） */}
      {!stickToBottom ? (
        <div className="pointer-events-none absolute inset-x-0 -top-11 flex justify-center">
          <button
            type="button"
            onClick={scrollToBottom}
            className="pointer-events-auto flex h-8 w-8 items-center justify-center rounded-full border bg-card text-muted-foreground shadow-md transition-colors hover:text-foreground"
            aria-label="滚动到底部"
            title="滚动到底部"
          >
            <ArrowDown size={14} />
          </button>
        </div>
      ) : null}
      {/* 输入区与消息区同宽：columnWidth 由同一个拖拽把手控制（用户要求宽度包含输入框） */}
      <div className="mx-auto px-4 sm:px-6" style={{ maxWidth: columnWidth }}>
        <div className="relative">
          <ComposerSuggest
            open={suggest !== null}
            groups={suggestGroups}
            query={suggest?.query ?? ""}
            activeIndex={suggestIndex}
            onSelect={selectSuggestItem}
          />
        <div className="overflow-hidden rounded-xl border bg-card shadow-sm transition-all focus-within:border-primary/50 focus-within:ring-1 focus-within:ring-primary/30">
          {notice ? (
            <div className="flex items-center justify-center border-b border-border/60 bg-primary/5 px-4 py-1.5 text-xs text-primary">{notice}</div>
          ) : null}
          {/* `$` 选中后回填的 chip 行：Skill 唯一，会话可多个（上限 3），均可点 × 移除 */}
          {(skillChip || sessionChips.length > 0) ? (
            <div className="flex flex-wrap items-center gap-1.5 px-4 pb-1 pt-2.5">
              {skillChip ? (
                <span className="flex items-center gap-1.5 rounded-lg border border-primary/30 bg-primary/5 px-2.5 py-1 text-xs font-medium text-primary">{skillChip.name}<button type="button" aria-label={`移除${skillChip.name}`} onClick={() => setSkillChip(null)} className="ml-0.5 shrink-0 text-primary/60 hover:text-primary"><X size={12} /></button></span>
              ) : null}
              {sessionChips.map(ref => (
                <span key={ref.id} className="flex items-center gap-1.5 rounded-lg border border-primary/30 bg-primary/5 px-2.5 py-1 text-xs font-medium text-primary">{ref.title}<button type="button" aria-label={`移除${ref.title}`} onClick={() => setSessionChips(previous => previous.filter(item => item.id !== ref.id))} className="ml-0.5 shrink-0 text-primary/60 hover:text-primary"><X size={12} /></button></span>
              ))}
            </div>
          ) : null}
          {attachments.length > 0 && <div className="flex flex-wrap gap-1.5 px-4 pb-1 pt-3">{attachments.map((item, index) => <div key={`${item.file.name}-${index}`} className="flex max-w-[180px] items-center gap-1.5 rounded-lg border border-border bg-muted px-2 py-1 text-xs text-foreground/70">{item.previewUrl ? <button type="button" aria-label={`预览${item.file.name}`} onClick={() => openPreview(item.previewUrl!)} className="shrink-0 overflow-hidden rounded-md"><img src={item.previewUrl} alt={item.file.name} className="h-9 w-9 object-cover" /></button> : <Paperclip size={11} className="shrink-0 text-muted-foreground" />}<span className="truncate">{item.file.name}</span><button type="button" aria-label={`移除${item.file.name}`} onClick={() => { if (item.previewUrl) URL.revokeObjectURL(item.previewUrl); setAttachments(prev => prev.filter((_, itemIndex) => itemIndex !== index)); }} className="ml-0.5 shrink-0 text-muted-foreground hover:text-foreground"><X size={12} /></button></div>)}</div>}
          {/* 挂起的中途引导提示：回复进行中发送的内容被暂时挂起，待当前轮自然停顿时由后端接管插入 */}
          {pendingGuide ? (
            <div className="flex items-center justify-between gap-2 border-t border-border/60 px-4 py-1.5 text-xs text-muted-foreground">
              <span className="truncate">引导已挂起：{pendingGuide}</span>
              <button type="button" aria-label="撤消引导" title="撤消引导" onClick={() => onCancelGuide?.()} className="ml-0.5 shrink-0 text-muted-foreground/70 hover:text-foreground"><X size={12} /></button>
            </div>
          ) : <div className="h-px" />}
          <textarea
            ref={textareaRef}
            value={input}
            rows={1}
            // 回复进行中也可继续输入：输入的内容会作为"中途引导"被挂起（见 pendingGuide），
            // 待当前轮 LLM 输出完整收尾时自动插入，而不是强制等整轮结束。
placeholder={isReplyPending ? "回复生成中，可输入引导，将在自然停顿时插入…" : "发送消息… (Shift+Enter 换行)"}
            // 支持拖拽图片/文件进输入框：与"附件"按钮共用 appendAttachmentFiles，走同一条附件上传链路，
            // 否则默认行为是浏览器直接打开文件，发送消息时 AI 拿不到该文件。
            onDragOver={event => {
              // 仅对携带文件的拖拽阻止默认（避免浏览器把文件当导航打开）；
              // 纯文本 / 链接等拖拽不拦截，保持浏览器默认插入行为，避免显示为空内容。
              if (Array.from(event.dataTransfer.types).includes("Files")) event.preventDefault();
            }}
            onDrop={event => {
              const files = Array.from(event.dataTransfer.files ?? []);
              if (files.length === 0) {
                // 无文件时放行给浏览器默认处理；但拖入的纯文本若为空白（如空段落 / 换行）则丢弃，
                // 避免输入框被插入 "\n\n" 这类无意义"空内容"。
                const text = event.dataTransfer.getData("text/plain") ?? "";
                if (!text.trim()) event.preventDefault();
                return;
              }
              event.preventDefault();
              appendAttachmentFiles(files);
            }}
 onPaste={event => {
              // 支持直接粘贴图片（截图 / 复制图片）：提取剪贴板中的图片文件成为附件。
              // 图片入附件区的同时，若剪贴板还携带非空纯文本（如网页复制截图+文字），不拦截文本照常插入。
              const clipboard = event.clipboardData;
              const imageFiles = Array.from(clipboard.items)
                .filter(item => item.type.startsWith("image/"))
                .map(item => item.getAsFile())
                .filter((file): file is File => file !== null);
              if (imageFiles.length === 0) return;
              if (!clipboard.getData("text/plain").trim()) event.preventDefault();
              appendAttachmentFiles(imageFiles);
            }}
            onChange={event => {
              const value = event.target.value;
              setInput(value);
              event.target.style.height = "auto";
              event.target.style.height = `${Math.min(event.target.scrollHeight, 160)}px`;
              // 中文输入法 composing 期间不弹，避免拼音阶段误触发列表。
              const composing = (event.nativeEvent as InputEvent).isComposing === true;
              const pos = event.target.selectionEnd ?? value.length;
              setSuggest(composing ? null : detectTrigger(value, pos));
            }}
            onKeyDown={event => {
              // 弹层打开时：↑↓ 选择、Enter 确认、Esc 关闭；Enter 不再发送消息。
              if (suggest) {
                const items = suggestGroups.flatMap(group => group.items);
                const total = items.length;
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  if (total > 0) selectSuggestItem(items[suggestIndex % total]);
                  else {
                    setSuggest(null);
                    setSuggestIndex(0);
                  }
                  return;
                }
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  if (total > 0) setSuggestIndex(index => (index + 1) % total);
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  if (total > 0) setSuggestIndex(index => (index - 1 + total) % total);
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  setSuggest(null);
                  setSuggestIndex(0);
                  return;
                }
              }
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                send();
              }
            }}
            className={cn(
              "w-full resize-none bg-transparent px-4 pb-2 pt-3.5 text-sm text-foreground outline-none placeholder:text-muted-foreground",
              isReplyPending && "opacity-90",
            )}
            style={{ minHeight: 44, maxHeight: 160 }}
          />
          <div className="flex items-center justify-between px-3 pb-3 pt-1">
            <div className="flex min-w-0 items-center gap-0.5">
              <input ref={fileInputRef} type="file" multiple accept="image/*,.txt" className="hidden" onChange={event => { appendAttachmentFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
              <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="sm" className="h-7 gap-1.5 text-xs text-muted-foreground hover:text-foreground" onClick={() => fileInputRef.current?.click()} disabled={isReplyPending}><Paperclip size={13} />附件</Button></TooltipTrigger><TooltipContent>上传文件</TooltipContent></Tooltip>
              <Separator orientation="vertical" className="mx-1 h-4" />
              {/* 联网搜索 / 图像生成两个开关独立成组：外层 gap-0.5 是给「图标按钮相邻」用的，
                  这里每个 chip 自带底色，贴太近会连成一块，单独给 6px 间距 */}
              <div className="flex items-center gap-1.5">
                {[{ id: "search", icon: Search, label: "联网搜索" }, { id: "image", icon: ImageIcon, label: "图像生成" }].map(({ id, icon: Icon, label }) => <Tooltip key={id}><TooltipTrigger asChild><Button variant={tools.includes(id) ? "secondary" : "ghost"} size="sm" className={cn("h-7 gap-1.5 text-xs", tools.includes(id) ? "text-primary" : "text-muted-foreground hover:text-foreground")} onClick={() => onToolsChange(tools.includes(id) ? tools.filter(item => item !== id) : [...tools, id])} disabled={isReplyPending}><Icon size={13} /><span className="hidden lg:inline">{label}</span></Button></TooltipTrigger><TooltipContent>{label}</TooltipContent></Tooltip>)}
              </div>
            </div>
            <div className="flex min-w-0 items-center gap-2">
              <ModelSettingsPopover model={model} models={models} modelsLoading={modelsLoading} modelsError={modelsError} onModelChange={onModelChange} onReloadModels={onReloadModels} />
              {/* 回复生成中：输入框有内容时按钮仍为发送，点击发送"中途引导"（App 层挂起，等自然停顿时插入）；
                  输入框为空时才切换为"停止"，点击中断当前回复；非回复中始终为发送按钮 */}
              {isReplyPending && !input.trim() && !attachments.length
                ? <Button size="icon-sm" className="h-7 w-7" onClick={onStop} title="中断回复"><CircleStop size={13} /></Button>
                : <Button size="icon-sm" className="h-7 w-7" onClick={send} disabled={!model || (!input.trim() && !attachments.length)} title={isReplyPending ? "发送引导" : "发送消息"}><Send size={13} /></Button>}
            </div>
          </div>
          </div>
        </div>
      </div>
    </div>
    {/* 右侧子进程会话面板：点击子进程卡片后滑出 */}
    {activeSubagent && <SubagentPanel run={activeSubagent} onClose={() => setActiveSubagent(null)} />}
    {/* 右侧子任务列表面板：点击子任务列表卡片后滑出 */}
    {activeSubagentList && <SubagentListPanel tasks={activeSubagentList} onClose={() => setActiveSubagentList(null)} />}
  </div>;
}

export { ChatPage };
