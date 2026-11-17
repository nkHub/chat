// 输入框历史游标（lib/input-history）的纯逻辑校验脚本。
//
// chat 仓库没有测试框架，沿用 check:history / check:timeline / check:markdown 的做法：
// 用 esbuild 把纯逻辑模块打成 ESM 到 /tmp，再用 node 直接跑断言。
//
// 覆盖的规则（都是"改坏就直接毁掉用户正在输入的内容"的地方）：
//   1. 草稿保护 —— 进历史再翻回来，用户原本打的字必须一字不差地还原
//   2. 下标方向 —— 下标 0 是最新一条，↑ 越旧、↓ 越新
//   3. 边界不回绕 —— 到最旧一条继续按 ↑ 停在原地
//   4. 让位规则 —— 弹层打开 / 输入法合成中 / 光标不在第一行时不抢 ↑↓
//   5. 派生口径 —— 只取 user、非空、最新在前、按 limit 截断
//
// 改动 src/lib/input-history.ts 后请运行：
//
//   npm run check:history-input

import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";

const require_ = createRequire(import.meta.url);
const esbuild = require_("esbuild");

const OUT_DIR = "/tmp/ihcheck";
mkdirSync(OUT_DIR, { recursive: true });
esbuild.buildSync({
  entryPoints: ["src/lib/input-history.ts"],
  format: "esm",
  outfile: `${OUT_DIR}/input-history.mjs`,
  logLevel: "error",
});

const {
  EMPTY_INPUT_HISTORY,
  deriveInputHistory,
  historyDown,
  historyUp,
  resetInputHistory,
  shouldHandleHistoryKey,
} = await import(`${OUT_DIR}/input-history.mjs`);

let fails = 0;
const check = (label, cond, extra = "") => {
  if (!cond) {
    fails += 1;
    console.log("FAIL", label, extra);
    return;
  }
  console.log("ok  ", label, extra);
};

// 历史条目：下标 0 为最新一条。
const HISTORY = ["最新问题", "中间问题", "最早问题"];

// ---- 1. 草稿保护（最关键）----
{
  const draft = "我还没打完的半句";
  const up1 = historyUp(EMPTY_INPUT_HISTORY, draft, HISTORY);
  check("第一次 ↑ 进入最新一条", up1.text === "最新问题", up1.text);
  check("第一次 ↑ 记下草稿", up1.state.draft === draft, up1.state.draft);

  const up2 = historyUp(up1.state, up1.text, HISTORY);
  check("第二次 ↑ 更旧一条", up2.text === "中间问题", up2.text);
  const up3 = historyUp(up2.state, up2.text, HISTORY);
  check("第三次 ↑ 到最旧一条", up3.text === "最早问题", up3.text);

  const down1 = historyDown(up3.state, up3.text, HISTORY);
  check("↓ 回到较新一条", down1.text === "中间问题", down1.text);
  const down2 = historyDown(down1.state, down1.text, HISTORY);
  check("↓ 回到最新一条", down2.text === "最新问题", down2.text);
  const down3 = historyDown(down2.state, down2.text, HISTORY);
  check("再 ↓ 退出历史并还原草稿", down3.text === draft, down3.text);
  check("退出后游标归位", down3.state.index === null, String(down3.state.index));
}

// ---- 2. 下标方向 ----
{
  const up = historyUp(EMPTY_INPUT_HISTORY, "草稿", HISTORY);
  check("下标 0 指向最新一条", up.text === HISTORY[0], up.text);
  const up2 = historyUp(up.state, up.text, HISTORY);
  check("下标递增 = 更旧", up2.text === HISTORY[1], up2.text);
}

// ---- 3. 边界不回绕 ----
{
  let state = EMPTY_INPUT_HISTORY;
  let text = "草稿";
  // 一直按 ↑ 到底。
  for (let index = 0; index < HISTORY.length; index += 1) {
    const step = historyUp(state, text, HISTORY);
    state = step.state;
    text = step.text;
  }
  check("已到最旧一条", text === "最早问题", text);
  const overshoot = historyUp(state, text, HISTORY);
  check("最旧一条继续 ↑ 停在原地（不回绕）", overshoot.text === "最早问题", overshoot.text);
  check("越界时状态不变", overshoot.state === state);
}

// ---- 4. 让位规则 ----
{
  check("弹层打开时让位", shouldHandleHistoryKey({ suggestOpen: true, composing: false, caretAtFirstLine: true }) === false);
  check("输入法合成中让位", shouldHandleHistoryKey({ suggestOpen: false, composing: true, caretAtFirstLine: true }) === false);
  check("光标不在第一行时让位", shouldHandleHistoryKey({ suggestOpen: false, composing: false, caretAtFirstLine: false }) === false);
  check("三个条件都满足才接管", shouldHandleHistoryKey({ suggestOpen: false, composing: false, caretAtFirstLine: true }) === true);
}

// ---- 5. 派生口径 ----
{
  const messages = [
    { role: "user", content: "第一问" },
    { role: "assistant", content: "回答一" },
    { role: "user", content: "   " },
    { role: "user", content: "第二问" },
    { role: "user", content: "第三问" },
  ];
  const derived = deriveInputHistory(messages);
  check("只取 user 且跳过空白", derived.length === 3, JSON.stringify(derived));
  check("最新在前", derived[0] === "第三问", derived[0]);
  check("最旧在后", derived[derived.length - 1] === "第一问", derived[derived.length - 1]);
  check("limit 生效", deriveInputHistory(messages, 2).length === 2);
  check("空列表返回空", deriveInputHistory([]).length === 0);
  // 不按内容去重：连问两次同一句是正常操作。
  const repeated = deriveInputHistory([{ role: "user", content: "同一句" }, { role: "user", content: "同一句" }]);
  check("重复内容不去重", repeated.length === 2, JSON.stringify(repeated));
}

// ---- 6. 空历史与重置 ----
{
  const result = historyUp(EMPTY_INPUT_HISTORY, "草稿", []);
  check("历史为空时 ↑ 不改变输入", result.text === "草稿", result.text);
  check("历史为空时状态不变", result.state === EMPTY_INPUT_HISTORY);
  const reset = resetInputHistory();
  check("重置回到初始状态", reset.index === null && reset.draft === "");
  const down = historyDown(EMPTY_INPUT_HISTORY, "草稿", HISTORY);
  check("不在历史中时 ↓ 不做事", down.text === "草稿", down.text);
}

console.log(fails === 0 ? "\n全部通过" : `\n${fails} 项失败`);
if (fails > 0) process.exitCode = 1;
