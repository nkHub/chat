import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { Bot, CircleStop, ImageIcon, Loader2, Paperclip, PanelLeftClose, PanelLeftOpen, Search, Send, X } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { AskUserCard, CitationsBlock, ContextHint, FunctionCallBlock, MessageActions, StatusNotice } from "./blocks";
import { formatDisplayTime, messageText } from "./helpers";
import { MemoMarkdown, ThinkingBlock } from "./markdown";
import { PreviewContext } from "./preview";
import { EmptyChat, ModelSettingsPopover, ThemeSettingsPopover } from "./sidebar";
import { collectSubagentList, collectSubagentRuns, findSubagentRun, isSubagentTool, SubagentCard, SubagentListCard, SubagentListPanel, SubagentPanel, type SubagentListTask, type SubagentRun } from "./subagent";
import type { ChatModel, Message, Session } from "./types";

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

  const send = () => {
    // 回复未完成时不允许再发；空内容同样拦截
    if (isReplyPending || (!input.trim() && !attachments.length)) return;
    onSend(input.trim() || attachments.map(file => file.name).join(", "), attachments, tools);
    // 发送新消息即重新吸附到底部：即使用户此前上翻阅读历史，也应回到最新消息。
    setStickToBottom(true);
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
    {/* 右侧子进程会话面板：点击子进程卡片后滑出 */}
    {activeSubagent && <SubagentPanel run={activeSubagent} onClose={() => setActiveSubagent(null)} />}
    {/* 右侧子任务列表面板：点击子任务列表卡片后滑出 */}
    {activeSubagentList && <SubagentListPanel tasks={activeSubagentList} onClose={() => setActiveSubagentList(null)} />}
  </div>;
}

export { ChatPage };
