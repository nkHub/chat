// Markdown 代码块的语法高亮。
//
// 只注册实际用得到的语言：highlight.js 全量语言包体积很大（~1MB），而聊天里出现的
// 基本就是前端（js/ts/html/css/json）、后端（python/php/java/go 等）与脚本/配置。
// 语言别名（js/jsx/ts/tsx/html/sh/shell…）由各语言定义自带，getLanguage 会自动解析。
//
// 代码块本身是固定深色底（见 markdown.tsx 的 CodeBlock），两种主题外观一致，
// 所以这里只需要一套深色配色（样式见 styles/theme.css 的 .code-hl 段）。
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import less from "highlight.js/lib/languages/less";
import lua from "highlight.js/lib/languages/lua";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

const LANGUAGES = {
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  dockerfile,
  go,
  ini,
  java,
  javascript,
  json,
  kotlin,
  less,
  lua,
  markdown,
  php,
  powershell,
  python,
  ruby,
  rust,
  scss,
  sql,
  swift,
  typescript,
  xml,
  yaml,
} as const;

for (const [name, definition] of Object.entries(LANGUAGES)) {
  hljs.registerLanguage(name, definition);
}

// 超过这个长度的代码不做高亮：一次性对几十 KB 的代码做词法分析会明显卡住输入/滚动，
// 而聊天里的代码块几乎不会到这个量级。超长代码回落成纯文本，观感与改动前一致。
const MAX_HIGHLIGHT_CHARS = 20000;

/**
 * 把代码高亮成 HTML 片段；返回 null 表示「不高亮」，调用方回落成纯文本。
 *
 * - 未知/未标注语言返回 null（不做自动检测：highlightAuto 需要全量语言包，且容易误判）；
 * - 高亮过程出错也返回 null —— 代码块关系到可复制性，宁可没颜色也不能让它消失；
 * - 返回值已由 highlight.js 做 HTML 转义，可安全用于 dangerouslySetInnerHTML。
 */
export function highlightCode(code: string, language: string): string | null {
  const lang = language.trim().toLowerCase();
  if (!lang || code.length > MAX_HIGHLIGHT_CHARS) return null;
  if (!hljs.getLanguage(lang)) return null;
  try {
    return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}
