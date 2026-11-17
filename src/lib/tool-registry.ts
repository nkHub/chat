/**
 * 工具渲染注册表：把「某个工具该怎么展示」收敛到一处。
 *
 * 背景：同一个工具的知识此前分散在三个文件里 ——
 * - `lib/agent-api.ts` 的 `resolveDeclaredTools`：工具 schema 下发给模型；
 * - `lib/process-groups.ts` 的 `HIDDEN_RENDER_TOOLS`：哪些工具不进过程时间线；
 * - `app/chat.tsx` 的 `isSpecialTool` / `segment.name === ...`：哪些工具要专用卡片。
 *
 * 三处各写一遍工具名，新增一个带 UI 的工具就要改三个文件、且容易漏。这里把
 * **纯展示层**的判定集中成一个注册表（schema 与客户端执行仍在各自原处，不做搬家）：
 * 新增工具只需要加一条，渲染侧不再出现具体工具名。
 *
 * 这是照着 assistant-ui 的 `useAssistantTool({ toolName, render })`
 * （`packages/core/src/react/model-context/useAssistantTool.ts`）的思路做的减法版本：
 * 它把 schema / 执行 / 渲染一并注册进 runtime；本项目工具执行在服务端，
 * 前端只需要「展示层注册表」这一层。
 */

/** 工具卡片在消息里的展示位次：与 assistant-ui 的 `display` 语义对齐。 */
export type ToolDisplay =
  /** 内联：进过程时间线，作为一行工具步骤（默认）。 */
  | "inline"
  /** 独立成块：有专用卡片，不进时间线（子 Agent、子任务列表）。 */
  | "standalone"
  /** 隐藏：原位渲染成卡片/图表，不占时间线一行（akm_render 等渲染工具）。 */
  | "hidden";

export type ToolUiEntry = {
  /** 展示位次。 */
  display: ToolDisplay;
  /** 归属分组，仅用于阅读与调试时聚合查看（例如「子 Agent」「渲染」）。 */
  group?: string;
};

/**
 * 工具展示注册表。
 *
 * 注意这里只登记「需要特殊展示」的工具：不在表内的工具一律按 `inline` 处理，
 * 因此绝大多数工具无需登记（默认值就是正确行为）。
 */
const TOOL_UI_REGISTRY: ReadonlyMap<string, ToolUiEntry> = new Map<string, ToolUiEntry>([
  // 子 Agent：spawn / wait / kill / status 归并成「子进程状态卡片」
  ["akm_subagent_spawn", { display: "standalone", group: "子 Agent" }],
  ["akm_subagent_wait", { display: "standalone", group: "子 Agent" }],
  ["akm_subagent_kill", { display: "standalone", group: "子 Agent" }],
  ["akm_subagent_status", { display: "standalone", group: "子 Agent" }],
  // 子任务列表：渲染为列表卡片，点击打开右侧面板
  ["akm_subagent_list", { display: "standalone", group: "子 Agent" }],
  // 渲染工具：回传的布局原位渲染成卡片，不在时间线里留一行工具调用
  ["akm_render", { display: "hidden", group: "渲染" }],
  ["render_ui", { display: "hidden", group: "渲染" }],
]);

/** 取工具的展示位次；未登记的工具按 `inline`（进过程时间线）处理。 */
export function toolDisplay(name: string): ToolDisplay {
  return TOOL_UI_REGISTRY.get(name)?.display ?? "inline";
}

/** 是否需要专用卡片（不进过程时间线、由调用方单独渲染）。 */
export function isStandaloneTool(name: string): boolean {
  return toolDisplay(name) === "standalone";
}

/** 是否隐藏（原位渲染成卡片，不占时间线一行，也不参与折叠/展开）。 */
export function isHiddenTool(name: string): boolean {
  return toolDisplay(name) === "hidden";
}

/** 取工具归属分组（用于按分组聚合，如「全部子 Agent 工具」）；未登记返回 undefined。 */
export function toolGroup(name: string): string | undefined {
  return TOOL_UI_REGISTRY.get(name)?.group;
}

/**
 * 是否为「子任务列表」工具（akm_subagent_list）。
 *
 * 单独成一个判定而不是让调用方写 `name === "akm_subagent_list"`：这个工具与
 * spawn/wait/kill/status 同属「子 Agent」分组，但渲染成列表卡片而非状态卡片。
 */
export function isSubagentListTool(name: string): boolean {
  return name === "akm_subagent_list";
}

/** 已登记的工具名（仅用于调试与断言，渲染路径不依赖它）。 */
export function registeredToolNames(): string[] {
  return [...TOOL_UI_REGISTRY.keys()];
}
