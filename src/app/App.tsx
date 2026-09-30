import { useEffect, useMemo, useRef, useState } from "react";
import { Bot } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import { compactMessages, fetchModels, runAgent, runAgentStream, type AgentMessage } from "@/lib/agent-api";
import { loadChatState, saveChatState } from "@/lib/chat-store";
import { CLIENT_TOOLS, executeClientTool } from "@/lib/client-tools";
import { AssistantPage } from "./assistant";
import { AutomationPage } from "./automation";
import { ChatPage } from "./chat";
import { AGENT_INSTRUCTIONS, AUTO_TITLE_ENABLED, COMPACT_KEEP_RECENT, DEFAULT_ASSISTANTS, THEMES, THEME_KEY, THEME_MODE_KEY } from "./constants";
import { clearModalResidue, extractTextContent, fenceCloser, messageText, normalizeStoredState, nowTime, sessionRefsToContextMessages, splitFenceDeltas, toAgentMessages, toChatModel } from "./helpers";
import { BUILTIN_SKILLS } from "./skills";
import { Lightbox, PreviewContext } from "./preview";
import { Sidebar } from "./sidebar";
import { applyTheme, ThemeContext } from "./theme";
import type { AssistantDef, ChatModel, Message, MessageSegment, Session, StoredChatState, ThemeMode, ThemePreset } from "./types";
import { WorkflowPage } from "./workflow";

// 组装"发送给模型的视角历史"：发生过上下文压缩的会话，用所有摘要消息 + 最近
// COMPACT_KEEP_RECENT 条原文作为视角（更早的原文只出现在摘要里），未压缩则原样返回。
// 注意这里只裁剪"发往模型"的历史；allMessages（界面渲染与本地 IndexedDB）始终保留完整
// 原文，因此压缩后刷新仍能看到全部对话记录，不会被删。
function buildRequestHistory(list: Message[]): Message[] {
  const summaries: Message[] = [];
  const original = list.filter(message => {
    if (message.compactSummary) { summaries.push(message); return false; }
    return true;
  });
  if (summaries.length === 0) return list;
  return [...summaries, ...original.slice(-COMPACT_KEEP_RECENT)];
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
  // 回复进行中用户输入的"中途引导"：内容、附件、工具开关。流式回复在每个自然停顿点
  // （后端 turn_pause 事件）到来时自动插入，避免打断半截残话。cancel 后清空。
  const pendingGuideRef = useRef<{ content: string; attachments: File[]; tools: string[] } | null>(null);
  // 挂起引导的文本预览（用于输入区提示条展示）；空表示当前没有挂起引导。
  const [pendingGuide, setPendingGuide] = useState<string>("");
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
      // 过滤掉不能用于聊天的专用模型：reranker（重排序）/ embedding（向量化）/ review（评审）/ image（图像生成），
      // 其余按名称字母顺序排序。
      const loadedModels = (await fetchModels())
        .filter(model => !/(reranker|embedding|review|image)/i.test(model.id))
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

  const requestAgent = async (sessionId: string, userMessageId: string, assistantMessageId: string, requestHistory: Message[], files: File[] = [], tools: string[] = [], baseMessages?: AgentMessage[], injected: AgentMessage[] = [], resumeSegments?: MessageSegment[]) => {
    // injected 为引用会话（$ + 会话名）整理出的上下文消息：拼在历史之前，
    // 让模型能看到被引用会话的对话记录。仅在首次发送时由 sendMessage 传入。
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

    // resumeSegments 有值 = 客户端工具续跑：结果要接回同一条助手消息。
    // 不能再插一条同 id 的气泡——两条同 id 会让 React 串 key，流式文本对错位
    // （实测 grok 被改写成 arok），同一轮回复也会被拆成上下两张卡片。
    const resumeExisting = resumeSegments !== undefined;
    if (!resumeExisting) {
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
    } else {
      setAllMessages(prev => ({
        ...prev,
        [sessionId]: (prev[sessionId] ?? []).map(message => message.id === assistantMessageId
          ? { ...message, status: "sending" as const, streamStatus: "正在连接 Agent…" }
          : message),
      }));
    }

    const updateAssistant = (changes: Partial<Message>) => {
      setAllMessages(prev => ({
        ...prev,
        [sessionId]: (prev[sessionId] ?? []).map(message => message.id === assistantMessageId ? { ...message, ...changes } : message),
      }));
    };

    // —— 段序列（segments）流式累积 ——
    // 每条消息的内容按发生顺序组织为若干段（正文/思考/工具调用段），
    // 这样工具轮正文与最终轮正文是各自独立的段，不会互相覆盖，而是顺序叠加展示。
    // 续跑时带上本轮已经落地的段（含刚执行完的客户端工具），新正文接在后面。
    // 拷贝一层，避免和上一次请求闭包里的段对象互相改。
    let segments: MessageSegment[] = resumeExisting ? resumeSegments.map(segment => ({ ...segment })) : [];
    // 本轮新产生的正文/思考从这里开始；final 只覆盖本轮的段，不回写工具之前的正文。
    const segmentBaseline = segments.length;
    let curText = "";
    let curThinking = "";
    let segMode: "text" | "thinking" | null = null;
    let segTimer: number | undefined;

    // 把当前正文增量并入段列表（append，语义与逐帧 flush 累加一致）：最后一个 text 段
    // 存在则追加，否则新建正文段。注意流式正文（含未闭合代码围栏原文）逐帧写回后由
    // 渲染层按围栏状态切分展示：围栏前正文走 markdown、开放围栏代码渐进展示，见 chat.tsx。
    // finalize 为 true（真正收尾）时若最后一个正文段仍有未闭合围栏，前端自动补一个同型的
    // 闭合围栏，把代码块收为完整块——避免正文残留半截、也避免渐进块"永在生成"。
    const pushBuffers = (finalize: boolean) => {
      if (curText) {
        const last = segments[segments.length - 1];
        if (last?.type === "text") last.content += curText;
        else segments.push({ type: "text", content: curText });
        curText = "";
      }
      if (finalize) {
        const last = segments[segments.length - 1];
        if (last?.type === "text") {
          const view = splitFenceDeltas(last.content);
          if (view.openFence) last.content += `\n${fenceCloser(view.openFence.fenceLine)}`;
        }
      }
      if (curThinking) {
        const last = segments[segments.length - 1];
        if (last?.type === "thinking") last.content += curThinking;
        else segments.push({ type: "thinking", content: curThinking });
        curThinking = "";
      }
    };

    // 将缓冲写回消息（40ms 节流），可选更新 streamStatus，避免逐 token 全量渲染。
    // 渲染帧走 pushBuffers(false)：正文（含未闭合围栏原文）随帧累进，渲染层渐进展示。
    const writeSegments = (streamStatus?: string) => {
      segTimer = undefined;
      pushBuffers(false);
      setAllMessages(prev => ({
        ...prev,
        [sessionId]: (prev[sessionId] ?? []).map(message => message.id === assistantMessageId
          ? { ...message, segments: segments.slice(), ...(streamStatus ? { streamStatus } : {}) }
          : message),
      }));
    };

    // 立即冲刷并结束当前正文/思考流（工具边界/错误前调用，保证内容顺序）。
    // 收尾走 pushBuffers(true)：未闭合围栏在此补全闭合围栏（见 pushBuffers）。
    const finalizeStream = () => {
      if (segTimer) {
        window.clearTimeout(segTimer);
        segTimer = undefined;
      }
      segMode = null;
      pushBuffers(true);
    };

    try {
      let completed = false;
      // AI 询问用户（akm_ask_user）时暂存的澄清内容；有值说明本轮已转为等待回答。
      let askPending: { question: string; options?: string[]; multiple?: boolean; messages: AgentMessage[] } | null = null;
      // 客户端工具（client_tool_call）待执行的调用；有值说明本轮流结束后要在浏览器执行该工具并续跑。
      let clientToolPending: { toolCallId: string; name: string; arguments: Record<string, unknown>; messages: AgentMessage[] } | null = null;
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
      // 对话携带图片时给出识图提示：模型（尤其不可视图的模型）应把图片转成文字描述后再作答。
      const readImageHint = files.some(file => file.type.startsWith("image/"))
        ? "\n对话中存在用户上传或粘贴的图片。若你的模型无法直接查看图片（不支持视觉输入），请调用 akm_read_image 读取图片，把其内容转为文字描述后再回答；可把对话中的图片数据以 image_base64 参数传入。"
        : "";
      for await (const event of runAgentStream({
        model: modelKey,
        // 续跑时把后端返回的工作消息作为基底，再追加当前请求的会话消息。
        messages: baseMessages ? [...baseMessages, ...injected, ...toAgentMessages(requestHistory)] : [...injected, ...toAgentMessages(requestHistory)],
        instructions: (sessions.find(session => session.id === sessionId)?.instructions ?? AGENT_INSTRUCTIONS) + searchHint + imageHint + readImageHint,
        // 普通工具由服务端按当前注册状态与 config 开关注入；chat 只传两个
        // 用户可见的可选能力开关，新增服务端工具不再需要同步更新前端 schema。
        // clientTools 是"数据在浏览器里"的工具（会话历史等）：服务端把调用交回前端执行。
        clientTools: CLIENT_TOOLS,
        toolOptions: { search: tools.includes("search"), image: tools.includes("image") },
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
        } else if (event.event === "client_tool_call") {
          // 客户端工具：服务端把调用交回浏览器本地执行（会话历史等数据在 IndexedDB，
          // 服务端拿不到）。本轮同样不走 final 收尾，待循环结束后本地执行工具，
          // 把结果作为 tool 消息追加入工作消息续跑同一轮 Agent。
          finalizeStream();
          const toolName = event.data.name || "客户端工具";
          segments.push({ type: "tool", name: toolName, params: event.data.arguments ?? {}, result: null, status: "running" });
          updateAssistant({ segments: segments.slice(), streamStatus: `正在本地执行 ${toolName}…` });
          clientToolPending = {
            toolCallId: event.data.tool_call_id || "",
            name: toolName,
            arguments: event.data.arguments ?? {},
            messages: event.data.messages ?? [],
          };
        } else if (event.event === "turn_pause") {
          // 自然停顿点：当前轮 LLM 输出（正文/思考）已完整收尾。若用户在回复过程中
          // 输入了"中途引导"（pendingGuideRef 有值），在此中断当前轮，用后端返回的
          // 工作消息快照（event.data.messages）作为基底，追加引导消息后续跑——避免
          // 打断半截残话，也让换方向/补充内容从完整上下文继续。无引导时忽略该事件。
          if (pendingGuideRef.current) {
            finalizeStream();
            const guide = pendingGuideRef.current;
            pendingGuideRef.current = null;
            setPendingGuide("");
            // 构造引导用户消息：追加进会话（状态即成功，后续续跑沿用其历史）。
            const guideMessage: Message = {
              id: `${sessionId}-user-${Date.now()}`,
              role: "user",
              content: guide.content,
              time: nowTime(),
              status: "success",
              files: guide.attachments.length ? guide.attachments.map(file => ({
                name: file.name, type: file.type, size: file.size,
                previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined,
              })) : undefined,
            };
            setAllMessages(prev => ({ ...prev, [sessionId]: [...(prev[sessionId] ?? []), guideMessage] }));
            // 先中断当前流（接下来的读取会抛 AbortError，走 catch 正常收尾，保留已输出内容），
            // 再用快照 + 引导消息续跑新一轮请求。
            controller.abort();
            const sessionTools = sessions.find(session => session.id === sessionId)?.tools ?? [];
            void requestAgent(sessionId, guideMessage.id, `${sessionId}-assistant-${Date.now()}`, [guideMessage], guide.attachments, guide.tools, event.data.messages ?? []);
          }
        } else if (event.event === "error") {
          throw new Error(event.data.error || "Agent 请求失败");
        } else if (event.event === "final") {
          finalizeStream();
          const finalMessage = event.data.final_message;
          const content = extractTextContent(finalMessage?.content);
          if (!content.trim()) throw new Error("Agent 返回了空消息");
          const thinking = extractTextContent(finalMessage?.reasoning_content);

          // 最终正文只覆盖「本轮」产生的最后一个 text 段（即本轮流式累积的正文）。
          // 客户端工具续跑时，工具之前的正文属于上一轮，不能被这次的 final 回写——
          // 否则上一段正文会被续跑的正文整段替换掉。
          const textIndex = segments.map((segment, index) => index >= segmentBaseline && segment.type === "text" ? index : -1)
            .reduce((last, index) => index >= 0 ? index : last, -1);
          if (textIndex >= 0) {
            (segments[textIndex] as { type: "text"; content: string }).content = content;
          } else {
            segments.push({ type: "text", content });
          }
          // 最终思考同样只覆盖本轮的最后一个 thinking 段，否则追加。
          if (thinking.trim()) {
            const thinkingIndex = segments.map((segment, index) => index >= segmentBaseline && segment.type === "thinking" ? index : -1)
              .reduce((last, index) => index >= 0 ? index : last, -1);
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
      } else if (clientToolPending) {
        // 客户端工具：在浏览器本地执行（会话历史等数据只存在于 IndexedDB），
        // 把结果作为 role: "tool" 消息追加进服务端返回的工作上下文后续跑同一轮 Agent。
        const pending = clientToolPending;
        const result = await executeClientTool(pending.name, pending.arguments);
        const hasError = result.includes('"error"');
        for (let index = segments.length - 1; index >= 0; index -= 1) {
          const segment = segments[index];
          if (segment.type === "tool" && segment.name === pending.name) {
            segment.status = hasError ? "error" : "success";
            segment.result = result;
            break;
          }
        }
        setAllMessages(prev => ({
          ...prev,
          [sessionId]: (prev[sessionId] ?? []).map(message => message.id === assistantMessageId
            ? { ...message, segments: segments.slice(), streamStatus: `正在继续（已执行 ${pending.name}）…` }
            : message),
        }));
        // 工具结果按 Chat 协议紧跟 assistant 的 tool_calls 之后，因此走 injected
        // （不落会话历史）注入；requestHistory 传空数组，避免把本轮之前的用户/助手
        // 消息再拼一遍导致工作上下文重复。
        void requestAgent(
          sessionId,
          userMessageId,
          assistantMessageId,
          [],
          files,
          tools,
          pending.messages,
          [{ role: "tool", tool_call_id: pending.toolCallId, content: result }],
          segments.slice(),
        );
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

  const sendMessage = (content: string, attachments: File[] = [], tools: string[] = [], skillRef?: { id: string; name: string }, sessionRefs: { id: string; title: string }[] = []) => {
    // 当前会话仍有发送中/生成中的消息：不立即发送，而是把输入暂存为"中途引导"，
    // 等后端在自然停顿点（turn_pause 事件）下发时自动中断当前轮并插入续跑。
    const sessionId = activeSession || `new-${Date.now()}`;
    const existing = allMessages[sessionId] ?? [];
    if (existing.some(message => message.status === "sending")) {
      pendingGuideRef.current = { content, attachments, tools };
      setPendingGuide(content || (attachments.length ? attachments.map(file => file.name).join(", ") : ""));
      return;
    }

    const id = `${sessionId}-user-${Date.now()}`;
    const message: Message = {
      id, role: "user", content, time: nowTime(), status: "sending",
      files: attachments.length ? attachments.map(file => ({
        name: file.name, type: file.type, size: file.size,
        previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined,
      })) : undefined,
      // skillRef 本期仅用于气泡短引用展示（skill 模板展开后续落地）；
      // sessionRefs 会在发送时把被引用会话历史作为上下文注入（见 requestAgent 的 injected 参数）。
      ...(skillRef ? { skillRef } : {}),
      ...(sessionRefs && sessionRefs.length > 0 ? { sessionRefs } : {}),
    };
    const requestHistory = [...buildRequestHistory(existing), message];
    setAllMessages(prev => ({ ...prev, [sessionId]: [...(prev[sessionId] ?? []), message] }));
    setSessions(prev => {
      if (!prev.some(session => session.id === sessionId)) {
        return [{ id: sessionId, title: content.slice(0, 22), time: nowTime(), autoTitled: true }, ...prev];
      }
      return prev.map(session => session.id === sessionId && session.title === "新对话" ? { ...session, title: content.slice(0, 22), autoTitled: true } : session);
    });
    if (!activeSession) setActiveSession(sessionId);
    // skill 若声明了强制工具（如生图的 image），本轮并入请求工具声明（不回写会话开关）。
    const skill = skillRef ? BUILTIN_SKILLS.find(candidate => candidate.id === skillRef.id) : undefined;
    const requestTools = skill?.tools?.length ? Array.from(new Set([...tools, ...skill.tools])) : tools;
    void requestAgent(sessionId, id, `${sessionId}-assistant-${Date.now()}`, requestHistory, attachments, requestTools, undefined, sessionRefs?.length ? sessionRefsToContextMessages(sessionRefs, allMessages) : []);
  };

  // 中断当前正在生成的回复：abort 流式请求，保留已输出内容并收尾。
  const stopReply = () => { activeRequestRef.current?.abort(); };

  // 手动压缩当前会话上下文（/compact）：把较早的对话交由后端 LLM 归纳成摘要，
  // 用一条"摘要提示消息"替换早期消息，保留最近 COMPACT_KEEP_RECENT 条原始消息，
  // 返回 promise<string | null>：null 表示成功，字符串为滚动展示的错误信息。
  const handleCompact = async (): Promise<string | null> => {
    const sessionId = activeSession;
    if (!sessionId) return "没有选中的会话";
    const list = allMessages[sessionId] ?? [];
    // 压缩输入用"视角历史"（摘要 + 最近若干条原文），避免再把已归纳的早期原文重复喂给模型。
    const messages = toAgentMessages(buildRequestHistory(list));
    if (messages.length === 0) return "会话暂无消息，无需压缩";
    const modelKey = selectedModel?.key;
    if (!modelKey) return "尚未选择模型";
    try {
      const result = await compactMessages({ model: modelKey, messages });
      if (!result.ok) throw new Error(result.detail || result.error || "压缩失败");
      // 摘要内容缺失时（如无模型可摘要）用默认文案占位，让用户知道已完成一轮压缩。
      const summary = result.summary || "（后端未能生成摘要，已直接截断较早消息）";
      const summaryMessage: Message = {
        id: `${sessionId}-compact-${Date.now()}`,
        role: "assistant",
        content: summary,
        time: nowTime(),
        status: "success",
        compactSummary: true,
      };
      // 不替换、不删除旧消息：界面与本地记录保留完整原文。把摘要卡插在"最近保留的
      // 原文"之前（旧内容 → 摘要卡 → 最近原文），让压缩过渡在界面上可见；
      // 发往模型的历史由 buildRequestHistory 统一裁剪（摘要 + 最近 COMPACT_KEEP_RECENT 条）。
      setAllMessages(prev => {
        const current = prev[sessionId] ?? [];
        const recent = current.slice(-COMPACT_KEEP_RECENT);
        const before = current.slice(0, Math.max(0, current.length - recent.length));
        return { ...prev, [sessionId]: [...before, summaryMessage, ...recent] };
      });
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : "压缩上下文失败";
    }
  };

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
    // 重试历史同样走"视角历史"（摘要 + 最近若干条原文，见 buildRequestHistory），
    // 再在视角里定位被重试的用户消息：它之前的内容作为上下文，本身作为本轮待发消息。
    const view = buildRequestHistory(snapshot);
    const userInViewIndex = view.findIndex(message => message.id === userMessage.id);
    const requestHistory = [...view.slice(0, userInViewIndex < 0 ? view.length : userInViewIndex), userMessage];
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
    return <ChatPage session={activeSessionData} sessions={sessions} messages={messages} model={selectedModel} models={models} modelsLoading={modelsLoading} modelsError={modelsError} sidebarOpen={sidebarOpen} onToggleSidebar={() => setSidebarOpen(value => !value)} onModelChange={model => { setSelectedModel(model); if (activeSession) setSessions(prev => prev.map(session => session.id === activeSession ? { ...session, modelKey: model.key } : session)); }} onReloadModels={() => { void loadModels(); }}     onSend={(contentValue, attachments, tools, skillRef, sessionRefs) => sendMessage(contentValue, attachments, tools, skillRef, sessionRefs)} onNewSession={newSession} onRetry={retryMessage} onStop={stopReply} onAnswer={answerQuestion} onCompact={handleCompact} tools={activeSessionData?.tools ?? []} onToolsChange={tools => { if (!activeSession) return; setSessions(prev => prev.map(session => session.id === activeSession ? { ...session, tools } : session)); }} pendingGuide={pendingGuide} onCancelGuide={() => { pendingGuideRef.current = null; setPendingGuide(""); }} />;
  }, [activePage, activeSessionData, allMessages, messages, models, modelsLoading, modelsError, selectedModel, sidebarOpen, assistants, sessions, pendingGuide]);

  return (
    <PreviewContext.Provider value={{ openPreview: setPreviewUrl }}>
      <TooltipProvider delayDuration={400}><ThemeContext.Provider value={{ activeTheme, onThemeChange: changeTheme, themeMode, onThemeModeChange: changeThemeMode }}><div className="flex h-screen w-full overflow-hidden bg-background" style={{ fontFamily: "Inter, system-ui, sans-serif" }}><Sidebar open={sidebarOpen} activePage={activePage} sessions={displaySessions} activeSession={activeSession} editingId={editingId} onPageChange={setActivePage} onNewSession={newSession} onSessionChange={id => { setActiveSession(id); setActivePage("chat"); const target = sessions.find(session => session.id === id); if (target?.modelKey) { const savedModel = models.find(model => model.key === target.modelKey); if (savedModel) setSelectedModel(savedModel); } }} onStartEdit={startEdit} onSaveEdit={saveEdit} onCloseEdit={() => setEditingId(null)} onDeleteSession={id => setDeleteSessionTarget(sessions.find(session => session.id === id) ?? null)} onReorderSessions={reorderSessions} onClose={() => setSidebarOpen(false)} /><main className="flex min-w-0 flex-1 flex-col overflow-hidden">{content}</main></div></ThemeContext.Provider></TooltipProvider>
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
