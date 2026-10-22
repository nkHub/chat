/**
 * AG-UI 布局渲染层（从同级设计项目 `AI Chat Window Design` 的
 * `src/components/agui/` 移植，保持协议与渲染实现一致）。
 *
 * 只搬了两块：
 * - `types.ts`：布局协议（15 种 block + `AGUILayout`），也是服务端校验的唯一依据；
 * - `AGUIRenderer.tsx`：按 block 渲染（含 recharts 图表）。
 *
 * 设计项目里的 `AGUIEventBus.ts` / `useAGUI.ts` 是**本地 mock**（源码注释写明
 * 「In a real deployment, replace emit() with an SSE write」），这里不搬：
 * 真实事件来自 AKM `/v1/agent` 的 `custom` 事件，由 `App.tsx` 直接落地到
 * `Message.layout`，不需要额外的事件总线层。
 */
export { AGUIRenderer } from "./AGUIRenderer";
export type {
  AGUILayout,
  AGUIBlock,
  AGUIIntent,
  AGUIVersion,
  TextBlock,
  HeadingBlock,
  CodeBlock,
  TableBlock,
  StatsBlock,
  CardsBlock,
  AlertBlock,
  ComparisonBlock,
  TimelineBlock,
  ListBlock,
  SeparatorBlock,
  ChartBlock,
  ProgressBlock,
  KanbanBlock,
  MapBlock,
} from "./types";
