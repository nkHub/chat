import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

// 上拉列表项：name 为主文案，description 为副文案。
type SuggestItem = { id: string; name: string; description?: string };
// 上拉分组：`$` 触发时按 Skill / 会话分（后期加工作流）；`/` 触发时是命令组。
type SuggestGroup = { label: string; items: SuggestItem[] };

// 名称/文案里命中 query 的子串加粗高亮（上拉列表本身的匹配加粗，
// 与输入框内不做文本高亮的决策无关——输入框走 chip）。
function highlight(text: string, query: string) {
  const key = query.trim().toLowerCase();
  if (!key) return text;
  const index = text.toLowerCase().indexOf(key);
  if (index < 0) return text;
  return (
    <>
      {text.slice(0, index)}
      <mark className="bg-transparent font-semibold text-primary">{text.slice(index, index + key.length)}</mark>
      {text.slice(index + key.length)}
    </>
  );
}

// 输入框上拉建议面板：以 textarea 上方的绝对定位浮层展示分组列表。
// - groups 由父组件按 trigger 构造并过滤（空分组不上传）；
// - activeIndex 为全局扁平索引（跨分组累计），由父组件的键盘事件驱动；
// - 活跃项变化时滚动进入可视区（block: nearest）。
// - onMouseDown preventDefault：避免点击按钮时 textarea 失焦关闭面板，交给 onClick 选中。
function ComposerSuggest({
  open,
  groups,
  query,
  activeIndex,
  onSelect,
}: {
  open: boolean;
  groups: SuggestGroup[];
  query: string;
  activeIndex: number;
  onSelect: (item: SuggestItem) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !listRef.current) return;
    const active = listRef.current.querySelector<HTMLElement>("[data-active='true']");
    active?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex, groups]);

  if (!open || groups.length === 0) return null;

  // ordinal 为跨分组的扁平索引，逐项累加，与父组件的 activeIndex 对齐。
  let ordinal = 0;

  return (
    <div className="absolute bottom-full left-0 right-0 z-50 mb-2 overflow-hidden rounded-xl border border-border/80 bg-card shadow-xl">
      <div ref={listRef} className="max-h-64 overflow-y-auto p-1.5">
        {groups.map(group => (
          <div key={group.label}>
            <p className="px-2 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{group.label}</p>
            {group.items.map(item => {
              const flatIndex = ordinal++;
              const active = flatIndex === activeIndex;
              return (
                <button
                  key={`${group.label}-${item.id}`}
                  data-active={active}
                  type="button"
                  onMouseDown={event => event.preventDefault()}
                  onClick={() => onSelect(item)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                    active ? "bg-primary/10 text-primary" : "text-foreground hover:bg-muted",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{highlight(item.name, query)}</span>
                  {item.description ? (
                    <span className="max-w-[220px] shrink-0 truncate text-[11px] text-muted-foreground">{highlight(item.description, query)}</span>
                  ) : null}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

export { ComposerSuggest };
export type { SuggestItem, SuggestGroup };