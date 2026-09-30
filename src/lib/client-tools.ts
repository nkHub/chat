// 客户端工具：由浏览器本地执行、服务端不注册 handler 的工具。
//
// 服务端 /v1/agent 支持客户端工具执行协议：请求里用顶层 `client_tools` 声明工具
// （或把声明放进 `tools` 并加 `"x-akm-client-tool": true`），服务端把调用下发给模型，
// 模型调用时下发 `client_tool_call` 事件把调用交回浏览器，前端本地执行后把结果作为
// `role: "tool"` 消息追加入 messages 续跑同一轮 Agent。
//
// 这里放的是「数据在浏览器里、服务端拿不到」的工具：会话历史本来就完整存在
// IndexedDB（见 chat-store.ts），没必要再让服务端把同一批对话落一份 JSON 到磁盘。
// 服务端原先那套读磁盘快照的会话历史工具（akm_list_sessions / akm_load_session）
// 已整体删除，因此这里的 `ui_` 工具是唯一的会话历史入口（前缀保留，用于和
// 服务端其它 `akm_` 工具区分）。
//
// 【为什么不会全量读取】单个会话可能有上千条消息（用户侧不做硬上限，历史只增不减），
// 因此每个工具都按「有界返回」设计：分页与搜索的边界在 session-history.ts 里实现并
// 由单测覆盖，模型给多大的 limit 都会被夹到 MAX_PAGE_SIZE；搜索只回命中片段与计数。
// 真正的瓶颈在持久化层（整条 IndexedDB 记录重写），与这里的分页无关，见 chat-store.ts。

import { loadChatState } from "./chat-store";
import type { AgentTool } from "./agent-api";
import type { Message, Session, StoredChatState } from "../app/types";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  messageText,
  normalizePaging,
  pageWindow,
  searchHistory,
} from "./session-history";

// 列出浏览器本地会话：只回元数据，不含任何消息正文，是「我有哪些会话」的最省调用。
const UI_LIST_SESSIONS_TOOL: AgentTool = {
  type: "function",
  function: {
    name: "ui_list_sessions",
    description:
      "列出用户在聊天界面里的历史会话（数据来自浏览器本地存储，与当前对话同一来源）：" +
      "返回会话名 name、标题 title、创建时间 created_at、更新时间 updated_at、消息数 message_count 与模型 model，" +
      "不含消息正文，按更新时间倒序。会话名用于 ui_load_session 读取正文",
    parameters: { type: "object", properties: {} },
  },
};

// 读取浏览器本地会话：三合一入口。关键设计是「按需取一页」，并在描述里明确要求
// 模型先搜索、只读需要的页，不要为了找一条信息把整个会话拉出来。
const UI_LOAD_SESSION_TOOL: AgentTool = {
  type: "function",
  function: {
    name: "ui_load_session",
    description:
      "按需读取浏览器本地会话历史，有界返回，请勿全量读取。三种用法（按参数自动选择）：" +
      "① 传 query：在所有会话里搜索关键词，返回命中片段与所在位置（推荐先用它定位，再看具体会话）；" +
      "② 传 name：读取该会话的一页消息，offset 0 表示最新一页（从最近往前翻）；" +
      "③ 两者都不传：等同于列出全部会话的元数据。" +
      `单次最多返回 ${MAX_PAGE_SIZE} 条消息（默认 ${DEFAULT_PAGE_SIZE} 条），` +
      "返回里的 total / has_more 可用于翻页。请只读取回答问题所需的最少内容：优先 search 定位，" +
      "需要上下文时再读一两页，不要反复翻页试图读完整个会话",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "会话名（来自 ui_list_sessions 的 name 字段）或会话标题；按会话读取时使用" },
        query: { type: "string", description: "搜索关键词；传入时在所有会话中搜索，忽略 name" },
        offset: { type: "integer", description: "从最近往前数的偏移量，0 表示最新一页（仅按会话读取时有效）" },
        limit: { type: "integer", description: `本页条数，1 到 ${MAX_PAGE_SIZE}，默认 ${DEFAULT_PAGE_SIZE}` },
      },
    },
  },
};

// 客户端声明的全部工具。请求时随 client_tools 字段发送，
// 服务端据此把这些工具下发给模型并把调用交回浏览器。
// 注意：服务端用「同时声明了 ui_list_sessions + ui_load_session」判断客户端自己持有
// 会话历史（见 akm/agent_runtime/loop.py 的 _SESSION_HISTORY_CLIENT_TOOLS），
// 因此这两个名字不要随意改动或省略。
export const CLIENT_TOOLS: AgentTool[] = [UI_LIST_SESSIONS_TOOL, UI_LOAD_SESSION_TOOL];

// 会话元信息：与 Agent 工具返回值保持一致的字段形状。
type SessionMeta = {
  name: string;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  model: string;
};

// 读取本地状态并规整；无数据时返回空结构（不抛异常，由工具返回可读的错误文本）。
async function readState(): Promise<Required<Pick<StoredChatState, "sessions" | "allMessages">> & { selectedModelKey: string }> {
  const raw = (await loadChatState()) as StoredChatState | null;
  return {
    sessions: Array.isArray(raw?.sessions) ? raw!.sessions : [],
    allMessages: raw?.allMessages && typeof raw.allMessages === "object" ? raw!.allMessages : {},
    selectedModelKey: String(raw?.selectedModelKey ?? ""),
  };
}

// 把会话列表整理成带统计的元信息：更新时间取最后一条消息的时间（没有消息时回退
// 会话自身的 time），这样与界面上「最近活动」的排序一致。
function buildSessionMetas(sessions: Session[], allMessages: Record<string, Message[]>): SessionMeta[] {
  return sessions
    .map(session => {
      const messages = allMessages[session.id] ?? [];
      const last = messages[messages.length - 1];
      return {
        name: session.id,
        title: session.title || "未命名对话",
        created_at: session.time || "",
        updated_at: (last?.time || session.time || ""),
        message_count: messages.length,
        model: session.modelKey || "",
      };
    })
    .sort((left, right) => (left.updated_at < right.updated_at ? 1 : left.updated_at > right.updated_at ? -1 : 0));
}

// 列出全部会话元数据（最省的一档，不含正文）。
function listSessions(sessions: Session[], allMessages: Record<string, Message[]>): string {
  const metas = buildSessionMetas(sessions, allMessages);
  return JSON.stringify({ sessions: metas, total: metas.length }, null, 2);
}

// 会话是否匹配用户给的 name：先按会话名（id）精确匹配，再退回标题匹配。
function findSession(sessions: Session[], wanted: string): Session | undefined {
  return sessions.find(candidate => candidate.id === wanted)
    ?? sessions.find(candidate => (candidate.title || "") === wanted);
}

// 读取单个会话的一页消息：窗口计算见 session-history.ts 的 pageWindow，
// 返回 has_more / total 让模型知道还能不能继续翻，而不必先拉全量再数。
function loadSessionPage(
  session: Session,
  messages: Message[],
  offset: number,
  limit: number,
  selectedModelKey: string,
): string {
  const window = pageWindow(messages.length, offset, limit);
  const picked = (window.range ? messages.slice(window.range.from - 1, window.range.to) : [])
    .map(message => ({
      role: message.role,
      content: messageText(message),
      time: message.time,
    }));
  return JSON.stringify({
    name: session.id,
    title: session.title || "未命名对话",
    model: session.modelKey || selectedModelKey,
    created_at: session.time || "",
    updated_at: (messages[window.total - 1]?.time || session.time || ""),
    total: window.total,
    offset: window.offset,
    limit: window.limit,
    // 本页在会话中的序号区间（1 起），便于模型知道自己在会话的哪个位置。
    range: window.range,
    has_more: window.hasMore,
    messages: picked,
  }, null, 2);
}

// 在所有会话里搜索关键词：只回片段与定位信息，命中数单独统计后只回传前若干条。
function searchSessions(query: string, sessions: Session[], allMessages: Record<string, Message[]>): string {
  const result = searchHistory(query, sessions, allMessages);
  return JSON.stringify({
    query,
    ...result,
    hint: result.hits.length
      ? "可用 name + offset（offset_from_latest 附近）读取对应页的完整上下文"
      : "没有命中，可换关键词，或用 ui_list_sessions 查看有哪些会话",
  }, null, 2);
}

// 工具执行入口：按工具名分发，统一返回 JSON 字符串（与后端工具的返回约定一致，
// 失败时返回 {"error": "..."} 让模型能看懂并自行修正）。
export async function executeClientTool(name: string, args: Record<string, unknown>): Promise<string> {
  try {
    if (name === "ui_list_sessions") {
      const { sessions, allMessages } = await readState();
      return listSessions(sessions, allMessages);
    }
    if (name === "ui_load_session") {
      const { sessions, allMessages, selectedModelKey } = await readState();
      const query = String(args?.query ?? "").trim();
      // 传了 query 就走搜索：先定位、再看具体会话，避免模型为了找一条信息读整个会话。
      if (query) return searchSessions(query, sessions, allMessages);

      const wanted = String(args?.name ?? "").trim();
      // 既没 query 也没 name：降级为列出会话元数据，模型不必为了「看看有哪些会话」多学一个工具。
      if (!wanted) return listSessions(sessions, allMessages);

      const session = findSession(sessions, wanted);
      if (!session) {
        return JSON.stringify({ error: `未找到会话: ${wanted}`, hint: "先用 ui_list_sessions 查看可用会话名，或用 query 搜索关键词" });
      }
      const { offset, limit } = normalizePaging(args);
      return loadSessionPage(session, allMessages[session.id] ?? [], offset, limit, selectedModelKey);
    }
    return JSON.stringify({ error: `未实现的客户端工具: ${name}` });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return JSON.stringify({ error: `客户端工具执行失败: ${detail}` });
  }
}
