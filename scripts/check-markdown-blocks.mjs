// Markdown 按块切分的纯逻辑校验脚本。
//
// chat 仓库没有测试框架，沿用 check:history / check:timeline 的做法：
// 用 esbuild 把纯逻辑模块打成 ESM 到 /tmp，再用 node 直接跑断言。
//
// 覆盖的规则：
//   1. 切分无损 —— join(split(text)) === text（这是「按块 memo」成立的前提：
//      每块单独渲染后拼起来，必须与整段渲染等价）
//   2. 稳定块 —— 流式追加时，已完成的块保持原样（只让末尾块变化，memo 才有意义）
//   3. 危险边界不切 —— 松散列表 / 表格 / 引用块 / 代码围栏 / 缩进续行
//
// 改动 src/lib/markdown-blocks.ts 后请运行：
//
//   npm run check:markdown

import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";

const require_ = createRequire(import.meta.url);
const esbuild = require_("esbuild");

const OUT_DIR = "/tmp/mdcheck";
mkdirSync(OUT_DIR, { recursive: true });
esbuild.buildSync({
  entryPoints: ["src/lib/markdown-blocks.ts"],
  format: "esm",
  outfile: `${OUT_DIR}/markdown-blocks.mjs`,
  logLevel: "error",
});

const { splitMarkdownBlocks, joinMarkdownBlocks, canSplitBetween, hasOpenFence } = await import(
  `${OUT_DIR}/markdown-blocks.mjs`
);

let fails = 0;
const check = (label, cond, extra = "") => {
  if (!cond) {
    fails += 1;
    console.log("FAIL", label, extra);
    return;
  }
  console.log("ok  ", label, extra);
};

// ---- 切分无损（核心不变量） ----
const samples = [
  "第一段。",
  "第一段。\n\n第二段。",
  "第一段。\n\n第二段。\n\n第三段。",
  "# 标题\n\n正文一段。\n\n## 小标题\n\n正文二段。",
  "- a\n- b\n- c",
  "- a\n\n- b\n\n- c",
  "| h1 | h2 |\n| --- | --- |\n| 1 | 2 |",
  "> 引用一\n\n> 引用二",
  "```js\nconst a = 1;\n\nconst b = 2;\n```",
  "正文。\n\n```python\ndef f():\n\n    return 1\n```\n\n结尾。",
  "1. 第一步\n\n2. 第二步",
  "段落。\n\n- 列表项\n  - 子项\n\n结尾。",
];
for (const sample of samples) {
  const blocks = splitMarkdownBlocks(sample);
  check(`切分无损：${JSON.stringify(sample).slice(0, 28)}…`, joinMarkdownBlocks(blocks) === sample);
}

// ---- 空输入与单段 ----
check("空字符串 → 无块", splitMarkdownBlocks("").length === 0);
check("单段 → 1 块", splitMarkdownBlocks("只有一段").length === 1);
check("两段 → 2 块", splitMarkdownBlocks("甲段。\n\n乙段。").length === 2);

// ---- 稳定块：流式追加时已完成的块不变 ----
const streamed = ["开头一段。", "开头一段。\n\n第二段开始", "开头一段。\n\n第二段内容完整。", "开头一段。\n\n第二段内容完整。\n\n第三段"];
const firstBlocks = splitMarkdownBlocks(streamed[0]);
for (let i = 1; i < streamed.length; i += 1) {
  const blocks = splitMarkdownBlocks(streamed[i]);
  const stable = firstBlocks.every((block, index) => blocks[index] === block);
  check(`流式第 ${i} 帧：已完成块保持原样`, stable, stable ? "" : JSON.stringify(blocks));
}

// ---- 危险边界：不该切 ----
check("松散列表不切（- a / 空行 / - b）", canSplitBetween("- a", "- b") === false);
check("有序列表不切（1. / 2.）", canSplitBetween("1. a", "2. b") === false);
check("表格行不切（| / |）", canSplitBetween("| 1 | 2 |", "| 3 | 4 |") === false);
check("引用块不切（> / >）", canSplitBetween("> a", "> b") === false);
check("HTML 块不切（< / <）", canSplitBetween("<details>", "<summary>") === false);
check("缩进续行不切", canSplitBetween("- 父项", "  - 子项") === false);
check("未闭合围栏内不切", canSplitBetween("```js\ncode", "more code") === false);

// ---- 安全边界：该切 ----
check("普通段落之间切", canSplitBetween("甲段。", "乙段。") === true);
check("段落与标题之间切", canSplitBetween("正文。", "# 标题") === true);
check("列表与后续段落之间切", canSplitBetween("- a\n- b", "结尾段。") === true);
check("闭合围栏之后切", canSplitBetween("```js\ncode\n```", "结尾段。") === true);

// ---- 围栏判定 ----
check("未闭合围栏被识别", hasOpenFence("```js\ncode") === true);
check("闭合围栏不被误判", hasOpenFence("```js\ncode\n```") === false);
check("波浪号围栏同样识别", hasOpenFence("~~~\ncode") === true);

// ---- 渲染等价：分块渲染必须与整段渲染一致 ----
// 这才是真正要保证的不变量。切分无损（join 能还原原文）在排版被切坏时依然成立，
// 所以上面那些断言抓不到「一个列表被切成两个」「有序列表编号重置」这类问题。
const { createElement: h } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const ReactMarkdown = (await import("react-markdown")).default;
const remarkGfm = (await import("remark-gfm")).default;
const remarkMath = (await import("remark-math")).default;
const rehypeKatex = (await import("rehype-katex")).default;

const renderMd = (text) =>
  renderToStaticMarkup(
    h(ReactMarkdown, {
      remarkPlugins: [remarkGfm, remarkMath],
      rehypePlugins: [[rehypeKatex, { strict: false, throwOnError: false }]],
      children: text,
    })
  );

// 块级标签之间的换行是渲染器排版差异，浏览器里不产生视觉区别，归一化后才是「视觉等价」。
// HTML 块（<details> 等）的差异落在文本节点内部、无法这样归一化，故不放进本组用例。
const normalizeHtml = (html) => html.replace(/>\s+</g, "><").replace(/\s+/g, " ").trim();

const renderCases = {
  "嵌套无序列表接兄弟项": "- 父项\n  - 子项一\n  - 子项二\n\n- 第二个父项",
  "嵌套有序列表接兄弟项": "1. 第一步\n   1. 细节一\n   2. 细节二\n\n2. 第二步",
  "三层嵌套列表": "- a\n  - b\n    - c\n\n- d",
  "列表项内代码块": "- 项一\n  ```js\n  const a = 1;\n  ```\n\n- 项二",
  "长文档大纲": "# 说明\n\n正文。\n\n## 目录\n\n- 第一章\n  - 1.1 背景\n  - 1.2 目标\n\n- 第二章\n  - 2.1 方案\n\n## 附录\n\n| 项 | 说明 |\n| - | - |\n| A | 甲 |\n\n结束语。",
  "普通长文": "# 标题\n\n段落一。\n\n## 二级\n\n- 项一\n- 项二\n\n```js\nconst a = 1;\n```",
  "有序松散列表": "1. 第一步\n\n2. 第二步\n\n3. 第三步",
  "表格接段落": "| a | b |\n| - | - |\n| 1 | 2 |\n\n表格后段落。",
};
for (const [name, text] of Object.entries(renderCases)) {
  const whole = normalizeHtml(renderMd(text));
  const split = normalizeHtml(splitMarkdownBlocks(text).map(renderMd).join(""));
  check(`渲染等价：${name}`, whole === split, whole === split ? "" : `\n     整段 ${whole}\n     分块 ${split}`);
}

// ---- 子项结尾接列表项不切（渲染等价的判据层回归） ----
check("子项结尾接列表项不切", canSplitBetween("- 父项\n  - 子项", "- 兄弟项") === false);
check("子项结尾接段落仍切", canSplitBetween("- 父项\n  - 子项", "普通段落。") === true);

console.log(fails === 0 ? "\n全部通过" : `\n${fails} 项失败`);
if (fails > 0) process.exitCode = 1;
