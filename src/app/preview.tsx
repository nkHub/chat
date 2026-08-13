import { createContext, useEffect } from "react";
import { API_BASE_URL } from "@/lib/agent-api";

// 图片点击预览：通过 Context 向各图片渲染处暴露"打开大图预览"回调。
const PreviewContext = createContext<{ openPreview: (url: string) => void }>({ openPreview: () => {} });

// 全屏图片预览遮罩：点击遮罩或按 Esc 关闭，点击图片本身不关闭。
function Lightbox({ url, onClose }: { url: string; onClose: () => void }) {
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6" onClick={onClose}>
      <img src={url} alt="预览" className="max-h-full max-w-full rounded-lg object-contain shadow-2xl" onClick={event => event.stopPropagation()} />
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
