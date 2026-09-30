// 会话历史工具的分页与搜索纯逻辑：不碰 IndexedDB、不依赖浏览器 API，
// 便于单独验证边界（单次返回必须有界，即使模型要求读取上千条）。
//
// 设计要点：
// - 分页从**最近往前翻**：offset 0 是最后一条消息所在的那一页。问「上次聊了什么」
//   一次就能命中，不必从第 1 条顺着翻 1700 页。
// - limit 由 normalizePaging 夹紧到 [1, MAX_PAGE_SIZE]，模型给多大都不会一次拉全量。
// - 搜索只回命中片段 + 计数，片段有长度上限，超长消息不会整条进上下文。

// 单次返回的消息条数上限：与工具 description 里写给模型的约束保持一致。
export const MAX_PAGE_SIZE = 50;
export const DEFAULT_PAGE_SIZE = 20;
// 一次搜索最多回传的命中条数（其余只计数），避免返回体随命中数膨胀。
export const MAX_SEARCH_HITS = 20;
// 搜索片段在命中位置前后各保留的字符数。
export const SNIPPET_PAD = 80;

// 会话历史里被检索/读取的最小字段集：Message 满足该结构，测试可直接构造普通对象。
// segments 用结构化最小描述（只有正文/思考段带 content，工具段没有），
// 因此 content 可选、type 放宽为 string —— 真实 MessageSegment 联合类型可直接赋值。
export type HistorySegment = { type: string; content?: string };

export type HistoryMessage = {
  role: string;
  content: string;
  time?: string;
  // 正文为空时作为回退（渲染层把流式内容拆成段落）。
  segments?: HistorySegment[];
};

export type PageWindow = {
  // 本页在会话中的序号区间（1 起）；空会话为 null。
  range: { from: number; to: number } | null;
  // 从最近往前数是否还有更早的消息（即还能继续翻页）。
  hasMore: boolean;
  total: number;
  offset: number;
  limit: number;
};

// 解析并夹紧分页参数：模型给的 offset/limit 不可信，越界一律归一到合法区间，
// 保证单次返回体有界（这是「别全量读取」在实现层的兜底，不依赖模型自觉）。
export function normalizePaging(args: Record<string, unknown>): { offset: number; limit: number } {
  const rawLimit = Number(args?.limit ?? DEFAULT_PAGE_SIZE);
  const rawOffset = Number(args?.offset ?? 0);
  return {
    limit: Number.isFinite(rawLimit) ? Math.max(1, Math.min(Math.trunc(rawLimit), MAX_PAGE_SIZE)) : DEFAULT_PAGE_SIZE,
    offset: Number.isFinite(rawOffset) ? Math.max(0, Math.trunc(rawOffset)) : 0,
  };
}

// 取某条消息的文本：正文为空（如纯工具调用轮）时回退到最后一个有内容的段，
// 两者都空则返回空串（由调用方决定是否跳过）。
export function messageText(message: HistoryMessage): string {
  const direct = (message.content ?? "").trim();
  if (direct) return message.content;
  const segments = message.segments ?? [];
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (segment.content?.trim()) return segment.content;
  }
  return "";
}

// 计算「从最近往前翻」的第 offset 页窗口：offset 0 取最后 limit 条。
// 返回 [start, end) 半开区间，并夹到 [0, total] 内。offset 超出总条数时收敛到
// 最早一页（返回该页内容、hasMore=false），而不是给出一个空页——「翻过头」与
// 「会话为空」必须可区分，否则模型会以为这个会话没有消息。空会话 range=null。
export function pageWindow(total: number, offset: number, limit: number): PageWindow {
  if (total <= 0) {
    return { range: null, hasMore: false, total, offset, limit };
  }
  // 从尾部往前数的起点：offset 超过「最早一页的起点」说明翻过头了，夹到 total-limit，
  // 保证最后一页仍然返回完整的一页（而不是只剩 1 条）。offset 本身原样回传，
  // 让调用方知道它请求的是哪一页。
  const maxOffset = Math.max(0, total - limit);
  const fromEnd = Math.max(0, Math.min(maxOffset, offset));
  const end = total - fromEnd;
  const start = Math.max(0, end - limit);
  return {
    range: { from: start + 1, to: end },
    hasMore: start > 0,
    total,
    offset,
    limit,
  };
}

// 截取命中位置前后的片段并压掉换行，避免超长消息整条进上下文。
export function snippet(text: string, index: number, queryLength: number): string {
  const start = Math.max(0, index - SNIPPET_PAD);
  const end = Math.min(text.length, index + queryLength + SNIPPET_PAD);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end).replace(/\s+/g, " ").trim()}${suffix}`;
}

export type SearchHit = {
  name: string;
  title: string;
  role: string;
  time?: string;
  // 从最近往前数的位置：offset 0 即最新一条，可直接配合 load 模式翻页。
  offset_from_latest: number;
  snippet: string;
};

export type SessionLike = { id: string; title?: string };

// 在所有会话里搜索关键词（大小写不敏感子串匹配）：
// - total_hits 统计全部命中，hits 只回传前 MAX_SEARCH_HITS 条，因此返回体有界；
// - truncated 显式告诉模型「还有更多」，避免它以为搜完了；
// - 优先保留**最近**的命中：会话是从旧到新追加的，只会正序扫描的话，1700 条会话
//   里命中很多时会被最早的 20 条占满、最近的命中全被截掉，而用户问的通常是近期的事。
//   因此会话内从最新往前扫描、取满即止，hits 顺序即「新→旧」（首条 offset 0）。
export function searchHistory(
  query: string,
  sessions: SessionLike[],
  messagesBySession: Record<string, HistoryMessage[]>,
): { total_hits: number; returned: number; truncated: boolean; hits: SearchHit[] } {
  const needle = query.toLowerCase();
  const hits: SearchHit[] = [];
  let totalHits = 0;
  for (const session of sessions) {
    const messages = messagesBySession[session.id] ?? [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      const text = messageText(message);
      if (!text) continue;
      const at = text.toLowerCase().indexOf(needle);
      if (at < 0) continue;
      totalHits += 1;
      if (hits.length < MAX_SEARCH_HITS) {
        hits.push({
          name: session.id,
          title: session.title || "未命名对话",
          role: message.role,
          time: message.time,
          offset_from_latest: messages.length - 1 - index,
          snippet: snippet(text, at, query.length),
        });
      }
    }
  }
  // 倒序扫描与 push 的顺序叠加后，hits 天然就是「新→旧」（首条 offset 0），
  // 模型先看到的就是最近的命中，因此这里不做任何重排。

  return { total_hits: totalHits, returned: hits.length, truncated: totalHits > hits.length, hits };
}
