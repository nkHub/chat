// highlight.js 的语言包没有自带 d.ts（只有 core 有），这里补一个通配声明，
// 让 `import python from "highlight.js/lib/languages/python"` 拿到正确的类型。
declare module "highlight.js/lib/languages/*" {
  import type { LanguageFn } from "highlight.js";
  const language: LanguageFn;
  export default language;
}
