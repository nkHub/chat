import { useState } from "react";
import { cn } from "@/lib/utils";
import {
  CheckCircle2, XCircle, AlertTriangle, Info, TrendingUp, TrendingDown,
  Minus, Copy, Check, ChevronDown, ChevronRight, Circle,
} from "lucide-react";
import {
  ResponsiveContainer, BarChart, Bar, LineChart, Line, AreaChart, Area,
  PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid,
  Tooltip as RechartsTooltip, Legend,
} from "recharts";
import type {
  AGUILayout, AGUIBlock,
  TextBlock, HeadingBlock, CodeBlock, TableBlock,
  StatsBlock, CardsBlock, AlertBlock, ComparisonBlock,
  TimelineBlock, ListBlock, SeparatorBlock,
  StatItem, CardItem,
  ChartBlock, ProgressBlock, KanbanBlock, MapBlock,
} from "./types";

// ─── Text block ───────────────────────────────────────────────────────────────

function RenderText({ block }: { block: TextBlock }) {
  const sizeClass = block.size === "sm" ? "text-sm" : block.size === "lg" ? "text-base font-medium" : "text-sm";
  return (
    <p className={cn("leading-relaxed", sizeClass, block.muted ? "text-muted-foreground" : "text-foreground")}>
      {block.content}
    </p>
  );
}

// ─── Heading block ────────────────────────────────────────────────────────────

function RenderHeading({ block }: { block: HeadingBlock }) {
  const cls = {
    1: "text-lg font-semibold text-foreground tracking-tight",
    2: "text-base font-semibold text-foreground",
    3: "text-sm font-semibold text-foreground uppercase tracking-widest",
  }[block.rank];
  return <div className={cls}>{block.content}</div>;
}

// ─── Code block ───────────────────────────────────────────────────────────────

function RenderCode({ block }: { block: CodeBlock }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(block.code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="rounded-lg border border-border overflow-hidden text-sm font-mono">
      <div className="flex items-center justify-between px-3 py-1.5 bg-muted/60 border-b border-border">
        <span className="text-xs text-muted-foreground font-sans">
          {block.title ?? block.lang}
        </span>
        <button
          onClick={copy}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <pre className="p-3 overflow-x-auto bg-[#f8f9fa] dark:bg-[#1a1b1e] leading-relaxed">
        <code className="text-[13px]">{block.code}</code>
      </pre>
    </div>
  );
}

// ─── Table block ──────────────────────────────────────────────────────────────

const BADGE_COLORS: Record<string, string> = {
  done: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  success: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  error: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300",
  failed: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300",
  pending: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  warning: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  running: "bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300",
  active: "bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300",
};

function cellBadge(val: string) {
  const lower = val.toLowerCase();
  const cls = BADGE_COLORS[lower] ?? "bg-muted text-muted-foreground";
  return <span className={cn("inline-flex px-1.5 py-0.5 rounded text-xs font-medium", cls)}>{val}</span>;
}

function RenderTable({ block }: { block: TableBlock }) {
  return (
    <div className="rounded-lg border border-border overflow-hidden">
      {block.caption && (
        <div className="px-3 py-1.5 bg-muted/40 border-b border-border text-xs text-muted-foreground font-medium">
          {block.caption}
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted/30">
              {block.columns.map((col) => (
                <th
                  key={col.key}
                  className={cn(
                    "px-3 py-2 text-xs font-semibold text-muted-foreground border-b border-border",
                    col.align === "right" ? "text-right" : col.align === "center" ? "text-center" : "text-left"
                  )}
                >
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, i) => (
              <tr key={i} className="border-b border-border/50 last:border-0 hover:bg-muted/20 transition-colors">
                {block.columns.map((col) => {
                  const val = String(row[col.key] ?? "—");
                  return (
                    <td
                      key={col.key}
                      className={cn(
                        "px-3 py-2 text-foreground",
                        col.align === "right" ? "text-right" : col.align === "center" ? "text-center" : "text-left",
                        col.mono ? "font-mono text-xs" : ""
                      )}
                    >
                      {col.badge ? cellBadge(val) : val}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Stats block ──────────────────────────────────────────────────────────────

const STAT_COLOR: Record<string, { bg: string; text: string }> = {
  green:  { bg: "bg-emerald-50 dark:bg-emerald-500/10",  text: "text-emerald-700 dark:text-emerald-300"  },
  red:    { bg: "bg-red-50 dark:bg-red-500/10",          text: "text-red-700 dark:text-red-300"          },
  blue:   { bg: "bg-blue-50 dark:bg-blue-500/10",        text: "text-blue-700 dark:text-blue-300"        },
  amber:  { bg: "bg-amber-50 dark:bg-amber-500/10",      text: "text-amber-700 dark:text-amber-300"      },
  violet: { bg: "bg-violet-50 dark:bg-violet-500/10",    text: "text-violet-700 dark:text-violet-300"    },
  default:{ bg: "bg-muted/40",    text: "text-foreground"   },
};

function RenderStat({ item }: { item: StatItem }) {
  const color = STAT_COLOR[item.color ?? "default"];
  const TrendIcon = item.delta?.trend === "up" ? TrendingUp : item.delta?.trend === "down" ? TrendingDown : Minus;
  const trendColor = item.delta?.trend === "up" ? "text-emerald-600 dark:text-emerald-400" : item.delta?.trend === "down" ? "text-red-500 dark:text-red-400" : "text-muted-foreground";
  return (
    <div className={cn("rounded-lg p-3 flex flex-col gap-1", color.bg)}>
      <div className="text-xs text-muted-foreground font-medium">{item.label}</div>
      <div className={cn("text-2xl font-bold tabular-nums", color.text)}>{item.value}</div>
      {item.delta && (
        <div className={cn("flex items-center gap-0.5 text-xs font-medium", trendColor)}>
          <TrendIcon size={11} />
          {item.delta.value}
        </div>
      )}
    </div>
  );
}

function RenderStats({ block }: { block: StatsBlock }) {
  const cols = block.columns ?? (block.items.length <= 2 ? 2 : block.items.length <= 3 ? 3 : 4);
  const gridClass = {
    2: "grid-cols-2",
    3: "grid-cols-3",
    4: "grid-cols-2 sm:grid-cols-4",
  }[cols];
  return (
    <div className={cn("grid gap-2", gridClass)}>
      {block.items.map((item, i) => <RenderStat key={i} item={item} />)}
    </div>
  );
}

// ─── Cards block ──────────────────────────────────────────────────────────────

const BADGE_TAG_COLORS: Record<string, string> = {
  blue:   "bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300",
  green:  "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  red:    "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300",
  amber:  "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  violet: "bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300",
  default:"bg-muted text-muted-foreground",
};

function RenderCard({ item }: { item: CardItem }) {
  const badgeCls = BADGE_TAG_COLORS[item.badgeColor ?? "default"];
  return (
    <div className="rounded-lg border border-border p-3 flex flex-col gap-1.5 hover:bg-muted/20 transition-colors">
      <div className="flex items-start justify-between gap-2">
        <div className="font-medium text-sm text-foreground leading-snug">{item.title}</div>
        {item.badge && (
          <span className={cn("shrink-0 text-xs px-1.5 py-0.5 rounded font-medium", badgeCls)}>{item.badge}</span>
        )}
      </div>
      {item.description && <p className="text-xs text-muted-foreground leading-relaxed">{item.description}</p>}
      {item.tags && item.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-0.5">
          {item.tags.map((tag, i) => (
            <span key={i} className="text-xs px-1.5 py-0.5 bg-muted rounded text-muted-foreground">{tag}</span>
          ))}
        </div>
      )}
      {item.meta && <div className="text-xs text-muted-foreground/70 mt-auto pt-0.5">{item.meta}</div>}
    </div>
  );
}

function RenderCards({ block }: { block: CardsBlock }) {
  const cols = block.columns ?? (block.items.length <= 2 ? 2 : 3);
  const gridClass = { 2: "grid-cols-2", 3: "grid-cols-3", 4: "grid-cols-2 sm:grid-cols-4" }[cols];
  return (
    <div className={cn("grid gap-2", gridClass)}>
      {block.items.map((item, i) => <RenderCard key={i} item={item} />)}
    </div>
  );
}

// ─── Alert block ──────────────────────────────────────────────────────────────

const ALERT_STYLES = {
  info:    { bg: "bg-blue-50 dark:bg-blue-500/10",         border: "border-blue-200 dark:border-blue-500/30",       icon: Info,          iconCls: "text-blue-500 dark:text-blue-400",       title: "text-blue-800 dark:text-blue-200",    body: "text-blue-700 dark:text-blue-300"    },
  success: { bg: "bg-emerald-50 dark:bg-emerald-500/10",   border: "border-emerald-200 dark:border-emerald-500/30", icon: CheckCircle2,  iconCls: "text-emerald-500 dark:text-emerald-400", title: "text-emerald-800 dark:text-emerald-200", body: "text-emerald-700 dark:text-emerald-300" },
  warning: { bg: "bg-amber-50 dark:bg-amber-500/10",       border: "border-amber-200 dark:border-amber-500/30",     icon: AlertTriangle, iconCls: "text-amber-500 dark:text-amber-400",     title: "text-amber-800 dark:text-amber-200",  body: "text-amber-700 dark:text-amber-300"  },
  error:   { bg: "bg-red-50 dark:bg-red-500/10",           border: "border-red-200 dark:border-red-500/30",         icon: XCircle,       iconCls: "text-red-500 dark:text-red-400",         title: "text-red-800 dark:text-red-200",      body: "text-red-700 dark:text-red-300"      },
};

function RenderAlert({ block }: { block: AlertBlock }) {
  const s = ALERT_STYLES[block.severity];
  const Icon = s.icon;
  return (
    <div className={cn("rounded-lg border px-3 py-2.5 flex gap-2.5", s.bg, s.border)}>
      <Icon size={15} className={cn("shrink-0 mt-0.5", s.iconCls)} />
      <div>
        {block.title && <div className={cn("text-sm font-semibold mb-0.5", s.title)}>{block.title}</div>}
        <div className={cn("text-sm", s.body)}>{block.message}</div>
      </div>
    </div>
  );
}

// ─── Comparison block ─────────────────────────────────────────────────────────

function RenderComparison({ block }: { block: ComparisonBlock }) {
  return (
    <div className="rounded-lg border border-border overflow-hidden">
      {block.caption && (
        <div className="px-3 py-1.5 bg-muted/40 border-b border-border text-xs text-muted-foreground font-medium">
          {block.caption}
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted/30">
              <th className="px-3 py-2 text-xs font-semibold text-muted-foreground text-left border-b border-border w-1/3">
                对比项
              </th>
              {block.headers.map((h, i) => (
                <th key={i} className="px-3 py-2 text-xs font-semibold text-center border-b border-border">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, i) => (
              <tr key={i} className="border-b border-border/50 last:border-0 hover:bg-muted/20 transition-colors">
                <td className="px-3 py-2 font-medium text-foreground text-sm">{row.label}</td>
                {row.values.map((val, j) => {
                  if (typeof val === "boolean") {
                    return (
                      <td key={j} className="px-3 py-2 text-center">
                        {val
                          ? <CheckCircle2 size={14} className="text-emerald-500 mx-auto" />
                          : <XCircle size={14} className="text-red-400 mx-auto" />}
                      </td>
                    );
                  }
                  return <td key={j} className="px-3 py-2 text-center text-muted-foreground">{String(val)}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Timeline block ───────────────────────────────────────────────────────────

const TIMELINE_DOT: Record<string, string> = {
  done:    "bg-emerald-500 ring-2 ring-emerald-200 dark:ring-emerald-500/30",
  active:  "bg-blue-500 ring-2 ring-blue-200 dark:ring-blue-500/30 animate-pulse",
  pending: "bg-muted-foreground/30 ring-2 ring-muted/40",
};

function RenderTimeline({ block }: { block: TimelineBlock }) {
  return (
    <div className="flex flex-col gap-0">
      {block.events.map((ev, i) => {
        const dotCls = TIMELINE_DOT[ev.status ?? "pending"];
        const isLast = i === block.events.length - 1;
        return (
          <div key={i} className="flex gap-3">
            <div className="flex flex-col items-center">
              <div className={cn("w-2.5 h-2.5 rounded-full mt-1 shrink-0", dotCls)} />
              {!isLast && <div className="w-px flex-1 bg-border/60 my-1" />}
            </div>
            <div className={cn("pb-3 flex-1", isLast ? "pb-0" : "")}>
              <div className="flex items-baseline gap-2">
                <span className="text-sm font-medium text-foreground">{ev.title}</span>
                <span className="text-xs text-muted-foreground">{ev.time}</span>
              </div>
              {ev.description && <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{ev.description}</p>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── List block ───────────────────────────────────────────────────────────────

function RenderList({ block }: { block: ListBlock }) {
  return (
    <ul className="flex flex-col gap-1">
      {block.items.map((item, i) => (
        <li key={i} className="flex gap-2 text-sm">
          <span className="shrink-0 mt-0.5">
            {block.style === "check"
              ? item.done
                ? <CheckCircle2 size={14} className="text-emerald-500 mt-0.5" />
                : <Circle size={14} className="text-muted-foreground/40 mt-0.5" />
              : block.style === "numbered"
              ? <span className="text-muted-foreground font-mono text-xs w-4 text-right mt-0.5">{i + 1}.</span>
              : <span className="text-muted-foreground mt-1.5 block w-1 h-1 rounded-full bg-current" />}
          </span>
          <div>
            <span className={cn("leading-relaxed", item.done && block.style === "check" ? "line-through text-muted-foreground" : "text-foreground")}>
              {item.content}
            </span>
            {item.sub && item.sub.length > 0 && (
              <ul className="mt-1 flex flex-col gap-0.5 pl-3">
                {item.sub.map((s, j) => (
                  <li key={j} className="text-xs text-muted-foreground flex gap-1.5">
                    <span className="mt-1.5 block w-1 h-1 rounded-full bg-muted-foreground/40 shrink-0" />
                    {s}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

// ─── Separator block ──────────────────────────────────────────────────────────

function RenderSeparator({ block }: { block: SeparatorBlock }) {
  if (block.label) {
    return (
      <div className="flex items-center gap-2">
        <div className="flex-1 h-px bg-border" />
        <span className="text-xs text-muted-foreground uppercase tracking-widest font-medium px-1">{block.label}</span>
        <div className="flex-1 h-px bg-border" />
      </div>
    );
  }
  return <div className="h-px bg-border/60" />;
}

// ─── Chart block ──────────────────────────────────────────────────────────────

// 图表配色不写死色值，改走 tailwind 的 fill-*/stroke-* 工具类：
// 这些类由 CSS 提供，能吃到 .dark 下对 --chart-1..6 的覆盖，暗色自动提亮。
// 注意：SVG 的 fill/stroke attribute 不认 var()，写成 "var(--chart-1)" 会整块变黑。
// paint 给 Area（描边 + 半透明填充一起），stroke/fill 给 Line / Bar / Pie 单独用。
const CHART_SERIES = [
  { stroke: "stroke-chart-1", fill: "fill-chart-1", paint: "stroke-chart-1 fill-chart-1" },
  { stroke: "stroke-chart-2", fill: "fill-chart-2", paint: "stroke-chart-2 fill-chart-2" },
  { stroke: "stroke-chart-3", fill: "fill-chart-3", paint: "stroke-chart-3 fill-chart-3" },
  { stroke: "stroke-chart-4", fill: "fill-chart-4", paint: "stroke-chart-4 fill-chart-4" },
  { stroke: "stroke-chart-5", fill: "fill-chart-5", paint: "stroke-chart-5 fill-chart-5" },
  { stroke: "stroke-chart-6", fill: "fill-chart-6", paint: "stroke-chart-6 fill-chart-6" },
];
// 轴标签：fill 用 currentColor（合法 attribute）+ text-muted-foreground 提供实际颜色，
// 这样浅色/暗色下都跟着次要前景色走
const AXIS_STYLE = { fontSize: 11, fill: "currentColor", className: "text-muted-foreground" };
// 图例文字默认继承文本色，这里显式指到次要前景色，两种主题各自跟随
const LEGEND_STYLE = { fontSize: 12, color: "var(--muted-foreground)" };
// recharts 只吃内联样式：网格线与 tooltip 必须用「两种主题都能看」的取值，
// 否则暗色下会出现亮白网格线 + 白底 tooltip。
const GRID_STROKE = "rgba(148, 163, 184, 0.35)";
const TOOLTIP_STYLE = {
  fontSize: 12,
  borderRadius: 8,
  background: "var(--popover)",
  border: "1px solid var(--border)",
  color: "var(--popover-foreground)",
};

function RenderChart({ block }: { block: ChartBlock }) {
  const h = block.height ?? 220;
  const isPie = block.chartType === "pie" || block.chartType === "donut";

  return (
    <div className="rounded-lg border border-border p-3 space-y-2">
      {block.title && <div className="text-sm font-medium text-foreground">{block.title}</div>}
      <ResponsiveContainer width="100%" height={h}>
        {isPie ? (
          <PieChart>
            <Pie
              data={block.data.map(d => ({
                name: String(d[block.xKey]),
                value: Number(d[block.series[0]?.key ?? "value"]),
              }))}
              dataKey="value"
              nameKey="name"
              innerRadius={block.chartType === "donut" ? "50%" : 0}
              outerRadius="72%"
              paddingAngle={2}
            >
              {block.data.map((_, i) => (
                <Cell key={i} stroke="none" className={CHART_SERIES[i % CHART_SERIES.length].fill} />
              ))}
            </Pie>
            <RechartsTooltip
              formatter={(v: number) => [`${v}`, block.series[0]?.label ?? ""]}
              contentStyle={TOOLTIP_STYLE}
            />
            <Legend iconSize={10} wrapperStyle={LEGEND_STYLE} />
          </PieChart>
        ) : block.chartType === "area" ? (
          <AreaChart data={block.data} margin={{ top: 4, right: 4, left: -16, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
            <XAxis dataKey={block.xKey} tick={AXIS_STYLE} />
            <YAxis tick={AXIS_STYLE} />
            <RechartsTooltip contentStyle={TOOLTIP_STYLE} />
            {block.series.length > 1 && <Legend iconSize={10} wrapperStyle={LEGEND_STYLE} />}
            {block.series.map((s, i) => (
              <Area key={s.key} type="monotone" dataKey={s.key} name={s.label}
                stroke={s.color}
                fillOpacity={0.12} strokeWidth={2} dot={false}
                className={s.color ? undefined : CHART_SERIES[i % CHART_SERIES.length].paint} />
            ))}
          </AreaChart>
        ) : block.chartType === "line" ? (
          <LineChart data={block.data} margin={{ top: 4, right: 4, left: -16, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
            <XAxis dataKey={block.xKey} tick={AXIS_STYLE} />
            <YAxis tick={AXIS_STYLE} />
            <RechartsTooltip contentStyle={TOOLTIP_STYLE} />
            {block.series.length > 1 && <Legend iconSize={10} wrapperStyle={LEGEND_STYLE} />}
            {block.series.map((s, i) => (
              <Line key={s.key} type="monotone" dataKey={s.key} name={s.label}
                stroke={s.color} strokeWidth={2} dot={false}
                className={s.color ? undefined : CHART_SERIES[i % CHART_SERIES.length].stroke} />
            ))}
          </LineChart>
        ) : (
          <BarChart data={block.data} margin={{ top: 4, right: 4, left: -16, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
            <XAxis dataKey={block.xKey} tick={AXIS_STYLE} />
            <YAxis tick={AXIS_STYLE} />
            <RechartsTooltip contentStyle={TOOLTIP_STYLE} />
            {block.series.length > 1 && <Legend iconSize={10} wrapperStyle={LEGEND_STYLE} />}
            {block.series.map((s, i) => (
              <Bar key={s.key} dataKey={s.key} name={s.label}
                fill={s.color} className={s.color ? undefined : CHART_SERIES[i % CHART_SERIES.length].fill}
                radius={[3, 3, 0, 0]} />
            ))}
          </BarChart>
        )}
      </ResponsiveContainer>
      {block.caption && <p className="text-xs text-muted-foreground">{block.caption}</p>}
    </div>
  );
}

// ─── Progress block ───────────────────────────────────────────────────────────

const PROGRESS_COLORS: Record<string, { bar: string; text: string }> = {
  green:   { bar: "bg-emerald-500", text: "text-emerald-700 dark:text-emerald-300" },
  blue:    { bar: "bg-blue-500",    text: "text-blue-700 dark:text-blue-300"       },
  amber:   { bar: "bg-amber-500",   text: "text-amber-700 dark:text-amber-300"     },
  red:     { bar: "bg-red-500",     text: "text-red-600 dark:text-red-400"         },
  violet:  { bar: "bg-violet-500",  text: "text-violet-700 dark:text-violet-300"   },
  default: { bar: "bg-primary",     text: "text-primary"                            },
};

function RenderProgress({ block }: { block: ProgressBlock }) {
  return (
    <div className="space-y-3">
      {block.items.map((item, i) => {
        const c = PROGRESS_COLORS[item.color ?? "default"];
        return (
          <div key={i} className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-sm text-foreground">{item.label}</span>
              <span className={cn("text-xs font-mono font-semibold tabular-nums", c.text)}>
                {item.value}%
              </span>
            </div>
            <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
              <div
                className={cn("h-full rounded-full", c.bar)}
                style={{ width: `${Math.min(100, Math.max(0, item.value))}%` }}
              />
            </div>
            {item.sublabel && (
              <p className="text-xs text-muted-foreground">{item.sublabel}</p>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Kanban block ─────────────────────────────────────────────────────────────

const KANBAN_PRIORITY: Record<string, { label: string; cls: string }> = {
  high:   { label: "紧急", cls: "text-red-600 bg-red-50 border-red-200 dark:text-red-300 dark:bg-red-500/15 dark:border-red-500/30" },
  medium: { label: "中",   cls: "text-amber-600 bg-amber-50 border-amber-200 dark:text-amber-300 dark:bg-amber-500/15 dark:border-amber-500/30" },
  low:    { label: "低",   cls: "text-blue-500 bg-blue-50 border-blue-200 dark:text-blue-300 dark:bg-blue-500/15 dark:border-blue-500/30" },
};

const KANBAN_COL: Record<string, { header: string; dot: string }> = {
  default: { header: "text-muted-foreground", dot: "bg-muted-foreground/40" },
  blue:    { header: "text-blue-600 dark:text-blue-400",       dot: "bg-blue-400" },
  amber:   { header: "text-amber-600 dark:text-amber-400",     dot: "bg-amber-400" },
  green:   { header: "text-emerald-600 dark:text-emerald-400", dot: "bg-emerald-400" },
  red:     { header: "text-red-600 dark:text-red-400",         dot: "bg-red-400" },
  violet:  { header: "text-violet-600 dark:text-violet-400",   dot: "bg-violet-400" },
};

function RenderKanban({ block }: { block: KanbanBlock }) {
  const n = Math.min(block.columns.length, 4);
  const grid = n === 2 ? "grid-cols-2" : n === 3 ? "grid-cols-3" : "grid-cols-4";
  return (
    <div className={cn("grid gap-3", grid)}>
      {block.columns.map(col => {
        const cs = KANBAN_COL[col.color ?? "default"];
        return (
          <div key={col.id} className="flex flex-col gap-2">
            <div className="flex items-center gap-2 px-1">
              <span className={cn("w-2 h-2 rounded-full shrink-0", cs.dot)} />
              <span className={cn("text-xs font-semibold uppercase tracking-wide", cs.header)}>
                {col.title}
              </span>
              <span className="ml-auto text-xs text-muted-foreground bg-muted rounded-full px-1.5 py-0.5 leading-none">
                {col.cards.length}
              </span>
            </div>
            <div className="flex flex-col gap-1.5 min-h-[60px]">
              {col.cards.map(card => {
                const p = card.priority ? KANBAN_PRIORITY[card.priority] : null;
                return (
                  <div key={card.id} className="rounded-lg border border-border bg-card p-2.5 shadow-sm space-y-1.5 hover:shadow-md transition-shadow">
                    {p && (
                      <span className={cn("inline-flex text-[10px] font-medium px-1.5 py-0.5 rounded border", p.cls)}>
                        {p.label}
                      </span>
                    )}
                    <p className="text-xs font-medium text-foreground leading-snug">{card.title}</p>
                    {/* min-h-[2lh]：描述默认至少占两行高度（lh 跟随自身 line-height，
                        字号/行高变化时自动适配）。同列卡片描述长短不一时高度才齐，
                        只有一行描述的卡片不会比别人矮一截 */}
                    {card.description && (
                      <p className="text-[11px] text-muted-foreground leading-relaxed min-h-[2lh]">{card.description}</p>
                    )}
                    {card.tags && card.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {card.tags.map((tag, ti) => (
                          <span key={ti} className="text-[10px] bg-muted text-muted-foreground rounded px-1.5 py-0.5">{tag}</span>
                        ))}
                      </div>
                    )}
                    {card.assignee && (
                      <div className="flex items-center gap-1 pt-0.5 border-t border-border/50">
                        <div className="w-4 h-4 rounded-full bg-primary/15 flex items-center justify-center shrink-0">
                          <span className="text-[8px] text-primary font-bold">{card.assignee[0]}</span>
                        </div>
                        <span className="text-[10px] text-muted-foreground">{card.assignee}</span>
                      </div>
                    )}
                  </div>
                );
              })}
              {col.cards.length === 0 && (
                <div className="rounded-lg border border-dashed border-border h-14 flex items-center justify-center">
                  <span className="text-xs text-muted-foreground/40">空</span>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Map block (China tile cartogram) ────────────────────────────────────────

const CHINA_TILES: { name: string; col: number; row: number }[] = [
  { name: "内蒙古", col: 4, row: 1 }, { name: "黑龙江", col: 7, row: 1 },
  { name: "新疆",   col: 1, row: 2 }, { name: "甘肃",   col: 3, row: 2 },
  { name: "宁夏",   col: 4, row: 2 }, { name: "吉林",   col: 7, row: 2 },
  { name: "青海",   col: 2, row: 3 }, { name: "山西",   col: 4, row: 3 },
  { name: "北京",   col: 5, row: 3 }, { name: "天津",   col: 6, row: 3 },
  { name: "辽宁",   col: 7, row: 3 },
  { name: "西藏",   col: 1, row: 4 }, { name: "陕西",   col: 3, row: 4 },
  { name: "河南",   col: 4, row: 4 }, { name: "河北",   col: 5, row: 4 },
  { name: "山东",   col: 6, row: 4 },
  { name: "四川",   col: 2, row: 5 }, { name: "重庆",   col: 3, row: 5 },
  { name: "湖北",   col: 4, row: 5 }, { name: "安徽",   col: 5, row: 5 },
  { name: "江苏",   col: 6, row: 5 },
  { name: "云南",   col: 2, row: 6 }, { name: "贵州",   col: 3, row: 6 },
  { name: "湖南",   col: 4, row: 6 }, { name: "江西",   col: 5, row: 6 },
  { name: "浙江",   col: 6, row: 6 }, { name: "上海",   col: 7, row: 6 },
  { name: "广西",   col: 3, row: 7 }, { name: "广东",   col: 4, row: 7 },
  { name: "福建",   col: 5, row: 7 },
  { name: "海南",   col: 3, row: 8 }, { name: "台湾",   col: 5, row: 8 },
];

// 地图热力色阶：浅色模式用「越深越实」的实色，暗色模式换成同色相、不同透明度的叠层
// （暗底上实色块会显得刺眼，半透明叠层更贴合卡片底色）
const MAP_LEVELS: Record<string, string[]> = {
  blue: [
    "bg-blue-50 dark:bg-blue-500/10",
    "bg-blue-100 dark:bg-blue-500/20",
    "bg-blue-200 dark:bg-blue-500/30",
    "bg-blue-300 dark:bg-blue-500/45",
    "bg-blue-500 dark:bg-blue-500/65",
    "bg-blue-700 dark:bg-blue-500/85",
  ],
  green: [
    "bg-emerald-50 dark:bg-emerald-500/10",
    "bg-emerald-100 dark:bg-emerald-500/20",
    "bg-emerald-200 dark:bg-emerald-500/30",
    "bg-emerald-300 dark:bg-emerald-500/45",
    "bg-emerald-500 dark:bg-emerald-500/65",
    "bg-emerald-700 dark:bg-emerald-500/85",
  ],
  amber: [
    "bg-amber-50 dark:bg-amber-500/10",
    "bg-amber-100 dark:bg-amber-500/20",
    "bg-amber-200 dark:bg-amber-500/30",
    "bg-amber-300 dark:bg-amber-500/45",
    "bg-amber-500 dark:bg-amber-500/65",
    "bg-amber-700 dark:bg-amber-500/85",
  ],
  violet: [
    "bg-violet-50 dark:bg-violet-500/10",
    "bg-violet-100 dark:bg-violet-500/20",
    "bg-violet-200 dark:bg-violet-500/30",
    "bg-violet-300 dark:bg-violet-500/45",
    "bg-violet-500 dark:bg-violet-500/65",
    "bg-violet-700 dark:bg-violet-500/85",
  ],
};

function RenderMap({ block }: { block: MapBlock }) {
  const scheme = block.colorScheme ?? "blue";
  const levels = MAP_LEVELS[scheme];
  const dataMap = new Map(block.data.map(d => [d.name, d.value]));
  const maxVal = Math.max(...block.data.map(d => d.value), 1);

  function tileCls(name: string) {
    const v = dataMap.get(name);
    if (v === undefined || v === 0) return "bg-muted/40";
    const r = v / maxVal;
    if (r < 0.15) return levels[1];
    if (r < 0.30) return levels[2];
    if (r < 0.50) return levels[3];
    if (r < 0.75) return levels[4];
    return levels[5];
  }

  function tileTextCls(name: string) {
    const v = dataMap.get(name);
    if (!v) return "text-muted-foreground/40";
    return v / maxVal >= 0.5 ? "text-white" : "text-foreground/75";
  }

  return (
    <div className="rounded-lg border border-border p-3 space-y-2.5">
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(7, 1fr)",
        gridTemplateRows: "repeat(8, 1fr)",
        gap: "3px",
        height: "260px",
      }}>
        {CHINA_TILES.map(tile => {
          const v = dataMap.get(tile.name);
          const displayName = tile.name.length > 2 ? tile.name.slice(0, 2) : tile.name;
          return (
            <div
              key={tile.name}
              className={cn("rounded flex flex-col items-center justify-center cursor-default select-none", tileCls(tile.name))}
              style={{ gridColumn: tile.col, gridRow: tile.row }}
              title={v !== undefined ? `${tile.name}: ${v.toLocaleString()}${block.unit ? " " + block.unit : ""}` : tile.name}
            >
              <span className={cn("text-[8px] font-medium leading-none", tileTextCls(tile.name))}>
                {displayName}
              </span>
              {v !== undefined && (
                <span className={cn("text-[7px] leading-none mt-0.5 opacity-80", tileTextCls(tile.name))}>
                  {v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v}
                </span>
              )}
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">低</span>
        <div className="flex gap-0.5">
          {levels.slice(1).map((cls, i) => (
            <div key={i} className={cn("w-5 h-2.5 rounded-sm", cls)} />
          ))}
        </div>
        <span className="text-xs text-muted-foreground">高</span>
        {block.unit && (
          <span className="ml-2 text-xs text-muted-foreground">单位：{block.unit}</span>
        )}
      </div>
    </div>
  );
}

// ─── Block dispatcher ─────────────────────────────────────────────────────────

function RenderBlock({ block }: { block: AGUIBlock }) {
  switch (block.type) {
    case "text":       return <RenderText block={block} />;
    case "heading":    return <RenderHeading block={block} />;
    case "code":       return <RenderCode block={block} />;
    case "table":      return <RenderTable block={block} />;
    case "stats":      return <RenderStats block={block} />;
    case "cards":      return <RenderCards block={block} />;
    case "alert":      return <RenderAlert block={block} />;
    case "comparison": return <RenderComparison block={block} />;
    case "timeline":   return <RenderTimeline block={block} />;
    case "list":       return <RenderList block={block} />;
    case "separator":  return <RenderSeparator block={block} />;
    case "chart":      return <RenderChart block={block} />;
    case "progress":   return <RenderProgress block={block} />;
    case "kanban":     return <RenderKanban block={block} />;
    case "map":        return <RenderMap block={block} />;
    default:           return null;
  }
}

// ─── Main renderer ────────────────────────────────────────────────────────────

type AGUIRendererProps = {
  layout: AGUILayout;
  /** 底部「查看 Layout JSON」调试入口；聊天里改由操作区图标承载，默认关闭 */
  showDebug?: boolean;
  className?: string;
};

export function AGUIRenderer({ layout, showDebug = false, className }: AGUIRendererProps) {
  const [expanded, setExpanded] = useState(false);
  return (
    /* 卡片是「后到」的（多轮工具调用里可能连续出现），加一段很轻的淡入上移，
       避免整块突然插入造成的跳变；prefers-reduced-motion 下自动不播。 */
    <div className={cn("flex flex-col gap-0 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 motion-safe:duration-300", className)}>

      <div className="flex flex-col gap-3">
        {layout.blocks.map((block, i) => (
          <RenderBlock key={i} block={block} />
        ))}
      </div>

      {showDebug && (
        <div className="mt-3">
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1 text-[10px] text-muted-foreground/50 hover:text-muted-foreground transition-colors"
          >
            {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
            查看 Layout JSON
          </button>
          {expanded && (
            <pre className="mt-1.5 text-[10px] font-mono text-muted-foreground bg-muted/30 rounded p-2 overflow-x-auto border border-border/50">
              {JSON.stringify(layout, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
