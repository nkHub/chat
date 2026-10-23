// ─── AG-UI Protocol Types ────────────────────────────────────────────────────
// Schema for the constrained Layout JSON produced by the Layout Agent.
// The Main Agent communicates intent via CUSTOM events / tool calls;
// the Layout Agent emits a validated AGUILayout that the renderer hydrates.

export type AGUIVersion = "1.0";

export type AGUIIntent =
  | "data_summary"
  | "explanation"
  | "comparison"
  | "step_by_step"
  | "error_analysis"
  | "recommendation"
  | "status_report"
  | "code_review"
  | string;

// ─── Block types ─────────────────────────────────────────────────────────────


export type StatItem = {
  label: string;
  value: string | number;
  delta?: { value: string; trend: "up" | "down" | "neutral" };
  color?: "default" | "green" | "red" | "blue" | "amber" | "violet";
};

export type StatsBlock = {
  type: "stats";
  items: StatItem[];
  columns?: 2 | 3 | 4;
};

export type CardItem = {
  title: string;
  description?: string;
  badge?: string;
  badgeColor?: "default" | "blue" | "green" | "red" | "amber" | "violet";
  meta?: string;
  tags?: string[];
};

export type CardsBlock = {
  type: "cards";
  items: CardItem[];
  columns?: 2 | 3 | 4;
};

export type AlertBlock = {
  type: "alert";
  severity: "info" | "warning" | "error" | "success";
  title?: string;
  message: string;
};

export type ComparisonBlock = {
  type: "comparison";
  headers: string[];
  rows: { label: string; values: (string | boolean | number)[] }[];
  caption?: string;
};

export type TimelineEvent = {
  time: string;
  title: string;
  description?: string;
  status?: "done" | "active" | "pending";
};

export type TimelineBlock = {
  type: "timeline";
  events: TimelineEvent[];
};

/** 流程节点类型：决定方框的语义色与形状（start/end 更重，decision 用琥珀色） */
export type FlowNodeKind = "step" | "start" | "end" | "decision" | "async";

export type FlowNode = {
  id: string;
  label: string;
  sublabel?: string | null;
  kind: FlowNodeKind;
};

/** 连线类型：main 实线、branch 虚线分叉、async 点线、return 反向虚线 */
export type FlowEdgeKind = "main" | "branch" | "async" | "return";

export type FlowEdge = {
  from: string;
  to: string;
  label?: string | null;
  kind: FlowEdgeKind;
};

/**
 * 流程图块：nodes 是方框，edges 是带方向的连线。
 * 服务端已保证 nodes ≥ 2、edges 的 from/to 一定命中存在的 id
 * （见 layout_schema._normalize_flow_block），前端只负责布局与绘制。
 */
/** 分组（泳道）配色：与卡片其它块共用同一套语义色 */
export type FlowGroupColor = "default" | "blue" | "green" | "amber" | "violet" | "red";

/**
 * 分组/泳道：把若干节点圈进一个框（对应 archify 的 01 / 02 / EX 泳道）。
 * 服务端已保证 `nodes` 都是存在的节点 id，且一个节点只归属第一个匹配的组。
 */
export type FlowGroup = {
  label: string;
  color: FlowGroupColor;
  nodes: string[];
};

export type FlowBlock = {
  type: "flow";
  direction: "LR" | "TB";
  nodes: FlowNode[];
  /**
   * 以下四个字段在**新**数据里由服务端归一化保证齐全，但浏览器 IndexedDB 里的
   * 历史会话不会随协议升级重写，旧 flow 可能完全没有这些键。
   * 所以类型上标可选，由 `normalizeFlowBlock()` 在渲染前补齐（见 flow-diagram.tsx）。
   */
  edges?: FlowEdge[];
  /** 可选分区（最多 4 组）；缺失/空数组表示不画框 */
  groups?: FlowGroup[];
  /** 是否在底部显示按 kind 统计的图例 */
  legend?: boolean;
  caption?: string | null;
};

export type SeparatorBlock = {
  type: "separator";
  label?: string;
};

export type ChartSeries = { key: string; label: string; color?: string };

export type ChartBlock = {
  type: "chart";
  chartType: "bar" | "line" | "area" | "pie" | "donut";
  data: Record<string, string | number>[];
  xKey: string;
  series: ChartSeries[];
  title?: string;
  caption?: string;
  height?: number;
  stacked?: boolean;
};

export type ProgressItem = {
  label: string;
  value: number;
  sublabel?: string;
  color?: "green" | "blue" | "amber" | "red" | "violet" | "default";
};

export type ProgressBlock = {
  type: "progress";
  items: ProgressItem[];
};

export type KanbanCard = {
  id: string;
  title: string;
  description?: string;
  tags?: string[];
  priority?: "high" | "medium" | "low";
  assignee?: string;
};

export type KanbanColumn = {
  id: string;
  title: string;
  color?: "default" | "blue" | "amber" | "green" | "red" | "violet";
  cards: KanbanCard[];
};

export type KanbanBlock = {
  type: "kanban";
  columns: KanbanColumn[];
};

export type MapDataPoint = { name: string; value: number };

export type MapBlock = {
  type: "map";
  data: MapDataPoint[];
  unit?: string;
  colorScheme?: "blue" | "green" | "amber" | "violet";
};

export type AGUIBlock =
  | StatsBlock
  | CardsBlock
  | AlertBlock
  | ComparisonBlock
  | TimelineBlock
  | FlowBlock
  | SeparatorBlock
  | ChartBlock
  | ProgressBlock
  | KanbanBlock
  | MapBlock;

// ─── Layout document ─────────────────────────────────────────────────────────

export type AGUILayout = {
  version: AGUIVersion;
  intent: AGUIIntent;
  title?: string;
  blocks: AGUIBlock[];
};

// ─── Event protocol ──────────────────────────────────────────────────────────
// Main Agent → Layout Agent communication via CUSTOM events or tool calls.

export type AGUICustomEvent = {
  type: "CUSTOM";
  name: string;
  payload: {
    intent: AGUIIntent;
    context: string;
    constraints?: {
      maxBlocks?: number;
      allowedTypes?: AGUIBlock["type"][];
    };
  };
};

export type AGUIToolCall = {
  type: "TOOL_CALL";
  tool: "layout_agent";
  input: {
    prompt: string;
    intent: AGUIIntent;
    schemaVersion: AGUIVersion;
  };
  output?: AGUILayout;
  status: "pending" | "running" | "done" | "error";
};

export type AGUIEvent = AGUICustomEvent | AGUIToolCall;
