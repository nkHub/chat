// 图片预览（Lightbox）的缩放 / 旋转数学，单独抽成纯函数模块。
//
// 为什么单独抽出来：这些规则一旦写错（比如缩放钳制方向反了、旋转角度无限累加）
// 表现是「图越来越糊 / 转一圈回不到原位」这类肉眼很难判断对错的细节。
// 放在 src/lib 里就能被 node 直接断言（scripts/check-image-viewer.mjs），
// 沿用仓库既有的 check:history / check:quote 约定，不引入测试框架。

/** 最小缩放：再小没有意义，等于把图缩成一个点 */
export const MIN_SCALE = 0.25;

/** 最大缩放：再大只是看马赛克，且 transform 会让部分渲染器吃满内存 */
export const MAX_SCALE = 8;

/** 每次点按 / 滚轮的缩放倍率。1.25 的几何感比 1.2 更"跳"，比 1.5 更细腻 */
export const SCALE_STEP = 1.25;

/** 旋转步长（度）。只允许 90 的整数倍，回到 0 度时视图才和初始完全重合 */
export const ROTATION_STEP = 90;

/** 把任意输入钳到 [MIN_SCALE, MAX_SCALE]；NaN / Infinity 一律视为 1（复位） */
export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/** 以 factor 为倍率缩放一步。放大用 SCALE_STEP，缩小用 1 / SCALE_STEP */
export function zoomBy(scale: number, factor: number): number {
  if (!Number.isFinite(factor) || factor <= 0) return clampScale(scale);
  return clampScale(clampScale(scale) * factor);
}

/**
 * 旋转角度归一化到 [0, 360)。
 * 关键点：连续点 4 次旋转必须精确回到 0，而不是 360 或 -0，
 * 否则「重置」判定（rotation === 0）会失效、偏移量也不会被清掉。
 */
export function normalizeRotation(degrees: number): number {
  if (!Number.isFinite(degrees)) return 0;
  const wrapped = degrees % 360;
  const positive = wrapped < 0 ? wrapped + 360 : wrapped;
  // +0 归一：避免 -0 参与 === 比较时出现 -0 === 0 之外的意外
  return positive === 0 ? 0 : positive;
}

/** 顺时针旋转一个步长 */
export function rotateBy(degrees: number, step: number = ROTATION_STEP): number {
  return normalizeRotation(normalizeRotation(degrees) + step);
}

/**
 * 是否为「原始视图」：没缩放也没旋转。
 * 这个判定同时决定两件事：要不要显示"已调整"的提示、以及复位按钮是否可点。
 */
export function isOriginalView(scale: number, rotation: number): boolean {
  return clampScale(scale) === 1 && normalizeRotation(rotation) === 0;
}

/**
 * 缩放百分比文案。
 * 不用 toFixed(0) 直接四舍五入到整数：1.25 倍会显示成 125%，但 1.25*1.25=1.5625
 * 若取整会显示 156%，和用户按两次"+"的心算对不上；这里保留一位小数并在整数时去掉。
 */
export function formatZoom(scale: number): string {
  const percent = clampScale(scale) * 100;
  const rounded = Math.round(percent * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}%`;
}

/**
 * 缩放后的平移边界：图片允许被拖出视野多少像素。
 * 返回 null 表示不限制（图片本身比容器小、或缩放 <= 1 时不需要平移约束）。
 *
 * 为什么需要：不钳制的话可以把图拖到视野外，只剩空白，
 * 用户只能靠 Esc 重开才能找回图片。
 */
export function clampOffset(
  offset: { x: number; y: number },
  scale: number,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): { x: number; y: number } {
  const bounded = clampScale(scale);
  // 缩放不超过 1 时图片本来就装得下，强制回到原点，避免"能拖动但看不见变化"
  if (bounded <= 1) return { x: 0, y: 0 };
  // 允许拖动的余量：图片放大后的溢出部分的一半（居中布局下每侧各一半）
  const overflowX = Math.max(0, (size.width * bounded - viewport.width) / 2);
  const overflowY = Math.max(0, (size.height * bounded - viewport.height) / 2);
  return {
    x: Math.min(overflowX, Math.max(-overflowX, offset.x)),
    y: Math.min(overflowY, Math.max(-overflowY, offset.y)),
  };
}
