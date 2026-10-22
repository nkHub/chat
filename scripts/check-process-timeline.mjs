// 过程时间线的纯逻辑边界校验脚本。
//
// chat 仓库没有测试框架，沿用 check:history 的做法：用 esbuild 把纯逻辑模块
// 打包成 ESM 到 /tmp，再用 node 直接跑断言。覆盖两块最容易回归的规则：
//   1. lib/process-groups.ts —— 段分组（text 打断、连续步骤聚合、special 隔离、耗时口径）
//   2. lib/step-labels.ts    —— 文案降级（未知工具、错误摘要、参数优先级、时长格式化）
//
// 改动上面两个文件后请运行：
//
//   npm run check:timeline

import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";

// 本机 node_modules/esbuild 的 CLI 软链是断的（被 .ignored 收走），因此这里不用
// `esbuild` 命令，改用它的 Node API 打包；打包结果仍然是纯 ESM，可直接 import。
const require_ = createRequire(import.meta.url);
const esbuild = require_("esbuild");

const OUT_DIR = "/tmp/tlcheck";
mkdirSync(OUT_DIR, { recursive: true });
for (const name of ["process-groups", "step-labels"]) {
  esbuild.buildSync({
    entryPoints: [`src/lib/${name}.ts`],
    format: "esm",
    outfile: `${OUT_DIR}/${name}.mjs`,
    logLevel: "error",
  });
}

const { groupSegments, processDurationMs, stepDurationMs } = await import(`${OUT_DIR}/process-groups.mjs`);
const { describeStep, describeStepTarget, formatDuration, summarizeStepResult, summarizeThinking } = await import(
  `${OUT_DIR}/step-labels.mjs`
);

// ---- 断言小工具 ----
let fails = 0;
const check = (label, cond, extra = "") => {
  if (!cond) {
    fails += 1;
    console.log("FAIL", label, extra);
    return;
  }
  console.log("ok  ", label, extra);
};

// 便捷构造器：让断言读起来接近真实数据形态
const think = (content, startedAt, endedAt) => ({ type: "thinking", content, startedAt, endedAt });
const text = content => ({ type: "text", content });
const tool = (name, params, result, status = "success", startedAt, endedAt) => ({
  type: "tool",
  name,
  params,
  result,
  status,
  startedAt,
  endedAt,
});

// ---- 分组：基础形态 ----
check("空段序列 → 空块", groupSegments([]).length === 0);

const onlyText = groupSegments([text("你好")]);
check("纯正文 → 1 个 text 块", onlyText.length === 1 && onlyText[0].kind === "text");

const mixed = groupSegments([think("先想一想", 100, 200), tool("akm_read_file", { path: "a.md" }, '{"ok":true}', "success", 300, 500), text("好了")]);
check("思考+工具+正文 → process(2 步) + text", mixed.length === 2 && mixed[0].kind === "process" && mixed[0].stepCount === 2 && mixed[1].kind === "text");
check("process 保留原始段下标", mixed[0].segmentIndexes.join(",") === "0,1");

const threeTools = groupSegments([tool("a"), tool("b"), tool("c")]);
check("连续 3 个工具 → 一个 process 块（3 步）", threeTools.length === 1 && threeTools[0].stepCount === 3);

const textBreaks = groupSegments([tool("a"), text("中间正文"), tool("b")]);
check("text 打断分组 → 3 个块", textBreaks.length === 3 && textBreaks[0].kind === "process" && textBreaks[1].kind === "text" && textBreaks[2].kind === "process");

const blankThinking = groupSegments([think("   "), tool("a")]);
check("空白思考段被丢弃（不占步骤）", blankThinking.length === 1 && blankThinking[0].stepCount === 1);

const emptyText = groupSegments([text("")]);
check("空 text 段仍输出（交给渲染层过滤）", emptyText.length === 1 && emptyText[0].kind === "text");

// ---- 分组：special 工具隔离（子 Agent 卡片不能被卷进时间线） ----
const special = groupSegments([tool("a"), tool("akm_subagent_spawn", {}, null, "running"), tool("b")], {
  isSpecialTool: name => name === "akm_subagent_spawn",
});
check(
  "special 工具单独成块且打断前后过程组",
  special.length === 3 && special[0].kind === "process" && special[1].kind === "special" && special[2].kind === "process",
);
check("special 块保留工具名与原下标", special[1].segment.name === "akm_subagent_spawn" && special[1].segmentIndex === 1);

const specialNoOption = groupSegments([tool("akm_subagent_spawn")]);
check("未传 isSpecialTool 时不做隔离（向后兼容）", specialNoOption.length === 1 && specialNoOption[0].kind === "process");

// ---- 状态标记 ----
const withError = groupSegments([tool("a", {}, '{"error":"boom"}', "error"), tool("b", {}, null, "running")]);
check("失败步 → hasError", withError[0].hasError === true);
check("进行中步 → hasRunning", withError[0].hasRunning === true);
check("全部完成 → hasError/hasRunning 均为 false", mixed[0].hasError === false && mixed[0].hasRunning === false);

// ---- 耗时口径 ----
check("单步耗时：起止齐全", stepDurationMs({ kind: "tool", startedAt: 100, endedAt: 400 }) === 300);
check("单步耗时：缺 endedAt → 0", stepDurationMs({ kind: "tool", startedAt: 100 }) === 0);
check("单步耗时：end < start → 0（不返回负数）", stepDurationMs({ kind: "tool", startedAt: 500, endedAt: 400 }) === 0);

const spanSteps = [
  { kind: "thinking", content: "x", startedAt: 1000, endedAt: 1500 },
  { kind: "tool", name: "a", params: {}, result: null, status: "success", startedAt: 2000, endedAt: 2500 },
];
check("整组耗时取首步开始→末步结束的跨度（含间隙）", processDurationMs(spanSteps) === 1500);

const noSpanSteps = [
  { kind: "tool", name: "a", params: {}, result: null, status: "success", startedAt: 100, endedAt: 400 },
  { kind: "tool", name: "b", params: {}, result: null, status: "success", startedAt: 900, endedAt: 1200 },
];
// 末步缺 endedAt 时无法取跨度，退化为累加各步耗时
const partialSpan = [
  { kind: "tool", name: "a", params: {}, result: null, status: "success", startedAt: 100, endedAt: 400 },
  { kind: "tool", name: "b", params: {}, result: null, status: "running", startedAt: 900 },
];
check("缺末步结束时间 → 退化为各步耗时之和", processDurationMs(partialSpan) === 300);
check("完全无时间戳 → 0（组件据此不显示时长）", processDurationMs([{ kind: "thinking", content: "x" }]) === 0);
check("正常跨度下不参与累加", processDurationMs(noSpanSteps) === 1100);

// ---- 文案：工具名 → 人话 ----
check("已知工具翻译", describeStep("akm_read_file").action === "阅读文件");
check("未知工具回落工具名（去掉 akm_ 前缀）", describeStep("akm_not_registered_yet").action === "not_registered_yet");
check("空工具名回落占位文案", describeStep("").action === "工具调用");
check("语气字段参与图标选择", describeStep("tavily_search").tone === "net");

// ---- 文案：参数摘要 ----
check("参数优先取 path", describeStepTarget({ path: "/tmp/a.md", query: "x" }) === "/tmp/a.md");
check("无 path 时取 query", describeStepTarget({ query: "库存 SBBP007" }) === "库存 SBBP007");
check("数字参数也可作为对象", describeStepTarget({ task_id: 42 }) === "42");
check("无可用参数 → 空串", describeStepTarget({}) === "");
check("非对象参数 → 空串", describeStepTarget(null) === "");
const longTarget = describeStepTarget({ command: "a".repeat(200) });
check("超长参数被截断并补省略号", longTarget.length === 160 && longTarget.endsWith("…"));

// ---- 文案：结果摘要 ----
check("结构化 error → 失败：原因", summarizeStepResult('{"error":"文件不存在"}').startsWith("失败："));
check("ok:false → 未成功", summarizeStepResult('{"ok":false}') === "未成功");
check("显式 summary 字段优先", summarizeStepResult('{"ok":true,"summary":"已完成查询商品总库存"}') === "已完成查询商品总库存");
check("普通文本取第一行", summarizeStepResult("第一行内容\n第二行内容") === "第一行内容");
check("数组结果转数量", summarizeStepResult("[1,2,3]") === "3 项结果");
check("空结果 → 空串（调用方回落状态词）", summarizeStepResult("") === "");
check("null 结果 → 空串", summarizeStepResult(null) === "");
check("非 JSON 的裸文本不抛错", summarizeStepResult("{不是 JSON") .length > 0);

// ---- 文案：思考摘要与时长 ----
check("思考摘要合并多行为单行", summarizeThinking("我来查询库存情况，先加载说明。\n后续步骤") === "我来查询库存情况，先加载说明。 后续步骤");
check("空思考 → 空串", summarizeThinking("   ") === "");
check("时长：毫秒", formatDuration(500) === "500ms");
check("时长：一位小数秒（截图口径）", formatDuration(6000) === "6.0s");
check("时长：分秒", formatDuration(65000) === "1m 5s");
check("时长：非法值归零", formatDuration(-1) === "0ms" && formatDuration(Number.NaN) === "0ms");

console.log(fails === 0 ? "\n全部通过" : `\n${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);
