import { isValidElement, type ReactElement, type ReactNode } from "react";
import type { AgentMessage, ApiModel } from "@/lib/agent-api";
import type { ChatModel, Message, StoredChatState } from "./types";

// 规范化从存储层读出的聊天状态：
// 迁移旧数据：会话时间跟随最后一条消息的时间（空会话保留创建时间），
// 早期"刚刚"硬编码的会话补上当前时刻。非法/损坏数据返回 null。
function normalizeStoredState(parsed: unknown): StoredChatState | null {
  if (!parsed || typeof parsed !== "object") return null;
  const state = parsed as StoredChatState;
  if (Array.isArray(state.sessions)) {
    state.sessions = state.sessions.map(session => {
      const list = state.allMessages?.[session.id];
      const lastTime = list && list.length > 0 ? list[list.length - 1].time : "";
      const time = lastTime || (session.time === "刚刚" ? nowTime() : session.time);
      return { ...session, time };
    });
  }
  return state;
}

function toChatModel(model: ApiModel): ChatModel {
  return {
    key: model.id,
    label: model.id,
  };
}

// 存储用完整时间戳（ISO 字符串），保留日期信息以便会话时间按"今天/本周/更早"智能展示。
function nowTime(date = new Date()) {
  return date.toISOString();
}

// 会话时间智能展示：今天显示 HH:mm，本周内（非今天）显示周几，更早显示 MM:DD。
// 兼容无日期信息的旧数据（如 "14:30"），无法解析时原样返回。
function formatDisplayTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(date);
  }
  const startOfWeek = new Date(now);
  startOfWeek.setHours(0, 0, 0, 0);
  startOfWeek.setDate(startOfWeek.getDate() - ((startOfWeek.getDay() + 6) % 7));
  if (date >= startOfWeek) {
    return ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][date.getDay()];
  }
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${month}:${day}`;
}

// 会话列表使用的相对时间：随时间推进持续变化（配合侧栏的定时/回前台刷新）。
// 超过本周的会话用"MM-DD"（横杠分隔），避免与"时:分"歧义。
function formatRelativeTime(value: string, now: Date = new Date()) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const diffMs = now.getTime() - date.getTime();
  if (diffMs < 0) return "刚刚";
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "昨天";
  if (days < 7) return `${days} 天前`;
  const startOfWeek = new Date(now);
  startOfWeek.setHours(0, 0, 0, 0);
  startOfWeek.setDate(startOfWeek.getDate() - ((startOfWeek.getDay() + 6) % 7));
  if (date >= startOfWeek) {
    return ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][date.getDay()];
  }
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${month}-${day}`;
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map(item => {
        if (!item || typeof item !== "object") return "";
        const record = item as Record<string, unknown>;
        return typeof record.text === "string" ? record.text : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object") return JSON.stringify(content, null, 2);
  return "";
}

// 汇总一条助手消息的全部正文文本（segments 模式取所有 text 段，旧消息直接取 content），
// 用于占位判断、复制操作等。
function messageText(message: Message): string {
  if (message.segments?.length) {
    return message.segments
      .filter(segment => segment.type === "text")
      .map(segment => segment.content)
      .join("\n\n");
  }
  return message.content;
}

function toAgentMessages(messages: Message[]): AgentMessage[] {
  return messages
    .filter(message => message.role === "user" || message.role === "assistant")
    .filter(message => message.status !== "send_failed" && message.status !== "recv_failed")
    .map(message => ({ role: message.role, content: message.content }));
}

// 清除 Radix modal 可能残留的背景滚动/交互锁定（body/html 的 overflow 与 pointer-events），避免页面无法滚动/点击。
function clearModalResidue() {
  const leftover = Array.from(document.body.classList).filter(c => c.startsWith("block-interactivity-") || c.startsWith("allow-interactivity-"));
  leftover.forEach(c => document.body.classList.remove(c));
  document.body.style.overflow = "";
  document.body.style.pointerEvents = "";
  document.documentElement.style.overflow = "";
  document.documentElement.style.pointerEvents = "";
}

function nodeToText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeToText).join("");
  if (isValidElement(node)) return nodeToText((node as ReactElement<{ children?: ReactNode }>).props.children);
  return "";
}

export { normalizeStoredState, toChatModel, nowTime, formatDisplayTime, formatRelativeTime, extractTextContent, messageText, toAgentMessages, clearModalResidue, nodeToText };
