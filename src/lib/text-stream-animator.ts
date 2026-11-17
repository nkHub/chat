/**
 * 流式文本"打字机"揭示动画（纯逻辑，不含 React / 不含 rAF）。
 *
 * 移植自 assistant-ui 的 `TextStreamAnimator`
 * （packages/react/src/utils/smooth/useSmooth.ts），保留其算法与全部参数语义，
 * 但把「时钟」和「调度」从实现里剥出去。
 *
 * 为什么这样拆：
 *   1. 上游把 `performance.now()` 和 `requestAnimationFrame` 直接写死在类里，
 *      只能靠 React 渲染 + 假计时器测；本项目没有测试框架，纯逻辑用
 *      `npm run check:smooth`（esbuild + node）断言，所以时间必须由调用方传入。
 *   2. 本项目真正需要它的地方是流式正文与思考正文（见 `app/use-smooth-text.ts`），
 *      调度细节（rAF、reduced-motion、卸载清理）属于 hook 的职责。
 *
 * 核心思想：目标文本是"已经到达的全文"，展示文本是它的前缀。每帧按
 * 「把剩余积压摊平到 drainMs」算出每字符耗时，再按本帧可用时间决定揭示几个字符，
 * 于是**突发的大段文本会在 drainMs 内匀速排空**，而不会被一帧全刷出来。
 */

/** 揭示动画的调参。字段含义与 assistant-ui 的 `SmoothOptions` 一致。 */
export type SmoothTextOptions = {
  /**
   * 排空积压的目标耗时（毫秒）。积压越长每字符耗时可越短，
   * 但总时长被摊到该值上，避免长回答越拖越慢。
   */
  drainMs: number;
  /**
   * 每字符最长耗时（毫秒），即积压很短时的"最慢揭示速率"。
   * 积压 < drainMs / maxCharIntervalMs 时由它接管，防止末尾几个字慢到离谱。
   */
  maxCharIntervalMs: number;
  /** 单帧最多揭示的字符数。默认 Infinity（不设限）。 */
  maxCharsPerFrame: number;
  /**
   * 两次"提交"（把展示文本交给 React 重渲染）之间的最小间隔。
   * 揭示本身每帧都在推进，只是可见文本的提交被限流。
   * 收尾帧永远提交；`0` 表示每帧都提交。
   */
  minCommitMs: number;
};

/** 默认值取自 assistant-ui，改动前请先看上面的注释是否还成立。 */
export const DEFAULT_SMOOTH_OPTIONS: SmoothTextOptions = {
  drainMs: 250,
  maxCharIntervalMs: 5,
  maxCharsPerFrame: Infinity,
  minCommitMs: 0,
};

/**
 * 取正值或兜底值。上游同样只接受 `> 0`：`0`、负数、`undefined` 一律回落，
 * 否则 `drainMs / remaining` 会算出 0 或负的每字符耗时，揭示速率失控。
 */
function positiveOr(value: number | undefined, fallback: number): number {
  return value !== undefined && value > 0 ? value : fallback;
}

export class TextStreamAnimator {
  /** 目标文本：上游已到达的全文。 */
  public targetText: string;
  /** 当前展示文本：始终是 `targetText` 的前缀。 */
  public currentText: string;
  /** 上次提交展示文本的时刻；`-Infinity` 表示"下一次必定提交"。 */
  public lastCommitTime = -Infinity;
  /**
   * 上次"记账"的时刻。
   *
   * 注意与 `lastCommitTime` 的区别：本帧没揭示任何字符时**不更新**它，
   * 于是这一帧的时间会累积到下一帧（否则在 60fps 下每帧不足一个字符耗时，
   * 时间被反复丢弃，短积压会永远揭示不完）。
   */
  private lastUpdateTime: number | null = null;

  public drainMs: number;
  public maxCharIntervalMs: number;
  public maxCharsPerFrame: number;
  public minCommitMs: number;

  constructor(initialText = "", options: Partial<SmoothTextOptions> = {}) {
    this.currentText = initialText;
    this.targetText = initialText;
    this.drainMs = positiveOr(options.drainMs, DEFAULT_SMOOTH_OPTIONS.drainMs);
    this.maxCharIntervalMs = positiveOr(options.maxCharIntervalMs, DEFAULT_SMOOTH_OPTIONS.maxCharIntervalMs);
    this.maxCharsPerFrame = positiveOr(options.maxCharsPerFrame, DEFAULT_SMOOTH_OPTIONS.maxCharsPerFrame);
    this.minCommitMs = positiveOr(options.minCommitMs, DEFAULT_SMOOTH_OPTIONS.minCommitMs);
  }

  /** 当前展示是否已经追上目标（追上了就不必再排帧）。 */
  get caughtUp(): boolean {
    return this.currentText.length >= this.targetText.length;
  }

  /** 还没揭示的字符数，供调试与断言使用。 */
  get pendingChars(): number {
    return Math.max(0, this.targetText.length - this.currentText.length);
  }

  /**
   * 告知新的目标文本。
   *
   * 正常情况下目标是单调增长的，当前展示就是它的前缀，只换目标即可。
   * 但目标**不再以当前展示为前缀**时（重试、重放、组件被复用给了另一条消息），
   * 继续按长度拼接会拼出前后无关的乱码，所以整段重来并把游标归零。
   *
   * @returns 是否发生了重置（调用方需据此把展示文本也清空）。
   */
  setTarget(next: string, now: number): boolean {
    if (this.lastUpdateTime === null) this.lastUpdateTime = now;
    if (next.startsWith(this.currentText)) {
      this.targetText = next;
      return false;
    }
    this.currentText = "";
    this.targetText = next;
    this.lastCommitTime = -Infinity;
    this.lastUpdateTime = now;
    return true;
  }

  /**
   * 推进一帧。
   *
   * @param now 当前时刻（毫秒），由调用方传入，保证可确定性测试。
   * @returns 需要提交给视图的新展示文本；本帧没揭示字符、或未达提交间隔时返回
   *          `null`（此时游标可能已推进，但视图不必重渲染）。
   */
  advance(now: number): string | null {
    // 首帧只做记账：构造时刻到首帧之间的时间不该被算成盈余（上游在 start() 里做同样的事）。
    if (this.lastUpdateTime === null) {
      this.lastUpdateTime = now;
      return null;
    }

    const remaining = this.targetText.length - this.currentText.length;
    if (remaining <= 0) return null;

    let timeToConsume = now - this.lastUpdateTime;
    // 把剩余积压摊到 drainMs 上：积压越长每字符越便宜，但总时长上限就是 drainMs。
    const baseTimePerChar = Math.min(this.maxCharIntervalMs, this.drainMs / remaining);
    const frameLimit = Math.min(remaining, this.maxCharsPerFrame);

    let charsToAdd = 0;
    while (timeToConsume >= baseTimePerChar && charsToAdd < frameLimit) {
      charsToAdd += 1;
      timeToConsume -= baseTimePerChar;
    }
    // 被 maxCharsPerFrame 截断的帧不能把盈余时间存下来，否则下一帧会一次冲过上限。
    if (charsToAdd === frameLimit && frameLimit === this.maxCharsPerFrame) timeToConsume = 0;

    // 本帧无字符可揭示：**不更新** lastUpdateTime，让时间继续累积（见字段注释）。
    if (charsToAdd === 0) return null;

    this.currentText = this.targetText.slice(0, this.currentText.length + charsToAdd);
    // 余量结转：把没花完的时间留给下一帧，揭示速率因此是平滑的而不是整帧跳动。
    this.lastUpdateTime = now - timeToConsume;

    const isComplete = charsToAdd === remaining;
    // 收尾帧必须提交：否则动画停滞在半截，靠"下一次提交"永远补不上。
    if (!isComplete && now - this.lastCommitTime < this.minCommitMs) return null;
    this.lastCommitTime = now;
    return this.currentText;
  }

  /** 立即对齐到目标（跳过动画）：用于 reduced-motion、动画被关闭、或需要硬兜底时。 */
  snapToTarget(now: number): void {
    this.currentText = this.targetText;
    this.lastUpdateTime = now;
    this.lastCommitTime = now;
  }
}
