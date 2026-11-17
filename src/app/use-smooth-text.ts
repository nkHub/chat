import { useEffect, useRef, useState } from "react";
import { TextStreamAnimator } from "@/lib/text-stream-animator";

/**
 * 打字机式揭示流式文本（对应 assistant-ui 的 `useSmooth`）。
 *
 * 为什么需要它：服务端按 token 推送，但一个 token 常常是好几个字符甚至一整段
 * （工具结果回填、模型突发多字），直接渲染会让文字**成块跳变**。这里把「已到达全文」
 * 当作目标、把「已展示前缀」当作游标，每帧揭示几个字符，视觉上就是连续打字。
 *
 * 与上游的差异（都是为贴合本项目而做的减法）：
 *   1. 上游返回整个 `MessagePartState`（带 status 让下游感知「仍在揭示中」）；
 *      本项目只需要文本，所以直接返回 `string`。
 *   2. 上游用 zustand 的 `SmoothContext` 把揭示状态广播给姐妹组件，本项目没有这个需求。
 *   3. 上游在 render 阶段调 `setState` 做 resync（依赖 part 身份做比对）；本项目没有
 *      part 概念，目标变化统一走 `animator.setTarget()` 的前缀检查，效果等价且更简单。
 *
 * @param target 目标文本（上游已到达的全文）。
 * @param streaming 是否仍在流式生成；`false` 时不播动画，直接显示全文。
 * @returns 当前应当渲染的文本（`target` 的前缀）。
 */
export function useSmoothText(target: string, streaming: boolean): string {
  // 动画器跨渲染保留：揭示游标必须连续，否则每帧都从零开始、永远揭示不完。
  const animatorRef = useRef<TextStreamAnimator | null>(null);
  if (animatorRef.current === null) animatorRef.current = new TextStreamAnimator();
  const animator = animatorRef.current;
  // 帧循环的句柄。**与目标文本变化解耦**：target 每次变化都会重跑下面的 effect，
  // 如果帧循环也随 effect 启停，token 间隔短于 16ms 时上一帧会被反复取消，
  // 帧永远跑不起来、文字卡住不动。所以循环一经启动就自己跑，只在追上目标时停。
  const frameRef = useRef<number | null>(null);

  // 初值按「是不是历史消息」区分：历史消息不该从空白开始打字，
  // 流式消息则必须从空白开始，否则会先闪出全文再缩回去重打。
  const [displayed, setDisplayed] = useState(streaming ? "" : target);

  // 帧循环：单调推进直到追上目标。用 useRef 存函数会被每帧重建，
  // 这里直接内联在 effect 里，靠 frameRef 保证同一时刻最多一个循环。
  useEffect(() => {
    const now = performance.now();

    // 不播动画的两种情况，处理方式一样：立刻对齐全文。
    //   - 不在流式中：历史消息、回合已结束，也兜住「动画没跑完服务端就收尾」；
    //   - 用户要求减少动效：系统级无障碍设置优先级高于任何自定义动画。
    if (!streaming || prefersReducedMotion()) {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      animator.setTarget(target, now);
      animator.snapToTarget(now);
      setDisplayed(target);
      return;
    }

    // 目标不再以当前展示为前缀（重试 / 组件被复用）时 setTarget 会重置游标，
    // 此时必须把视图一起清空，否则会停在上一轮的残留文本上。
    animator.setTarget(target, now);
    setDisplayed(animator.currentText);

    // 已追上（这一帧没有新字符）就不必排帧，等下一个 token 到达时再进来。
    if (animator.caughtUp) return;
    // 循环已在跑：不重复启动（幂等，与上游 start() 的守卫一致）。
    if (frameRef.current !== null) return;

    const tick = () => {
      const next = animator.advance(performance.now());
      if (next !== null) setDisplayed(next);
      // 追上目标就自然停帧；下一批 token 到达时本 effect 会重新启动循环。
      frameRef.current = animator.caughtUp ? null : requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);
  }, [animator, target, streaming]);

  // 卸载时停帧：rAF 回调持有闭包与动画器，不取消就会在组件消失后继续跑。
  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    },
    [],
  );

  return displayed;
}

/**
 * 读取系统的「减少动效」偏好。
 *
 * 不做事件监听：本函数只在目标文本变化时被调用（跟随 token，量级是几十毫秒一次），
 * 反复读 `.matches` 足够便宜，而且用户中途改系统设置也能自然生效。
 */
function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}
