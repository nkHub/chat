/**
 * 划选引用（quote）的纯逻辑：把用户选中的一段回答整理成发给模型的引用块。
 *
 * 为什么不做成「只发一句元数据、由后端注入上下文」：
 * 本项目没有 quote 注入的后端接口，硬造一套字段等于前后端同时改协议。
 * 直接把它拼成 Markdown 引用块（`> ...`）反而更可靠 ——
 * 模型天然认这种格式，历史记录里也看得见「这句话是引用来的」，
 * 服务端零改动，旧版本回退也不影响。
 */

/**
 * 引用块最多保留的字符数。
 *
 * 用户经常一选就是大半屏（尤其贴日志）。原文太长会把本轮提问挤到后面、
 * 也白烧 token，所以截断并显式标注省略，让模型知道这里被裁过。
 */
export const QUOTE_MAX_CHARS = 1200;

/**
 * 把选中文本整理成引用块。
 *
 * 规则：
 *   - 折叠成单段的连续空白（Markdown 引用块里多行会被各自加 `>`，
 *     原样保留换行会显得嘈杂），但保留空行作为段落分隔；
 *   - 每一行都加 `>` 前缀，保证多行引用仍然是一个 blockquote；
 *   - 超长截断并补 `…`，不做「掐在半个词中间」的智能切分 ——
 *     引用是给人看的上下文，粗糙截断比过度加工更可预期。
 *
 * @returns 可直接拼在用户消息前的引用块；空内容返回空串（调用方据此不添加）
 */
export function formatQuote(text: string, maxChars: number = QUOTE_MAX_CHARS): string {
  const normalized = text.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").trim();
  if (!normalized) return "";
  // 只保留「最多一个空行」：连续多行空行在引用块里没有意义。
  const compact = normalized.replace(/\n{3,}/g, "\n\n");
  const clipped = compact.length > maxChars ? `${compact.slice(0, maxChars)}…` : compact;
  return clipped
    .split("\n")
    .map(line => (line ? `> ${line}` : ">"))
    .join("\n");
}

/**
 * 拼接最终的发送内容：引用块在前、用户输入在后。
 *
 * 引用块与正文之间空一行，否则 Markdown 会把用户输入的第一行当成引用的续行
 * （惰性续行），整段提问都变灰色引用样式。
 */
export function joinQuoteAndContent(quote: string, content: string): string {
  if (!quote) return content;
  if (!content.trim()) return quote;
  return `${quote}\n\n${content}`;
}

/**
 * 判断选区是否值得弹「引用」按钮。
 *
 * 太短的选区（几个字）没有引用价值，反而会在每次双击选词时闪一下按钮。
 * 阈值取 2：单个字误触概率高，两个以上通常是有意选择。
 */
export function isQuotableSelection(text: string): boolean {
  return text.trim().length >= 2;
}
