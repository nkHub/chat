/**
 * Markdown 按块切分（纯逻辑，不含 React）。
 *
 * 用途：`app/markdown.tsx` 的 `MemoMarkdown` 会把一段正文按块 memo 渲染，
 * 让流式输出只重解析**末尾块**。切分规则在这里独立成模块，便于用
 * `npm run check:markdown`（esbuild + node）直接断言，不依赖 DOM。
 *
 * 为什么按空行切：流式输出时只有末尾在长，前面的段落是稳定的。切开之后
 * 前面各块内容字符串不变 → 命中 React.memo，只重解析最后一块；不切的话
 * 整段正文每一帧都是新字符串，remark/rehype 每帧全量重跑（长回答 + 表格
 * 时主线程抖动明显）。
 *
 * 为什么按空行而不是按行：Markdown 的块级结构（段落 / 列表 / 表格 / 代码围栏）
 * 都以空行为边界，块内再切会把列表项、表格行切碎，语义就变了。
 */

/** 列表项标记：无序（- * +）或有序（1. / 1)）。 */
const LIST_ITEM = /^([-*+]|\d+[.)])\s/;

/** 从后面的块里取首行缩进宽度（用于判断缩进续行）。 */
function firstLineIndent(text: string): number {
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    return line.length - line.trimStart().length;
  }
  return 0;
}

/** 取第一行非空文本（保留左侧缩进，仅去右侧空白）。 */
function firstNonEmptyLine(text: string): string {
  for (const line of text.split("\n")) {
    if (line.trim()) return line.trimEnd();
  }
  return "";
}

/** 取最后一行非空文本。 */
function lastNonEmptyLine(text: string): string {
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].trim()) return lines[index];
  }
  return "";
}

/**
 * 判断文本是否停在未闭合的代码围栏里。
 *
 * 只数围栏行（去缩进后以连续三个反引号或三个波浪号开头），不关心语言标注。
 */
export function hasOpenFence(text: string): boolean {
  let open = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) open = !open;
  }
  return open;
}

/**
 * 判断「空行边界」两侧是否可以作为独立块切开。
 *
 * CommonMark 里有些结构会**跨空行合并**，切开就会改变渲染结果，必须合并：
 * - 松散列表：`- a` / 空行 / `- b` 属于同一个列表，切开会渲染成两个列表；
 * - 表格：表格行之间允许空行，切开必然裂成两张表；
 * - 引用块：`> a` / 空行 / `> b` 属于同一个 blockquote；
 * - 缩进续行：下一段缩进比上一段更浅或持平且有缩进时，属于上一块的延续（子列表、软换行）；
 * - 未闭合的代码围栏：围栏内的空行不是块边界；
 * - HTML 块：`<details>` / `<div>` 等跨空行出现时保守合并。
 *
 * 判据刻意取保守侧：宁可少切（少命中一次 memo），也不能切出错误排版。
 */
export function canSplitBetween(prev: string, next: string): boolean {
  // 围栏未闭合：空行在围栏内部，不是边界
  if (hasOpenFence(prev)) return false;
  const nextFirst = firstNonEmptyLine(next);
  if (!nextFirst) return true;
  const prevLast = lastNonEmptyLine(prev);
  if (!prevLast) return true;
  // 松散列表：两侧都是列表项
  if (LIST_ITEM.test(prevLast) && LIST_ITEM.test(nextFirst)) return false;
  // 缩进续行：下一块以缩进开头时，它是上一块列表项 / 段落的延续（子列表、软换行）。
  // 这里只看向下一块 —— 上一块是否也缩进并不影响结论：缩进块总是依附于前面的块。
  if (firstLineIndent(next) > 0) return false;
  // 表格行：两侧都是表格行
  if (prevLast.startsWith("|") && nextFirst.startsWith("|")) return false;
  // 引用块：两侧都是引用行
  if (prevLast.startsWith(">") && nextFirst.startsWith(">")) return false;
  // HTML 块之间可能跨空行
  if (/^</.test(prevLast) && /^</.test(nextFirst)) return false;
  return true;
}

/**
 * 把一段 Markdown 切成「只有末尾会变」的若干块。
 *
 * 保证：`joinMarkdownBlocks(splitMarkdownBlocks(text)) === text`，
 * 即切分可无损还原（块之间原本是空行，用一个 `\n\n` 拼回）。
 */
export function splitMarkdownBlocks(text: string): string[] {
  if (!text) return [];
  const blocks: string[] = [];
  // 以「空行」为候选边界切段；空行指两侧都有换行的空白行（允许行尾空白）。
  const parts = text.split(/\n[ \t]*\n/);
  for (let index = 0; index < parts.length; index += 1) {
    let merged = parts[index];
    // 当前边界不允许切分时，把下一段并进来继续判断，直到遇到可切分的边界。
    while (index < parts.length - 1 && !canSplitBetween(merged, parts[index + 1])) {
      index += 1;
      merged += `\n\n${parts[index]}`;
    }
    blocks.push(merged);
  }
  return blocks;
}

/** 把切开的块拼回原文（用于断言切分无损）。 */
export function joinMarkdownBlocks(blocks: readonly string[]): string {
  return blocks.join("\n\n");
}
