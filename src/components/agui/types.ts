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

export type TextBlock = {
  type: "text";
  content: string;
  size?: "sm" | "base" | "lg";
  muted?: boolean;
};

export type HeadingBlock = {
  type: "heading";
  content: string;
  rank: 1 | 2 | 3;
};

export type CodeBlock = {
  type: "code";
  code: string;
  lang: string;
  title?: string;
  highlight?: number[];
};

export type TableColumn = {
  key: string;
  label: string;
  align?: "left" | "center" | "right";
  mono?: boolean;
  badge?: boolean;
};

export type TableBlock = {
  type: "table";
  columns: TableColumn[];
  rows: Record<string, string | number>[];
  caption?: string;
};

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

export type ListItem = {
  content: string;
  done?: boolean;
  sub?: string[];
};

export type ListBlock = {
  type: "list";
  style: "bullet" | "numbered" | "check";
  items: ListItem[];
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
  | TextBlock
  | HeadingBlock
  | CodeBlock
  | TableBlock
  | StatsBlock
  | CardsBlock
  | AlertBlock
  | ComparisonBlock
  | TimelineBlock
  | ListBlock
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
