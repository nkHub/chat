import { useState } from "react";
import { AlertCircle, Check, ChevronRight, Copy, Cpu, List, Loader2, X } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { Message } from "./types";

// ── 子 Agent（子进程）展示 ──────────────────────────────────────────────
// 后端 agent_subagent_enabled 开启时主 Agent 可调用 akm_subagent_spawn / wait / kill / status
// 委托独立子进程会话；akm_subagent_list 返回全部子任务概要。
// 前端把 spawn/wait/kill/status 的调用段渲染为「子进程状态卡片」，点击卡片在右侧滑动面板
// 查看该子进程的完整聚合信息（任务号/指令/状态/输出等）；list 渲染为「子任务列表卡片」，
// 点击在右侧面板查看全部子任务概要。数据仅来自工具调用段本身（params + result），不额外请求后端。

// 子 Agent 工具名集合（按 task_id 归并展示）：用于识别哪些工具段属于子进程调用
const SUBAGENT_TOOL_NAMES = new Set(["akm_subagent_spawn", "akm_subagent_wait", "akm_subagent_kill", "akm_subagent_status"]);

// 单次子进程工具调用（spawn / wait / kill / status 任一段）
type SubagentCall = {
  name: string;
  params: Record<string, unknown>;
  result: unknown;
  status: "running" | "success" | "error";
};

// 聚合后的子进程信息：同一 task_id 的所有工具调用段归并为一条记录
type SubagentRun = {
  taskId: string;
  prompt: string;
  model?: string;
  workspace?: string;
  logPath?: string;
  depth?: number;
  latestStatus?: string; // running / succeeded / failed / killed（来自最近一次 result）
  exitCode?: number;
  output?: string; // wait 返回的子进程输出文本
  logTail?: string; // status 返回的日志尾部文本（最多 2000 字符）
  logTruncated?: boolean; // status 返回的日志是否因超长被截断
  calls: SubagentCall[];
};

// 判断工具段是否属于子 Agent 调用
function isSubagentTool(name: string): boolean {
  return SUBAGENT_TOOL_NAMES.has(name);
}

// 工具 result 可能是 JSON 字符串（后端 json.dumps 下发）或对象，统一解析为对象
function parseSubagentResult(result: unknown): Record<string, unknown> | null {
  if (!result) return null;
  if (typeof result === "object") return result as Record<string, unknown>;
  if (typeof result === "string") {
    try {
      const parsed: unknown = JSON.parse(result);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return null;
}

// 从全部消息中按 task_id 聚合子进程调用段，返回聚合后的子进程列表
function collectSubagentRuns(messages: Message[]): SubagentRun[] {
  const runs = new Map<string, SubagentRun>();
  for (const message of messages) {
    for (const segment of message.segments ?? []) {
      if (segment.type !== "tool" || !isSubagentTool(segment.name)) continue;
      const parsed = parseSubagentResult(segment.result);
      const taskId =
        typeof parsed?.task_id === "string"
          ? parsed.task_id
          : typeof segment.params.task_id === "string"
            ? segment.params.task_id
            : "";
      if (!taskId) continue;
      let run = runs.get(taskId);
      if (!run) {
        run = { taskId, prompt: "", calls: [] };
        runs.set(taskId, run);
      }
      // spawn 段补全任务元信息（prompt / workspace / log_path / depth）
      if (segment.name === "akm_subagent_spawn") {
        run.prompt = typeof segment.params.prompt === "string" ? segment.params.prompt : "";
        run.model = typeof segment.params.model === "string" ? segment.params.model : "";
        run.workspace = typeof parsed?.workspace === "string" ? parsed.workspace : "";
        run.logPath = typeof parsed?.log_path === "string" ? parsed.log_path : "";
        run.depth = typeof parsed?.depth === "number" ? parsed.depth : undefined;
      }
      // status 段补全日志尾部信息（status / exit_code / log_tail / 截断标记），
      // 其返回的 status、exit_code 与 wait 一致，覆盖顺序以调用先后为准。
      if (segment.name === "akm_subagent_status") {
        run.logTail = typeof parsed?.log_tail === "string" ? parsed.log_tail : undefined;
        run.logTruncated = parsed?.log_truncated === true;
      }
      run.calls.push({ name: segment.name, params: segment.params, result: segment.result, status: segment.status });
      if (typeof parsed?.status === "string") run.latestStatus = parsed.status;
      if (typeof parsed?.exit_code === "number") run.exitCode = parsed.exit_code;
      if (typeof parsed?.output === "string" && parsed.output) run.output = parsed.output;
    }
  }
  return Array.from(runs.values());
}

// 从聚合结果中查找某个工具调用段对应的子进程记录（按 task_id 匹配）
function findSubagentRun(runs: SubagentRun[], segment: { name: string; params: Record<string, unknown>; result: unknown }): SubagentRun | undefined {
  if (!isSubagentTool(segment.name)) return undefined;
  const parsed = parseSubagentResult(segment.result);
  const taskId =
    typeof parsed?.task_id === "string"
      ? parsed.task_id
      : typeof segment.params.task_id === "string"
        ? segment.params.task_id
        : "";
  return taskId ? runs.find(run => run.taskId === taskId) : undefined;
}

// 子任务列表项：akm_subagent_list 返回的单条任务概要
type SubagentListTask = {
  taskId: string;
  status?: string; // running / succeeded / failed / killed
  depth?: number;
  model?: string;
  workspace?: string;
  createdAt?: string;
};

// 从全部消息中聚合 akm_subagent_list 的结果：其 result 形如 { tasks: [{task_id, status, depth, model, workspace, created_at}] }。
// 多次调用时按 task_id 去重合并，保留首次出现的顺序。
function collectSubagentList(messages: Message[]): SubagentListTask[] {
  const seen = new Set<string>();
  const tasks: SubagentListTask[] = [];
  for (const message of messages) {
    for (const segment of message.segments ?? []) {
      if (segment.type !== "tool" || segment.name !== "akm_subagent_list") continue;
      const parsed = parseSubagentResult(segment.result);
      if (!Array.isArray(parsed?.tasks)) continue;
      for (const raw of parsed.tasks as unknown[]) {
        const item = raw as Record<string, unknown>;
        const taskId = typeof item.task_id === "string" ? item.task_id : "";
        if (!taskId || seen.has(taskId)) continue;
        seen.add(taskId);
        tasks.push({
          taskId,
          status: typeof item.status === "string" ? item.status : undefined,
          depth: typeof item.depth === "number" ? item.depth : undefined,
          model: typeof item.model === "string" ? item.model : undefined,
          workspace: typeof item.workspace === "string" ? item.workspace : undefined,
          createdAt: typeof item.created_at === "string" ? item.created_at : undefined,
        });
      }
    }
  }
  return tasks;
}

// 子任务列表卡片：akm_subagent_list 工具调用段的专用展示。
// 点击后打开右侧面板查看全部子任务概要（不按单 task_id 归并）。
function SubagentListCard({ tasks, onOpen }: { tasks: SubagentListTask[]; onOpen: () => void }) {
  const running = tasks.filter(t => t.status === "running").length;
  const finished = tasks.filter(t => t.status && t.status !== "running").length;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="block w-full overflow-hidden rounded-lg border border-indigo-200 bg-indigo-50/70 text-left transition-colors hover:border-indigo-300 hover:bg-indigo-50 dark:border-indigo-800/40 dark:bg-indigo-950/40 dark:hover:border-indigo-700/60"
    >
      <div className="flex items-center gap-2 border-b border-indigo-200 px-3 py-2 text-xs font-medium text-indigo-700 dark:border-indigo-800/40 dark:text-indigo-300">
        <List size={12} />
        <span>子任务列表</span>
        <span className="ml-auto flex items-center gap-1.5">
          <span className="inline-flex items-center gap-1 text-indigo-600/80 dark:text-indigo-300/80">
            <Loader2 size={12} className={running > 0 ? "animate-spin" : undefined} />
            {running} 运行中
          </span>
          <span className="text-indigo-600/60 dark:text-indigo-300/60">共 {tasks.length} 个</span>
        </span>
      </div>
      <div className="px-3 py-2 text-xs text-indigo-900/70 dark:text-indigo-200/70">
        {tasks.length > 0 ? (
          <p className="line-clamp-1 [overflow-wrap:anywhere]">
            {tasks.slice(0, 3).map(t => t.taskId).join("、")}
            {tasks.length > 3 ? ` 等 ${tasks.length} 个任务` : ""}
          </p>
        ) : (
          <p className="text-indigo-600/50 dark:text-indigo-300/50">暂未查询到子任务…</p>
        )}
        {finished > 0 ? <p className="mt-1 text-[11px] text-indigo-600/60 dark:text-indigo-300/60">其中 {finished} 个已结束</p> : null}
      </div>
    </button>
  );
}

// 右侧滑动面板：展示 akm_subagent_list 返回的全部子任务概要
function SubagentListPanel({ tasks, onClose }: { tasks: SubagentListTask[]; onClose: () => void }) {
  return (
    <>
      {/* 遮罩层：点击关闭面板 */}
      <div className="fixed inset-0 z-40 bg-black/30" onClick={onClose} />
      {/* 面板本体：右侧滑入，独立滚动 */}
      <div className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l bg-card shadow-2xl animate-in slide-in-from-right">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <List size={14} className="text-indigo-500" />
          <h2 className="text-sm font-semibold text-foreground">子任务列表</h2>
          <span className="ml-auto rounded-full bg-indigo-100 px-2 py-0.5 text-[11px] font-medium text-indigo-600 dark:bg-indigo-900/40 dark:text-indigo-300">共 {tasks.length} 个</span>
          <button type="button" onClick={onClose} aria-label="关闭" className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><X size={15} /></button>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-2 px-4 py-4">
            {tasks.length === 0 ? (
              <p className="text-xs text-muted-foreground">暂无子任务记录。</p>
            ) : (
              tasks.map(task => {
                const statusMeta =
                  task.status === "succeeded"
                    ? { label: "已完成", cls: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300" }
                    : task.status === "failed"
                      ? { label: "失败", cls: "bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-300" }
                      : task.status === "killed"
                        ? { label: "已终止", cls: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300" }
                        : { label: "运行中", cls: "bg-indigo-100 text-indigo-600 dark:bg-indigo-900/40 dark:text-indigo-300" };
                return (
                  <div key={task.taskId} className="rounded-lg border border-border bg-muted/50 px-3 py-2">
                    <div className="flex items-center gap-2">
                      <code className="truncate font-mono text-xs text-foreground/80">{task.taskId}</code>
                      <span className={cn("ml-auto inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium", statusMeta.cls)}>
                        {task.status === "running" ? <Loader2 size={10} className="animate-spin" /> : null}
                        {statusMeta.label}
                      </span>
                    </div>
                    <dl className="mt-1.5 space-y-0.5 text-[11px] text-foreground/60">
                      {task.depth !== undefined ? <div className="flex gap-2"><dt className="w-12 shrink-0 text-muted-foreground">深度</dt><dd className="min-w-0 break-all">{task.depth}</dd></div> : null}
                      {task.model ? <div className="flex gap-2"><dt className="w-12 shrink-0 text-muted-foreground">模型</dt><dd className="min-w-0 break-all">{task.model}</dd></div> : null}
                      {task.workspace ? <div className="flex gap-2"><dt className="w-12 shrink-0 text-muted-foreground">工作区</dt><dd className="min-w-0 break-all font-mono">{task.workspace}</dd></div> : null}
                      {task.createdAt ? <div className="flex gap-2"><dt className="w-12 shrink-0 text-muted-foreground">创建</dt><dd className="min-w-0 break-all">{task.createdAt}</dd></div> : null}
                    </dl>
                  </div>
                );
              })
            )}
          </div>
        </ScrollArea>
      </div>
    </>
  );
}

// 子进程卡片：展示单个工具调用段 + 该 task_id 聚合后的最新状态
function SubagentCard({ run, onOpen }: { run: SubagentRun | null; onOpen: () => void }) {
  // 最近一次 result 中的子进程状态（spawn 返回 running；wait 返回 running/succeeded/failed；
  // kill 返回 killed）。工具调用段自身报错时优先显示 error。
  const calls = run?.calls ?? [];
  const lastCall = calls[calls.length - 1];
  const callStatus = lastCall?.status ?? "running";
  const subStatus = callStatus === "error" ? "error" : (run?.latestStatus ?? "running");
  const statusMeta =
    subStatus === "succeeded"
      ? { label: "已完成", icon: Check, cls: "text-emerald-600 dark:text-emerald-400" }
      : subStatus === "failed"
        ? { label: "失败", icon: AlertCircle, cls: "text-red-500 dark:text-red-400" }
        : subStatus === "killed"
          ? { label: "已终止", icon: AlertCircle, cls: "text-amber-600 dark:text-amber-400" }
          : callStatus === "error"
            ? { label: "调用失败", icon: AlertCircle, cls: "text-red-500 dark:text-red-400" }
            : { label: "运行中", icon: Loader2, cls: "text-primary" };
  const StatusIcon = statusMeta.icon;
  const actionLabel =
    lastCall?.name === "akm_subagent_spawn" ? "开启子进程" : lastCall?.name === "akm_subagent_kill" ? "终止子进程" : "等待子进程";
  return (
    <button
      type="button"
      onClick={onOpen}
      className="block w-full overflow-hidden rounded-lg border border-indigo-200 bg-indigo-50/70 text-left transition-colors hover:border-indigo-300 hover:bg-indigo-50 dark:border-indigo-800/40 dark:bg-indigo-950/40 dark:hover:border-indigo-700/60"
    >
      <div className="flex items-center gap-2 border-b border-indigo-200 px-3 py-2 text-xs font-medium text-indigo-700 dark:border-indigo-800/40 dark:text-indigo-300">
        <Cpu size={12} />
        <span>{actionLabel}</span>
        <span className="ml-auto flex items-center gap-1.5">
          {run ? <code className="font-mono text-indigo-600/80 dark:text-indigo-300/80">{run.taskId}</code> : <span className="text-indigo-600/60 dark:text-indigo-300/60">任务创建中…</span>}
          <span className={cn("inline-flex items-center gap-1", statusMeta.cls)}>
            <StatusIcon size={12} className={subStatus === "running" ? "animate-spin" : undefined} />
            {statusMeta.label}
          </span>
        </span>
      </div>
      <div className="px-3 py-2 text-xs text-indigo-900/70 dark:text-indigo-200/70">
        {run?.prompt ? <p className="line-clamp-2 [overflow-wrap:anywhere]">{run.prompt}</p> : <p className="text-indigo-600/50 dark:text-indigo-300/50">正在向子 Agent 发起任务…</p>}
        {run?.workspace ? <p className="mt-1 truncate font-mono text-[11px] text-indigo-600/60 dark:text-indigo-300/60">工作区：{run.workspace}</p> : null}
      </div>
    </button>
  );
}

// 右侧滑动面板：展示单个子进程的完整聚合信息（调用序列 + 输出）
function SubagentPanel({ run, onClose }: { run: SubagentRun | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  // 输出优先取 wait 的完整输出，其次取 status 返回的日志尾部
  const output = run?.output ?? run?.logTail ?? "";
  const copy = () => {
    navigator.clipboard.writeText(output).catch(() => undefined);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };
  const statusMeta =
    run?.latestStatus === "succeeded"
      ? { label: "已完成", cls: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300" }
      : run?.latestStatus === "failed"
        ? { label: "失败", cls: "bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-300" }
        : run?.latestStatus === "killed"
          ? { label: "已终止", cls: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300" }
          : { label: "运行中", cls: "bg-indigo-100 text-indigo-600 dark:bg-indigo-900/40 dark:text-indigo-300" };
  return (
    <>
      {/* 遮罩层：点击关闭面板 */}
      <div className="fixed inset-0 z-40 bg-black/30" onClick={onClose} />
      {/* 面板本体：右侧滑入，独立滚动 */}
      <div className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l bg-card shadow-2xl animate-in slide-in-from-right">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Cpu size={14} className="text-indigo-500" />
          <h2 className="text-sm font-semibold text-foreground">子进程会话</h2>
          {run?.taskId ? <code className="ml-1 truncate font-mono text-xs text-muted-foreground">{run.taskId}</code> : null}
          {run?.latestStatus || run?.calls.length ? <span className={cn("ml-auto inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium", statusMeta.cls)}>{statusMeta.label}</span> : null}
          <button type="button" onClick={onClose} aria-label="关闭" className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><X size={15} /></button>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-3 px-4 py-4">
            {/* 任务信息 */}
            {run?.prompt ? (
              <section>
                <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">任务指令</h3>
                <p className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-xs leading-relaxed text-foreground/80 [overflow-wrap:anywhere]">{run.prompt}</p>
              </section>
            ) : null}
            {/* 元信息 */}
            {(run?.model || run?.workspace || run?.logPath || run?.depth !== undefined) ? (
              <section>
                <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">元信息</h3>
                <dl className="space-y-1 rounded-lg border border-border bg-muted/50 px-3 py-2 text-xs text-foreground/70">
                  {run?.depth !== undefined ? <div className="flex gap-2"><dt className="w-16 shrink-0 text-muted-foreground">深度</dt><dd className="min-w-0 break-all">{run.depth}</dd></div> : null}
                  {run?.model ? <div className="flex gap-2"><dt className="w-16 shrink-0 text-muted-foreground">模型</dt><dd className="min-w-0 break-all">{run.model}</dd></div> : null}
                  {run?.workspace ? <div className="flex gap-2"><dt className="w-16 shrink-0 text-muted-foreground">工作区</dt><dd className="min-w-0 break-all font-mono text-[11px]">{run.workspace}</dd></div> : null}
                  {run?.logPath ? <div className="flex gap-2"><dt className="w-16 shrink-0 text-muted-foreground">日志</dt><dd className="min-w-0 break-all font-mono text-[11px]">{run.logPath}</dd></div> : null}
                  {run?.exitCode !== undefined ? <div className="flex gap-2"><dt className="w-16 shrink-0 text-muted-foreground">退出码</dt><dd className="min-w-0 break-all">{run.exitCode}</dd></div> : null}
                </dl>
              </section>
            ) : null}
            {/* 子进程输出 */}
            {output ? (
              <section>
                <div className="mb-1.5 flex items-center justify-between">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">执行输出</h3>
                  <button type="button" className="flex items-center gap-1 rounded p-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground" onClick={copy}>{copied ? <Check size={12} /> : <Copy size={12} />}{copied ? "已复制" : "复制"}</button>
                </div>
                <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-muted/50 px-3 py-2 text-[11px] leading-relaxed text-foreground/80 [overflow-wrap:anywhere]">{output}</pre>
                {run?.logTruncated ? <p className="mt-1 text-[10px] text-amber-600 dark:text-amber-400">日志过长已截断，仅显示末尾 2000 字符</p> : null}
              </section>
            ) : null}
            {/* 调用序列 */}
            {run?.calls.length ? (
              <section>
                <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">调用序列</h3>
                <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
                  {run.calls.map((call, index) => (
                    <details key={`${call.name}-${index}`} className="group px-3 py-2">
                      <summary className="flex cursor-pointer list-none items-center gap-2 text-xs text-foreground/80">
                        {call.status === "success" ? <Check size={12} className="text-emerald-600 dark:text-emerald-400" /> : call.status === "error" ? <AlertCircle size={12} className="text-red-500 dark:text-red-400" /> : <Loader2 size={12} className="animate-spin text-primary" />}
                        <code className="font-mono">{call.name}</code>
                        <ChevronRight size={12} className="ml-auto transition-transform group-open:rotate-90" />
                      </summary>
                      <pre className="mt-2 overflow-x-auto rounded bg-muted/60 p-2 text-[11px] leading-relaxed text-foreground/60">{JSON.stringify({ params: call.params, result: parseSubagentResult(call.result) ?? call.result }, null, 2)}</pre>
                    </details>
                  ))}
                </div>
              </section>
            ) : null}
          </div>
        </ScrollArea>
      </div>
    </>
  );
}

export { SUBAGENT_TOOL_NAMES, isSubagentTool, parseSubagentResult, collectSubagentRuns, findSubagentRun, collectSubagentList, SubagentListCard, SubagentListPanel, SubagentCard, SubagentPanel };
export type { SubagentCall, SubagentRun, SubagentListTask };
