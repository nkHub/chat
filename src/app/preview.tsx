import { createContext, useCallback, useEffect, useRef, useState } from "react";
import { Maximize2, Minus, Plus, RotateCcw, RotateCw, X } from "lucide-react";
import { API_BASE_URL } from "@/lib/agent-api";
import {
  MAX_SCALE,
  MIN_SCALE,
  SCALE_STEP,
  clampOffset,
  clampScale,
  formatZoom,
  isOriginalView,
  isQuarterTurn,
  nearestZeroRotation,
  rotateBy,
  zoomBy,
} from "@/lib/image-viewer";

// 图片点击预览：通过 Context 向各图片渲染处暴露"打开大图预览"回调。
const PreviewContext = createContext<{ openPreview: (url: string) => void }>({ openPreview: () => {} });

// 工具栏按钮的统一外观：半透明深色玻璃，压在任意图片上都看得清
const TOOLBAR_BUTTON =
  "flex h-8 w-8 items-center justify-center rounded-md text-white/90 transition-colors hover:bg-white/15 hover:text-white disabled:cursor-not-allowed disabled:text-white/30 disabled:hover:bg-transparent";

/** 视图状态收敛成一个对象：缩放 / 旋转 / 平移三者每次都要一起更新，拆成三个 state 极易读到互相不一致的旧值 */
type View = { scale: number; rotation: number; x: number; y: number };

/** 初始视图与换图复位用；**不要**拿它当"复位按钮"的实现，那会把角度硬拉回 0 而绕圈 */
const ORIGINAL_VIEW: View = { scale: 1, rotation: 0, x: 0, y: 0 };

/**
 * 全屏图片预览遮罩，支持缩放 / 旋转 / 拖动。
 *
 * 交互约定（改动前先读，下面的实现都是为这些约定服务的）：
 *  - 点遮罩 / 按 Esc / 点右上角关闭 → 关闭；
 *  - 点图片本身**不**关闭：放大后经常要在图上拖动、双击，误触关闭会很难受；
 *  - 拖动过再松手不算"点击遮罩"，否则放大后一松手预览就没了；
 *  - 缩放 / 旋转只作用在 transform 上，不动布局：容器尺寸恒定，
 *    这样"装不装得下"的判断（clampOffset）才有稳定基准；
 *  - 换图片时视图整体复位，否则上一张的缩放会带到下一张。
 */
function Lightbox({ url, onClose }: { url: string; onClose: () => void }) {
  const [view, setView] = useState<View>(ORIGINAL_VIEW);
  const [dragging, setDragging] = useState(false);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  // view 的镜像：滚轮 / 键盘的监听只在挂载时注册一次（依赖项为空），
  // 闭包里拿不到最新 view，必须走 ref 读当前值
  const viewRef = useRef<View>(ORIGINAL_VIEW);
  // 拖拽过程量：放 ref，避免每帧 setState 造成额外渲染
  const dragRef = useRef<{ startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null);
  // "刚刚拖动过"标记：endDrag 会清空 dragRef，而 click 在 pointerup 之后才触发，
  // 所以必须单独记一笔，否则放大后每次松手都会把预览关掉
  const draggedRecentlyRef = useRef(false);

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  // 换图片时复位视图
  useEffect(() => {
    setView(ORIGINAL_VIEW);
    setDragging(false);
    dragRef.current = null;
    draggedRecentlyRef.current = false;
  }, [url]);

  /**
   * 量出当前"有效尺寸"：图片布局尺寸（offsetWidth/Height，不受 transform 影响）
   * 与容器可视区。旋转 90°/270° 时图片在视觉上宽高对调，
   * 所以把 size 交换后交给 clampOffset，拖动边界才和看到的一致。
   */
  const measure = useCallback((rotation: number) => {
    const image = imageRef.current;
    const viewport = viewportRef.current;
    if (!image || !viewport) return null;
    // 用 isQuarterTurn 判断（内部会先归一），否则 -90° 会被算成"没对调"：
    // rotation 现在是累计值，可能是负数或大于 360
    const swapped = isQuarterTurn(rotation);
    return {
      size: swapped
        ? { width: image.offsetHeight, height: image.offsetWidth }
        : { width: image.offsetWidth, height: image.offsetHeight },
      viewport: { width: viewport.clientWidth, height: viewport.clientHeight },
    };
  }, []);

  /** 一次性提交新视图，并把平移钳进合法范围 */
  const commit = useCallback(
    (next: View) => {
      const scale = clampScale(next.scale);
      // 注意：**不要**在这里把 rotation 归一化到 [0,360)。
      // 累计角度直接喂给 transform，CSS transition 才会沿"加了多少"插值；
      // 一旦归一，逆时针一步 0 → 270 会实打实转 3/4 圈（就是用户看到的"转了好几圈"）。
      // 归一化只在需要比较的地方调用（isQuarterTurn / isOriginalView）。
      const rotation = Number.isFinite(next.rotation) ? next.rotation : 0;
      let position = { x: next.x, y: next.y };
      const measured = measure(rotation);
      // 缩到 1 倍以内时图片装得下，平移无意义，clampOffset 会归零
      if (measured) position = clampOffset(position, scale, measured.size, measured.viewport);
      setView({ scale, rotation, x: position.x, y: position.y });
    },
    [measure],
  );

  /** 按倍率缩放（工具栏 / 键盘入口）：以容器中心为锚点，平移只需重新钳制 */
  const zoomByFactor = useCallback(
    (factor: number) => {
      const current = viewRef.current;
      const scale = zoomBy(current.scale, factor);
      if (scale === current.scale) return; // 已在上下限，别触发无意义的重渲染
      commit({ ...current, scale });
    },
    [commit],
  );

  /**
   * 复位：角度落到**最接近的 360 倍**，而不是硬写 0。
   * 已经转到 270° 时写 0 会让 transition 倒着扫 270°（又像在绕圈），
   * 落到 360° 只转 90°，视觉上就是"回到原样"。
   */
  const resetView = useCallback(
    () => setView({ scale: 1, rotation: nearestZeroRotation(viewRef.current.rotation), x: 0, y: 0 }),
    [],
  );

  // 键盘：Esc 关闭、+/- 缩放、0 复位、r 旋转。
  // 用 keydown（不是 keypress）才能收到 Esc 与功能键。
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      // 正在输入框里打字时不抢快捷键（预览层当前没有输入框，防将来叠加）
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        zoomByFactor(SCALE_STEP);
      } else if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        zoomByFactor(1 / SCALE_STEP);
      } else if (event.key === "0") {
        event.preventDefault();
        resetView();
      } else if (event.key === "r" || event.key === "R") {
        event.preventDefault();
        const current = viewRef.current;
        // 旋转后有效宽高对调，交给 commit 重新钳制平移
        commit({ ...current, rotation: rotateBy(current.rotation) });
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose, zoomByFactor, resetView, commit]);

  /**
   * 滚轮缩放，锚点是光标位置（"放大我看的那块"）。
   *
   * 为什么必须用原生监听 + { passive: false }：React 的 onWheel 注册的是被动监听，
   * 里面调 preventDefault() 无效，滚轮会一边缩放一边把父容器滚走。
   */
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const current = viewRef.current;
      const scale = zoomBy(current.scale, event.deltaY < 0 ? SCALE_STEP : 1 / SCALE_STEP);
      if (scale === current.scale) return;

      const image = imageRef.current;
      if (!image || scale <= 1) {
        commit({ ...current, scale });
        return;
      }

      // translate 在 scale 之前生效，保持光标下的图像点不动的条件是：
      //   x' = c - (c - x) * (s' / s)，其中 c 是光标相对容器中心的坐标
      const bounds = viewport.getBoundingClientRect();
      const cursorX = event.clientX - (bounds.left + bounds.width / 2);
      const cursorY = event.clientY - (bounds.top + bounds.height / 2);
      const ratio = scale / current.scale;
      commit({
        scale,
        rotation: current.rotation,
        x: cursorX - (cursorX - current.x) * ratio,
        y: cursorY - (cursorY - current.y) * ratio,
      });
    };
    viewport.addEventListener("wheel", handleWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", handleWheel);
  }, [commit]);

  const handlePointerDown = (event: React.PointerEvent<HTMLImageElement>) => {
    // 只有放大到装不下时拖动才有意义；1 倍时拖动是空操作，还会误触发"拖动过"判定
    if (viewRef.current.scale <= 1) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const current = viewRef.current;
    dragRef.current = { startX: event.clientX, startY: event.clientY, originX: current.x, originY: current.y, moved: false };
    draggedRecentlyRef.current = false;
    setDragging(true);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLImageElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    // 3px 阈值：触摸 / 手抖会带出 1~2px 位移，超过才算"真的在拖"
    if (!drag.moved && Math.abs(deltaX) + Math.abs(deltaY) > 3) drag.moved = true;
    commit({ ...viewRef.current, x: drag.originX + deltaX, y: drag.originY + deltaY });
  };

  const endDrag = () => {
    // 先记下是否真的拖动过，再清空 dragRef —— click 在 pointerup 之后才触发
    draggedRecentlyRef.current = dragRef.current?.moved ?? false;
    dragRef.current = null;
    setDragging(false);
  };

  const adjusted = !isOriginalView(view.scale, view.rotation);
  // 用归一后的比较判断宽高是否对调；transform 里仍用累计角度
  const rotated = isQuarterTurn(view.rotation);
  const transform = `translate(${view.x}px, ${view.y}px) rotate(${view.rotation}deg) scale(${view.scale})`;

  return (
    <div
      ref={viewportRef}
      // 遮罩比原来更实（80%）：放大看图时背景内容不再干扰判断
      className="fixed inset-0 z-50 flex items-center justify-center overflow-hidden bg-black/80 p-6"
      onClick={() => {
        // 拖动过松手不算点击，否则放大后一松手就把预览关了
        if (draggedRecentlyRef.current) {
          draggedRecentlyRef.current = false;
          return;
        }
        onClose();
      }}
    >
      {/* 工具栏固定在右上角；这里 stopPropagation，否则点按钮会连带关闭预览 */}
      <div
        className="absolute right-4 top-4 z-10 flex items-center gap-1 rounded-xl bg-black/50 p-1 shadow-lg ring-1 ring-white/10 backdrop-blur"
        onClick={event => event.stopPropagation()}
      >
        <button
          type="button"
          className={TOOLBAR_BUTTON}
          aria-label="缩小"
          title="缩小（-）"
          disabled={view.scale <= MIN_SCALE}
          onClick={() => zoomByFactor(1 / SCALE_STEP)}
        >
          <Minus size={15} />
        </button>
        <button
          type="button"
          className="h-8 min-w-[52px] rounded-md px-1 text-center text-xs font-medium tabular-nums text-white/90 transition-colors hover:bg-white/15"
          aria-label="复位缩放"
          title="点击复位（0）"
          onClick={resetView}
        >
          {formatZoom(view.scale)}
        </button>
        <button
          type="button"
          className={TOOLBAR_BUTTON}
          aria-label="放大"
          title="放大（+）"
          disabled={view.scale >= MAX_SCALE}
          onClick={() => zoomByFactor(SCALE_STEP)}
        >
          <Plus size={15} />
        </button>

        <span className="mx-0.5 h-5 w-px bg-white/15" />

        <button
          type="button"
          className={TOOLBAR_BUTTON}
          aria-label="逆时针旋转"
          title="逆时针旋转"
          onClick={() => commit({ ...viewRef.current, rotation: rotateBy(viewRef.current.rotation, -90) })}
        >
          <RotateCcw size={15} />
        </button>
        <button
          type="button"
          className={TOOLBAR_BUTTON}
          aria-label="顺时针旋转"
          title="顺时针旋转（r）"
          onClick={() => commit({ ...viewRef.current, rotation: rotateBy(viewRef.current.rotation) })}
        >
          <RotateCw size={15} />
        </button>
        <button
          type="button"
          className={TOOLBAR_BUTTON}
          aria-label="适应窗口"
          title={adjusted ? "恢复原始视图" : "当前已是原始视图"}
          disabled={!adjusted}
          onClick={resetView}
        >
          <Maximize2 size={15} />
        </button>

        <span className="mx-0.5 h-5 w-px bg-white/15" />

        <button type="button" className={TOOLBAR_BUTTON} aria-label="关闭预览" title="关闭（Esc）" onClick={onClose}>
          <X size={16} />
        </button>
      </div>

      <img
        ref={imageRef}
        src={url}
        alt="预览"
        draggable={false}
        className={`select-none rounded-lg object-contain shadow-2xl transition-transform ${
          dragging ? "cursor-grabbing" : view.scale > 1 ? "cursor-grab" : "cursor-default"
        }`}
        style={{
          transform,
          // 拖拽时关掉过渡：跟手比平滑重要；松手后恢复，缩放/旋转才有动画
          transitionDuration: dragging ? "0ms" : "160ms",
          // 旋转 90°/270° 时视觉宽高对调，上限也跟着对调，
          // 否则竖图转成横图会被容器切掉两侧
          maxWidth: rotated ? "calc(100vh - 3rem)" : "calc(100vw - 3rem)",
          maxHeight: rotated ? "calc(100vw - 3rem)" : "calc(100vh - 3rem)",
        }}
        onClick={event => event.stopPropagation()}
        onDoubleClick={event => {
          event.stopPropagation();
          // 双击在"放大到 2 倍"与"复原"之间切换，是最常用的一档快捷操作
          commit({ ...viewRef.current, scale: viewRef.current.scale > 1 ? 1 : 2, x: 0, y: 0 });
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      />
    </div>
  );
}

// 把服务端返回的图片 http_url（http://127.0.0.1:{port}/agent-uploads/xxx）转成
// 可访问的相对路径：开发模式经 Vite 代理走 /akm-api/agent-uploads/xxx，
// 打包为 AKM 插件同源部署时 API_BASE_URL 为空串，直接走 /agent-uploads/xxx。
// 避免端口硬编码与跨源问题。
function toImageSrc(url: string): string {
  const match = url.match(/^https?:\/\/[^/]+(\/agent-uploads\/[^/]+)/);
  return match ? `${API_BASE_URL}${match[1]}` : url;
}

// 提取图片生成/编辑工具返回的图片 URL 列表，用于直接预览。
// 优先使用 http_url（服务端已下载保存的本地访问地址），其次用上游 url。
function extractGeneratedImages(result: unknown): string[] {
  if (!result || typeof result !== "object") return [];
  const images = (result as { images?: unknown }).images;
  if (!Array.isArray(images)) return [];
  const urls: string[] = [];
  for (const item of images) {
    if (item && typeof item === "object") {
      const record = item as { http_url?: unknown; url?: unknown };
      const src = record.http_url ?? record.url;
      if (typeof src === "string" && src.trim()) urls.push(toImageSrc(src));
    }
  }
  return urls;
}

export { PreviewContext, Lightbox, toImageSrc, extractGeneratedImages };
