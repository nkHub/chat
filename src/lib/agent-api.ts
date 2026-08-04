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

// OpenAI function calling 格式的工具定义，与后端 /v1/agent 内置工具保持一致。
// 后端采用白名单注入：请求显式传入 tools 时只注入列表内声明的工具（未声明的内置工具
// 如 tavily_search / akm_generate_image 等不会被注入，避免模型未经声明自主调用）。
export type AgentTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, { type: string; description?: string; enum?: string[] }>;
      required?: string[];
    };
  };
};

// 联网搜索工具（对应后端内置 tavily_search，需在服务端配置 tavily_api_key）。
const TAVILY_SEARCH_TOOL: AgentTool = {
  type: "function",
  function: {
    name: "tavily_search",
    description: "通过 Tavily 实时联网搜索互联网信息，返回包含标题、链接和摘要的搜索结果。需要先在 config.json 中配置 tavily_api_key",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词" },
        max_results: { type: "integer", description: "返回结果数量，1 到 20，默认 5" },
        search_depth: { type: "string", enum: ["basic", "advanced"], description: "搜索深度，默认 basic" },
      },
      required: ["query"],
    },
  },
};

// 图像生成工具（对应后端内置 akm_generate_image，需配置 image_supported_models 对应可用 Key）。
const AKM_GENERATE_IMAGE_TOOL: AgentTool = {
  type: "function",
  function: {
    name: "akm_generate_image",
    description: "调用 AKM 配置的图片生成模型生成图片，返回图片资源列表。每项含 url，并附带保存到本地的 local_path 与可访问的 http_url（/agent-uploads/...），保存失败时含 save_error。需要配置 image_supported_models 对应的可用 API Key",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "图片描述提示词" },
        model: { type: "string", description: "图片生成模型，默认取 image_supported_models 首项" },
        size: { type: "string", description: "图片尺寸，如 1024x1024，可选" },
        quality: { type: "string", description: "生成质量，如 standard 或 hd，可选" },
        n: { type: "integer", description: "生成张数，默认 1" },
      },
      required: ["prompt"],
    },
  },
};

// 图像编辑工具（对应后端内置 akm_edit_image）。读取本地图片（生成工具返回的 local_path
// 或用户上传时后端落盘的路径）进行编辑，需配置 image_supported_models 对应可用 Key。
const AKM_EDIT_IMAGE_TOOL: AgentTool = {
  type: "function",
  function: {
    name: "akm_edit_image",
    description: "读取本地图片并编辑（如重绘局部、扩展内容），返回编辑后的图片资源列表。每项含 url，并附带保存到本地的 local_path 与可访问的 http_url（/agent-uploads/...），保存失败时含 save_error。需要提供服务器可访问的图片路径，以及配置了对应模型的可用 API Key",
    parameters: {
      type: "object",
      properties: {
        image_path: { type: "string", description: "本地图片文件的绝对路径" },
        prompt: { type: "string", description: "编辑指令，描述期望的修改效果" },
        model: { type: "string", description: "图片编辑模型，默认取 image_supported_models 首项" },
        mask_path: { type: "string", description: "本地蒙版图片路径，用于限定重绘区域，可选" },
        size: { type: "string", description: "输出图片尺寸，如 1024x1024，可选" },
        quality: { type: "string", description: "生成质量，如 standard 或 hd，可选" },
        output_format: { type: "string", description: "输出格式，如 png 或 jpeg，可选" },
        n: { type: "integer", description: "生成张数，默认 1" },
      },
      required: ["image_path", "prompt"],
    },
  },
};

// 按客户端 UI 工具开关（"search" / "image"）映射为显式声明的工具定义列表。
// 开启哪个声明哪个；"image" 同时声明生成与编辑，模型可先生成拿到 local_path 再编辑。
// 全关时返回空数组（调用方据此不携带 tools 字段，
// 后端默认不注入联网搜索/图片生成/编辑工具）。
export function resolveDeclaredTools(tools: string[]): AgentTool[] {
  const declared: AgentTool[] = [];
  if (tools.includes("search")) declared.push(TAVILY_SEARCH_TOOL);
  if (tools.includes("image")) {
    declared.push(AKM_GENERATE_IMAGE_TOOL, AKM_EDIT_IMAGE_TOOL);
  }
  return declared;
}

export type AgentStreamEventName = "reasoning_delta" | "model_delta" | "turn_start" | "tool_call" | "tool_result" | "context_warning" | "final" | "error";

// 上下文占用警告信息（对应后端 context_warning 事件）：
// 上下文估算已用 / 上限 / 剩余 tokens、占用比例与已压缩次数。
export type ContextWarning = {
  estimated_tokens: number;
  max_tokens: number;
  remaining_tokens: number;
  ratio: number;
};

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
    // 上下文管理信息：context_warning 事件携带占用估算与比例（平铺字段，
    // 与后端 _sse_event 下发格式一致），final 事件携带 compacted（本次运行自动压缩次数）。
    estimated_tokens?: number;
    max_tokens?: number;
    remaining_tokens?: number;
    ratio?: number;
    compacted?: number;
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
  tools?: AgentTool[];
}, stream: boolean) {
  return JSON.stringify({
    model: options.model,
    messages: options.messages,
    instructions: options.instructions,
    // 仅当显式声明了工具时才携带 tools 字段（白名单注入）。
    // 未开启任何工具时不传 tools：后端默认不注入联网搜索/图片生成/编辑工具。
    ...(options.tools?.length ? { tools: options.tools } : {}),
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
  tools?: AgentTool[];
  files: File[];
}, stream: boolean) {
  const form = new FormData();
  form.append("model", options.model);
  form.append("messages", JSON.stringify(options.messages));
  form.append("instructions", options.instructions);
  // multipart 场景同样支持 tools：仅当显式声明了工具时才携带，
  // 与纯 JSON 一样按白名单注入声明中列出的工具。
  if (options.tools?.length) form.append("tools", JSON.stringify(options.tools));
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
  tools?: AgentTool[];
}): Promise<AgentResponse> {
  const payload = await requestJson<AgentResponse>("/v1/agent", {
    method: "POST",
    body: createAgentRequestBody(options, false),
  });

  if (!payload?.ok) throw new Error(payload?.error || "Agent 未返回成功结果");
  return payload;
}

function isAgentStreamEventName(value: unknown): value is AgentStreamEventName {
  return value === "reasoning_delta" || value === "model_delta" || value === "turn_start" || value === "tool_call" || value === "tool_result" || value === "context_warning" || value === "final" || value === "error";
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
  tools?: AgentTool[];
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
