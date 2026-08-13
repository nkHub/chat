import { Children, isValidElement, memo, useContext, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import { Brain, Check, Copy } from "lucide-react";
import { nodeToText } from "./helpers";
import { PreviewContext } from "./preview";

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
      <pre className="overflow-x-auto p-3 leading-relaxed text-zinc-300"><code>{code}</code></pre>
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

// 记忆化 Markdown 渲染：仅当内容变化时才重新解析，避免消息列表全量重渲染时重复解析未变化的消息。
const MemoMarkdown = memo(function MemoMarkdown({ content, components }: { content: string; components?: Components }) {
  return <div>{renderMarkdown(content, components)}</div>;
});

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
function ThinkingBlock({ text, defaultOpen = false }: { text: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details open={open} className="mb-2.5 overflow-hidden rounded-lg border border-violet-200 bg-violet-50/60 dark:border-violet-800/40 dark:bg-violet-950/40">
      <summary onClick={event => { event.preventDefault(); setOpen(value => !value); }} className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-left text-xs text-violet-600 dark:text-violet-300">
        <Brain size={12} className="shrink-0 text-violet-500 dark:text-violet-400" />
        <span className="font-medium">思考过程</span>
        <span className="ml-auto text-xs text-muted-foreground">{open ? "收起" : "展开"}</span>
      </summary>
      <div onClick={() => setOpen(false)} className="border-t border-violet-200 px-3 pb-3 pt-2 leading-relaxed dark:border-violet-800/40">
        <MemoMarkdown components={THINKING_COMPONENTS} content={text} />
      </div>
    </details>
  );
}

export { MARKDOWN_COMPONENTS, CodeBlock, renderMarkdown, MemoMarkdown, THINKING_COMPONENTS, ThinkingBlock };
