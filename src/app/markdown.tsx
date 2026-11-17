import { Children, isValidElement, memo, useContext, useMemo, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import { Brain, Check, Copy } from "lucide-react";
import { nodeToText, splitSegmentForRender } from "./helpers";
import { PreviewContext } from "./preview";
import { highlightCode } from "@/lib/code-highlight";
import { splitMarkdownBlocks } from "@/lib/markdown-blocks";
import { useSmoothText } from "./use-smooth-text";

const MARKDOWN_COMPONENTS: Components = {
  h1: ({ node: _node, ...props }) => <h1 className="mb-1 mt-3 text-lg font-semibold text-foreground" {...props} />,
  h2: ({ node: _node, ...props }) => <h2 className="mb-1 mt-3 text-base font-semibold text-foreground" {...props} />,
  h3: ({ node: _node, ...props }) => <h3 className="mb-1 mt-3 text-sm font-semibold text-foreground" {...props} />,
  h4: ({ node: _node, ...props }) => <h4 className="mb-1 mt-2 text-sm font-semibold text-foreground" {...props} />,
  h5: ({ node: _node, ...props }) => <h5 className="mb-1 mt-2 text-sm font-semibold text-foreground" {...props} />,
  h6: ({ node: _node, ...props }) => <h6 className="mb-1 mt-2 text-sm font-semibold text-foreground" {...props} />,
  p: ({ node: _node, ...props }) => <p className="mb-1 text-sm leading-relaxed text-foreground/80" {...props} />,
  a: ({ node: _node, ...props }) => <a target="_blank" rel="noreferrer noopener" className="text-primary underline underline-offset-2 hover:opacity-80" {...props} />,
  strong: ({ node: _node, ...props }) => <strong className="font-semibold text-foreground" {...props} />,
  em: ({ node: _node, ...props }) => <em className="italic text-foreground/80" {...props} />,
  del: ({ node: _node, ...props }) => <del className="text-muted-foreground" {...props} />,
  ul: ({ node: _node, ...props }) => <ul className="my-2 list-disc space-y-1.5 pl-5" {...props} />,
  ol: ({ node: _node, ...props }) => <ol className="my-2 list-decimal space-y-1.5 pl-5" {...props} />,
  li: ({ node: _node, ...props }) => <li className="text-sm leading-relaxed text-foreground/80" {...props} />,
  blockquote: ({ node: _node, ...props }) => <blockquote className="my-2 border-l-2 border-primary/40 pl-3 italic text-muted-foreground" {...props} />,
  hr: ({ node: _node, ...props }) => <hr className="my-3 border-border" {...props} />,
  img: ({ node: _node, alt, ...props }) => {
    const { openPreview } = useContext(PreviewContext);
    return (
      <img
        alt={alt ?? ""}
        className="my-2 max-w-full cursor-zoom-in rounded-lg"
        {...props}
        onClick={() => { if (props.src) openPreview(props.src); }}
      />
    );
  },
  code: ({ node: _node, ...props }) => <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-primary" {...props} />,
  pre: ({ children }) => {
    const first = Children.toArray(children)[0];
    const className = isValidElement(first) ? (first.props as { className?: string })?.className : undefined;
    const language = /language-(\w+)/.exec(className ?? "")?.[1] ?? "";
    return <CodeBlock code={nodeToText(children)} language={language} />;
  },
  table: ({ node: _node, children, ...props }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-sm text-foreground/80" {...props}>{children}</table>
    </div>
  ),
  thead: ({ node: _node, ...props }) => <thead className="bg-muted/50" {...props} />,
  th: ({ node: _node, ...props }) => <th className="border border-border px-3 py-2 text-left text-xs font-semibold text-foreground" {...props} />,
  td: ({ node: _node, ...props }) => <td className="border border-border px-3 py-2 align-top text-sm text-foreground/80" {...props} />,
  input: ({ node: _node, ...props }) => <input className="mr-1.5 accent-primary" disabled {...props} />,
};

function CodeBlock({ code, language }: { code: string; language: string }) {
  const [copied, setCopied] = useState(false);
  // 高亮结果按 (code, language) 记忆：完整代码块通常只算一次；
  // 未标注 / 未知语言返回 null，回落成纯文本（宁可没颜色，也不能让代码块消失）。
  const highlighted = useMemo(() => highlightCode(code, language), [code, language]);
  return (
    <div className="my-3 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950 text-xs font-mono">
      <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900 px-3 py-1.5">
        <span className="text-xs uppercase tracking-wider text-zinc-500">{language || "code"}</span>
        <button
          type="button"
          className="flex items-center gap-1 text-xs text-zinc-500 transition-colors hover:text-zinc-200"
          onClick={() => {
            navigator.clipboard.writeText(code).catch(() => undefined);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1600);
          }}
        >
          {copied ? <Check size={11} /> : <Copy size={11} />}
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 leading-relaxed text-zinc-300">
        {highlighted
          ? <code className="code-hl hljs" dangerouslySetInnerHTML={{ __html: highlighted }} />
          : <code>{code}</code>}
      </pre>
    </div>
  );
}

// 流式生成中的"渐进式代码块"：正文段末尾的开放（未闭合）围栏代码块。
// 围栏一吐出就渲染代码容器，尾部放闪烁的 ▌ 光标暗示仍在生成；代码随帧增长不跳动。
// 配色与下方 CodeBlock 完全一致（border-zinc-800 / bg-zinc-950 / 文字 text-zinc-300），
// 闭合后渐进块消失、完整代码并入正文走 CodeBlock，两者视觉无缝衔接，无"先灰后亮"跳变。
// 容器加 mx-4 与正文气泡的 px-4 对齐：否则渐进态是消息列全宽、闭合后进气泡内缩 16px，
// 代码块会"先宽后突然收窄"。代码块本身无气泡框，用水平外距补齐同等内缩。
function StreamingCodeBlock({ fenceLine, code }: { fenceLine: string; code: string }) {
  const language = /language-(\w+)/.exec(fenceLine)?.[1] ?? "";
  // 生成过程中也着色（边生成边高亮），光标跟在最后一行末尾继续闪。
  const highlighted = useMemo(() => highlightCode(code, language), [code, language]);
  return (
    <div className="mx-4 my-3 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950 text-xs font-mono">
      <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900 px-3 py-1.5">
        <span className="text-xs uppercase tracking-wider text-zinc-500">{language || "code"}</span>
        <span className="flex items-center gap-1 text-[11px] text-zinc-500">生成中…</span>
      </div>
      <pre className="overflow-x-auto p-3 leading-relaxed text-zinc-300">
        {highlighted
          ? <><code className="code-hl hljs" dangerouslySetInnerHTML={{ __html: highlighted }} /><span className="streaming-caret text-zinc-200">▌</span></>
          : <code>{code}<span className="streaming-caret text-zinc-200">▌</span></code>}
      </pre>
    </div>
  );
}

function renderMarkdown(text: string, components: Components = MARKDOWN_COMPONENTS) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[[rehypeKatex, { strict: false, throwOnError: false }]]}
      components={components}
    >
      {text}
    </ReactMarkdown>
  );
}

// Markdown 按块切分的纯逻辑在 lib/markdown-blocks（可用 npm run check:markdown 断言），
// 这里只负责渲染。

/**
 * 单块 Markdown 渲染（被 memo 记住的单元）。
 *
 * key 由父组件给成块内容本身：内容不变则不会重渲染，也就不会重解析。
 */
const MarkdownBlock = memo(function MarkdownBlock({ content, components }: { content: string; components?: Components }) {
  return <>{renderMarkdown(content, components)}</>;
});

// 记忆化 Markdown 渲染：仅当内容变化时才重新解析，避免消息列表全量重渲染时重复解析未变化的消息。
//
// 这里额外做**按块 memo**：流式正文每帧都在变，整段一次性交给 ReactMarkdown
// 会让 remark + rehype 每帧全量重跑（长回答 + 表格时代价很高）。切成块之后
// 前面各块文本不变、命中 memo，只有末尾块参与重解析。
// 块之间用空行拼接还原，因此渲染结果与原整段解析一致。
const MemoMarkdown = memo(function MemoMarkdown({ content, components }: { content: string; components?: Components }) {
  const blocks = splitMarkdownBlocks(content);
  return (
    <div>
      {blocks.map((block, index) => (
        <MarkdownBlock key={`${index}-${block}`} content={block} components={components} />
      ))}
    </div>
  );
});

/**
 * 带打字机揭示的 Markdown 正文（仅渲染成 Markdown，不拆围栏）。
 *
 * 为什么不直接在 `MemoMarkdown` 里调 hook：正文块是在 `groupSegments(...).map()`
 * 的回调里渲染的，历史消息也不该重播动画。拆成独立组件后，只有显式用它的地方
 * （流式正文、进行中的思考步）才有揭示成本，其余路径零变化。
 *
 * 揭示必须在切块**之前**作用于原始文本：先交给 `useSmoothText` 拿到前缀，
 * 再交给 `MemoMarkdown` 按块 memo。反过来先切块再揭示会把 `splitMarkdownBlocks`
 * 的稳定块判据打碎（每帧块内容都在变），memo 就失效了。
 */
function SmoothMarkdown({ content, streaming, components }: { content: string; streaming: boolean; components?: Components }) {
  const revealed = useSmoothText(content, streaming);
  return <MemoMarkdown content={revealed} components={components} />;
}

/**
 * 流式正文段：打字机揭示 + 拆出开放围栏 + 分别渲染。
 *
 * 顺序很关键 —— 揭示作用于**整段原文**，再从揭示出的前缀里拆围栏。
 * 反过来（先拆围栏、只揭示 renderable）会在围栏闭合那一刻出问题：
 * `renderable` 突然从「围栏前正文」变成「正文 + 完整代码块」，多出来的代码
 * 会被当作新到达的文字再打一遍，视觉上代码块凭空重放。
 *
 * 这里返回 null 的判据与原先在 chat.tsx 里的一致：定稿正文与开放围栏都空时，
 * 不渲染空白气泡。
 */
function SmoothSegmentBody({ content, streaming }: { content: string; streaming: boolean }) {
  const revealed = useSmoothText(content, streaming);
  const view = splitSegmentForRender(revealed);
  if (!view.renderable.trim() && !view.openFence) return null;
  return (
    <>
      {view.renderable.trim() ? (
        <div className="min-w-0 [overflow-wrap:anywhere]">
          <MemoMarkdown content={view.renderable} />
        </div>
      ) : null}
      {/* 仍在流式生成的代码块：渐进式展示（灰化 + 尾部 ▌ 光标闪烁） */}
      {view.openFence && streaming ? (
        <StreamingCodeBlock fenceLine={view.openFence.fenceLine} code={view.openFence.code} />
      ) : null}
    </>
  );
}

// 思考过程的 Markdown 组件映射：与正文（MARKDOWN_COMPONENTS）区分，整体走淡紫色调，深色模式下同步加深。
const THINKING_COMPONENTS: Components = {
  h1: ({ node: _node, ...props }) => <h1 className="mb-1 mt-2 text-sm font-semibold text-violet-900 dark:text-violet-100" {...props} />,
  h2: ({ node: _node, ...props }) => <h2 className="mb-1 mt-2 text-sm font-semibold text-violet-900 dark:text-violet-100" {...props} />,
  h3: ({ node: _node, ...props }) => <h3 className="mb-1 mt-2 text-sm font-semibold text-violet-900 dark:text-violet-100" {...props} />,
  h4: ({ node: _node, ...props }) => <h4 className="mb-1 mt-2 text-sm font-semibold text-violet-900 dark:text-violet-100" {...props} />,
  h5: ({ node: _node, ...props }) => <h5 className="mb-1 mt-2 text-sm font-semibold text-violet-900 dark:text-violet-100" {...props} />,
  h6: ({ node: _node, ...props }) => <h6 className="mb-1 mt-2 text-sm font-semibold text-violet-900 dark:text-violet-100" {...props} />,
  p: ({ node: _node, ...props }) => <p className="mb-1 text-sm leading-relaxed text-violet-700/80 dark:text-violet-300/80" {...props} />,
  a: ({ node: _node, ...props }) => <a target="_blank" rel="noreferrer noopener" className="text-violet-600 underline underline-offset-2 hover:opacity-80 dark:text-violet-400" {...props} />,
  strong: ({ node: _node, ...props }) => <strong className="font-semibold text-violet-900 dark:text-violet-100" {...props} />,
  em: ({ node: _node, ...props }) => <em className="italic text-violet-700/80 dark:text-violet-300/80" {...props} />,
  del: ({ node: _node, ...props }) => <del className="text-violet-500 dark:text-violet-400" {...props} />,
  ul: ({ node: _node, ...props }) => <ul className="my-2 list-disc space-y-1.5 pl-5" {...props} />,
  ol: ({ node: _node, ...props }) => <ol className="my-2 list-decimal space-y-1.5 pl-5" {...props} />,
  li: ({ node: _node, ...props }) => <li className="text-sm leading-relaxed text-violet-700/80 dark:text-violet-300/80" {...props} />,
  blockquote: ({ node: _node, ...props }) => <blockquote className="my-2 border-l-2 border-violet-400/50 pl-3 italic text-violet-600 dark:border-violet-500/50 dark:text-violet-300" {...props} />,
  hr: ({ node: _node, ...props }) => <hr className="my-3 border-violet-200 dark:border-violet-800/40" {...props} />,
  img: ({ node: _node, alt, ...props }) => {
    const { openPreview } = useContext(PreviewContext);
    return (
      <img
        alt={alt ?? ""}
        className="my-2 max-w-full cursor-zoom-in rounded-lg"
        {...props}
        onClick={() => { if (props.src) openPreview(props.src); }}
      />
    );
  },
  code: ({ node: _node, ...props }) => <code className="rounded bg-violet-100 px-1.5 py-0.5 font-mono text-xs text-violet-800 dark:bg-violet-900/50 dark:text-violet-200" {...props} />,
  pre: ({ node: _node, children }) => (
    <pre className="my-2 overflow-x-auto rounded-lg border border-violet-200 bg-violet-100/60 p-2.5 font-mono text-xs leading-relaxed text-violet-800 dark:border-violet-800/40 dark:bg-violet-900/40 dark:text-violet-200">
      <code>{nodeToText(children)}</code>
    </pre>
  ),
  table: ({ node: _node, children, ...props }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-sm text-violet-700/80 dark:text-violet-300/80" {...props}>{children}</table>
    </div>
  ),
  thead: ({ node: _node, ...props }) => <thead className="bg-violet-100/60 dark:bg-violet-900/40" {...props} />,
  th: ({ node: _node, ...props }) => <th className="border border-violet-200 px-3 py-2 text-left text-xs font-semibold text-violet-900 dark:border-violet-800/40 dark:text-violet-100" {...props} />,
  td: ({ node: _node, ...props }) => <td className="border border-violet-200 px-3 py-2 align-top text-sm text-violet-700/80 dark:border-violet-800/40 dark:text-violet-300/80" {...props} />,
  input: ({ node: _node, ...props }) => <input className="mr-1.5 accent-violet-600 dark:accent-violet-400" disabled {...props} />,
};

// 思考过程折叠块：默认展开状态由 defaultOpen 决定（最新消息默认展开），
// 展开/收起状态由组件内部记忆，重新渲染不会重置。
// streaming 为 true 时正文走打字机揭示：思考 token 经常一次好几个字，
// 直接渲染会成块跳出；历史消息则一步到位，不重播。
function ThinkingBlock({ text, defaultOpen = false, streaming = false }: { text: string; defaultOpen?: boolean; streaming?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details open={open} className="mb-2.5 overflow-hidden rounded-lg border border-violet-200 bg-violet-50/60 dark:border-violet-800/40 dark:bg-violet-950/40">
      <summary onClick={event => { event.preventDefault(); setOpen(value => !value); }} className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-left text-xs text-violet-600 dark:text-violet-300">
        <Brain size={12} className="shrink-0 text-violet-500 dark:text-violet-400" />
        <span className="font-medium">思考过程</span>
        <span className="ml-auto text-xs text-muted-foreground">{open ? "收起" : "展开"}</span>
      </summary>
      <div onClick={() => setOpen(false)} className="border-t border-violet-200 px-3 pb-3 pt-2 leading-relaxed dark:border-violet-800/40">
        <SmoothMarkdown components={THINKING_COMPONENTS} content={text} streaming={streaming} />
      </div>
    </details>
  );
}

export { MARKDOWN_COMPONENTS, CodeBlock, StreamingCodeBlock, renderMarkdown, MemoMarkdown, SmoothMarkdown, SmoothSegmentBody, THINKING_COMPONENTS, ThinkingBlock };
