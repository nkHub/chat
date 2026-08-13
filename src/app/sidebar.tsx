import { useContext, useEffect, useState } from "react";
import { ArrowRight, Bot, ChevronDown, Check, Cpu, MessageSquare, PanelLeftClose, PanelLeftOpen, Pencil, Plus, Settings, Trash2, Workflow as WorkflowIcon, Zap } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { QUICK_PROMPTS, THEME_MODES, THEMES } from "./constants";
import { formatRelativeTime } from "./helpers";
import { ThemeContext } from "./theme";
import type { ChatModel, Session } from "./types";

// 右上角设置入口：外观模式（跟随系统/浅色/深色）与主题色选择。
// 原位于侧栏底部，随用户区移除后挪到主界面头部右上角；主题状态来自全局 ThemeContext。
function ThemeSettingsPopover() {
  const theme = useContext(ThemeContext);
  if (!theme) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="h-7 w-7 text-foreground/40 hover:bg-black/[0.06] hover:text-foreground/70 dark:hover:bg-white/10"><Settings size={13} /></Button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" sideOffset={8} className="w-72 p-3">
        <p className="mb-2 text-xs font-semibold text-foreground">外观</p>
        <div className="mb-3 grid grid-cols-3 gap-1 rounded-lg bg-muted p-1">{THEME_MODES.map(({ key, label, icon: Icon }) => <button key={key} type="button" onClick={() => theme.onThemeModeChange(key)} className={cn("flex items-center justify-center gap-1 rounded-md px-1 py-1.5 text-xs transition-colors", theme.themeMode === key ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}><Icon size={12} /><span>{label}</span></button>)}</div>
        <p className="mb-2.5 text-xs font-semibold text-foreground">主题色</p>
        <div className="grid grid-cols-3 gap-2">{THEMES.map(themePreset => <button key={themePreset.key} type="button" onClick={() => theme.onThemeChange(themePreset)} className={cn("flex flex-col items-center gap-1.5 rounded-lg border px-2 py-2 transition-all hover:bg-muted", theme.activeTheme === themePreset.key ? "border-primary bg-primary/5" : "border-border")}><span className="h-5 w-5 rounded-full" style={{ background: themePreset.primary, boxShadow: theme.activeTheme === themePreset.key ? `0 0 0 2px white, 0 0 0 4px ${themePreset.primary}` : "none" }} /><span className="text-xs leading-none text-muted-foreground">{themePreset.label}</span></button>)}</div>
      </PopoverContent>
    </Popover>
  );
}

function Sidebar({
  open,
  activePage,
  sessions,
  activeSession,
  editingId,
  onPageChange,
  onNewSession,
  onSessionChange,
  onStartEdit,
  onSaveEdit,
  onCloseEdit,
  onDeleteSession,
  onReorderSessions,
  onClose,
}: {
  open: boolean;
  activePage: string;
  sessions: Session[];
  activeSession: string;
  editingId: string | null;
  onPageChange: (page: string) => void;
  onNewSession: () => void;
  onSessionChange: (id: string) => void;
  onStartEdit: (id: string) => void;
  onSaveEdit: (id: string, title: string) => void;
  onCloseEdit: () => void;
  onDeleteSession: (id: string) => void;
  onReorderSessions: (fromId: string, toId: string) => void;
  onClose: () => void;
}) {
  const [editValue, setEditValue] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  // 相对时间的"当前时刻"：每分钟刷新一次；从后台切回页面时（visibilitychange）立即刷新，
  // 保证会话列表的"x 分钟前/x 小时前"等时间显示保持新鲜。
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60000);
    const handleVisibility = () => {
      if (document.visibilityState === "visible") setNow(new Date());
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, []);
  const links = [
    { icon: MessageSquare, label: "对话", page: "chat", plus: true },
    { icon: Cpu, label: "助手", page: "assistant", plus: false },
    { icon: WorkflowIcon, label: "工作流", page: "workflow", plus: false },
    { icon: Zap, label: "自动化", page: "automation", plus: false },
  ];
  return (
    <>
      {open && <button type="button" aria-label="关闭侧栏" className="fixed inset-0 z-30 bg-black/20 md:hidden" onClick={onClose} />}
      <aside className={cn("fixed inset-y-0 left-0 z-40 flex shrink-0 flex-col overflow-hidden border-r border-black/[0.06] bg-[#f2f3f5] transition-all duration-200 md:relative md:inset-auto md:z-auto dark:bg-sidebar", open ? "w-[240px]" : "w-0 border-r-0") }>
        <div className={cn("flex h-full w-[240px] flex-col transition-opacity duration-150", open ? "opacity-100" : "opacity-0")}>
          <div className="flex items-center gap-2.5 border-b border-black/[0.06] px-4 py-[15px]">
            <Avatar className="h-7 w-7 rounded-md"><AvatarFallback className="rounded-md bg-primary text-primary-foreground"><Bot size={14} /></AvatarFallback></Avatar>
            <span className="text-sm font-semibold tracking-tight text-foreground">AetherAI</span>
            <button type="button" aria-label="收起侧栏" className="ml-auto rounded p-1 text-foreground/40 hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/10 md:hidden" onClick={onClose}><PanelLeftClose size={14} /></button>
          </div>
          <div className="space-y-0.5 px-2 pb-1 pt-3">
            {links.map(({ icon: Icon, label, page, plus }) => (
              <button key={page} type="button" onClick={() => onPageChange(page)} className={cn("group flex w-full items-center gap-2.5 rounded-md px-2.5 py-[7px] text-sm font-medium transition-colors", page === activePage ? "bg-black/[0.07] text-foreground dark:bg-white/10" : "text-foreground/50 hover:bg-black/[0.05] hover:text-foreground/80 dark:hover:bg-white/10 dark:hover:text-foreground")}>
                <Icon size={13} /><span className="flex-1 text-left">{label}</span>
                {plus && <span onClick={event => { event.stopPropagation(); onNewSession(); }} className="rounded p-0.5 opacity-40 transition-opacity hover:bg-black/[0.08] hover:opacity-100 group-hover:opacity-70 dark:hover:bg-white/10"><Plus size={13} /></span>}
              </button>
            ))}
          </div>
          <ScrollArea className="min-h-0 flex-1 px-2">
            <p className="px-2.5 py-1.5 text-sm font-semibold uppercase tracking-widest text-foreground/30">最近对话</p>
            {sessions.map(session => (
              <ContextMenu key={session.id}>
                <ContextMenuTrigger asChild>
                  <div
                    draggable
                    onDragStart={() => setDragId(session.id)}
                    onDragOver={event => {
                      event.preventDefault();
                      if (dragId && dragId !== session.id && overId !== session.id) setOverId(session.id);
                    }}
                    onDragLeave={() => { if (overId === session.id) setOverId(null); }}
                    onDrop={event => {
                      event.preventDefault();
                      if (dragId && dragId !== session.id) onReorderSessions(dragId, session.id);
                      setDragId(null);
                      setOverId(null);
                    }}
                    onDragEnd={() => { setDragId(null); setOverId(null); }}
                    onClick={() => onSessionChange(session.id)}
                    className={cn("mb-0.5 flex w-full cursor-pointer select-none items-center gap-1 rounded-md px-2.5 py-2 text-left transition-colors", dragId === session.id && "opacity-40", overId === session.id && "outline-2 outline-dashed outline-primary", session.id === activeSession ? "bg-primary/10 text-primary" : "text-foreground/55 hover:bg-black/[0.05] hover:text-foreground/80 dark:hover:bg-white/10 dark:hover:text-foreground")}
                  >
                    <span className="min-w-0 flex-1 truncate text-sm leading-snug">{session.title}</span>
                    <span className="shrink-0 whitespace-nowrap text-xs text-foreground/30">{formatRelativeTime(session.time, now)}</span>
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent className="w-44">
                  <ContextMenuItem onClick={() => { setEditValue(session.title); onStartEdit(session.id); }} className="cursor-pointer gap-2 text-xs"><Pencil size={13} className="text-muted-foreground" />编辑标题</ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem onClick={() => onDeleteSession(session.id)} className="cursor-pointer gap-2 text-xs text-destructive focus:bg-destructive/10 focus:text-destructive"><Trash2 size={13} />删除会话</ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            ))}
          </ScrollArea>
        </div>
      </aside>
      <Dialog
        open={editingId !== null}
        onOpenChange={open => {
          if (!open) onCloseEdit();
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>编辑会话标题</DialogTitle>
            <DialogDescription>修改后点击保存，或按 Esc / 点取消放弃。</DialogDescription>
          </DialogHeader>
          <input
            autoFocus
            value={editValue}
            onChange={event => setEditValue(event.target.value)}
            onKeyDown={event => {
              if (event.key === "Enter" && editingId) onSaveEdit(editingId, editValue);
            }}
            className="mt-2 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary/40"
          />
          <DialogFooter>
            <Button variant="ghost" onClick={onCloseEdit}>取消</Button>
            <Button onClick={() => editingId && onSaveEdit(editingId, editValue)}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function PageHeader({ title, subtitle, sidebarOpen, onToggle }: { title: string; subtitle: string; sidebarOpen: boolean; onToggle: () => void }) {
  return <header className="flex shrink-0 items-center gap-2 border-b border-black/[0.06] bg-white px-4 py-3 dark:border-border dark:bg-card"><Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-sm" className="h-7 w-7 text-foreground/40 hover:text-foreground/70" onClick={onToggle}>{sidebarOpen ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}</Button></TooltipTrigger><TooltipContent>{sidebarOpen ? "收起侧栏" : "展开侧栏"}</TooltipContent></Tooltip><div><h1 className="text-sm font-semibold leading-tight text-foreground">{title}</h1><p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p></div><div className="ml-auto"><ThemeSettingsPopover /></div></header>;
}

function EmptyChat({ onPrompt }: { onPrompt: (prompt: string) => void }) {
  return <div className="flex flex-col items-center px-4 pb-6 pt-16"><div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10"><Bot size={22} className="text-primary" /></div><h2 className="mb-1 text-xl font-semibold text-foreground">开始对话</h2><p className="mb-10 text-sm text-muted-foreground">选择一个快捷提问，或直接输入你的问题</p><div className="grid w-full max-w-lg grid-cols-1 gap-3 sm:grid-cols-2">{QUICK_PROMPTS.map(({ icon: Icon, label, prompt }) => <button key={label} type="button" onClick={() => onPrompt(prompt)} className="group flex flex-col gap-2 rounded-xl border bg-card px-4 py-3.5 text-left shadow-sm transition-all hover:border-primary/40 hover:bg-primary/[0.02] hover:shadow-md"><div className="flex items-center gap-2"><div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10 transition-colors group-hover:bg-primary/15"><Icon size={14} className="text-primary" /></div><span className="text-xs font-semibold text-foreground/80">{label}</span></div><p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">{prompt}</p><ArrowRight size={12} className="self-end text-primary/40 transition-colors group-hover:text-primary/70" /></button>)}</div></div>;
}

function ModelSettingsPopover({
  model,
  models,
  modelsLoading,
  modelsError,
  onModelChange,
  onReloadModels,
}: {
  model: ChatModel | null;
  models: ChatModel[];
  modelsLoading: boolean;
  modelsError: string | null;
  onModelChange: (model: ChatModel) => void;
  onReloadModels: () => void;
}) {
  const modelLabel = model?.label || (modelsLoading ? "加载模型中…" : "未选择模型");
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" disabled={modelsLoading} className="h-7 max-w-[220px] gap-1.5 rounded-full bg-muted/60 px-2.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
          <Cpu size={13} className="shrink-0" />
          <span className="truncate">{modelLabel}</span>
          <ChevronDown size={11} className="shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" sideOffset={8} className="w-72 p-1.5">
        <div className="max-h-64 space-y-0.5 overflow-y-auto">
          {modelsLoading ? <p className="px-2 py-3 text-xs text-muted-foreground">正在读取 /v1/models…</p> : models.length ? models.map(item => <button key={item.key} type="button" onClick={() => { onModelChange(item); setOpen(false); }} className="flex w-full items-center justify-between gap-3 rounded-md px-2 py-2 text-left text-xs transition-colors hover:bg-muted"><span className="min-w-0 truncate">{item.label}</span>{model?.key === item.key && <Check size={12} className="shrink-0 text-primary" />}</button>) : <div className="px-2 py-3 text-xs text-muted-foreground">{modelsError || "暂无可用模型"}</div>}
        </div>
        {modelsError && <button type="button" className="mt-1 w-full border-t px-2 pt-2 text-left text-xs text-destructive underline underline-offset-2" onClick={onReloadModels}>重试读取模型</button>}

      </PopoverContent>
    </Popover>
  );
}

export { ThemeSettingsPopover, Sidebar, PageHeader, EmptyChat, ModelSettingsPopover };
