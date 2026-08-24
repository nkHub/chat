import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { Bot, CircleStop, ImageIcon, Loader2, Lock, Paperclip, PanelLeftClose, PanelLeftOpen, Search, Send, X } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { AskUserCard, CitationsBlock, ContextHint, FunctionCallBlock, MessageActions, StatusNotice } from "./blocks";
import { ComposerSuggest, type SuggestGroup } from "./composer-suggest";
import { formatDisplayTime, messageText } from "./helpers";
import { MemoMarkdown, ThinkingBlock } from "./markdown";
import { PreviewContext } from "./preview";
import { EmptyChat, ModelSettingsPopover, ThemeSettingsPopover } from "./sidebar";
import { BUILTIN_SKILLS, filterSkills, type Skill } from "./skills";
import { collectSubagentList, collectSubagentRuns, findSubagentRun, isSubagentTool, SubagentCard, SubagentListCard, SubagentListPanel, SubagentPanel, type SubagentListTask, type SubagentRun } from "./subagent";
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
}) {
  const [input, setInput] = useState("");
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

  return <div className="flex min-h-0 flex-1 flex-col">
    <header className="flex shrink-0 items-center justify-start border-b border-black/[0.06] bg-white px-4 py-3 dark:border-border dark:bg-card">
        <div className="flex items-center gap-2">
          <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-sm" className="h-7 w-7 text-foreground/40 hover:text-foreground/70" onClick={onToggleSidebar}>{sidebarOpen ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}</Button></TooltipTrigger><TooltipContent>{sidebarOpen ? "收起侧栏" : "展开侧栏"}</TooltipContent></Tooltip>
          <div><h1 className="text-sm font-semibold leading-tight text-foreground">{session?.title ?? "新对话"}</h1><p className="mt-0.5 text-xs text-muted-foreground">{messages.length} 条消息 · {modelLabel}</p></div>
        </div>
        <div className="ml-auto"><ThemeSettingsPopover /></div>
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
                    if (segment.name === "akm_subagent_list") {
                      // 子任务列表工具段：渲染为列表卡片，点击在右侧面板查看全部子任务概要
                      return (
                        <SubagentListCard
                          key={`sublist-${segmentIndex}`}
                          tasks={subagentList}
                          onOpen={() => setActiveSubagentList(subagentList.length > 0 ? subagentList : [])}
                        />
                      );
                    }
                    return isSubagentTool(segment.name) ? (
                      // 子 Agent 工具段：渲染为子进程状态卡片，点击在右侧面板查看聚合信息
                      <SubagentCard
                        key={`sub-${segmentIndex}`}
                        run={findSubagentRun(subagentRuns, segment) ?? null}
                        onOpen={() => setActiveSubagent(findSubagentRun(subagentRuns, segment) ?? null)}
                      />
                    ) : (
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
                  ) : message.compactSummary ? (
                    <div className="min-w-0 rounded-xl border border-dashed border-primary/40 bg-primary/5 px-4 py-3 shadow-sm [overflow-wrap:anywhere]">
                      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-primary">
                        <Lock size={12} className="shrink-0" />
                        <span>压缩过渡：此卡之上的较早对话已收纳为摘要</span>
                      </div>
                      <div className="text-sm text-muted-foreground [overflow-wrap:anywhere]">{message.content}</div>
                      <div className="mt-2 text-[11px] leading-relaxed text-primary/60">此卡上方的完整对话记录仍保留在本地（不会删除），但发往模型时已折叠为上述摘要；从下方消息起为最近保留的原文与会话继续。</div>
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
              {/* 消息携带的 Skill / 会话引用 chip：气泡只显示短引用，不摊开摘录全文 */}
              {(message.skillRef || message.sessionRefs?.length) ? (
                <div className="mb-1 flex max-w-full flex-wrap justify-end gap-1.5">
                  {message.skillRef ? <span className="inline-flex items-center rounded-md bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">{message.skillRef.name}</span> : null}
                  {message.sessionRefs?.map(ref => <span key={ref.id} className="inline-flex items-center rounded-md bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">{ref.title}</span>)}
                </div>
              ) : null}
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
              {[{ id: "search", icon: Search, label: "联网搜索" }, { id: "image", icon: ImageIcon, label: "图像生成" }].map(({ id, icon: Icon, label }) => <Tooltip key={id}><TooltipTrigger asChild><Button variant={tools.includes(id) ? "secondary" : "ghost"} size="sm" className={cn("h-7 gap-1.5 text-xs", tools.includes(id) ? "text-primary" : "text-muted-foreground hover:text-foreground")} onClick={() => onToolsChange(tools.includes(id) ? tools.filter(item => item !== id) : [...tools, id])} disabled={isReplyPending}><Icon size={13} /><span className="hidden lg:inline">{label}</span></Button></TooltipTrigger><TooltipContent>{label}</TooltipContent></Tooltip>)}
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
