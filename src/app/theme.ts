import { createContext } from "react";
import type { ThemeMode, ThemePreset } from "./types";

// 主题设置上下文：把外观/主题色状态提到全局，右上角设置入口（ThemeSettingsPopover）
// 可直接取用，避免给每个页面组件逐层传递 theme 相关 props。
const ThemeContext = createContext<{
  activeTheme: string;
  onThemeChange: (theme: ThemePreset) => void;
  themeMode: ThemeMode;
  onThemeModeChange: (mode: ThemeMode) => void;
} | null>(null);

function applyTheme(theme: ThemePreset, dark = false) {
  // 深色模式下使用 theme.dark 配色：primary 保持主题色，secondary/accent 用暗色避免刺眼。
  const colors = dark ? theme.dark : theme;
  const root = document.documentElement;
  root.style.setProperty("--primary", colors.primary);
  root.style.setProperty("--primary-foreground", "#ffffff");
  root.style.setProperty("--secondary", colors.secondary);
  root.style.setProperty("--secondary-foreground", dark ? "#f8fafc" : theme.primary);
  root.style.setProperty("--accent", colors.accent);
  root.style.setProperty("--accent-foreground", dark ? "#f8fafc" : theme.primary);
  root.style.setProperty("--ring", colors.primary);
  root.style.setProperty("--sidebar-primary", colors.primary);
}

export { ThemeContext, applyTheme };
