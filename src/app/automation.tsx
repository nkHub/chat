import { useEffect, useState } from "react";
import { AlertCircle, Bot, Check, Clock, Loader2, Pause, Pencil, Play, Plus, Trash2, Zap } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { createTask, deleteTask, listTasks, resolveDeclaredTools, runTask, updateTask, type AgentMessage, type ScheduledTask, type TaskPayload, type TaskType } from "@/lib/agent-api";
import { clearModalResidue } from "./helpers";
import { PageHeader } from "./sidebar";
import type { ChatModel } from "./types";

// 任务类型展示配置：图标与配色
const TASK_TYPE_META: Record<TaskType, { label: string; icon: LucideIcon; color: string }> = {
  agent_call: { label: "AI 对话", icon: Bot, color: "bg-blue-100 text-blue-600" },
  usage_query: { label: "用量查询", icon: Zap, color: "bg-violet-100 text-violet-600" },
};

// 把任务间隔秒数格式化为人类可读的周期描述（0 表示单次执行）
function formatInterval(intervalSec: number) {
  if (!intervalSec || intervalSec < 0) return "单次执行";
  if (intervalSec % 86400 === 0) return `每 ${intervalSec / 86400} 天`;
  if (intervalSec % 3600 === 0) return `每 ${intervalSec / 3600} 小时`;
  if (intervalSec % 60 === 0) return `每 ${intervalSec / 60} 分钟`;
  return `每 ${intervalSec} 秒`;
}

// 从任务 payload 生成卡片上的一行描述文字
function describeTask(task: ScheduledTask) {
  if (task.task_type === "usage_query") return `监控 Key：${task.payload.alias || "未设置"}`;
  const messages = task.payload.messages ?? [];
  const lastUser = [...messages].reverse().find(message => message.role === "user");
  const content = lastUser?.content || task.payload.instructions || "";
  return content.length > 60 ? `${content.slice(0, 60)}…` : content || "暂无描述";
}

// 后端返回的时间字符串为空时显示占位符
function formatTaskTime(value: string | null | undefined) {
  return value || "—";
}

function AutomationPage({ sidebarOpen, onToggle, models, defaultModelKey }: { sidebarOpen: boolean; onToggle: () => void; models: ChatModel[]; defaultModelKey: string }) {
  // 任务列表数据（null 表示尚未加载完成）
  const [tasks, setTasks] = useState<ScheduledTask[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 新建 / 编辑弹窗的表单状态
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ScheduledTask | null>(null);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [taskType, setTaskType] = useState<TaskType>("agent_call");
  const [intervalSec, setIntervalSec] = useState("3600");
  const [instruction, setInstruction] = useState("");
  const [userPrompt, setUserPrompt] = useState("");
  const [alias, setAlias] = useState("");
  // agent_call 任务使用的执行模型：新建时默认跟随聊天当前所选模型，
  // 后端若收到空 model 会退化为"第一个可用 Key 的模型"，这里显式带上更可控。
  const [modelKey, setModelKey] = useState(defaultModelKey);
  // agent_call 任务开启的工具开关（"search" 联网搜索 / "image" 图像生成）
  const [selectedTools, setSelectedTools] = useState<string[]>([]);

  // 删除确认弹窗的目标任务
  const [deleteTarget, setDeleteTarget] = useState<ScheduledTask | null>(null);

  // 正在执行操作的任务 id（用于按钮加载态，避免重复提交）
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);

  // 拉取任务列表
  const loadTasks = async () => {
    setLoading(true);
    setError(null);
    try {
      setTasks(await listTasks());
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载任务失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void loadTasks(); }, []);

  // 打开新建表单：清空编辑状态与所有字段
  const openCreate = () => {
    setEditTarget(null);
    setName("");
    setTaskType("agent_call");
    setIntervalSec("3600");
    setInstruction("");
    setUserPrompt("");
    setAlias("");
    setModelKey(defaultModelKey);
    setSelectedTools([]);
    setDialogOpen(true);
  };

  // 打开编辑表单：从任务记录还原各字段（agent_call 取最后一条 user 消息）
  const openEdit = (task: ScheduledTask) => {
    setEditTarget(task);
    setName(task.name);
    setTaskType(task.task_type);
    setIntervalSec(String(task.interval_sec ?? 0));
    setInstruction(task.payload.instructions ?? "");
    setUserPrompt((task.payload.messages ?? []).filter(message => message.role === "user").map(message => message.content ?? "").join("\n"));
    setAlias(task.payload.alias ?? "");
    setModelKey(task.payload.model || defaultModelKey);
    // 从 payload.tools 还原已开启的工具开关
    const toolNames = (task.payload.tools ?? []).map(tool => tool.function?.name);
    setSelectedTools([
      ...(toolNames.includes("tavily_search") ? (["search"] as string[]) : []),
      ...(toolNames.some(name => name === "akm_generate_image" || name === "akm_edit_image") ? (["image"] as string[]) : []),
    ]);
    setDialogOpen(true);
  };

  // 关闭弹窗并清空表单，避免残留上次的编辑/添加状态
  const closeDialog = () => {
    setDialogOpen(false);
    setEditTarget(null);
    window.setTimeout(clearModalResidue, 250);
  };

  // 关闭删除确认弹窗
  const closeDelete = () => {
    setDeleteTarget(null);
    window.setTimeout(clearModalResidue, 250);
  };

  // 提交保存：新建或更新任务
  const submit = async () => {
    if (!name.trim() || (taskType === "agent_call" ? !userPrompt.trim() : !alias.trim())) return;
    const messages: AgentMessage[] = [{ role: "user", content: userPrompt.trim() }];
    // 按类型构造 payload；编辑时在原始 payload 基础上覆盖表单字段，保留 last_result 等执行产物
    const nextPayload: TaskPayload = taskType === "agent_call"
      ? { model: modelKey, instructions: instruction.trim(), messages, tools: resolveDeclaredTools(selectedTools) }
      : { alias: alias.trim() };
    const payload = editTarget ? { ...editTarget.payload, ...nextPayload } : nextPayload;
    setSaving(true);
    setError(null);
    try {
      const input = { name: name.trim(), task_type: taskType, interval_sec: Math.max(0, Number(intervalSec) || 0), payload };
      if (editTarget) await updateTask(editTarget.id, input);
      else await createTask(input);
      closeDialog();
      void loadTasks();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  // 通用操作包装：锁定按钮避免重复提交，操作完成后刷新列表
  const runOperation = async (taskId: string, operation: () => Promise<unknown>) => {
    setBusyTaskId(taskId);
    setError(null);
    try {
      await operation();
      void loadTasks();
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setBusyTaskId(null);
    }
  };

  const toggleEnabled = (task: ScheduledTask) => void runOperation(task.id, () => updateTask(task.id, { enabled: !task.enabled }));
  const runNow = (task: ScheduledTask) => void runOperation(task.id, () => runTask(task.id));
  const confirmDelete = () => {
    if (deleteTarget) void runOperation(deleteTarget.id, () => deleteTask(deleteTarget.id));
    closeDelete();
  };

  return (
    <>
      <PageHeader title="自动化" subtitle="让重复任务在合适的时间自动运行" sidebarOpen={sidebarOpen} onToggle={onToggle} />
      <ScrollArea className="min-h-0 flex-1 bg-white dark:bg-card">
        <div className="mx-auto max-w-4xl space-y-6 px-4 py-6 sm:px-8">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold text-foreground">自动化任务</h2>
              <p className="mt-1 text-sm text-muted-foreground">集中管理定时运行的任务和通知。</p>
            </div>
            <Button className="gap-2" onClick={openCreate}><Plus size={15} />新建自动化</Button>
          </div>

          {/* 加载或操作失败时展示错误信息 */}
          {error && <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive"><AlertCircle size={15} className="mt-0.5 shrink-0" /><div className="min-w-0 flex-1">{error}</div></div>}

          {tasks === null && loading && (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground"><Loader2 size={16} className="animate-spin" />正在加载任务…</div>
          )}

          {tasks !== null && tasks.length === 0 && (
            <div className="rounded-xl border border-dashed py-14 text-center text-sm text-muted-foreground">还没有自动化任务，点击右上角「新建自动化」创建第一个。</div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            {(tasks ?? []).map(task => {
              const meta = TASK_TYPE_META[task.task_type];
              const busy = busyTaskId === task.id;
              return (
                <div key={task.id} className="group relative flex flex-col rounded-xl border bg-card p-4 shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md">
                  <div className="mb-4 flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg", meta.color)}><meta.icon size={17} /></div>
                      <div className="min-w-0">
                        <h3 className="truncate text-sm font-semibold">{task.name}</h3>
                        <div className="mt-1 flex items-center gap-1.5">
                          <Badge variant="secondary" className="h-4 px-1.5 py-0 text-[11px]">{meta.label}</Badge>
                          {task.enabled ? <Badge variant="green" className="h-4 px-1.5 py-0 text-[11px]">运行中</Badge> : <Badge variant="secondary" className="h-4 px-1.5 py-0 text-[11px]">已暂停</Badge>}
                        </div>
                      </div>
                    </div>
                    {/* 悬浮操作：立即运行 / 编辑 / 删除 */}
                    <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                      <button type="button" onClick={() => runNow(task)} disabled={busy} title="立即运行" className="rounded p-1 text-foreground/25 hover:bg-black/[0.06] hover:text-primary focus:outline-none disabled:opacity-50 dark:hover:bg-white/10">
                        {busy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                      </button>
                      <button type="button" onClick={() => openEdit(task)} title="编辑" className="rounded p-1 text-foreground/25 hover:bg-black/[0.06] hover:text-foreground focus:outline-none dark:hover:bg-white/10"><Pencil size={14} /></button>
                      <button type="button" onClick={() => setDeleteTarget(task)} title="删除" className="rounded p-1 text-foreground/25 hover:bg-black/[0.06] hover:text-red-500 focus:outline-none dark:hover:bg-white/10"><Trash2 size={14} /></button>
                    </div>
                  </div>
                  <p className="mb-2 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{describeTask(task)}</p>
                  {/* 上次执行结果摘要（agent_call 执行后写回 payload.last_result） */}
                  {task.payload.last_result && (
                    <div className="mt-3 rounded-lg bg-muted/50 px-3 py-2 text-xs">
                      <div className={cn("mb-1 flex items-center gap-1.5 font-medium", task.payload.last_result.ok ? "text-emerald-700" : "text-destructive")}>
                        {task.payload.last_result.ok ? <Check size={12} /> : <AlertCircle size={12} />}
                        上次执行{task.payload.last_result.ok ? "成功" : "失败"}
                        {task.payload.last_result_time ? <span className="font-normal text-muted-foreground">· {task.payload.last_result_time}</span> : null}
                      </div>
                      {task.payload.last_result.final_message && <p className="line-clamp-3 leading-relaxed text-muted-foreground">{task.payload.last_result.final_message}</p>}
                    </div>
                  )}
                  <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-xs text-muted-foreground">
                    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1">
                      <span className="inline-flex items-center gap-1"><Clock size={12} />{formatInterval(task.interval_sec)}</span>
                      <span>上次运行：{formatTaskTime(task.last_run_at)}</span>
                      <span>下次运行：{formatTaskTime(task.next_run_at)}</span>
                    </div>
                    <Button variant="ghost" size="sm" className="h-6 shrink-0 gap-1 text-xs" onClick={() => toggleEnabled(task)} disabled={busy} title={task.enabled ? "暂停该任务" : "启用该任务"}>
                      {task.enabled ? <Pause size={12} /> : <Play size={12} />}
                      {task.enabled ? "暂停" : "启用"}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </ScrollArea>

      <Dialog open={dialogOpen} onOpenChange={open => { if (!open) closeDialog(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editTarget ? "编辑自动化" : "新建自动化"}</DialogTitle>
            <DialogDescription>配置定时执行的任务；执行间隔为 0 表示只运行一次，运行后自动暂停。</DialogDescription>
          </DialogHeader>
          <div className="mt-4 space-y-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-foreground/70">名称</label>
              <input value={name} onChange={event => setName(event.target.value)} placeholder="例如：每周研究摘要" autoFocus className="w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:border-primary/60" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-foreground/70">任务类型</label>
              <div className="grid grid-cols-2 gap-2">
                {(["agent_call", "usage_query"] as TaskType[]).map(type => (
                  <button key={type} type="button" onClick={() => setTaskType(type)} className={cn("rounded-lg border px-3 py-2 text-left text-sm transition-colors", taskType === type ? "border-primary/60 bg-primary/[0.03]" : "border-border bg-background hover:border-primary/30")}>
                    <span className="block font-medium">{TASK_TYPE_META[type].label}</span>
                    <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">{type === "agent_call" ? "定时让模型完成一轮对话" : "定时执行指定 Key 的用量查询"}</span>
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-foreground/70">执行间隔（秒）</label>
              <input type="number" min={0} value={intervalSec} onChange={event => setIntervalSec(event.target.value)} placeholder="0 表示只执行一次" className="w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:border-primary/60" />
            </div>
            {taskType === "agent_call" ? (
              <>
                <div>
                  <label className="mb-1 block text-xs font-medium text-foreground/70">执行模型</label>
                  {/* 用原生 select 而非 Popover：modal Dialog 内嵌 Popover 存在点击选项被拦截的问题 */}
                  <select value={modelKey} onChange={event => setModelKey(event.target.value)} className="w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:border-primary/60">
                    <option value="">默认模型</option>
                    {models.map(model => <option key={model.key} value={model.key}>{model.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-foreground/70">任务内容（发给模型的消息）</label>
                  <textarea value={userPrompt} onChange={event => setUserPrompt(event.target.value)} rows={3} placeholder="例如：请汇总最近一周的订阅内容，输出一份要点摘要。" className="w-full resize-none rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:border-primary/60" />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-foreground/70">附加指令（可选）</label>
                  <textarea value={instruction} onChange={event => setInstruction(event.target.value)} rows={2} placeholder="例如：以简洁的 Markdown 列表输出。" className="w-full resize-none rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:border-primary/60" />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-foreground/70">启用工具</label>
                  <div className="flex flex-wrap gap-2">
                    {[{ id: "search", label: "联网搜索" }, { id: "image", label: "图像生成" }].map(tool => (
                      <button key={tool.id} type="button" onClick={() => setSelectedTools(prev => prev.includes(tool.id) ? prev.filter(item => item !== tool.id) : [...prev, tool.id])} className={cn("rounded-full border px-3 py-1.5 text-xs font-medium transition-colors", selectedTools.includes(tool.id) ? "border-primary/60 bg-primary/10 text-primary" : "border-border bg-background text-muted-foreground hover:border-primary/30")}>
                        {tool.label}
                      </button>
                    ))}
                  </div>
                  <p className="mt-1 text-[11px] leading-snug text-muted-foreground">开启后模型可在执行时调用对应能力，需要服务端已配置相应的 API Key。</p>
                </div>
              </>
            ) : (
              <div>
                <label className="mb-1 block text-xs font-medium text-foreground/70">Key 别名</label>
                <input value={alias} onChange={event => setAlias(event.target.value)} placeholder="例如：openai-main" className="w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:border-primary/60" />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={closeDialog}>取消</Button>
            <Button onClick={submit} disabled={!name.trim() || (taskType === "agent_call" ? !userPrompt.trim() : !alias.trim()) || saving}>
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
              {saving ? "保存中…" : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteTarget !== null} onOpenChange={open => { if (!open) closeDelete(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除自动化</DialogTitle>
            <DialogDescription>确定删除「{deleteTarget?.name}」吗？此操作不可撤销。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={closeDelete}>取消</Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={deleteTarget !== null && busyTaskId === deleteTarget.id}>
              {deleteTarget !== null && busyTaskId === deleteTarget.id ? <Loader2 size={14} className="animate-spin" /> : null}
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export { TASK_TYPE_META, formatInterval, describeTask, formatTaskTime, AutomationPage };
