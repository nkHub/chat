// 会话历史分页/搜索的边界校验脚本。
//
// chat 仓库没有测试框架，这里用「esbuild 打包纯逻辑模块 + node 直接跑断言」的方式
// 覆盖最关键的约束：单次返回必须有界（模型要求读上千条也不能拉全量）、
// 翻页从最近往前、搜索优先保留最近命中。改动 session-history.ts 后请运行：
//
//   npm run check:history   （内部即为 esbuild 打包 + node 运行本脚本）

import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  MAX_SEARCH_HITS,
  normalizePaging,
  pageWindow,
  searchHistory,
  snippet,
} from "/tmp/shcheck/session-history.mjs";

let fails = 0;
const check = (label, cond, extra = "") => {
  if (!cond) {
    fails += 1;
    console.log("FAIL", label, extra);
  } else {
    console.log("ok  ", label, extra);
  }
};

// ---- normalizePaging：模型给多大都不能一次拉全量 ----
check("limit 省略 → 默认", normalizePaging({}).limit === DEFAULT_PAGE_SIZE);
check("limit 9999 → 夹到上限", normalizePaging({ limit: 9999 }).limit === MAX_PAGE_SIZE);
check("limit 0 → 至少 1", normalizePaging({ limit: 0 }).limit === 1);
check("limit -5 → 至少 1", normalizePaging({ limit: -5 }).limit === 1);
check("limit NaN → 默认", normalizePaging({ limit: "abc" }).limit === DEFAULT_PAGE_SIZE);
check("limit 20.7 → 取整 20", normalizePaging({ limit: 20.7 }).limit === 20);
check("offset -3 → 归零", normalizePaging({ offset: -3 }).offset === 0);
check("offset NaN → 0", normalizePaging({ offset: "x" }).offset === 0);

// ---- pageWindow：1700 条会话，从最近往前翻 ----
const TOTAL = 1700;
const p0 = pageWindow(TOTAL, 0, 20);
check("offset 0 是最新一页", p0.range.from === 1681 && p0.range.to === 1700, JSON.stringify(p0.range));
check("offset 0 还有更早", p0.hasMore === true);
const p1 = pageWindow(TOTAL, 20, 20);
check("offset 20 是倒数第二页", p1.range.from === 1661 && p1.range.to === 1680, JSON.stringify(p1.range));
// 最后一页：offset 1690 与翻过头、与极大 offset 都应稳定返回同一页（最早 20 条）
const last = pageWindow(TOTAL, 1690, 20);
check("读到最早一页 hasMore=false 且仍是整页", last.range.from === 1 && last.range.to === 20 && last.hasMore === false, JSON.stringify(last));
const beyond = pageWindow(TOTAL, 99999, 20);
check("offset 越界收敛到最早一页", beyond.range.from === 1 && beyond.range.to === 20 && beyond.hasMore === false, JSON.stringify(beyond.range));
check("空会话 range=null", pageWindow(0, 0, 20).range === null);
check("空会话 hasMore=false", pageWindow(0, 5, 20).hasMore === false);
const one = pageWindow(1, 0, 50);
check("单条会话", one.range.from === 1 && one.range.to === 1 && one.hasMore === false);
// 任何 offset / 超大 limit 下每页条数恒不超过上限
let maxSeen = 0;
for (let off = 0; off < TOTAL; off += 7) {
  const w = pageWindow(TOTAL, off, normalizePaging({ limit: 100000 }).limit);
  maxSeen = Math.max(maxSeen, w.range.to - w.range.from + 1);
}
check("任何 offset/超大 limit 下每页 ≤ 上限", maxSeen <= MAX_PAGE_SIZE, "maxSeen=" + maxSeen);
// 逐页翻完整个会话：不重不漏
const seen = new Set();
for (let off = 0; off < TOTAL + 100; off += 20) {
  const w = pageWindow(TOTAL, off, 20);
  for (let n = w.range.from; n <= w.range.to; n += 1) seen.add(n);
  if (!w.hasMore) break;
}
check("逐页翻完无遗漏", seen.size === TOTAL, "size=" + seen.size);

// ---- searchHistory：命中计数与返回条数解耦，且优先保留最近命中 ----
const many = Array.from({ length: TOTAL }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `第${i}条 苹果 appleseed`, time: `t${i}` }));
const hitAll = searchHistory("苹果", [{ id: "s1", title: "大会话" }], { s1: many });
check("1700 条全部命中时报出总数", hitAll.total_hits === TOTAL, "total=" + hitAll.total_hits);
check("只回传上限条数", hitAll.returned === MAX_SEARCH_HITS, "returned=" + hitAll.returned);
check("truncated=true 提示还有更多", hitAll.truncated === true);
const within = hitAll.hits.map(h => h.offset_from_latest);
check("输出按新→旧（首条 offset 0 递增）", within.every((v, i) => i === 0 || v > within[i - 1]), JSON.stringify(within));
check("最新命中排首位，远古命中被截断而不是挤掉最近命中", within[0] === 0 && within[within.length - 1] <= MAX_SEARCH_HITS - 1, "range=" + within[0] + ".." + within[within.length - 1]);
// offset_from_latest 可直接用于翻页定位：命中所属消息必须落在该页区间内
// 用最早保留的那条命中（within[0]）做往返验证
const target = within[0];
const page = pageWindow(TOTAL, target, 20);
const messageNo = TOTAL - target;
check("offset_from_latest 可直接用于翻页定位", page.range.from <= messageNo && page.range.to >= messageNo, JSON.stringify(page.range) + " msg=" + messageNo);

const hitFew = searchHistory("appleseed", [{ id: "s1" }], { s1: [{ role: "user", content: "no match here" }, { role: "assistant", content: "has Appleseed uppercase" }] });
check("大小写不敏感", hitFew.total_hits === 1 && hitFew.truncated === false);
check("无命中 total=0", searchHistory("不存在词", [{ id: "s1" }], { s1: many }).total_hits === 0);
const hitSeg = searchHistory("回退段", [{ id: "s1" }], { s1: [{ role: "assistant", content: "", segments: [{ type: "thinking", content: "x" }, { type: "text", content: "来自回退段" }] }] });
check("正文为空时用最后一段正文搜索", hitSeg.total_hits === 1, JSON.stringify(hitSeg.hits[0]?.snippet));
const hitToolSeg = searchHistory("无关", [{ id: "s1" }], { s1: [{ role: "assistant", content: "", segments: [{ type: "tool", name: "x", params: {}, result: null, status: "success" }] }] });
check("纯工具段不炸", hitToolSeg.total_hits === 0);
check("搜索跳过空消息不产生空命中", searchHistory("", [{ id: "s1" }], { s1: [{ role: "user", content: "" }] }).total_hits === 0);

// ---- snippet：超长消息只取片段 ----
const long = "A".repeat(5000) + "NEEDLE" + "B".repeat(5000);
const sn = snippet(long, 5000, 6);
check("片段长度有界", sn.length <= 2 * 80 + 6 + 4, "len=" + sn.length);
check("片段含关键词", sn.includes("NEEDLE"));
check("两侧有省略号", sn.startsWith("…") && sn.endsWith("…"));
check("换行被压平", !snippet("a\n\nb NEEDLE c", 6, 6).includes("\n"));

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
