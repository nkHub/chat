// 划选引用（lib/quote）的纯逻辑校验脚本。
//
// chat 仓库没有测试框架，沿用 check:history / check:timeline / check:markdown 的做法：
// 用 esbuild 把纯逻辑模块打成 ESM 到 /tmp，再用 node 直接跑断言。
//
// 覆盖的规则（都是"改坏后引用内容会变形"的地方）：
//   1. 每行都加 `>` —— 多行引用必须仍是一个 blockquote
//   2. 空行输出裸 `>` —— 否则引用块被切断成两段
//   3. 超长截断并补省略号
//   4. 拼接时留空行 —— 否则用户输入被 Markdown 当作引用的惰性续行
//   5. 选区阈值 —— 单个字不弹按钮，避免双击选词时闪
//
// 改动 src/lib/quote.ts 后请运行：
//
//   npm run check:quote

import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";

const require_ = createRequire(import.meta.url);
const esbuild = require_("esbuild");

const OUT_DIR = "/tmp/qcheck";
mkdirSync(OUT_DIR, { recursive: true });
esbuild.buildSync({
  entryPoints: ["src/lib/quote.ts"],
  format: "esm",
  outfile: `${OUT_DIR}/quote.mjs`,
  logLevel: "error",
});

const { QUOTE_MAX_CHARS, formatQuote, isQuotableSelection, joinQuoteAndContent } = await import(
  `${OUT_DIR}/quote.mjs`
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

// ---- 1. 单行与多行 ----
{
  check("单行加 > 前缀", formatQuote("这句话") === "> 这句话", JSON.stringify(formatQuote("这句话")));
  const multi = formatQuote("第一行\n第二行");
  check("多行每行都加 >", multi === "> 第一行\n> 第二行", JSON.stringify(multi));
  // 关键：不能只有首行加前缀，否则第二行掉出引用块。
  check("多行应有两处 >", multi.split("\n").every(line => line.startsWith(">")), JSON.stringify(multi));
}

// ---- 2. 空行 ----
{
  const withBlank = formatQuote("第一段\n\n第二段");
  check("空行输出裸 >", withBlank === "> 第一段\n>\n> 第二段", JSON.stringify(withBlank));
  // 连续多行空行被压成一个。
  const manyBlank = formatQuote("甲\n\n\n\n乙");
  check("连续空行压缩为一行", manyBlank === "> 甲\n>\n> 乙", JSON.stringify(manyBlank));
}

// ---- 3. 截断 ----
{
  const long = "あ".repeat(QUOTE_MAX_CHARS + 500);
  const clipped = formatQuote(long);
  check("超长被截断", clipped.length < long.length, `原 ${long.length} → ${clipped.length}`);
  check("截断补省略号", clipped.endsWith("…"), JSON.stringify(clipped.slice(-6)));
  // 恰好等于上限时不截断、不加省略号。
  const exact = "あ".repeat(QUOTE_MAX_CHARS);
  const exactResult = formatQuote(exact);
  check("恰好等于上限不截断", !exactResult.endsWith("…"), JSON.stringify(exactResult.slice(-6)));
}

// ---- 4. 拼接 ----
{
  check("引用 + 正文留空行", joinQuoteAndContent("> 引用", "提问") === "> 引用\n\n提问", JSON.stringify(joinQuoteAndContent("> 引用", "提问")));
  check("无引用时原样返回", joinQuoteAndContent("", "提问") === "提问");
  check("正文为空时只返回引用", joinQuoteAndContent("> 引用", "   ") === "> 引用");
  // 拼接结果里，用户正文不应以 > 开头（否则会被当成引用）。
  const joined = joinQuoteAndContent("> 引用", "我的问题");
  check("用户正文没被并入引用", joined.split("\n\n")[1] === "我的问题", JSON.stringify(joined));
}

// ---- 5. 选区阈值 ----
{
  check("空选区不可引用", isQuotableSelection("") === false);
  check("空白选区不可引用", isQuotableSelection("   \n  ") === false);
  check("单字不可引用", isQuotableSelection("是") === false);
  check("两字可引用", isQuotableSelection("可以") === true);
  check("长段落可引用", isQuotableSelection("这是一段比较长的文字") === true);
}

// ---- 6. 空输入与空白归一 ----
{
  check("空文本返回空串", formatQuote("") === "");
  check("纯空白返回空串", formatQuote("   \n\t\n  ") === "");
  // 行内多余空格被压缩，避免引用块里出现奇怪的宽间隔。
  check("行内空白压缩", formatQuote("甲    乙") === "> 甲 乙", JSON.stringify(formatQuote("甲    乙")));
  // CRLF 统一成 LF，否则 windows 剪贴板内容会带 \r。
  check("CRLF 归一为 LF", formatQuote("甲\r\n乙") === "> 甲\n> 乙", JSON.stringify(formatQuote("甲\r\n乙")));
}

console.log(fails === 0 ? "\n全部通过" : `\n${fails} 项失败`);
if (fails > 0) process.exitCode = 1;
