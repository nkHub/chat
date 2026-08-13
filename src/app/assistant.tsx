import { useState } from "react";
import { ArrowRight, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { clearModalResidue } from "./helpers";
import { PageHeader } from "./sidebar";
import type { AssistantDef } from "./types";

function AssistantPage({ sidebarOpen, onToggle, onStart, assistants, onAdd, onEdit, onDelete }: {
  sidebarOpen: boolean;
  onToggle: () => void;
  onStart: (id: string) => void;
  assistants: AssistantDef[];
  onAdd: (name: string, prompt: string) => void;
  onEdit: (id: string, name: string, prompt: string) => void;
  onDelete: (id: string) => void;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AssistantDef | null>(null);
  const [editTarget, setEditTarget] = useState<AssistantDef | null>(null);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");

  // 关闭删除助手弹窗：受控 Dialog 点按钮关闭时不会触发 onOpenChange，
  // 这里统一在关闭时延迟清除 body 残留的滚动/交互锁定。
  const closeDeleteTarget = () => {
    setDeleteTarget(null);
    window.setTimeout(clearModalResidue, 250);
  };

  // 关闭对话框并清空表单，避免残留上次的编辑/添加状态。
  const closeDialog = () => {
    setDialogOpen(false);
    setEditTarget(null);
    setName("");
    setPrompt("");
    window.setTimeout(clearModalResidue, 250);
  };

  // 打开编辑对话框：预填当前助手的名称与提示词。
  const openEdit = (assistant: AssistantDef) => {
    setEditTarget(assistant);
    setName(assistant.name);
    setPrompt(assistant.prompt ?? "");
    setDialogOpen(true);
  };

  const submit = () => {
    const trimmedName = name.trim();
    if (!trimmedName) return;
    if (editTarget) {
      // 编辑模式：名称必填，提示词可为空（为空时保留原提示词）。
      onEdit(editTarget.id, trimmedName, prompt.trim());
    } else {
      const trimmedPrompt = prompt.trim();
      if (!trimmedPrompt) return;
      onAdd(trimmedName, trimmedPrompt);
    }
    closeDialog();
  };

  return (
    <>
      <PageHeader title="助手" subtitle="为不同任务准备一个专属的工作方式" sidebarOpen={sidebarOpen} onToggle={onToggle} />
<ScrollArea className="min-h-0 flex-1 bg-white dark:bg-card">
        <div className="mx-auto max-w-4xl px-4 py-6 sm:px-8">
          <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold">选择一个助手</h2>
              <p className="mt-1 text-sm text-muted-foreground">每个助手都有自己的重点和语气，你可以随时开始新的对话。</p>
            </div>
            <Button className="gap-2" onClick={() => { setEditTarget(null); setName(""); setPrompt(""); setDialogOpen(true); }}><Plus size={15} />添加助手</Button>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            {assistants.map(assistant => {
              const { id, name: assistantName, description, icon: Icon, color } = assistant;
              return (
                <div key={id} className="group relative flex flex-col rounded-xl border bg-card p-4 shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md">
                  <div className="absolute right-2 top-2 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                    <button type="button" onClick={event => { event.stopPropagation(); openEdit(assistant); }} className="rounded p-1 text-foreground/25 hover:bg-black/[0.06] hover:text-foreground focus:outline-none dark:hover:bg-white/10" title="编辑助手"><Pencil size={14} /></button>
                    <button type="button" onClick={event => { event.stopPropagation(); setDeleteTarget(assistant); }} className="rounded p-1 text-foreground/25 hover:bg-black/[0.06] hover:text-red-500 focus:outline-none dark:hover:bg-white/10" title="删除助手"><Trash2 size={14} /></button>
                  </div>
                  <button type="button" onClick={() => onStart(id)} className="flex w-full flex-1 flex-col text-left">
                    <div className="mb-3 flex items-center gap-2">
                      <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg", color)}><Icon size={17} /></div>
                      <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">{assistantName}</h3>
                    </div>
                    <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">{description}</p>
                    <div className="mt-auto flex items-center gap-1 pt-5 text-xs font-medium text-primary opacity-70 transition-opacity group-hover:opacity-100">开始使用<ArrowRight size={12} /></div>
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </ScrollArea>
      <Dialog open={dialogOpen} onOpenChange={open => { if (!open) closeDialog(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editTarget ? "编辑助手" : "添加助手"}</DialogTitle>
            <DialogDescription>{editTarget ? "修改名称或提示词，提示词将作为该助手的系统指令。" : "填写名称和提示词，创建专属助手。提示词将作为该助手的系统指令。"}</DialogDescription>
          </DialogHeader>
          <div className="mt-4 space-y-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-foreground/70">名称</label>
              <input value={name} onChange={event => setName(event.target.value)} placeholder="例如：翻译助手" autoFocus className="w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:border-primary/60" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-foreground/70">提示词</label>
              <textarea value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="例如：你是资深翻译，请把用户内容译为地道的中文。" rows={4} className="w-full resize-none rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:border-primary/60" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={closeDialog}>取消</Button>
            <Button onClick={submit} disabled={!name.trim() || (!editTarget && !prompt.trim())}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={deleteTarget !== null} onOpenChange={open => { if (!open) closeDeleteTarget(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除助手</DialogTitle>
            <DialogDescription>确定删除助手「{deleteTarget?.name}」吗？已开始的会话不受影响，此操作不可撤销。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={closeDeleteTarget}>取消</Button>
            <Button variant="destructive" onClick={() => { if (deleteTarget) onDelete(deleteTarget.id); closeDeleteTarget(); }}>删除</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export { AssistantPage };
