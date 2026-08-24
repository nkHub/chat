import { isValidElement, type ReactElement, type ReactNode } from "react";
import type { AgentMessage, ApiModel } from "@/lib/agent-api";
import type { ChatModel, Message, StoredChatState } from "./types";
import { BUILTIN_SKILLS } from "./skills";

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
    .map(message => {
      // 用户消息携带 skill 引用（chip）：把对应 Skill 的模板展开成实际发给模型的内容，
      // {{input}} 替换为用户原文（如「翻译」→「请把下面的内容翻译成…需要翻译的内容：原文」）。
      // 会话气泡内仍展示原文，只有发往模型的正文是展开后的约束文本。
      if (message.role === "user" && message.skillRef) {
        const skill = BUILTIN_SKILLS.find(candidate => candidate.id === message.skillRef!.id);
        if (skill?.template && message.content.trim()) {
          return { role: "user", content: skill.template.replace("{{input}}", message.content.trim()) };
        }
      }
      return { role: message.role, content: message.content };
    });
}

// 把引用的会话历史整理成一段整体注入的"引用资料"消息（role:user）：
// - 开头显式声明：下列内容来自其它会话，是背景参考资料，不属于当前对话的历史轮次，
//   避免模型把引用内容与当前对话原始轮次混淆；
// - 每个会话块用分隔行包住，并附带 session_id，提示可用 akm_load_session 按 id 加载更完整内容；
// - 限制每会话最近条数、单块字符与总字符量，避免撑爆上下文。
function sessionRefsToContextMessages(refs: { id: string; title: string }[], all: Record<string, Message[]>, maxMessages = 12, maxChars = 4000, totalChars = 8000): AgentMessage[] {
  const blocks: string[] = [];
  let budget = totalChars;
  for (const ref of refs) {
    const list = (all[ref.id] ?? [])
      .filter(message => (message.role === "user" || message.role === "assistant") && message.status !== "send_failed" && message.status !== "recv_failed");
    const lines: string[] = [];
    let chars = 0;
    for (const message of list.slice(-maxMessages)) {
      const text = messageText(message).trim();
      if (!text) continue;
      const line = `${message.role === "user" ? "用户" : "助手"}: ${text}`;
      if (chars + line.length > maxChars) break;
      lines.push(line);
      chars += line.length;
    }
    // 明确标注实际注入的条数（可能因字符上限而少于 maxMessages），让模型知晓取的是最近几轮。
    const count = lines.length;
    const body = count > 0 ? `以下为该会话最近 ${count} 条对话记录：\n${lines.join("\n\n")}` : "该会话当前无文本记录。";
    const block = [
      `[引用会话「${ref.title}」（session_id: ${ref.id}）]`,
      body,
      `若需查看该会话更完整上下文，可调用 akm_load_session 工具，传 session_id=${ref.id}。`,
    ].join("\n");
    // 总预算不足则裁剪掉更靠后的引用块。
    if (block.length > budget) break;
    blocks.push(block);
    budget -= block.length;
  }
  if (!blocks.length) return [];
  // 聚合为单条资料消息：与后续真实对话轮次物理隔开，声明其"外部引用"属性。
  return [{
    role: "user",
    content: [
      "【引用资料 — 非当前对话】",
      "以下内容来自用户引用的其它会话，仅作为背景参考资料提供，",
      "不属于当前对话的历史轮次，请勿把它们当作本次对话的原始对话内容。",
      "",
      blocks.join("\n\n----------\n\n"),
      "【引用资料结束】",
    ].join("\n"),
  }];
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

export { normalizeStoredState, toChatModel, nowTime, formatDisplayTime, formatRelativeTime, extractTextContent, messageText, toAgentMessages, sessionRefsToContextMessages, clearModalResidue, nodeToText };
