/**
 * 过程段分组：把「按发生顺序累加的段序列」折叠成「正文块 + 过程时间线块」。
 *
 * 背景：`Message.segments` 是按时间顺序累加的扁平数组（text / thinking / tool 交错），
 * 渲染层如果逐段独立渲染，用户会看到七八个各自带边框的紫色/琥珀色卡片竖着堆叠。
 * 这里把它重排为：
 * - `text` 块：正文段，位置与顺序完全保留（不受影响，仍走 markdown 渲染）；
 * - `process` 块：**连续的** thinking / tool 段聚成一条过程时间线，
 *   收进一个可折叠的「N 个步骤」容器里。
 *
 * 设计约束：
 * 1. **纯函数、零依赖**（不 import React，也不 import 页面模块），
 *    便于 `npm run check:timeline` 用 esbuild + node 直接跑断言；
 * 2. 只做分组与计时，不改内容：任何一段的正文/参数/结果都原样保留在 steps 里；
 * 3. 计时口径优先用服务端事件时间戳（`ts`），缺失时由调用方回落到浏览器打点，
 *    两者都没有就返回 0（组件据此不显示时长，而不是显示「0ms」误导用户）。
 */

/**
 * 不出现在过程时间线里的工具名：AG-UI 渲染类。
 *
 * 约定（对齐《AG-UI 渲染架构 · 实现规范》第 2.2 / 3.1 节）：卡片是正文的**补充**，
 * 不是工具执行痕迹的一部分。因此即使将来主 Agent 改成直接调用 `render_ui` 工具，
 * 也只在正文下方原位呈现卡片，不在时间线里留一行工具调用。
 */
export const HIDDEN_RENDER_TOOLS: ReadonlySet<string> = new Set([
  "akm_render",
  "render_ui",
]);
/** 渲染工具回传的布局：结构由服务端 `layout_schema` 校验过，前端只负责画。 */
export type RenderLayout = {
  version?: string;
  intent?: string;
  title?: string;
  blocks: unknown[];
};

/**
 * 从 `akm_render` 的 tool_result 里取出布局。
 *
 * 服务端把结果序列化成 JSON 字符串（`{"ok":true,"layout":{...}}`），但不同调用路径
 * 也可能直接给对象，所以两种都试。任何一步不合法就返回 null —— 该工具段整段不渲染，
 * 宁可「没有卡片」，也不要半截或空白块。
 */
export function extractRenderLayout(result: unknown): RenderLayout | null {
  let value: unknown = result;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  const record = value as { ok?: unknown; layout?: unknown };
  if (record.ok === false) return null;
  const layout = record.layout;
  if (!layout || typeof layout !== "object") return null;
  const blocks = (layout as { blocks?: unknown }).blocks;
  if (!Array.isArray(blocks) || blocks.length === 0) return null;
  return layout as RenderLayout;
}

/** 过程步骤：时间线里的一步。由 thinking / tool 段归一化而来。 */
export type ProcessStep =
  | {
      kind: "thinking";
      /** 思考正文（渲染时按 Markdown 展示，可折叠） */
      content: string;
      /** 服务端事件时间戳（毫秒），缺失时为 undefined */
      startedAt?: number;
      endedAt?: number;
    }
  | {
      kind: "tool";
      /** 内部工具名，原样保留（文案翻译在 lib/step-labels.ts 做） */
      name: string;
      params: Record<string, unknown>;
      result: unknown;
      /** running=执行中、success=已完成、error=失败 */
      status: "running" | "success" | "error";
      startedAt?: number;
      endedAt?: number;
    };

/** 渲染块：正文块或过程块。 */
export type MessageBlock =
  | { kind: "text"; content: string; segmentIndex: number }
  | {
      kind: "process";
      steps: ProcessStep[];
      /** 组成该块的原始段下标，用于生成稳定的 React key */
      segmentIndexes: number[];
      stepCount: number;
      /** 组内耗时（毫秒）：优先取首步开始 → 末步结束的跨度；0 表示拿不到时间戳 */
      durationMs: number;
      /** 是否含失败的工具步（时间线标题显示红点计数） */
      hasError: boolean;
      /** 是否仍在执行（流式中） */
      hasRunning: boolean;
    }
  | {
      // 特殊工具段（子 Agent / 子任务列表等）不进过程时间线：
      // 它们各自有专门卡片渲染，收进时间线会丢失卡片功能，因此单独成块交给调用方。
      kind: "special";
      segment: Extract<ProcessSegmentInput, { type: "tool" }>;
      segmentIndex: number;
    }
  | {
      // 渲染工具（akm_render）回传的布局：按它发生的位置**原位**渲染成卡片，
      // 不占时间线一行，也不参与「折叠 / 展开」逻辑。
      kind: "render";
      layout: RenderLayout;
      segmentIndex: number;
    };

/**
 * 分组输入的段类型。
 *
 * 与 `app/types.ts` 的 `MessageSegment` 结构兼容（后者是它的超集），
 * 这里独立声明是为了让本模块保持零 import、可被 esbuild 单独打包断言。
 * 若 types.ts 的段结构变化，需要同步本类型（两处都有注释互相指向）。
 */
export type ProcessSegmentInput =
  | { type: "text"; content: string }
  | { type: "thinking"; content: string; startedAt?: number; endedAt?: number }
  | {
      type: "tool";
      name: string;
      params: Record<string, unknown>;
      result: unknown;
      status: "running" | "success" | "error";
      startedAt?: number;
      endedAt?: number;
    };

/** 单步耗时（毫秒）：起止都有才计算，否则返回 0。 */
export function stepDurationMs(step: ProcessStep): number {
  if (typeof step.startedAt !== "number" || typeof step.endedAt !== "number") return 0;
  const span = step.endedAt - step.startedAt;
  return span > 0 ? span : 0;
}

/**
 * 一组步骤的总耗时。
 *
 * 口径：优先「首步开始 → 末步结束」的真实跨度（含模型思考与工具执行之间的间隙，
 * 与截图里「已处理完 6.0s」一致）；拿不到跨度的两端时，退化为各步耗时之和；
 * 仍然拿不到（旧服务端没有 ts、也没有浏览器打点）就返回 0。
 */
export function processDurationMs(steps: readonly ProcessStep[]): number {
  if (steps.length === 0) return 0;
  const first = steps[0];
  const last = steps[steps.length - 1];
  if (typeof first.startedAt === "number" && typeof last.endedAt === "number") {
    const span = last.endedAt - first.startedAt;
    if (span > 0) return span;
  }
  return steps.reduce((total, step) => total + stepDurationMs(step), 0);
}

/** thinking / tool 段统一转成 ProcessStep。 */
function toProcessStep(segment: Exclude<ProcessSegmentInput, { type: "text" }>): ProcessStep {
  if (segment.type === "thinking") {
    return {
      kind: "thinking",
      content: segment.content,
      startedAt: segment.startedAt,
      endedAt: segment.endedAt,
    };
  }
  return {
    kind: "tool",
    name: segment.name,
    params: segment.params ?? {},
    result: segment.result,
    status: segment.status,
    startedAt: segment.startedAt,
    endedAt: segment.endedAt,
  };
}

/**
 * 把扁平的段序列分组成渲染块。
 *
 * 规则（刻意保持简单可预期）：
 * - text 段一律独立成块，并**打断**当前过程组的连续性（正文之后的工具是新的一段过程）；
 * - 连续的 thinking / tool 段合成一个过程块；
 * - 命中 `isSpecialTool` 的工具段单独成 special 块并打断分组（例如子 Agent 卡片）；
 * - 纯空白的 thinking 段被丢弃（流式起手时会产生空思考段，不该占一行）；
 * - 空字符串的 text 段仍然输出（渲染层按自身规则过滤，避免这里吞掉流式占位）。
 *
 * @param segments 待分组的段序列
 * @param options.isSpecialTool 判定「不该收进时间线、有专用卡片」的工具名
 */
export function groupSegments(
  segments: readonly ProcessSegmentInput[],
  options: { isSpecialTool?: (name: string) => boolean } = {},
): MessageBlock[] {
  const isSpecialTool = options.isSpecialTool;
  const blocks: MessageBlock[] = [];
  // 当前正在累积的过程组（遇到 text 段即封口）
  let pendingSteps: ProcessStep[] = [];
  let pendingIndexes: number[] = [];

  const flushProcess = () => {
    if (pendingSteps.length === 0) return;
    const steps = pendingSteps;
    const hasError = steps.some(step => step.kind === "tool" && step.status === "error");
    const hasRunning = steps.some(step => step.kind === "tool" && step.status === "running");
    blocks.push({
      kind: "process",
      steps,
      segmentIndexes: pendingIndexes,
      stepCount: steps.length,
      durationMs: processDurationMs(steps),
      hasError,
      hasRunning,
    });
    pendingSteps = [];
    pendingIndexes = [];
  };

  segments.forEach((segment, index) => {
    if (segment.type === "text") {
      flushProcess();
      blocks.push({ kind: "text", content: segment.content, segmentIndex: index });
      return;
    }
    if (segment.type === "thinking" && !segment.content.trim()) {
      // 空思考段（流式起手/仅空白）不参与分组，也不打断过程连续性
      return;
    }
    if (segment.type === "tool" && HIDDEN_RENDER_TOOLS.has(segment.name)) {
      // 渲染类工具（akm_render / render_ui）：**原位替换**成卡片，不占时间线一行。
      // 卡片放在它发生的位置（前后过程组各自封口），而不是消息末尾 —— 这样正文与卡片
      // 的先后顺序就是模型真实的输出顺序。解析不出布局（ok=false / 结构不对）时整段跳过，
      // 用户只会看到「没有卡片」，不会看到一行莫名其妙的工具调用。
      flushProcess();
      const layout = extractRenderLayout(segment.result);
      if (layout) blocks.push({ kind: "render", layout, segmentIndex: index });
      return;
    }
    if (segment.type === "tool" && isSpecialTool?.(segment.name)) {
      // 有专用卡片的工具（子 Agent / 子任务列表）单独成块，前后过程组各自封口
      flushProcess();
      blocks.push({ kind: "special", segment, segmentIndex: index });
      return;
    }
    pendingSteps.push(toProcessStep(segment));
    pendingIndexes.push(index);
  });
  flushProcess();

  return blocks;
}
