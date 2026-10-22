/**
 * 过程步骤（思考 / 工具）的展示文案层。
 *
 * 目的：把「内部工具名 + 原始参数 + 原始结果」翻译成用户能读的一行话：
 * - 主标题：人话动作（`akm_read_file` → 「阅读文件」），而不是裸露的函数名；
 * - 参数摘要：本次操作的对象（文件名、关键词、命令行…）；
 * - 结果摘要：一句话结论（失败原因、结果首行），而不是整坨 JSON。
 *
 * 设计约束：
 * 1. **纯函数、零依赖**（不 import React/lucide），方便被 `npm run check:timeline`
 *    用 esbuild + node 直接跑断言；
 * 2. 只做静态映射与规则提取，**不调用模型**：过程时间线必须在流式过程中实时
 *    出文案，任何额外的 LLM 调用都会拖慢首屏并翻倍成本；
 * 3. 未知工具一律优雅降级（显示工具名本身），新增服务端工具不需要同步改前端。
 */

/** 步骤语气，决定时间线里的图标与配色（图标映射在 process-timeline.tsx）。 */
export type StepTone = "read" | "write" | "search" | "net" | "image" | "system" | "agent" | "other";

export type StepLabel = {
  /** 人话动作，如「阅读文件」「联网搜索」 */
  action: string;
  tone: StepTone;
};

/**
 * 工具名 → 人话动作的静态映射。
 *
 * 键必须是服务端注册的**完整工具名**（见 akm/agent_runtime/tools.py）。
 * 未收录的工具不会报错：describeStep 会回落到「工具名 + other 语气」，
 * 因此这张表可以随时增量补充，不存在版本耦合。
 */
const TOOL_LABELS: Record<string, StepLabel> = {
  // ── 工作区文件读写 ──
  akm_read_file: { action: "阅读文件", tone: "read" },
  akm_read_image: { action: "识别图片", tone: "read" },
  akm_list_dir: { action: "浏览目录", tone: "read" },
  akm_glob: { action: "查找文件", tone: "search" },
  akm_grep: { action: "搜索内容", tone: "search" },
  akm_file_info: { action: "查看文件信息", tone: "read" },
  akm_write_file: { action: "写入文件", tone: "write" },
  akm_edit_file: { action: "编辑文件", tone: "write" },
  akm_make_dir: { action: "新建目录", tone: "write" },
  akm_delete_file: { action: "删除文件", tone: "write" },
  akm_xlsx: { action: "处理表格", tone: "write" },
  // ── 命令与版本控制 ──
  akm_run_shell: { action: "执行命令", tone: "system" },
  akm_run_git: { action: "Git 操作", tone: "system" },
  // ── 联网与检索 ──
  tavily_search: { action: "联网搜索", tone: "net" },
  akm_search_kb: { action: "检索知识库", tone: "search" },
  // ── 图像 ──
  akm_generate_image: { action: "生成图片", tone: "image" },
  akm_edit_image: { action: "编辑图片", tone: "image" },
  // ── 系统与本机能力 ──
  akm_get_status: { action: "读取运行状态", tone: "read" },
  akm_get_config: { action: "读取配置", tone: "read" },
  akm_get_time: { action: "读取时间", tone: "read" },
  akm_get_usage_stats: { action: "查询用量统计", tone: "read" },
  akm_get_keys_summary: { action: "查询密钥概况", tone: "read" },
  akm_list_keys: { action: "列出密钥", tone: "read" },
  akm_list_logs: { action: "查看日志", tone: "read" },
  akm_list_plugins: { action: "查看插件", tone: "read" },
  akm_system_info: { action: "读取系统信息", tone: "system" },
  akm_frontmost_app: { action: "识别前台应用", tone: "system" },
  akm_open: { action: "打开链接", tone: "system" },
  akm_clipboard_get: { action: "读取剪贴板", tone: "system" },
  akm_clipboard_set: { action: "写入剪贴板", tone: "system" },
  akm_send_notification: { action: "发送通知", tone: "system" },
  akm_send_email: { action: "发送邮件", tone: "system" },
  // ── 定时任务与工作流 ──
  akm_create_task: { action: "创建定时任务", tone: "write" },
  akm_list_tasks: { action: "列出定时任务", tone: "read" },
  akm_delete_task: { action: "删除定时任务", tone: "write" },
  akm_flow_list: { action: "列出工作流", tone: "read" },
  akm_flow_get: { action: "读取工作流", tone: "read" },
  akm_flow_save: { action: "保存工作流", tone: "write" },
  akm_flow_delete: { action: "删除工作流", tone: "write" },
  akm_flow_run: { action: "运行工作流", tone: "system" },
  akm_flow_runs: { action: "查询运行记录", tone: "read" },
  akm_flow_run_get: { action: "读取运行记录", tone: "read" },
  akm_flow_cancel: { action: "取消运行", tone: "system" },
  // ── 子 Agent ──
  akm_subagent_spawn: { action: "派发子任务", tone: "agent" },
  akm_subagent_list: { action: "列出子任务", tone: "agent" },
  akm_subagent_status: { action: "查看子任务", tone: "agent" },
  akm_subagent_wait: { action: "等待子任务", tone: "agent" },
  akm_subagent_kill: { action: "终止子任务", tone: "agent" },
  // ── 交互澄清（时间线里较少出现，保留以保证不降级） ──
  akm_ask_user: { action: "向你确认", tone: "other" },
};

/**
 * 参数摘要的取值优先级。
 *
 * 按顺序取第一个非空的标量参数作为「这次操作的对象」：文件名类字段排前面，
 * 因为文件工具最常出现在时间线里；宽泛字段（name/title/code）放最后兜底。
 */
const PARAM_KEY_ORDER = [
  "path",
  "file_path",
  "image_path",
  "dir",
  "pattern",
  "query",
  "keywords",
  "command",
  "cmd",
  "url",
  "task_id",
  "workflow_id",
  "run_id",
  "name",
  "title",
  "prompt",
];

/** 参数摘要最大展示长度，超出截断并补省略号（避免一行被长命令撑爆）。 */
// 参数与结果摘要的字符上限：只做「防超长」兜底，真正的省略交给时间线那一行的 CSS `truncate`
// （按容器宽度自适应）。之前这两个值分别是 42 / 46，宽屏下列宽 1200 也只能看到 40 来字符，
// 视觉上就成了「右边整片空白」。
const MAX_TARGET_CHARS = 160;
/** 结果/思考摘要最大长度（仅防超长，实际显示长度由容器宽度决定）。 */
const MAX_SUMMARY_CHARS = 300;

/** 把任意未知值安全转成单行短文本。 */
function toShortText(value: unknown, maxChars: number): string {
  if (value === null || value === undefined) return "";
  const raw = typeof value === "string" ? value : String(value);
  // 换行/连续空白压成单空格：时间线的副标题只允许占一行。
  const oneLine = raw.replace(/\s+/g, " ").trim();
  if (!oneLine) return "";
  return oneLine.length > maxChars ? `${oneLine.slice(0, maxChars - 1)}…` : oneLine;
}

/**
 * 取工具的人话动作。未收录的工具回落到工具名本身（不隐藏信息，便于排查），
 * 语气统一为 other。
 */
export function describeStep(name: string): StepLabel {
  const key = String(name || "").trim();
  const known = TOOL_LABELS[key];
  if (known) return known;
  // 未知工具：去掉 akm_ 前缀让名字更像话，但仍保留原始语义
  const fallback = key ? key.replace(/^akm_/, "") : "工具调用";
  return { action: fallback, tone: "other" };
}

/**
 * 从参数里提取「操作对象」摘要，例如：
 * `{path: "/tmp/a.md"}` → `/tmp/a.md`；`{query: "库存 SBBP007"}` → `库存 SBBP007`。
 * 没有可用参数时返回空字符串（调用方据此省略副标题）。
 */
export function describeStepTarget(params: unknown): string {
  if (!params || typeof params !== "object") return "";
  const record = params as Record<string, unknown>;
  for (const key of PARAM_KEY_ORDER) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return toShortText(value, MAX_TARGET_CHARS);
    if (typeof value === "number" || typeof value === "boolean") {
      return toShortText(value, MAX_TARGET_CHARS);
    }
  }
  return "";
}

/** 从结果文本里挑出可直接展示的一行（跳过空行、代码围栏与 JSON 括号噪声）。 */
function firstMeaningfulLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const candidate = line
      .replace(/^[#>*\-\s]+/, "")
      .replace(/^```.*$/, "")
      .trim();
    if (!candidate) continue;
    if (candidate === "{" || candidate === "}" || candidate === "[" || candidate === "]") continue;
    // JSON 里的无意义键值（如 "ok": true）不适合做副标题，跳过
    if (/^"[a-z_]+":\s*(true|false|null|\{|\}|\[|\]),?$/.test(candidate)) continue;
    return candidate;
  }
  return "";
}

/**
 * 把工具结果压成一句结论。优先级：
 * 1. 结构化错误（`{error}` / `ok: false`）→ 「失败：原因」，这类信息最需要被看见；
 * 2. 显式摘要字段（summary / message / text）→ 直接用；
 * 3. 普通文本 → 第一行有意义的文本；
 * 4. 都取不到 → 空字符串（调用方回落到状态词「已完成 / 失败」）。
 */
export function summarizeStepResult(result: unknown): string {
  if (result === null || result === undefined) return "";

  let payload: unknown = result;
  if (typeof result === "string") {
    const trimmed = result.trim();
    if (!trimmed) return "";
    // 工具结果大多是 JSON 字符串，先尝试解析以提取结构化信息
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        payload = JSON.parse(trimmed);
      } catch {
        return toShortText(firstMeaningfulLine(trimmed), MAX_SUMMARY_CHARS);
      }
    } else {
      return toShortText(firstMeaningfulLine(trimmed), MAX_SUMMARY_CHARS);
    }
  }

  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const record = payload as Record<string, unknown>;
    const errorText = record.error ?? record.error_message;
    if (typeof errorText === "string" && errorText.trim()) {
      return toShortText(`失败：${errorText}`, MAX_SUMMARY_CHARS);
    }
    if (record.ok === false) return "未成功";
    if (typeof record.compacted === "boolean" && record.compacted) return "上下文已压缩";
    for (const key of ["summary", "message", "text", "output", "detail"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) {
        return toShortText(firstMeaningfulLine(value), MAX_SUMMARY_CHARS);
      }
    }
    return "";
  }

  if (Array.isArray(payload)) return `${payload.length} 项结果`;
  return toShortText(payload, MAX_SUMMARY_CHARS);
}

/**
 * 时长格式化（毫秒 → 人类可读）。
 * - < 1000ms 显示整数毫秒（避免出现「0.0s」这种没有信息量的值）；
 * - < 60s 显示一位小数秒（截图里的「6.0s」口径）；
 * - 更长显示「Xm Ys」或「Xh Ym」。
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 3600) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}m${seconds ? ` ${seconds}s` : ""}`;
  }
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.round((totalSeconds % 3600) / 60);
  return `${hours}h${minutes ? ` ${minutes}m` : ""}`;
}

/**
 * 思考正文压成一行摘要（时间线的思考步副标题）。
 *
 * 只做两件事：**合并成单行**（副标题只能占一行）与剔除纯噪声行（围栏、空括号、JSON 键值）。
 * **不做固定字符数硬截**——折叠态那一行有 CSS `truncate`，会按容器宽度自动省略；
 * 之前在这里按 46 字符截断，即使列宽 1200 也只能显示 40 来个字符，看起来就像「没铺满」。
 */
export function summarizeThinking(content: string): string {
  const text = String(content || "");
  if (!text.trim()) return "";
  const meaningful = text
    .split(/\r?\n/)
    .map(line => line.replace(/^[#>*\-\s]+/, "").replace(/^```.*$/, "").trim())
    .filter(line =>
      Boolean(line) &&
      line !== "{" && line !== "}" && line !== "[" && line !== "]" &&
      !/^"[a-z_]+":\s*(true|false|null|\{|\}|\[|\]),?$/.test(line))
    .join(" ");
  return toShortText(meaningful, MAX_SUMMARY_CHARS);
}
