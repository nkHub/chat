import { useContext, useEffect, useRef, useState } from "react";
import { AlertCircle, Check, ChevronRight, Copy, ExternalLink, HelpCircle, Loader2, RotateCcw, Share2, ThumbsDown, ThumbsUp, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { extractGeneratedImages, PreviewContext } from "./preview";
import type { Citation, FunctionCall } from "./types";

function ContextHint({ compacted }: { compacted?: number }) {
  if (!compacted || compacted <= 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 px-0.5 text-[11px] text-muted-foreground">
      <span className="inline-flex items-center gap-1">
        <Check size={11} className="shrink-0 text-primary" />
        已自动压缩上下文 {compacted} 次
      </span>
    </div>
  );
}

function FunctionCallBlock({ calls }: { calls: FunctionCall[] }) {
  const { openPreview } = useContext(PreviewContext);
  return (
    <div className="mb-2.5 overflow-hidden rounded-lg border border-amber-200 bg-amber-50/70 dark:border-amber-800/40 dark:bg-amber-950/40">
      <div className="flex items-center gap-2 border-b border-amber-200 px-3 py-2 text-xs font-medium text-amber-700 dark:border-amber-800/40 dark:text-amber-300">
        <Wrench size={12} />
        <span>工具调用</span>
        <span className="ml-auto text-xs text-amber-700/60 dark:text-amber-300/60">{calls.length} 项</span>
      </div>
      <div className="divide-y divide-amber-200/70 dark:divide-amber-800/40">
        {calls.map((call, index) => {
          const imageUrls = extractGeneratedImages(call.result);
          return (
            <details key={`${call.name}-${index}`} className="group px-3 py-2">
              <summary className="flex cursor-pointer list-none items-center gap-2 text-xs text-amber-900/80 dark:text-amber-200/80">
                {call.status === "success" ? <Check size={12} className="text-emerald-600 dark:text-emerald-400" /> : call.status === "running" ? <Loader2 size={12} className="animate-spin text-amber-600 dark:text-amber-400" /> : <AlertCircle size={12} className="text-red-500 dark:text-red-400" />}
                <code className="font-mono">{call.name}</code>
                <ChevronRight size={12} className="ml-auto transition-transform group-open:rotate-90" />
              </summary>
              <pre className="mt-2 overflow-x-auto rounded bg-white/70 p-2 text-xs leading-relaxed text-amber-900/70 dark:bg-black/30 dark:text-amber-200/70">{JSON.stringify({ params: call.params, result: call.result }, null, 2)}</pre>
              {imageUrls.length > 0 && (
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {imageUrls.map((url, imageIndex) => (
                    <img key={imageIndex} src={url} alt={`生成图片 ${imageIndex + 1}`} className="w-full cursor-zoom-in rounded border border-amber-200/70 bg-white/70 object-contain dark:border-amber-800/40 dark:bg-black/30" onClick={() => openPreview(url)} />
                  ))}
                </div>
              )}
            </details>
          );
        })}
      </div>
    </div>
  );
}

function CitationsBlock({ citations }: { citations: Citation[] }) {
  return (
    <div className="mt-3 border-t border-border pt-2.5">
      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        <ExternalLink size={11} /> 参考来源
      </div>
      <div className="flex flex-wrap gap-1.5">
        {citations.map(citation => (
          <button key={citation.index} type="button" className="inline-flex min-w-0 items-center gap-1 rounded-md border border-border bg-muted/50 px-2 py-1 text-left text-xs text-muted-foreground transition-colors hover:border-primary/30 hover:text-primary">
            <span className="font-semibold text-primary">[{citation.index}]</span>
            <span className="truncate">{citation.title}</span>
            <span className="text-foreground/30">{citation.domain}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function MessageActions({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text).catch(() => undefined);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };
  return (
    <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover/msg:opacity-100">
      <Tooltip><TooltipTrigger asChild><button type="button" className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" onClick={copy}>{copied ? <Check size={12} /> : <Copy size={12} />}</button></TooltipTrigger><TooltipContent>复制</TooltipContent></Tooltip>
      <Tooltip><TooltipTrigger asChild><button type="button" className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><ThumbsUp size={12} /></button></TooltipTrigger><TooltipContent>有帮助</TooltipContent></Tooltip>
      <Tooltip><TooltipTrigger asChild><button type="button" className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><ThumbsDown size={12} /></button></TooltipTrigger><TooltipContent>没帮助</TooltipContent></Tooltip>
      <Tooltip><TooltipTrigger asChild><button type="button" className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><Share2 size={12} /></button></TooltipTrigger><TooltipContent>分享</TooltipContent></Tooltip>
    </div>
  );
}

function StatusNotice({ status, error, onRetry }: { status: "send_failed" | "recv_failed"; error?: string; onRetry: () => void }) {
  const received = status === "recv_failed";
  return (
    <div className={cn("mt-1.5 flex items-center gap-2 text-xs", received ? "text-red-500" : "text-destructive")}>
      <AlertCircle size={11} />
      <span className="max-w-[min(70vw,360px)] truncate">{error || (received ? "回复加载失败" : "发送失败")}</span>
      <button type="button" className="inline-flex items-center gap-1 text-xs font-medium leading-none underline underline-offset-2" onClick={onRetry}><RotateCcw size={10} />重试</button>
    </div>
  );
}

// AI 通过 akm_ask_user 工具提出的澄清问题卡片：
// active 为 true（消息状态 asking）时显示回答区等待用户回答，提交后回调 onSubmit；
// 回答提交或历史记录恢复后 active 为 false，只读展示问题原文。
// 支持后端三模式：无 options 时自由文本输入框；options 单选点击即提交；
// options + multiple 时 checkbox 多选后点确认提交（选中项以「、」拼接）。
function AskUserCard({ question, options, multiple, active, onSubmit }: {
  question: string;
  options?: string[];
  multiple?: boolean;
  active: boolean;
  onSubmit: (answer: string) => void;
}) {
  const [answer, setAnswer] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const hasOptions = (options ?? []).length > 0;

  // 激活时仅自由文本模式自动聚焦输入框；选项模式靠点击操作，无需聚焦。
  useEffect(() => {
    if (active && !hasOptions) inputRef.current?.focus();
  }, [active, hasOptions]);

  // 自由文本模式提交。
  const submitText = () => {
    const value = answer.trim();
    if (!value) return;
    onSubmit(value);
    setAnswer("");
  };

  // 多选模式提交：选中项拼接后作为回答传给 AI。
  const submitMultiple = () => {
    if (selected.length === 0) return;
    onSubmit(selected.join("、"));
    setSelected([]);
  };

  // 切换某个选项的选中状态（多选）；单选直接提交该选项。
  const toggleOption = (option: string) => {
    if (multiple) {
      setSelected(prev => prev.includes(option) ? prev.filter(item => item !== option) : [...prev, option]);
    } else {
      onSubmit(option);
    }
  };

  return (
    <div className="mt-3 rounded-xl border border-primary/25 bg-primary/[0.04] px-3.5 py-3">
      <div className="flex items-start gap-2">
        <HelpCircle size={15} className="mt-0.5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-foreground">需要确认一下：</p>
          <p className="mt-1 text-sm leading-relaxed text-foreground/90">{question}</p>
          {active && hasOptions ? (
            <div className="mt-2.5 space-y-1.5">
              {options!.map(option => multiple ? (
                <label key={option} className="flex cursor-pointer items-center gap-2 rounded-lg border bg-background px-2.5 py-1.5 text-xs transition-colors hover:border-primary/40">
                  <input type="checkbox" checked={selected.includes(option)} onChange={() => toggleOption(option)} className="h-3.5 w-3.5 accent-primary" />
                  <span className="text-foreground/90">{option}</span>
                </label>
              ) : (
                <button key={option} type="button" onClick={() => toggleOption(option)} className="flex w-full items-center rounded-lg border bg-background px-2.5 py-1.5 text-left text-xs transition-colors hover:border-primary/40 hover:bg-primary/5">
                  <span className="text-foreground/90">{option}</span>
                </button>
              ))}
              {multiple ? (
                <Button size="sm" className="h-8 gap-1" onClick={submitMultiple} disabled={selected.length === 0}>确认</Button>
              ) : null}
            </div>
          ) : null}
          {active && !hasOptions ? (
            <div className="mt-2.5 flex items-center gap-2">
              <input
                ref={inputRef}
                value={answer}
                onChange={event => setAnswer(event.target.value)}
                onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing) submitText(); }}
                placeholder="在这里回答…"
                className="min-w-0 flex-1 rounded-lg border bg-background px-3 py-1.5 text-sm outline-none focus:border-primary/60"
              />
              <Button size="sm" className="h-8 shrink-0 gap-1" onClick={submitText} disabled={!answer.trim()}>回答</Button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export { ContextHint, FunctionCallBlock, CitationsBlock, MessageActions, StatusNotice, AskUserCard };
