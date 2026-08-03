export type AgentMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  reasoning_content?: string | null;
  tool_calls?: Array<{
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
  tool_call_id?: string;
};

export type ApiModel = {
  id: string;
  owned_by?: string;
};

export type AgentResponse = {
  ok: boolean;
  final_message?: AgentMessage;
  messages?: AgentMessage[];
  turns?: number;
  error?: string;
  usage?: Record<string, number>;
};

export type AgentStreamEventName = "reasoning_delta" | "model_delta" | "turn_start" | "tool_call" | "tool_result" | "final" | "error";

export type AgentStreamEvent = {
  event: AgentStreamEventName;
  data: {
    turn?: number;
    content?: string;
    name?: string;
    arguments?: Record<string, unknown>;
    result?: unknown;
    final_message?: AgentMessage;
    messages?: AgentMessage[];
    turns?: number;
    usage?: Record<string, number>;
    error?: string;
  };
};

// 开发环境默认通过 Vite 代理访问本机 AKM，避免浏览器直接跨源请求被 CORS 拦截。
// 部署到其它地址时可用 VITE_AKM_API_URL 覆盖，例如 http://127.0.0.1:8800。
const API_BASE_URL = (import.meta.env.VITE_AKM_API_URL || "/akm-api").replace(/\/+$/, "");

function getErrorMessage(payload: unknown, status: number) {
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    if (typeof record.detail === "string" && record.detail) return record.detail;
    if (typeof record.error === "string" && record.error) return record.error;
  }
  return `请求失败（HTTP ${status}）`;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });

  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) throw new Error(getErrorMessage(payload, response.status));
  return payload as T;
}

function createAgentRequestBody(options: {
  model: string;
  messages: AgentMessage[];
  instructions: string;
}, stream: boolean) {
  return JSON.stringify({
    model: options.model,
    messages: options.messages,
    instructions: options.instructions,
    api_path: "chat/completions",
    max_turns: 20,
    stream,
  });
}

// 后端 /v1/agent 支持 multipart/form-data 上传文件：messages 为 JSON 字符串表单字段，
// files 可携带多个文件（图片转 image_url、文本按 UTF-8 读取）。
function createAgentFormData(options: {
  model: string;
  messages: AgentMessage[];
  instructions: string;
  files: File[];
}, stream: boolean) {
  const form = new FormData();
  form.append("model", options.model);
  form.append("messages", JSON.stringify(options.messages));
  form.append("instructions", options.instructions);
  form.append("api_path", "chat/completions");
  form.append("max_turns", "20");
  form.append("stream", String(stream));
  options.files.forEach(file => form.append("files", file));
  return form;
}

export async function fetchModels(): Promise<ApiModel[]> {
  const payload = await requestJson<{ data?: ApiModel[] }>("/v1/models");
  if (!Array.isArray(payload?.data)) throw new Error("模型列表格式无效");
  return payload.data.filter(model => typeof model?.id === "string" && model.id.trim());
}

export async function runAgent(options: {
  model: string;
  messages: AgentMessage[];
  instructions: string;
}): Promise<AgentResponse> {
  const payload = await requestJson<AgentResponse>("/v1/agent", {
    method: "POST",
    body: createAgentRequestBody(options, false),
  });

  if (!payload?.ok) throw new Error(payload?.error || "Agent 未返回成功结果");
  return payload;
}

function isAgentStreamEventName(value: unknown): value is AgentStreamEventName {
  return value === "reasoning_delta" || value === "model_delta" || value === "turn_start" || value === "tool_call" || value === "tool_result" || value === "final" || value === "error";
}

function parseAgentStreamFrame(frame: string): AgentStreamEvent | null {
  const data = frame
    .split(/\r?\n/)
    .filter(line => line.startsWith("data:"))
    .map(line => line.slice(5).trimStart())
    .join("\n")
    .trim();

  if (!data || data === "[DONE]") return null;

  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    throw new Error("Agent 流式事件格式无效");
  }

  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (!isAgentStreamEventName(record.event) || !record.data || typeof record.data !== "object") return null;
  return { event: record.event, data: record.data as AgentStreamEvent["data"] };
}

export async function* runAgentStream(options: {
  model: string;
  messages: AgentMessage[];
  instructions: string;
  files?: File[];
}): AsyncGenerator<AgentStreamEvent> {
  // 携带附件时改用 multipart/form-data，否则保持纯 JSON。
  const hasFiles = Boolean(options.files?.length);
  const headers: Record<string, string> = { Accept: "text/event-stream" };
  // multipart 的 Content-Type（含 boundary）由浏览器自动生成，不能手动设置。
  if (!hasFiles) headers["Content-Type"] = "application/json";

  const response = await fetch(`${API_BASE_URL}/v1/agent`, {
    method: "POST",
    headers,
    body: hasFiles ? createAgentFormData({ ...options, files: options.files! }, true) : createAgentRequestBody(options, true),
  });

  if (!response.ok) {
    const text = await response.text();
    let payload: unknown = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    throw new Error(getErrorMessage(payload, response.status));
  }

  if (!response.body) throw new Error("Agent 未返回可读取的流");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // SSE 事件以空行分帧。每次读取只处理完整帧，避免网络分片把 JSON 截断后误解析。
  const emitFrames = function* (flush = false): Generator<AgentStreamEvent> {
    if (flush) buffer += decoder.decode();
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = flush ? "" : (frames.pop() || "");
    for (const frame of frames) {
      const event = parseAgentStreamFrame(frame);
      if (event) yield event;
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      yield* emitFrames();
    }
    yield* emitFrames(true);
  } finally {
    reader.releaseLock();
  }
}
