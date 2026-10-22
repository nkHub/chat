import { useState } from "react";
import { AlertCircle, Bot, Brain, ChevronRight, FileText, Globe, Image as ImageIcon, Loader2, PencilLine, Search, TerminalSquare, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import type { MessageBlock, ProcessStep } from "@/lib/process-groups";
import { describeStep, describeStepTarget, formatDuration, summarizeStepResult, summarizeThinking } from "@/lib/step-labels";
import { MemoMarkdown } from "./markdown";

/**
 * 过程时间线：把一轮里的「思考 + 工具调用」收成一条可折叠的步骤流。
 *
 * 视觉规则（对齐 pi-desktop 的做法，去掉了早期的竖线 + 圆点 + 彩色圆底）：
 * - **零卡片**：整个过程区没有边框、没有背景、没有圆角；唯一的底色是 hover 时
 *   一条淡填充（`hover:bg-muted/40`），且用 `-mx-1 px-1` 做出 4px 出血，让 hover
 *   区域比文字略宽、更像「可点的一行」而不是「一个块」。
 * - **层级只靠缩进**：展开的步骤相对组头缩进 12px（`pl-3`），不画连接线。
 * - **组头是一整行**：`N 个步骤 + 状态 + 总耗时`，右侧 chevron 旋转表示展开态。
 * - **单步右侧只放状态与 chevron**：普通工具行不显示单步耗时（耗时只出现在组头），
 *   避免一排小数字把行挤满（与 pi-desktop 一致）。
 * - **图标按动作区分**：读文件 / 搜内容 / 联网 / 终端 / 生图 / 子 Agent 各有图标，
 *   统一 15px 弱化色；思考步用大脑图标 + 紫色，与工具步区分。
 * - **思考正文不限高**：思考不内滚（跟着页面滚）；工具的参数与结果限高 240px 内滚。
 *
 * 数据来自 lib/process-groups.ts 的分组结果，文案来自 lib/step-labels.ts，
 * 本组件只负责展示与交互，不含业务判断。
 */

type ProcessBlock = Extract<MessageBlock, { kind: "process" }>;

/** 图标尺寸：与 pi-desktop 的 15px 一致，比正文略小、不抢注意力。 */
const ICON_SIZE = 15;

/** 按 step-labels 给出的语气选择图标（tone 未收录时用扳手兜底）。 */
function StepIcon({ step }: { step: ProcessStep }) {
  if (step.kind === "thinking") {
    return <Brain size={ICON_SIZE} className="shrink-0 text-violet-500/80 dark:text-violet-400/80" />;
  }
  const tone = describeStep(step.name).tone;
  const className = "shrink-0 text-muted-foreground";
  switch (tone) {
    case "read":
      return <FileText size={ICON_SIZE} className={className} />;
    case "write":
      return <PencilLine size={ICON_SIZE} className={className} />;
    case "search":
      return <Search size={ICON_SIZE} className={className} />;
    case "net":
      return <Globe size={ICON_SIZE} className={className} />;
    case "image":
      return <ImageIcon size={ICON_SIZE} className={className} />;
    case "system":
      return <TerminalSquare size={ICON_SIZE} className={className} />;
    case "agent":
      return <Bot size={ICON_SIZE} className={className} />;
    default:
      return <Wrench size={ICON_SIZE} className={className} />;
  }
}

/** 主标题：思考步固定「思考过程」，工具步走静态映射的人话动作。 */
function stepAction(step: ProcessStep): string {
  if (step.kind === "thinking") return "思考过程";
  return describeStep(step.name).action;
}

/** 参数摘要（操作对象），思考步没有。 */
function stepTarget(step: ProcessStep): string {
  if (step.kind !== "tool") return "";
  return describeStepTarget(step.params);
}

/**
 * 副标题：思考步取思考正文首行；工具步取结果摘要。
 * 结果为空的「运行中」步不占位（右侧状态已经写明「进行中」），避免出现空副标题。
 */
/**
 * 单行摘要最多取前 300 字符。
 * 这一行最终会被容器截断，但摘要字符串本身可能上千字（尤其思考正文），
 * 先裁一次能少做无用布局与文本测量；保留尾部省略号让「还有更多」可感知。
 */
const SUMMARY_MAX_CHARS = 300;

function clipSummary(text: string): string {
  const value = text.trim();
  return value.length > SUMMARY_MAX_CHARS ? `${value.slice(0, SUMMARY_MAX_CHARS)}…` : value;
}

function stepSummary(step: ProcessStep): string {
  if (step.kind === "thinking") return clipSummary(summarizeThinking(step.content));
  if (step.status === "running") return "";
  return clipSummary(summarizeStepResult(step.result));
}

/** 单步状态文案（与 pi-desktop 的 Done / Running / Failed 对齐，这里用中文短词）。 */
function stepStatusLabel(step: ProcessStep): { text: string; className: string } | null {
  if (step.kind === "thinking") return null;
  if (step.status === "running") return { text: "进行中", className: "text-primary/80" };
  if (step.status === "error") return { text: "失败", className: "text-red-500/90 dark:text-red-400/90" };
  return { text: "完成", className: "text-muted-foreground" };
}

/** 单步详情：思考正文用 Markdown（不限高）；工具参数/结果用 JSON（限高内滚）。 */
function StepDetail({ step }: { step: ProcessStep }) {
  if (step.kind === "thinking") {
    return (
      <div className="mt-1 mb-1.5 text-[13px] leading-relaxed text-muted-foreground [&_li]:text-[13px] [&_p]:text-[13px]">
        <MemoMarkdown content={step.content} />
      </div>
    );
  }
  return (
    <pre className="mt-1 mb-1.5 max-h-60 overflow-auto rounded-md border border-border/50 bg-muted/20 px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-muted-foreground/90">
      {JSON.stringify({ params: step.params, result: step.result }, null, 2)}
    </pre>
  );
}

/** 单个步骤行：一整行可点（展开详情），hover 淡填充，零卡片。 */
function StepRow({ step }: { step: ProcessStep }) {
  // 展开策略：默认跟随步骤状态，用户手动点过后固定为手动选择（manualOpen 非 null）。
  // - 思考步：进行中默认展开（边想边看），思考结束自动折叠成一行摘要
  //   （结束判据是段上的 endedAt：流式期间为 undefined，后续事件到来时才补齐）；
  // - 工具步：始终默认折叠（参数/结果 JSON 信息密度低，需要时再点开）。
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const autoOpen = step.kind === "thinking" && typeof step.endedAt !== "number";
  const detailOpen = manualOpen ?? autoOpen;
  // 思考步是模型的推理过程，用户更想读；工具步只是执行痕迹，弱一档显示。
  const isThinking = step.kind === "thinking";
  const target = stepTarget(step);
  const summary = stepSummary(step);
  const status = stepStatusLabel(step);

  return (
    <div>
      <button
        type="button"
        onClick={() => setManualOpen(!detailOpen)}
        aria-expanded={detailOpen}
        className="-mx-1 flex min-h-6 w-full items-center gap-1.5 rounded-sm px-1 py-0.5 text-left transition-colors hover:bg-muted/40"
      >
        <StepIcon step={step} />
        {/* 主标题：不截断（动作词很短），弱化但可读 */}
        <span className={cn("shrink-0 text-[13px] font-medium", isThinking ? "text-foreground/85" : "text-foreground/65")}>{stepAction(step)}</span>
        {/* 中间段（参数 + 结果摘要）合并成一个整体，只有它伸缩并在单行内截断；
            等宽字体 + 弱化灰，视觉上明显低于主标题。
            思考步没有状态词，这里会一路铺到右侧箭头，不留空位。 */}
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted-foreground">
          {target ? <span>{target}</span> : null}
          {target && summary ? " " : null}
          {summary ? <span>{summary}</span> : null}
        </span>
        {/* 状态只在真有状态时渲染：思考步没有状态 → 不占固定宽度，中间段直接吃满；
            工具步固定 40px 右对齐，「完成 / 进行中 / 失败」宽度不一也能让箭头对齐。 */}
        {status ? (
          <span className={cn("w-10 shrink-0 text-right text-[11px]", status.className)}>{status.text}</span>
        ) : null}
        <ChevronRight size={12} className={cn("shrink-0 opacity-60 transition-transform", detailOpen && "rotate-90")} />
      </button>
      {/* 缩进与组内步骤对齐（12px）：详情左边界贴近主标题起点，右侧因此能一路铺到箭头 */}
      {detailOpen ? (
        /* 单步详情按需渲染（思考正文可能很长，不能常驻 DOM），因此用一次进入动画代替
           grid 过渡：展开时轻微淡入上移，收起直接消失（收起的瞬间不影响观感）。 */
        <div className="pl-3 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1 motion-safe:duration-150">
          <StepDetail step={step} />
        </div>
      ) : null}
    </div>
  );
}

export function ProcessTimeline({
  block,
  open,
  onToggle,
  runDurationMs = 0,
}: {
  block: ProcessBlock;
  /** 是否展开（受控）：进行中默认展开、结束后默认收起，状态由消息持久化 */
  open: boolean;
  onToggle: () => void;
  /** 整轮耗时（毫秒）：优先于组内耗时，0 表示无数据不显示时长 */
  runDurationMs?: number;
}) {
  // 总时长口径：整轮耗时 > 组内首末步跨度 > 0（无数据）
  const totalMs = runDurationMs > 0 ? runDurationMs : block.durationMs;
  const runningStepIndex = block.steps.findIndex(step => step.kind === "tool" && step.status === "running");
  const errorCount = block.steps.filter(step => step.kind === "tool" && step.status === "error").length;

  // 组头状态文案：进行中显示到第几步，结束后显示总耗时（拿不到时间戳就只说「已处理完」）
  const statusText = block.hasRunning
    ? runningStepIndex >= 0
      ? `正在处理 · 第 ${runningStepIndex + 1} 步`
      : "正在处理…"
    : totalMs > 0
      ? `已处理完 ${formatDuration(totalMs)}`
      : "已处理完";

  return (
    /* mb-2：与下方正文留一点呼吸（消息区还有 space-y-2.5，合计约 18px） */
    <div className="mb-2">
      {/* 组头：整行可点，hover 才有一条淡填充（唯一底色，零卡片） */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="-mx-1 flex min-h-6 w-full items-center gap-1.5 rounded-sm px-1 py-0.5 text-left transition-colors hover:bg-muted/40"
      >
        {block.hasRunning ? (
          <Loader2 size={13} className="shrink-0 animate-spin text-primary/80" />
        ) : (
          <Wrench size={13} className="shrink-0 text-muted-foreground" />
        )}
        <span className="shrink-0 text-[13px] font-medium text-foreground/85">{block.stepCount} 个步骤</span>
        <span className="shrink-0 text-[12px] text-muted-foreground">{statusText}</span>
        {errorCount > 0 ? (
          <span className="shrink-0 rounded-sm bg-red-50 px-1 text-[10.5px] text-red-600 dark:bg-red-950/40 dark:text-red-400">
            {errorCount} 步失败
          </span>
        ) : null}
        <ChevronRight size={12} className={cn("ml-auto shrink-0 opacity-60 transition-transform", open && "rotate-90")} />
      </button>

      {/* 展开/收起用 grid-template-rows 过渡（0fr ↔ 1fr）：这是唯一能对「高度未知的块」
          做真动画的写法。常驻的只是步骤行（很轻），单步详情正文仍按需渲染，不增加开销。 */}
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-200 ease-out",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className="overflow-hidden">
          {/* 层级只靠缩进（12px），不画连接线；步骤多时按整页滚动，不内滚 */}
          <div className="mt-0.5 pl-3">
            {block.steps.map((step, index) => (
              <StepRow key={`${step.kind}-${index}`} step={step} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** 单步状态图标（供外部复用，例如子 Agent 卡片内联展示时）。 */
export function StepStatusIcon({ status }: { status: "running" | "success" | "error" }) {
  if (status === "running") return <Loader2 size={12} className="animate-spin text-primary/80" />;
  if (status === "error") return <AlertCircle size={12} className="text-red-500 dark:text-red-400" />;
  return <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500/80" />;
}
