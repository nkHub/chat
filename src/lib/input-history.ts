/**
 * 输入框历史游标（纯逻辑，不含 React / DOM）。
 *
 * 用途：在输入框按 ↑ / ↓ 翻出最近发过的消息，改写笔记、重发旧问题这类高频动作
 * 不用来回复制粘贴。规则刻意保守 —— 输入历史是"顺手"功能，猜错一次就会覆盖
 * 用户正在打的字，代价比没有它还高。
 *
 * 设计要点：
 *   1. **草稿不被丢弃**：第一次按 ↑ 时当前输入存为草稿，翻到底再按 ↓ 会把它放回来。
 *      否则用户翻两下历史，自己刚写的内容就没了。
 *   2. **只从当前会话派生**，不额外持久化：历史就是该会话里 role=user 的消息，
 *      刷新、切会话自动一致，不需要维护一份独立的 localStorage 列表。
 *   3. **游标越界后停在原地**，不回绕：回绕会让「按到底」变成「跳回最新」，与直觉相反。
 */

/** 历史游标状态：`index === null` 表示未进入历史（显示的是草稿）。 */
export type InputHistoryState = {
  /** 当前在历史里的下标；`null` 表示不在历史中（展示草稿） */
  index: number | null;
  /** 进入历史前用户正在输入的内容，退出历史时还原 */
  draft: string;
};

/** 初始状态：不在历史里。 */
export const EMPTY_INPUT_HISTORY: InputHistoryState = { index: null, draft: "" };

/**
 * 是否需要把 ↑ / ↓ 让位给其他功能。
 *
 * 只在「没开弹层、光标在第一行」时翻历史：多行输入里 ↑↓ 是移动光标，
 * 抢占它会让长文本编辑变得无法用键盘微调。输入法 composing 期间也让位，
 * 否则候选词选择与翻历史会打架。
 */
export function shouldHandleHistoryKey(
  options: { suggestOpen: boolean; composing: boolean; caretAtFirstLine: boolean },
): boolean {
  if (options.suggestOpen || options.composing) return false;
  return options.caretAtFirstLine;
}

/**
 * 按 ↑：往上翻（越旧）。
 *
 * @param state 当前游标状态
 * @param input 输入框当前内容（进入历史时存为草稿）
 * @param history 历史条目，**下标 0 为最新一条**
 * @returns 新的游标状态与应当填入输入框的文本；历史为空时原样返回
 */
export function historyUp(
  state: InputHistoryState,
  input: string,
  history: string[],
): { state: InputHistoryState; text: string } {
  if (history.length === 0) return { state, text: input };
  // 首次进入历史：把当前输入记为草稿。
  if (state.index === null) {
    const next = { index: 0, draft: input };
    return { state: next, text: history[0] };
  }
  // 已到最旧一条：停在原地（不回绕）。
  if (state.index >= history.length - 1) {
    return { state, text: history[state.index] };
  }
  const index = state.index + 1;
  return { state: { ...state, index }, text: history[index] };
}

/**
 * 按 ↓：往下翻（越新）。翻过最新一条后退出历史，还原草稿。
 *
 * @param state 当前游标状态
 * @param input 输入框当前内容（不在历史中时使用）
 * @param history 历史条目，**下标 0 为最新一条**
 */
export function historyDown(
  state: InputHistoryState,
  input: string,
  history: string[],
): { state: InputHistoryState; text: string } {
  // 不在历史中：↓ 不做事（下方的行移交给光标）。
  if (state.index === null) return { state, text: input };
  // 已是最新一条：再往下就退出历史，放回草稿。
  if (state.index <= 0) return { state: EMPTY_INPUT_HISTORY, text: state.draft };
  const index = state.index - 1;
  // 历史可能被裁剪（新一轮发送后变长/变短），越界时回到最新一条。
  const safeIndex = Math.min(index, Math.max(0, history.length - 1));
  return { state: { ...state, index: safeIndex }, text: history[safeIndex] ?? state.draft };
}

/**
 * 退出历史：发送、切换会话、或清空输入时调用。
 *
 * 只清游标，不碰输入框内容 —— 调用方通常刚把输入框清空或换成新值，
 * 这里再去改文本会把两者顺序搞乱。
 */
export function resetInputHistory(): InputHistoryState {
  return EMPTY_INPUT_HISTORY;
}

/**
 * 从消息列表派生历史条目。
 *
 * 只取 role=user 且正文非空的消息，**最新在前**（与 `historyUp` 的下标约定一致）。
 * 不按内容去重：连问同一个问题两次是常见操作，去重会让"再按一次 ↑ 还是那句"变成怪现象。
 */
export function deriveInputHistory(
  messages: { role: string; content: string }[],
  limit = 50,
): string[] {
  const items: string[] = [];
  for (let index = messages.length - 1; index >= 0 && items.length < limit; index -= 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    const text = message.content.trim();
    if (!text) continue;
    items.push(text);
  }
  return items;
}
