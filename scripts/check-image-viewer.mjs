// 图片预览（lib/image-viewer）纯逻辑校验脚本。
//
// chat 仓库没有测试框架，沿用 check:history / check:quote 的做法：
// 用 esbuild 把纯逻辑模块打成 ESM 到 /tmp，再用 node 跑断言。
//
// 覆盖的都是「写错了肉眼看不出来」的规则：
//   1. 缩放钳制在 [MIN_SCALE, MAX_SCALE]，NaN / Infinity 视为复位
//   2. 缩放累计不越界（连点 + 到上限后停住）
//   3. rotateBy 返回累计值，每步只走 90°（曾经归一化导致 CSS transition 绕远路）
//   4. 复位落到最近的 360 倍（硬写 0 会让 270 倒扫 270°）
//   5. 宽高对调判定（isQuarterTurn）在 -90 / 450 等等价角下同样成立
//   5. 缩放百分比文案：整数不带小数点，非整数保留一位
//   6. 平移边界：放大后能拖动、缩小后强制归零、不越出图片边缘
//
// 改动 src/lib/image-viewer.ts 后请运行：
//
//   npm run check:image

import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";

const require_ = createRequire(import.meta.url);
const esbuild = require_("esbuild");

const OUT_DIR = "/tmp/ivcheck";
mkdirSync(OUT_DIR, { recursive: true });
esbuild.buildSync({
  entryPoints: ["src/lib/image-viewer.ts"],
  format: "esm",
  outfile: `${OUT_DIR}/image-viewer.mjs`,
  logLevel: "error",
});

const {
  MIN_SCALE,
  MAX_SCALE,
  SCALE_STEP,
  ROTATION_STEP,
  clampScale,
  zoomBy,
  normalizeRotation,
  rotateBy,
  isOriginalView,
  isQuarterTurn,
  nearestZeroRotation,
  formatZoom,
  clampOffset,
} = await import(`${OUT_DIR}/image-viewer.mjs`);

let fails = 0;
const check = (label, cond, extra = "") => {
  if (!cond) {
    fails += 1;
    console.log("FAIL", label, extra);
  }
};
const eq = (label, actual, expected) =>
  check(label, Object.is(actual, expected), `实际=${String(actual)} 期望=${String(expected)}`);

// 对象结果无法用 Object.is 比较，按字段断言
const eqPoint = (label, actual, expected) =>
  check(
    label,
    Boolean(actual) && actual.x === expected.x && actual.y === expected.y,
    `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`,
  );
// ---- 1. clampScale ----
check("常量自洽：下界 < 1 < 上界", MIN_SCALE < 1 && MAX_SCALE > 1, `${MIN_SCALE} / ${MAX_SCALE}`);
eq("clampScale 超出上界被压到 MAX", clampScale(99), MAX_SCALE);
eq("clampScale 超出下界被抬到 MIN", clampScale(0.01), MIN_SCALE);
eq("clampScale 正常值原样返回", clampScale(2.5), 2.5);
eq("clampScale NaN 视为复位", clampScale(NaN), 1);
eq("clampScale Infinity 视为复位", clampScale(Infinity), 1);
eq("clampScale -Infinity 视为复位", clampScale(-Infinity), 1);

// ---- 2. zoomBy 累计 ----
eq("放大一步", Number(zoomBy(1, SCALE_STEP).toFixed(4)), Number(SCALE_STEP.toFixed(4)));
eq("缩小一步", Number(zoomBy(1, 1 / SCALE_STEP).toFixed(4)), Number((1 / SCALE_STEP).toFixed(4)));
// 连点 20 次放大必须停在上界，不能溢出成 Infinity 或继续增长
let scaled = 1;
for (let i = 0; i < 20; i += 1) scaled = zoomBy(scaled, SCALE_STEP);
eq("连续放大 20 次停在上界", scaled, MAX_SCALE);
// 连点 20 次缩小必须停在下界
scaled = 1;
for (let i = 0; i < 20; i += 1) scaled = zoomBy(scaled, 1 / SCALE_STEP);
eq("连续缩小 20 次停在下界", scaled, MIN_SCALE);
eq("非法倍率（0）不改变缩放", zoomBy(2, 0), 2);
eq("非法倍率（NaN）不改变缩放", zoomBy(2, NaN), 2);
eq("负倍率不改变缩放", zoomBy(2, -1.5), 2);

// ---- 3. normalizeRotation ----
eq("0 度不变", normalizeRotation(0), 0);
eq("360 归零", normalizeRotation(360), 0);
eq("450 归一为 90", normalizeRotation(450), 90);
eq("-90 归一为 270", normalizeRotation(-90), 270);
eq("-360 归零", normalizeRotation(-360), 0);
eq("归一结果非负", normalizeRotation(-1) >= 0, true);
eq("NaN 归零", normalizeRotation(NaN), 0);
// 关键：不能用 === -0 判定，Object.is(-0, 0) 为 false，这里必须真等于 +0
check("归零结果是 +0 而非 -0", Object.is(normalizeRotation(-360), 0), String(normalizeRotation(-360)));

// ---- 4. rotateBy：返回累计值，每步只走 90°（回归：曾经归一化导致"转好几圈"）----
// 关键点：rotateBy 必须返回**累加值**。曾经它返回 [0,360) 归一值，
// 于是逆时针一步 0 → 270，CSS transition 会实打实转 3/4 圈，观感像"转了好几圈"。
let rotation = 0;
for (let i = 0; i < 4; i += 1) rotation = rotateBy(rotation);
eq("连续旋转 4 次累计 360", rotation, 360);
eq("累计 360 归一仍是 0", normalizeRotation(rotation), 0);
// 每一步的绝对增量必须恰好一个步长，否则会出现"绕远路"的过渡动画
rotation = 0;
let maxStep = 0;
for (let i = 0; i < 6; i += 1) {
  const next = rotateBy(rotation, -ROTATION_STEP);
  maxStep = Math.max(maxStep, Math.abs(next - rotation));
  rotation = next;
}
eq("逆时针每步的绝对增量为 90", maxStep, 90);
eq("逆时针 6 步累计 -540", rotation, -540);
eq("旋转步长是 90 的整数倍", ROTATION_STEP % 90, 0);
// 归一化只用于比较：逆时针一步归一后是 270
eq("逆时针一步归一为 270", normalizeRotation(0 - ROTATION_STEP), 270);

// ---- 4b. nearestZeroRotation：复位要落到最近的 360 倍，不能硬写 0 ----
eq("0 度复位到 0", nearestZeroRotation(0), 0);
eq("270 度复位到 360（只转 90，不倒扫 270）", nearestZeroRotation(270), 360);
// 180 是正中间，向上取到 360（Math.round 半值进位），两个方向都只走 180
check("180 度复位到 360（半值进位，两个方向都走 180）", nearestZeroRotation(180) === 360);
eq("-90 度复位到 0", nearestZeroRotation(-90), 0);
eq("-270 度复位到 -360（只转 90）", nearestZeroRotation(-270), -360);
eq("-540 度复位到 -360", nearestZeroRotation(-540), -360);
check("复位后归一必为 0（270）", normalizeRotation(nearestZeroRotation(270)) === 0);
check("复位后归一必为 0（-270）", normalizeRotation(nearestZeroRotation(-270)) === 0);
check("复位角度差不超过 180", Math.abs(nearestZeroRotation(270) - 270) <= 180);

// ---- 4c. isQuarterTurn：宽高对调判定 ----
eq("0 度不对调", isQuarterTurn(0), false);
eq("90 度对调", isQuarterTurn(90), true);
eq("180 度不对调", isQuarterTurn(180), false);
eq("270 度对调", isQuarterTurn(270), true);
eq("-90 度对调", isQuarterTurn(-90), true);
eq("-270 度对调", isQuarterTurn(-270), true);
eq("360 度不对调", isQuarterTurn(360), false);
eq("450 度对调", isQuarterTurn(450), true);

// ---- 5. isOriginalView ----
eq("1 倍 0 度是原始视图", isOriginalView(1, 0), true);
eq("2 倍不是原始视图", isOriginalView(2, 0), false);
eq("旋转 90 不是原始视图", isOriginalView(1, 90), false);
eq("旋转 360 等价于原始视图", isOriginalView(1, 360), true);

// ---- 6. formatZoom ----
eq("1 倍显示 100%", formatZoom(1), "100%");
eq("0.5 倍显示 50%", formatZoom(0.5), "50%");
eq("2 倍显示 200%", formatZoom(2), "200%");
eq("1.25 倍显示 125%", formatZoom(1.25), "125%");
// 1.5625 若取整成 156% 会和用户按两次「+」的心算对不上，必须保留一位
eq("1.5625 保留一位小数", formatZoom(1.5625), "156.3%");
// 越界值先钳制再格式化，不能显示 1200%
eq("超上界的值先钳制", formatZoom(12), `${MAX_SCALE * 100}%`);

// ---- 7. clampOffset ----
const size = { width: 800, height: 600 };
const viewport = { width: 800, height: 600 };
// 1 倍时图片正好装下，任何偏移都归零
eqPoint("1 倍时偏移归零", clampOffset({ x: 100, y: 100 }, 1, size, viewport), { x: 0, y: 0 });
check("1 倍时偏移归零（x）", clampOffset({ x: 100, y: 100 }, 1, size, viewport).x === 0);
check("1 倍时偏移归零（y）", clampOffset({ x: 100, y: 100 }, 1, size, viewport).y === 0);
// 2 倍：宽 1600 溢出 800，每侧可移动 400
eq("2 倍时 x 上限为溢出的一半", clampOffset({ x: 9999, y: 0 }, 2, size, viewport).x, 400);
eq("2 倍时 x 下限为负的溢出一半", clampOffset({ x: -9999, y: 0 }, 2, size, viewport).x, -400);
eq("2 倍时 y 上限为溢出的一半", clampOffset({ x: 0, y: 9999 }, 2, size, viewport).y, 300);
// 范围内的小偏移原样保留
eqPoint("范围内的偏移不被改动", clampOffset({ x: 123, y: -45 }, 2, size, viewport), { x: 123, y: -45 });
// 缩小到 1 倍以下同样归零
eqPoint("0.5 倍时偏移归零", clampOffset({ x: 50, y: 50 }, 0.5, size, viewport), { x: 0, y: 0 });
// 图片比容器小、放大后仍装得下时不产生可拖动余量
eqPoint(
  "放大后仍装得下则无可移动余量",
  clampOffset({ x: 200, y: 200 }, 1.5, { width: 200, height: 200 }, viewport),
  { x: 0, y: 0 },
);

console.log(fails === 0 ? "check:image 全部通过" : `check:image 失败 ${fails} 项`);
process.exit(fails === 0 ? 0 : 1);
