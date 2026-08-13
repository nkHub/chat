import type { LucideIcon } from "lucide-react";
import { Brain, Cpu, Monitor, Moon, Pencil, Search, Sun, Wrench, Zap } from "lucide-react";
import type { AssistantDef, ThemeMode, ThemePreset } from "./types";

// 外观模式独立持久化，与会话状态解耦（也方便 index.html 首屏脚本只读该键避免闪烁）。
// 注：聊天会话状态已迁移到 IndexedDB（见 src/lib/chat-store.ts），不再使用 localStorage。
const THEME_MODE_KEY = "aether-ai-theme-mode";
// 主题色独立持久化：key 对应 THEMES 中的 theme.key，读取失败/非法时回退到默认蓝色。
const THEME_KEY = "aether-ai-theme-key";
// 默认系统提示词：内置助手的基础行为约束。
// 包含图片展示约定：模型输出图片时必须用 Markdown 图片语法 ![图片](url) 直接内嵌到回复正文，
// 前端会把该语法渲染为可点击查看的图片，无需额外描述或链接形式。
const AGENT_INSTRUCTIONS = "你是 AetherAI 内置助手，请用中文回复，回答要清晰、准确、可执行。涉及图片时，请直接用 Markdown 图片语法 ![图片](url) 将图片展示在回复正文中。";

// 是否启用「自动生成会话标题」：会话消息每满 10 条时用 /v1/agent 生成一次标题。
// 默认关闭（false），避免每次会话额外消耗一次模型请求；改为 true 可开启。
const AUTO_TITLE_ENABLED = false;

const THEME_MODES: { key: ThemeMode; label: string; icon: LucideIcon }[] = [
  { key: "system", label: "跟随系统", icon: Monitor },
  { key: "light", label: "浅色", icon: Sun },
  { key: "dark", label: "深色", icon: Moon },
];

const THEMES: ThemePreset[] = [
  { key: "blue", label: "蓝色", primary: "#1a56db", secondary: "#eef2ff", accent: "#dbeafe", dark: { primary: "#3b82f6", secondary: "oklch(0.3 0.08 264)", accent: "oklch(0.35 0.09 264)" } },
  { key: "violet", label: "紫色", primary: "#7c3aed", secondary: "#f5f3ff", accent: "#ede9fe", dark: { primary: "#8b5cf6", secondary: "oklch(0.3 0.08 294)", accent: "oklch(0.35 0.09 294)" } },
  { key: "rose", label: "玫瑰", primary: "#e11d48", secondary: "#fff1f2", accent: "#ffe4e6", dark: { primary: "#f43f5e", secondary: "oklch(0.3 0.07 10)", accent: "oklch(0.35 0.08 10)" } },
  { key: "emerald", label: "翠绿", primary: "#059669", secondary: "#ecfdf5", accent: "#d1fae5", dark: { primary: "#10b981", secondary: "oklch(0.3 0.07 160)", accent: "oklch(0.35 0.08 160)" } },
  { key: "amber", label: "琥珀", primary: "#d97706", secondary: "#fffbeb", accent: "#fef3c7", dark: { primary: "#f59e0b", secondary: "oklch(0.31 0.07 75)", accent: "oklch(0.36 0.08 75)" } },
  { key: "slate", label: "石墨", primary: "#334155", secondary: "#f1f5f9", accent: "#e2e8f0", dark: { primary: "#64748b", secondary: "oklch(0.29 0.01 250)", accent: "oklch(0.34 0.01 250)" } },
];

const QUICK_PROMPTS = [
  { icon: Brain, label: "技术答疑", prompt: "帮我解释一下这段代码的含义和潜在问题。" },
  { icon: Zap, label: "效率提升", prompt: "帮我优化以下工作流程，让它更高效。" },
  { icon: Search, label: "深度研究", prompt: "帮我调研并总结该领域的最新进展。" },
  { icon: Wrench, label: "方案设计", prompt: "帮我设计一个可落地的技术方案，包含架构图和步骤。" },
];

const DEFAULT_ASSISTANTS: AssistantDef[] = [
  { id: "researcher", name: "研究助手", description: "梳理资料、提炼重点，快速形成研究结论。", icon: Search, color: "bg-blue-100 text-blue-600" },
  { id: "writer", name: "写作助手", description: "把零散想法整理成清晰、有说服力的文字。", icon: Pencil, color: "bg-violet-100 text-violet-600" },
  { id: "coder", name: "编码助手", description: "分析代码、定位问题，给出可落地的实现建议。", icon: Cpu, color: "bg-emerald-100 text-emerald-600" },
];

export { THEME_MODE_KEY, THEME_KEY, AGENT_INSTRUCTIONS, AUTO_TITLE_ENABLED, THEME_MODES, THEMES, QUICK_PROMPTS, DEFAULT_ASSISTANTS };
