// 打字机揭示（TextStreamAnimator）的纯逻辑校验脚本。
//
// chat 仓库没有测试框架，沿用 check:history / check:timeline / check:markdown 的做法：
// 用 esbuild 把纯逻辑模块打成 ESM 到 /tmp，再用 node 直接跑断言。
//
// 覆盖的规则（都是"手改算法就立刻会错"的地方）：
//   1. 逐字揭示 —— 一次给满全文时不会一帧刷完，且按 drainMs 排空
//   2. 时间累积 —— 单帧不足一个字符耗时，游标不推进但时间要留到下一帧
//   3. maxCharsPerFrame —— 单帧上限生效，且被截断的帧不累积盈余时间
//   4. 提交限流 —— minCommitMs 内不重复提交，但收尾帧永远提交
//   5. 前缀不匹配 —— 目标不再以展示为前缀时重置，不拼出乱码
//   6. caughtUp —— 追上目标后不再产出新文本
//
// 改动 src/lib/text-stream-animator.ts 后请运行：
//
//   npm run check:smooth

import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";

const require_ = createRequire(import.meta.url);
const esbuild = require_("esbuild");

const OUT_DIR = "/tmp/smcheck";
mkdirSync(OUT_DIR, { recursive: true });
esbuild.buildSync({
  entryPoints: ["src/lib/text-stream-animator.ts"],
  format: "esm",
  outfile: `${OUT_DIR}/text-stream-animator.mjs`,
  logLevel: "error",
});

const { TextStreamAnimator, DEFAULT_SMOOTH_OPTIONS } = await import(`${OUT_DIR}/text-stream-animator.mjs`);

let fails = 0;
const check = (label, cond, extra = "") => {
  if (!cond) {
    fails += 1;
    console.log("FAIL", label, extra);
    return;
  }
  console.log("ok  ", label, extra);
};

// ---- 默认值应与上游一致 ----
check("默认 drainMs = 250", DEFAULT_SMOOTH_OPTIONS.drainMs === 250);
check("默认 maxCharIntervalMs = 5", DEFAULT_SMOOTH_OPTIONS.maxCharIntervalMs === 5);
check("默认 maxCharsPerFrame = Infinity", DEFAULT_SMOOTH_OPTIONS.maxCharsPerFrame === Infinity);
check("默认 minCommitMs = 0", DEFAULT_SMOOTH_OPTIONS.minCommitMs === 0);

// ---- 1. 逐字揭示：一次给 50 字，不该一帧刷完 ----
{
  const target = "一".repeat(50);
  const animator = new TextStreamAnimator();
  animator.setTarget(target, 0);
  // 首帧只记账（不揭示），这里显式吃掉。
  check("首帧不揭示（只记账）", animator.advance(0) === null);
  // 每字符耗时 = min(5, 250/50) = 5ms；16ms 一帧 → 每帧约 3 字。
  const firstFrame = animator.advance(16);
  check(
    "单帧不会刷出全文",
    firstFrame !== null && firstFrame.length < target.length,
    `首帧揭示 ${firstFrame?.length ?? 0} 字`,
  );
  // 继续跑到追上：总耗时应在 drainMs 量级（50 字 × 5ms = 250ms）。
  let elapsed = 16;
  while (!animator.caughtUp && elapsed < 5000) {
    elapsed += 16;
    animator.advance(elapsed);
  }
  check("在 drainMs 附近排空", animator.caughtUp && elapsed <= 250 + 32, `实际 ${elapsed}ms`);
  check("最终展示等于全文", animator.currentText === target);
}

// ---- 2. 时间累积：单帧不足一个字符耗时也要继续推进 ----
{
  // 积压 3 字，每字符耗时 = min(5, 250/3) = 5ms；帧间隔 2ms → 前两帧推不动。
  const animator = new TextStreamAnimator();
  animator.setTarget("abc", 0);
  animator.advance(0);
  check("第 1 帧（2ms）未达字符耗时 → 不揭示", animator.advance(2) === null);
  check("第 2 帧（4ms）仍未达 → 不揭示", animator.advance(4) === null);
  // 累计 6ms > 5ms：这一帧必须揭示（时间要累积，不能每帧清零）。
  const text = animator.advance(6);
  check("第 3 帧（累计 6ms）揭示第 1 字", text === "a", JSON.stringify(text));
}

// ---- 3. maxCharsPerFrame：上限生效且不累积盈余 ----
{
  const target = "x".repeat(100);
  const animator = new TextStreamAnimator("", { maxCharsPerFrame: 4 });
  animator.setTarget(target, 0);
  animator.advance(0);
  // 给一大段时间（远超 4 字的耗时）：仍只能揭示 4 字。
  const first = animator.advance(10_000);
  check("单帧受 maxCharsPerFrame 限制", first !== null && first.length === 4, `揭示 ${first?.length ?? 0} 字`);
  // 盈余时间必须被清掉：否则下一帧会一次冲过上限。
  const second = animator.advance(10_016);
  check("截断帧不累积盈余（下一帧仍受上限）", second !== null && second.length === 8, `累计 ${second?.length ?? 0} 字`);
}

// ---- 4. 提交限流：minCommitMs 内不重复提交，收尾帧必提交 ----
{
  // 每字符耗时 = min(maxCharIntervalMs=10, drainMs/20=10) = 10ms，
  // 因此 100ms 只揭示 10 字 —— 留出「已揭示但未提交」的中间态。
  const target = "y".repeat(20);
  const animator = new TextStreamAnimator("", { minCommitMs: 100, maxCharIntervalMs: 10, drainMs: 200 });
  animator.setTarget(target, 0);
  animator.advance(0);
  const firstCommit = animator.advance(100);
  check("首次提交发生且只揭示一部分", firstCommit !== null && firstCommit.length === 10, `揭示 ${firstCommit?.length ?? 0} 字`);
  // 紧接着 16ms 后又攒了 1 个字：没到 100ms，视图不该重渲染。
  const blocked = animator.advance(116);
  check("未达 minCommitMs → 不提交", blocked === null, JSON.stringify(blocked));
  // 但游标必须已经推进了（限流只影响提交，不影响揭示）。
  check("限流期间游标仍在推进", animator.currentText.length > (firstCommit?.length ?? 0), `游标 ${animator.currentText.length} 字`);
  // 跑到追上目标的那一帧：无论间隔多短都必须提交，否则动画停在半截。
  let elapsed = 116;
  let lastCommit = null;
  while (!animator.caughtUp && elapsed < 5000) {
    elapsed += 16;
    const text = animator.advance(elapsed);
    if (text !== null) lastCommit = text;
  }
  check("收尾帧必提交（等于全文）", animator.caughtUp && lastCommit === target, `末次提交 ${lastCommit?.length ?? 0} 字`);
}

// ---- 5. 前缀不匹配：重置而不是拼乱码 ----
{
  const animator = new TextStreamAnimator();
  animator.setTarget("第一轮回答", 0);
  animator.advance(0);
  animator.advance(1000);
  check("第一轮已揭示部分", animator.currentText.length > 0, JSON.stringify(animator.currentText));
  // 重试 / 组件被复用：新目标不以当前展示为前缀。
  const reset = animator.setTarget("换了内容", 1000);
  check("前缀不匹配时报重置", reset === true);
  check("重置后展示文本清空", animator.currentText === "", JSON.stringify(animator.currentText));
  check("重置后目标已更新", animator.targetText === "换了内容");
}

// ---- 5b. 前缀匹配：不重置，只换目标 ----
{
  const animator = new TextStreamAnimator();
  animator.setTarget("abc", 0);
  animator.advance(0);
  animator.advance(1000);
  const reset = animator.setTarget("abcdef", 1000);
  check("前缀匹配时不重置", reset === false);
  check("扩展目标后保留已揭示部分", animator.currentText === "abc", JSON.stringify(animator.currentText));
}

// ---- 6. caughtUp：追上之后不再产出 ----
{
  const animator = new TextStreamAnimator();
  animator.setTarget("短", 0);
  animator.advance(0);
  animator.advance(1000);
  check("已追上目标", animator.caughtUp === true);
  check("追上后 advance 返回 null", animator.advance(2000) === null);
  check("追上后剩余字符数为 0", animator.pendingChars === 0);
}

// ---- 7. snapToTarget：立即对齐 ----
{
  const target = "z".repeat(30);
  const animator = new TextStreamAnimator();
  animator.setTarget(target, 0);
  animator.snapToTarget(0);
  check("snapToTarget 立即显示全文", animator.currentText === target);
  check("snapToTarget 后视为已追上", animator.caughtUp === true);
}

// ---- 8. 空串与非法调参 ----
{
  const animator = new TextStreamAnimator();
  animator.setTarget("", 0);
  check("空目标视为已追上", animator.caughtUp === true);
  check("空目标不产出文本", animator.advance(16) === null);
  // 非法值（0 / 负数）必须回落到默认，否则 drainMs / remaining 会算出 0 耗时。
  const patched = new TextStreamAnimator("", { drainMs: 0, maxCharIntervalMs: -1 });
  check("drainMs=0 回落默认", patched.drainMs === DEFAULT_SMOOTH_OPTIONS.drainMs);
  check("maxCharIntervalMs=-1 回落默认", patched.maxCharIntervalMs === DEFAULT_SMOOTH_OPTIONS.maxCharIntervalMs);
}

console.log(fails === 0 ? "\n全部通过" : `\n${fails} 项失败`);
if (fails > 0) process.exitCode = 1;
