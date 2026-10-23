import { memo, useEffect, useId, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { FlowBlock, FlowEdge, FlowGroup, FlowGroupColor, FlowNode, FlowNodeKind } from "./types";

// ── flow 块渲染（自绘 SVG）────────────────────────────────────────────────────
// 为什么不用 React Flow：这里要在消息流里嵌一张**只读**小图，多个 flow 块会同时存在，
// 每个都挂一个 React Flow 实例（自带缩放/拖拽/ResizeObserver）成本过高，样式也要与
// 卡片体系对齐。自绘 SVG 能精确控制坐标与边路由，天然适配深浅主题。
//
// 布局思路参考 archify 的 workflow 图：先把节点按「层」切开（拓扑最长路径，return 回边
// 不参与分层），同层沿垂直方向排列，再按 direction 决定是横向推进还是纵向推进。

/**
 * 节点高度：容纳「标题 12.5px + 副标题 10px」两行，上下各留 ~20px 呼吸空间。
 * 之前 54px 时两行字几乎贴着圆角边框，读起来发闷。
 */
const NODE_H = 62;
/**
 * 节点宽度**不是固定值**。卡片宽度可拖拽，固定 168px 会造成两个问题：
 * - 宽卡片（700px+）里图只占一小条，右边大片空白，看着又小又挤；
 * - 文字按 168px 截断，"Agent Planner" 被砍成 "Agent Pla…"。
 * 所以按容器宽度反算每个节点可用宽度，夹在 [168, 300]：
 * 窄屏保底可读宽度，宽屏把节点撑开，标题/副标题尽量完整显示。
 */
const MIN_NODE_W = 168;
const MAX_NODE_W = 300;
/**
 * 层间距（顺着流程方向）。
 *
 * 不能 LR / TB 共用一个值：LR 里这段是**横向**空隙，72px 很宽敞；TB 里同一段是
 * **纵向**空隙，边 label 正好压在这段中间（label 高 15px + 上下各 10px 背景），
 * 72px 会让「框—标签—框」挤成一条，看起来就是用户说的「很挤」。
 * 所以 TB 单独给 88px，保证 label 上下各留 ~20px 呼吸空间。
 */
const GAP_MAIN_LR = 72;
const GAP_MAIN_TB = 88;
/** 边 label 的最大显示宽度（超出按显示宽度截断） */
const LABEL_MAX_W = 132;
/** 同层间距（垂直于流程方向） */
const GAP_CROSS = 40;
/** 画布内边距 */
const PAD = 18;
/** 折行后的行间距：要留出「换行连线」的通道，比同层间距大 */
const GAP_ROW = 64;
/** 动画步长（毫秒）：每推进一层，线与节点依次进场 */
const STAGGER = 180;

/** 节点语义色：与 AG-UI 卡片配色口径一致（低饱和，深色下同样可读） */
const KIND_STYLE: Record<FlowNodeKind, { dot: string; border: string; fill: string }> = {
  start: { dot: "#22c55e", border: "#86efac", fill: "rgba(34, 197, 94, 0.06)" },
  step: { dot: "#64748b", border: "#cbd5e1", fill: "rgba(148, 163, 184, 0.06)" },
  decision: { dot: "#f59e0b", border: "#fcd34d", fill: "rgba(245, 158, 11, 0.07)" },
  async: { dot: "#8b5cf6", border: "#c4b5fd", fill: "rgba(139, 92, 246, 0.07)" },
  end: { dot: "#6366f1", border: "#a5b4fc", fill: "rgba(99, 102, 241, 0.07)" },
};

/** 连线样式：main 实线、branch 虚线（分叉）、async 点线（异步）、return 虚线（回边） */
const EDGE_STYLE: Record<FlowEdge["kind"], { stroke: string; dash?: string }> = {
  main: { stroke: "#94a3b8" },
  branch: { stroke: "#94a3b8", dash: "5 4" },
  async: { stroke: "#a78bfa", dash: "2 4" },
  return: { stroke: "#cbd5e1", dash: "4 4" },
};

/** 分组框内边距、顶部标签高度 */
const GROUP_PAD = 10;
const GROUP_LABEL_H = 16;
/** 图例区高度（legend=true 时占用画布底部） */
const LEGEND_H = 26;

/** 分组配色：与卡片其它块共用同一套语义色 */
const GROUP_COLOR: Record<FlowGroupColor, string> = {
  default: "#94a3b8",
  blue: "#3b82f6",
  green: "#22c55e",
  amber: "#f59e0b",
  violet: "#8b5cf6",
  red: "#ef4444",
};

/** 图例文案（按节点 kind） */
const KIND_LABEL: Record<FlowNodeKind, string> = {
  start: "起点",
  step: "步骤",
  decision: "判断",
  async: "异步",
  end: "终点",
};

type Positioned = {
  node: FlowNode;
  x: number;
  y: number;
  /** 进场动画延迟（毫秒）：按层递增，比同层的线晚一点 */
  delay: number;
};

type Routed = {
  edge: FlowEdge;
  path: string;
  labelX: number;
  labelY: number;
  /** 进场动画延迟（毫秒）：按源节点所在层递增 */
  delay: number;
};

/**
 * 分层：拓扑最长路径（Kahn）。
 *
 * 关键：**回边不只是 `kind: "return"`**。模型经常用 `branch` 表达"打回上一步"
 * （例如 `n2 --FAIL 打回--> n1`），这条边会让图成环。如果直接把它塞进 Kahn，
 * 入度永远消不完，所有节点都会被判成"环内剩余"而拍平到同一层——
 * 实测整张 6 层竖排图会塌成「1 个节点在上、5 个并排在下」，箭头也全部反向。
 *
 * 所以这里改成增量加边：逐条尝试加入分层图，**若该边会让已有图成环（to 已能到达 from）
 * 就跳过它**——它照常参与绘制（当作回边绕行），只是不参与分层。
 * 这样主链始终是 DAG，层数正确，回边也还能画出来。
 */
function computeLayers(nodes: FlowNode[], edges: FlowEdge[]): Map<string, number> {
  const ids = nodes.map(node => node.id);
  const known = new Set(ids);
  // 显式标注 Map<string, string[]>：否则 `[id, []]` 会被推断成 never[]，push 报错
  const adjacency = new Map<string, string[]>(ids.map(id => [id, []]));
  const indegree = new Map(ids.map(id => [id, 0]));

  /** from 是否能沿已加入的边走到 to（用于判断新边会不会成环） */
  const reaches = (from: string, to: string): boolean => {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === to) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      for (const next of adjacency.get(current) ?? []) stack.push(next);
    }
    return false;
  };

  for (const edge of edges) {
    // return 是显式回边，本来就不参与分层
    if (edge.kind === "return") continue;
    if (!known.has(edge.from) || !known.has(edge.to)) continue;
    // 自环不参与分层（也画不出有意义的方向）
    if (edge.from === edge.to) continue;
    // 会让图成环的边：只画不参与分层
    if (reaches(edge.to, edge.from)) continue;
    adjacency.get(edge.from)!.push(edge.to);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }

  const layer = new Map(ids.map(id => [id, 0]));
  const queue = ids.filter(id => (indegree.get(id) ?? 0) === 0);
  let guard = 0;
  while (queue.length > 0 && guard < ids.length * 8 + 8) {
    guard += 1;
    const current = queue.shift()!;
    for (const next of adjacency.get(current) ?? []) {
      layer.set(next, Math.max(layer.get(next) ?? 0, (layer.get(current) ?? 0) + 1));
      const left = (indegree.get(next) ?? 1) - 1;
      indegree.set(next, left);
      if (left <= 0) queue.push(next);
    }
  }

  // 兜底：上面已排除所有环，理论上不会再有剩余；真出现就放到最后一层避免重叠
  const stuck = ids.filter(id => (indegree.get(id) ?? 0) > 0);
  if (stuck.length > 0) {
    const maxLayer = Math.max(0, ...ids.map(id => layer.get(id) ?? 0));
    for (const id of stuck) layer.set(id, maxLayer + 1);
  }
  return layer;
}

/**
 * 布局：算出每个节点的坐标、画布尺寸，以及每条边的折线路径。
 *
 * LR 方向做**蛇形折行**：卡片宽度有限，7 个节点的链式流程横排能到 1300px 以上，
 * 用户得横向拖半屏才看得完。折成多行后图始终落在容器宽度内——偶数行从左到右、
 * 奇数行从右到左，流程像 S 形往下走。TB 方向本身纵向生长，不折行。
 *
 * `maxCols`：每行最多放几个「层」，由容器宽度算出（见组件里的 ResizeObserver）。
 */
type GroupBox = {
  label: string;
  color: FlowGroupColor;
  x: number;
  y: number;
  w: number;
  h: number;
};

type LegendItem = { kind: FlowNodeKind; count: number };

/**
 * 归一化后的 flow：可选字段全部落实为具体值。
 * 布局与绘制函数只接收这个类型，内部就不必到处写 `?.` 兜底。
 */
type ResolvedFlowBlock = FlowBlock & {
  edges: FlowEdge[];
  groups: FlowGroup[];
  legend: boolean;
};

/**
 * 旧 flow 数据归一化（**向后兼容，不能删**）。
 *
 * 聊天历史存在浏览器 IndexedDB 里，协议升级后**不会重写历史消息**：
 * 早于 `groups` / `legend` 的会话里，flow block 只有 `nodes` / `edges` / `direction`，
 * 组件直接读 `block.groups.length` 会抛
 * `TypeError: Cannot read properties of undefined (reading 'length')`，
 * 整个消息渲染崩掉（不只是图消失）。
 *
 * 所以进组件先补齐所有可选字段。服务端 `_normalize_flow_block` 只保证**新**数据完整，
 * 对已经落盘的历史数据无能为力，这一层兜底必须留在前端。
 */
function normalizeFlowBlock(block: FlowBlock): ResolvedFlowBlock {
  const nodes = Array.isArray(block.nodes) ? block.nodes : [];
  const known = new Set(nodes.map(node => node.id));
  return {
    ...block,
    // direction 缺省按 LR（与服务端一致）
    direction: block.direction === "TB" ? "TB" : "LR",
    nodes,
    // edges 缺失时按节点顺序串主链，和服务端「edges 整段省略」的语义一致
    edges: Array.isArray(block.edges)
      ? block.edges.filter(edge => known.has(edge.from) && known.has(edge.to))
      : nodes.slice(1).map((node, index) => ({
          from: nodes[index].id,
          to: node.id,
          kind: "main" as const,
        })),
    // 旧数据没有分组：空数组即可，其余逻辑都按「无分组」处理
    groups: Array.isArray(block.groups) ? block.groups : [],
    // 旧数据没有图例开关：默认不画（老图本来就没有图例，保持原样最不突兀）
    legend: block.legend === true,
  };
}

/** 有分组时整体下移，给分组标签留出空间（否则标签会被画布顶边裁掉） */
function shiftForGroups(block: ResolvedFlowBlock, positioned: Positioned[]): void {
  if (!block.groups.length) return;
  for (const item of positioned) item.y += GROUP_LABEL_H;
}

/**
 * 按容器宽度反算单个节点的宽度。
 *
 * - `count`：这一行（LR 的一行 / TB 的一层）最多并排几个节点；
 * - `gap`：同排节点之间的间距；
 * - 结果夹在 [MIN_NODE_W, MAX_NODE_W]：太窄放不下字，太宽图会散开。
 *
 * 固定 168px 的老做法在 700px+ 的卡片里会让整张图缩成一条，
 * 文字还被按 168px 截断（"Agent Planner" → "Agent Pla…"），所以改成跟着容器走。
 */
function fitNodeWidth(available: number, count: number, gap: number): number {
  if (count <= 0 || available <= 0) return MIN_NODE_W;
  const raw = (available - PAD * 2 - (count - 1) * gap) / count;
  return Math.round(Math.min(MAX_NODE_W, Math.max(MIN_NODE_W, raw)));
}

/** 计算每个分组框的包围盒（包含其全部节点 + 内边距 + 顶部标签区） */
function computeGroupBoxes(block: ResolvedFlowBlock, positioned: Positioned[], nodeW: number): GroupBox[] {
  const byId = new Map(positioned.map(item => [item.node.id, item]));
  const boxes: GroupBox[] = [];
  for (const group of block.groups) {
    const members = group.nodes
      .map(id => byId.get(id))
      .filter((item): item is Positioned => Boolean(item));
    if (!members.length) continue;
    const minX = Math.min(...members.map(m => m.x));
    const minY = Math.min(...members.map(m => m.y));
    const maxX = Math.max(...members.map(m => m.x + nodeW));
    const maxY = Math.max(...members.map(m => m.y + NODE_H));
    const box: GroupBox = {
      label: group.label,
      color: group.color,
      x: minX - GROUP_PAD,
      y: minY - GROUP_PAD - GROUP_LABEL_H,
      w: maxX - minX + GROUP_PAD * 2,
      h: maxY - minY + GROUP_PAD * 2 + GROUP_LABEL_H,
    };
    // 折行后同组节点可能分散到多行，包围盒会把别组的节点一起框进去——那是错的。
    // 这种情况直接不画这个框：宁可少一个泳道，也不要画一个圈错人的框。
    const foreign = positioned.some(
      item =>
        !group.nodes.includes(item.node.id) &&
        box.x < item.x + nodeW &&
        box.x + box.w > item.x &&
        box.y < item.y + NODE_H &&
        box.y + box.h > item.y,
    );
    if (foreign) continue;
    boxes.push(box);
  }
  return boxes;
}

/** 按 kind 统计节点生成图例（顺序固定：起点 → 步骤 → 判断 → 异步 → 终点） */
function computeLegend(positioned: Positioned[]): LegendItem[] {
  const order: FlowNodeKind[] = ["start", "step", "decision", "async", "end"];
  const counts = new Map<FlowNodeKind, number>();
  for (const item of positioned) {
    counts.set(item.node.kind, (counts.get(item.node.kind) ?? 0) + 1);
  }
  return order.filter(kind => counts.has(kind)).map(kind => ({ kind, count: counts.get(kind)! }));
}

function layoutFlow(block: ResolvedFlowBlock, maxCols: number, available: number): {
  nodes: Positioned[];
  edges: Routed[];
  groups: GroupBox[];
  legend: LegendItem[];
  /** 本次布局实际采用的节点宽度（随容器宽度变化，渲染时也要用它） */
  nodeWidth: number;
  width: number;
  height: number;
} {
  const layers = computeLayers(block.nodes, block.edges);
  const byLayer = new Map<number, FlowNode[]>();
  for (const node of block.nodes) {
    const index = layers.get(node.id) ?? 0;
    const bucket = byLayer.get(index);
    if (bucket) bucket.push(node);
    else byLayer.set(index, [node]);
  }
  const layerKeys = [...byLayer.keys()].sort((a, b) => a - b);
  const horizontal = block.direction !== "TB";
  // 没有节点时直接返回空画布：否则下面的 Math.max(...[]) 得到 -Infinity，
  // 一路算出 NaN 坐标，React 会画出 viewBox="0 0 NaN NaN" 的坏 SVG。
  if (layerKeys.length === 0) {
    return {
      nodes: [],
      edges: [],
      groups: [],
      legend: [],
      nodeWidth: MIN_NODE_W,
      width: 240,
      height: 120,
    };
  }
  // ── TB：层沿 y 推进，同层沿 x 并排（纵向生长，不折行）
  if (!horizontal) {
    const maxCross = Math.max(...layerKeys.map(key => byLayer.get(key)!.length));
    // 节点宽度按「同层最多几个节点」反算：同层只有 1 个时也不会无限拉宽（有上限）
    const nodeW = fitNodeWidth(available, maxCross, GAP_CROSS);
    const mainStep = NODE_H + GAP_MAIN_TB;
    const crossStep = nodeW + GAP_CROSS;
    /**
     * 回边通道的 x 位置：必须离左边足够远，否则居中放在通道上的 label 会被画布裁掉。
     * 取「最长回边 label 的一半宽 + 8px 边距」，最少 26px；节点整体右移这么多。
     */
    const backLabelW = Math.max(
      0,
      ...block.edges
        .filter(edge => edge.label && (layers.get(edge.to) ?? 0) < (layers.get(edge.from) ?? 0))
        .map(edge => labelWidth(edge.label!)),
    );
    const backChannelX = Math.max(26, backLabelW / 2 + 8);
    const extraLeft = backChannelX + 10;
    const positioned: Positioned[] = [];
    layerKeys.forEach((key, order) => {
      const bucket = byLayer.get(key)!;
      const offset = ((maxCross - bucket.length) * crossStep) / 2;
      bucket.forEach((node, index) => {
        positioned.push({
          node,
          // 整体右移，给回边通道留出空间
          x: PAD + extraLeft + offset + index * crossStep,
          y: PAD + order * mainStep,
          delay: order * STAGGER + 120,
        });
      });
    });
    shiftForGroups(block, positioned);
    const byId = new Map(positioned.map(item => [item.node.id, item]));
    const routed: Routed[] = [];
    for (const edge of block.edges) {
      const source = byId.get(edge.from);
      const target = byId.get(edge.to);
      if (!source || !target) continue;
      const sourceOrder = layerKeys.indexOf(layers.get(edge.from) ?? 0);
      const targetOrder = layerKeys.indexOf(layers.get(edge.to) ?? 0);
      const delay = sourceOrder * STAGGER;
      const sx = source.x + nodeW / 2;
      const tx = target.x + nodeW / 2;
      if (targetOrder > sourceOrder) {
        const sy = source.y + NODE_H;
        const ty = target.y;
        const midY = (sy + ty) / 2;
        routed.push({ edge, delay, path: `M ${sx} ${sy} V ${midY} H ${tx} V ${ty}`, labelX: (sx + tx) / 2, labelY: midY - 4 });
      } else if (targetOrder < sourceOrder) {
        // 回边：从节点左侧绕回去。
        //
        // 通道位置不能贴着画布边缘：label 是**居中**放在通道上的，若通道在 x=9，
        // 一个宽 58px 的 "FAIL 打回" 左边界会算到 -18，直接被画布裁掉（只剩 "AIL 打回"）。
        // 所以通道至少留出「半个 label 宽 + 边距」，节点整体右移的量由 layout 的 extraLeft 承担。
        const sy = source.y + NODE_H / 2;
        const ty = target.y + NODE_H / 2;
        const channelX = backChannelX;
        routed.push({
          edge,
          delay,
          path: `M ${source.x} ${sy} H ${channelX} V ${ty} H ${target.x}`,
          labelX: channelX,
          labelY: (sy + ty) / 2,
        });
      } else {
        // 同层：两个节点是**左右并排**的，不能画成竖直边。
        // 旧写法 `M sx (source.y+NODE_H) V target.y` 会从源底部向上穿到目标顶部，
        // 方向反了，而且 n1→n2 与 n2→n1 会得到完全相同的路径（叠成一条）。
        // 这里按左右关系从侧边出、侧边进。
        const rightward = target.x > source.x;
        const ex = rightward ? source.x + nodeW : source.x;
        const enterX = rightward ? target.x : target.x + nodeW;
        const ey = source.y + NODE_H / 2;
        const ty = target.y + NODE_H / 2;
        const midX = (ex + enterX) / 2;
        routed.push({
          edge,
          delay,
          path: `M ${ex} ${ey} H ${midX} V ${ty} H ${enterX}`,
          labelX: midX,
          labelY: (ey + ty) / 2 - 6,
        });
      }
    }
    const columns = Math.max(...layerKeys.map(key => byLayer.get(key)!.length));
    // 宽度要把左侧回边通道（extraLeft）算进去，否则最右侧节点会被画布裁掉
    const width = PAD * 2 + extraLeft + columns * (nodeW + GAP_CROSS) - GAP_CROSS;
    const height = PAD * 2 + layerKeys.length * (NODE_H + GAP_MAIN_TB) - GAP_MAIN_TB;
    avoidLabelCollisions(positioned, routed, nodeW);
    const groupBoxes = computeGroupBoxes(block, positioned, nodeW);
    const legend = block.legend ? computeLegend(positioned) : [];
    const legendSpace = legend.length ? LEGEND_H : 0;
    return {
      nodes: positioned,
      edges: routed,
      groups: groupBoxes,
      legend,
      nodeWidth: nodeW,
      width: Math.max(width, 240),
      height: Math.max(height + legendSpace, 120),
    };
  }

  // ── LR：蛇形折行网格
  const cols = Math.max(2, maxCols);
  const rowOf = (order: number) => Math.floor(order / cols);
  const colOf = (order: number) => {
    const row = Math.floor(order / cols);
    const inRow = order % cols;
    // 奇数行反向：行末接下一行行首，流程走成 S 形
    return row % 2 === 0 ? inRow : cols - 1 - inRow;
  };

  // 每行的高度由该行最拥挤的那一层决定（同层多个节点是上下堆叠的）
  const rowHeights: number[] = [];
  layerKeys.forEach((key, order) => {
    const row = rowOf(order);
    const slotHeight = byLayer.get(key)!.length * (NODE_H + GAP_CROSS) - GAP_CROSS;
    rowHeights[row] = Math.max(rowHeights[row] ?? 0, slotHeight);
  });
  const rowY: number[] = [];
  let cursor = PAD;
  rowHeights.forEach((rowHeight, row) => {
    rowY[row] = cursor;
    cursor += rowHeight + GAP_ROW;
  });

  const usedCols = Math.min(cols, layerKeys.length);
  // LR 一行放 usedCols 个节点：宽度按容器反算，宽卡片里节点被撑开、文字完整
  const nodeW = fitNodeWidth(available, usedCols, GAP_MAIN_LR);
  const contentWidth = PAD * 2 + usedCols * nodeW + (usedCols - 1) * GAP_MAIN_LR;
  const contentHeight = cursor - GAP_ROW + PAD;

  const positioned: Positioned[] = [];
  layerKeys.forEach((key, order) => {
    const row = rowOf(order);
    const col = colOf(order);
    const bucket = byLayer.get(key)!;
    const slotHeight = bucket.length * (NODE_H + GAP_CROSS) - GAP_CROSS;
    const offset = (rowHeights[row] - slotHeight) / 2;
    bucket.forEach((node, index) => {
      positioned.push({
        node,
        x: PAD + col * (nodeW + GAP_MAIN_LR),
        y: rowY[row] + offset + index * (NODE_H + GAP_CROSS),
        delay: order * STAGGER + 120,
      });
    });
  });

  shiftForGroups(block, positioned);
  const byId = new Map(positioned.map(item => [item.node.id, item]));
  const gridOf = (layerKey: number) => {
    const order = layerKeys.indexOf(layerKey);
    return { row: rowOf(order), col: colOf(order), order };
  };

  const routed: Routed[] = [];
  for (const edge of block.edges) {
    const source = byId.get(edge.from);
    const target = byId.get(edge.to);
    if (!source || !target) continue;
    const sg = gridOf(layers.get(edge.from) ?? 0);
    const tg = gridOf(layers.get(edge.to) ?? 0);
    const delay = sg.order * STAGGER;

    if (sg.order === tg.order) {
      // 同一层内的两个节点（上下堆叠）：直接垂直连
      const sx = source.x + nodeW / 2;
      const sy = source.y + NODE_H;
      const ty = target.y;
      routed.push({ edge, delay, path: `M ${sx} ${sy} V ${ty}`, labelX: sx, labelY: (sy + ty) / 2 });
    } else if (sg.row === tg.row) {
      // 同一行内相邻：按蛇形方向决定从哪一侧出、从哪一侧进
      const rightward = tg.col > sg.col;
      const sx = rightward ? source.x + nodeW : source.x;
      const tx = rightward ? target.x : target.x + nodeW;
      const sy = source.y + NODE_H / 2;
      const ty = target.y + NODE_H / 2;
      const midX = (sx + tx) / 2;
      routed.push({
        edge,
        delay,
        path: `M ${sx} ${sy} H ${midX} V ${ty} H ${tx}`,
        labelX: midX,
        labelY: (sy + ty) / 2 - 6,
      });
    } else if (tg.row > sg.row) {
      // 换到下一行：源底部 → 目标行上方的行间通道 → 目标顶部
      const channel = rowY[tg.row] - GAP_ROW / 2;
      const sx = source.x + nodeW / 2;
      const tx = target.x + nodeW / 2;
      routed.push({
        edge,
        delay,
        path: `M ${sx} ${source.y + NODE_H} V ${channel} H ${tx} V ${target.y}`,
        labelX: tx,
        labelY: channel - 6,
      });
    } else {
      // 回到上面的行（回边）
      const sx = source.x + nodeW / 2;
      const tx = target.x + nodeW / 2;
      if (sg.col === tg.col) {
        // 同列回边：竖直段若直上会穿过同列另一个节点，改走该列左侧的窄通道
        const laneX = Math.max(8, source.x - 10);
        const sy = source.y + NODE_H / 2;
        const ty = target.y + NODE_H / 2;
        routed.push({
          edge,
          delay,
          path: `M ${source.x} ${sy} H ${laneX} V ${ty} H ${target.x}`,
          labelX: laneX + 12,
          labelY: (sy + ty) / 2,
        });
      } else {
        // 不同列：源顶部 → 源行上方的行间通道 → 目标底部
        const channel = rowY[sg.row] - GAP_ROW / 2;
        routed.push({
          edge,
          delay,
          path: `M ${sx} ${source.y} V ${channel} H ${tx} V ${target.y + NODE_H}`,
          labelX: tx,
          labelY: channel + 12,
        });
      }
    }
  }

  avoidLabelCollisions(positioned, routed, nodeW);

  const groupBoxes = computeGroupBoxes(block, positioned, nodeW);
  const legend = block.legend ? computeLegend(positioned) : [];
  const legendSpace = legend.length ? LEGEND_H : 0;
  return {
    nodes: positioned,
    edges: routed,
    groups: groupBoxes,
    legend,
    nodeWidth: nodeW,
    width: Math.max(contentWidth, 240),
    height: Math.max(contentHeight + legendSpace, 120),
  };
}

/**
 * 边 label 背景块宽度：按「显示宽度 + 左右各 5px 内边距」算，上限 LABEL_MAX_W。
 *
 * 布局避让（avoidLabelCollisions）和实际绘制都调用它，避免两处各算一套导致
 * 检测说没重叠、画出来却贴边。
 */
function labelWidth(label: string): number {
  const textWidth = clipByWidth(label, LABEL_MAX_W - 10, 10);
  let width = 0;
  for (const char of textWidth) {
    width += char.charCodeAt(0) < 128 ? 10 * 0.55 : 10;
  }
  return Math.round(Math.min(width + 10, LABEL_MAX_W));
}

/**
 * 边 label 避让：label 默认压在边的中点上，短边（尤其是分支汇合处）会盖住节点边缘。
 * 这里做一次简单碰撞检测——与任何节点框相交就沿垂直方向往上挪 22px，最多 3 次。
 * 不做完整正交避障：卡片里元素少，让开一格就够读。
 */
function avoidLabelCollisions(positioned: Positioned[], routed: Routed[], nodeW: number): void {
  const boxes = positioned.map(item => ({ x: item.x, y: item.y }));
  const hits = (rect: { x: number; y: number; w: number; h: number }) =>
    boxes.some(
      box =>
        rect.x < box.x + nodeW &&
        rect.x + rect.w > box.x &&
        rect.y < box.y + NODE_H &&
        rect.y + rect.h > box.y,
    );

  for (const item of routed) {
    const label = item.edge.label;
    if (!label) continue;
    // 与渲染处共用 labelWidth()，保证布局避让和实际绘制用的是同一个宽度
    const width = labelWidth(label);
    const rect = { x: item.labelX - width / 2, y: item.labelY - 11, w: width, h: 15 };
    let guard = 0;
    while (hits(rect) && guard < 3) {
      rect.y -= 22;
      guard += 1;
    }
    item.labelY = rect.y + 11;
  }
}


/**
 * 按显示宽度截断：ASCII 按 0.55em、其余按 1em 估算。
 *
 * 只按字符数截会让英文单词吃亏——"Agent Planner" 13 个字符被砍成 "Agent Pla…"，
 * 而它实际只占节点一半宽度。这里按像素估算，中英文都能放满。
 *
 * 另外尽量在空格处断句：宁可少显示一个词（"Agent…"），也不要留半截单词
 * （"Agent Pla…" 这种读起来更费劲）。
 */
function clipByWidth(text: string, maxWidth: number, fontSize: number): string {
  const widthOf = (char: string) => (char.charCodeAt(0) < 128 ? fontSize * 0.55 : fontSize);
  let width = 0;
  for (let i = 0; i < text.length; i += 1) {
    const charWidth = widthOf(text[i]);
    if (width + charWidth > maxWidth) {
      // 截断点落在单词中间时，回退到最近的空格，避免 "Agent Pla…"
      const head = text.slice(0, i);
      const space = head.lastIndexOf(" ");
      const cut = space > 0 && head.length - space <= 12 ? space : Math.max(1, i - 1);
      return `${text.slice(0, cut).trimEnd()}…`;
    }
    width += charWidth;
  }
  return text;
}

function NodeLabel({ node, nodeW }: { node: FlowNode; nodeW: number }) {
  // 左右各留 14px 内边距（比之前的 12px 松一点，圆角处不顶边）
  const available = nodeW - 28;
  const label = clipByWidth(node.label, available, 12.5);
  const sublabel = node.sublabel ? clipByWidth(node.sublabel, available, 10) : "";
  return (
    <>
      <text x={nodeW / 2} y={node.sublabel ? NODE_H / 2 - 3 : NODE_H / 2 + 4} textAnchor="middle" className="fill-foreground" style={{ fontSize: 12.5, fontWeight: 600 }}>
        {label}
      </text>
      {node.sublabel ? (
        <text x={nodeW / 2} y={NODE_H / 2 + 13} textAnchor="middle" className="fill-muted-foreground" style={{ fontSize: 10 }}>
          {sublabel}
        </text>
      ) : null}
    </>
  );
}

/**
 * 流程图块。
 *
 * - 只读：不提供拖拽/缩放，宽度超出容器时横向滚动（窄屏也不会把字压扁）；
 * - 节点数上限由服务端夹紧（≤12），这里不再做二次校验；
 * - 深浅主题全部走 CSS 变量与固定语义色，不依赖 tailwind dark: 变体。
 */
export const FlowDiagram = memo(({ block: rawBlock }: { block: FlowBlock }) => {
  // 历史会话里的旧 flow 可能缺 groups / legend / edges：先补齐再布局。
  // 用 useMemo 缓存，避免每次渲染都新建对象导致下面 layoutFlow 的依赖失效。
  const block = useMemo(() => normalizeFlowBlock(rawBlock), [rawBlock]);
  // 折行需要知道容器实际宽度（聊天列宽可拖拽，卡片宽度会变）：用 ResizeObserver 跟随
  const wrapRef = useRef<HTMLDivElement>(null);
  const [boxWidth, setBoxWidth] = useState(0);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const observer = new ResizeObserver(entries => {
      const next = entries[0]?.contentRect.width ?? 0;
      // 只有真正变化才更新，避免亚像素抖动引起反复重排
      setBoxWidth(prev => (Math.abs(prev - next) > 4 ? next : prev));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // 每行最多放几层：按容器宽度算（上限 4 层，再多整图会太宽）；
  // 首帧还没量到宽度时先按 3 层排。
  // 这里用 MIN_NODE_W 算「最保守」的列数：真实节点宽度是之后按这个列数反算的，
  // 若先用大宽度算列数，会出现「算出来 3 列、每列 300px、又溢出」的自相矛盾。
  const maxCols =
    boxWidth > 0
      ? Math.min(4, Math.max(2, Math.floor((boxWidth - PAD * 2 + GAP_MAIN_LR) / (MIN_NODE_W + GAP_MAIN_LR))))
      : 3;
  const { nodes, edges, groups, legend, nodeWidth, width, height } = useMemo(
    () => layoutFlow(block, maxCols, boxWidth),
    [block, maxCols, boxWidth],
  );
  // 轻微溢出时整体缩放适配（字略小但完整可见）；溢出超过 22% 才让它横向滚动，
  // 否则字会被压到 9px 以下、根本读不了。
  const fitScale = boxWidth > 0 && width > boxWidth ? boxWidth / width : 1;
  const scaled = fitScale >= 0.78;
  const renderWidth = scaled ? Math.round(width * fitScale) : width;
  const renderHeight = scaled ? Math.round(height * fitScale) : height;
  // marker id 每个实例必须唯一：同一页可能有多个 flow 块，重复 id 会让箭头引用到别的 SVG
  const uid = useId().replace(/:/g, "");
  const markerId = (kind: string) => `flow-arrow-${uid}-${kind}`;


  return (
    <div className="space-y-2">
      <div ref={wrapRef} className="overflow-x-auto overscroll-x-contain rounded-xl border border-border bg-card p-1">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          width={renderWidth}
          height={renderHeight}
          role="img"
          aria-label={block.caption ?? "流程图"}
          /* mx-auto：图比容器窄时居中。之前固定左对齐，TB 图只有 240px 宽，
             右边空出 400px，整块看起来偏在一角、显得又小又挤。 */
          style={{ display: "block", marginInline: "auto" }}
        >
          <defs>
            {(["main", "branch", "async", "return"] as const).map(kind => (
              <marker
                key={kind}
                id={markerId(kind)}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill={EDGE_STYLE[kind].stroke} />
              </marker>
            ))}
          </defs>

          {/* 分组（泳道）：画在最底层，圈住相关节点，对应 archify 的 01/02/EX 泳道 */}
          {groups.map((box, index) => {
            const stroke = GROUP_COLOR[box.color] ?? GROUP_COLOR.default;
            return (
              <g key={`group-${index}`}>
                <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={14} fill={stroke} opacity={0.05} />
                <rect
                  x={box.x}
                  y={box.y}
                  width={box.w}
                  height={box.h}
                  rx={14}
                  fill="none"
                  stroke={stroke}
                  strokeOpacity={0.4}
                  strokeWidth={1.2}
                  strokeDasharray="5 4"
                />
                <text
                  x={box.x + 10}
                  y={box.y + GROUP_LABEL_H - 4}
                  style={{ fontSize: 10.5, fontWeight: 600, fill: stroke }}
                >
                  {box.label}
                </text>
              </g>
            );
          })}
          {/* 连线先画，节点后画：保证线不会压在方框文字上 */}
          {edges.map(({ edge, path, labelX, labelY, delay }, index) => {
            const style = EDGE_STYLE[edge.kind] ?? EDGE_STYLE.main;
            return (
              <g key={`${edge.from}-${edge.to}-${index}`}>
                {/* trace：主链先"画"一遍（pathLength 归一化 + dashoffset 从 1 到 0），
                    画完自己淡出，露出下面那条带箭头的标准线。分支/异步/回边只淡入，
                    否则虚线语义会被描边动画抹掉。 */}
                {edge.kind === "main" ? (
                  <>
                    {/* ① 进场描边：只播一次，画完淡出 */}
                    <path
                      d={path}
                      pathLength={1}
                      fill="none"
                      stroke={style.stroke}
                      strokeWidth={2.5}
                      strokeLinecap="round"
                      className="akm-flow-trace"
                      style={{ animationDelay: `${delay}ms` }}
                    />
                    {/* ② 常驻流动光点：无限循环。进场描边只有 480ms，滚动到卡片时早没了，
                        这条才是「一直能看到在流动」的那层。 */}
                    <path
                      d={path}
                      pathLength={1}
                      fill="none"
                      stroke={style.stroke}
                      strokeWidth={2.5}
                      strokeLinecap="round"
                      className="akm-flow-pulse"
                      style={{ animationDelay: `${delay}ms` }}
                    />
                  </>
                ) : null}
                <g
                  className="akm-flow-anim"
                  style={{
                    animation: "akm-flow-fade 300ms ease-out both",
                    animationDelay: `${delay + (edge.kind === "main" ? 220 : 0)}ms`,
                  }}
                >
                  <path
                    d={path}
                    fill="none"
                    stroke={style.stroke}
                    strokeWidth={1.5}
                    strokeDasharray={style.dash}
                    markerEnd={`url(#${markerId(edge.kind)})`}
                    opacity={0.95}
                  />
                  {edge.label ? (
                    <g>
                      {/* 背景块宽度按「文字真实占用宽度 + 左右各 5px」算。
                          旧写法 length * 10.4 是按汉字宽度估的，纯 ASCII 的 "plan"
                          只有 22px 却给了 41px 白底，白块比字宽一倍，看着又挤又脏。 */}
                      <rect
                        x={labelX - labelWidth(edge.label) / 2}
                        y={labelY - 10}
                        width={labelWidth(edge.label)}
                        height={15}
                        rx={4}
                        className="fill-background"
                        opacity={0.92}
                      />
                      <text
                        x={labelX}
                        y={labelY + 1}
                        textAnchor="middle"
                        className="fill-muted-foreground"
                        style={{ fontSize: 10 }}
                      >
                        {clipByWidth(edge.label, LABEL_MAX_W, 10)}
                      </text>
                    </g>
                  ) : null}
                </g>
              </g>
            );
          })}

          {nodes.map(({ node, x, y, delay }) => {
            const style = KIND_STYLE[node.kind] ?? KIND_STYLE.step;
            const radius = node.kind === "start" || node.kind === "end" ? 18 : 10;
            return (
              /* 关键：用 transform 承载节点位移，rect / 圆点 / 文字都用相对坐标。
                 直接把 x/y 只写给 rect、文字却用画布绝对坐标，会让所有节点的文字
                 叠在画布左上角同一个点上。 */
              <g key={node.id} transform={`translate(${x}, ${y})`}>
                {/* 动画层单独包一层：CSS transform 会覆盖 g 上的 transform 属性，
                    所以节点定位（translate）留在外层，进场位移只作用于内层 */}
                <g
                  className="akm-flow-anim"
                  style={{ animation: "akm-flow-node-in 360ms ease-out both", animationDelay: `${delay}ms` }}
                >
                  <rect
                    x={0}
                    y={0}
                    width={nodeWidth}
                    height={NODE_H}
                    rx={radius}
                    fill={style.fill}
                    stroke={style.border}
                    strokeWidth={1.25}
                  />
                  {/* 语义色点：与卡片其它块的色板一致，便于扫视区分节点角色 */}
                  <circle cx={12} cy={12} r={3} fill={style.dot} />
                  <NodeLabel node={node} nodeW={nodeWidth} />
                </g>
              </g>
            );
          })}

          {/* 图例：底部按节点 kind 统计（legend=true 时才有），对应 archify demo 的 Legend */}
          {legend.length ? (
            <g transform={`translate(${PAD}, ${height - LEGEND_H / 2})`}>
              {legend.map((item, index) => (
                <g key={item.kind} transform={`translate(${index * 78}, 0)`}>
                  <circle cx={4} cy={-4} r={3.5} fill={KIND_STYLE[item.kind].dot} />
                  <text x={13} y={0} className="fill-muted-foreground" style={{ fontSize: 10.5 }}>
                    {KIND_LABEL[item.kind]} {item.count}
                  </text>
                </g>
              ))}
            </g>
          ) : null}
        </svg>
      </div>
      {block.caption ? (
        <p className={cn("px-0.5 text-[11px] text-muted-foreground")}>{block.caption}</p>
      ) : null}
    </div>
  );
});

FlowDiagram.displayName = "FlowDiagram";
