import { useEffect, useMemo, useRef, useState } from "react";
import { Bot } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import { fetchModels, resolveDeclaredTools, runAgent, runAgentStream, type AgentMessage } from "@/lib/agent-api";
import { loadChatState, saveChatState } from "@/lib/chat-store";
import { AssistantPage } from "./assistant";
import { AutomationPage } from "./automation";
import { ChatPage } from "./chat";
import { AGENT_INSTRUCTIONS, AUTO_TITLE_ENABLED, DEFAULT_ASSISTANTS, THEMES, THEME_KEY, THEME_MODE_KEY } from "./constants";
import { clearModalResidue, extractTextContent, messageText, normalizeStoredState, nowTime, toAgentMessages, toChatModel } from "./helpers";
import { Lightbox, PreviewContext } from "./preview";
import { Sidebar } from "./sidebar";
import { applyTheme, ThemeContext } from "./theme";
import type { AssistantDef, ChatModel, Message, MessageSegment, Session, StoredChatState, ThemeMode, ThemePreset } from "./types";
import { WorkflowPage } from "./workflow";

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
