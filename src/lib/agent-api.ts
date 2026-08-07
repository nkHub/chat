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
      // enum 支持 string / number，与后端 OpenAI function schema 对齐（如 days: [0,1,7,30]）
      properties: Record<string, { type: string; description?: string; enum?: Array<string | number>; items?: { type: string } }>;
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

// 图像编辑工具（对应后端内置 akm_edit_image）。图片来源二选一：image_path 读服务器本地文件，
// 或 image_base64 直接传 base64/data URL（云端无本地文件场景）；需配置 image_supported_models 对应可用 Key。
const AKM_EDIT_IMAGE_TOOL: AgentTool = {
  type: "function",
  function: {
    name: "akm_edit_image",
    description:
      "编辑图片（如重绘局部、扩展内容），返回编辑后的图片资源列表。每项含 url，并附带保存到本地的 local_path 与可访问的 http_url（/agent-uploads/...），保存失败时含 save_error。" +
      "图片来源二选一：image_path 传服务器本地文件绝对路径；或 image_base64 传图片的 base64 数据（可直接使用对话中图片的 data:image/...;base64, 前缀数据，适合本地无文件的场景）。需要配置了对应模型的可用 API Key",
    parameters: {
      type: "object",
      properties: {
        image_path: { type: "string", description: "本地图片文件的绝对路径，与 image_base64 二选一" },
        image_base64: {
          type: "string",
          description: "图片 base64 数据（可带 data:image/...;base64, 前缀），与 image_path 二选一，优先级更高",
        },
        prompt: { type: "string", description: "编辑指令，描述期望的修改效果" },
        model: { type: "string", description: "图片编辑模型，默认取 image_supported_models 首项" },
        mask_path: { type: "string", description: "本地蒙版图片路径，用于限定重绘区域，可选" },
        mask_base64: {
          type: "string",
          description: "蒙版图片的 base64 数据（可带 data:... 前缀），与 mask_path 二选一，优先级更高",
        },
        size: { type: "string", description: "输出图片尺寸，如 1024x1024，可选" },
        quality: { type: "string", description: "生成质量，如 standard 或 hd，可选" },
        output_format: { type: "string", description: "输出格式，如 png 或 jpeg，可选" },
        n: { type: "integer", description: "生成张数，默认 1" },
      },
      // 与后端一致：仅 prompt 必填；图片由 image_path / image_base64 二选一提供
      required: ["prompt"],
    },
  },
};

// 获取服务器当前时间（对应后端内置 akm_get_time，无参数）。
// 只读且无害，作为始终声明的基础工具，避免开启其它工具开关后因白名单注入丢失。
const AKM_GET_TIME_TOOL: AgentTool = {
  type: "function",
  function: {
    name: "akm_get_time",
    description: "获取服务器当前时间，返回本地 ISO 时间、UTC 时间、UNIX 时间戳与时区",
    parameters: { type: "object", properties: {} },
  },
};

// 查询 Key 汇总（对应后端内置 akm_get_keys_summary，无参数）。
// 只读，作为基础工具始终声明；返回 Key 总数与每个 Key 的供应商/模型清单，不返回密钥。
const AKM_GET_KEYS_SUMMARY_TOOL: AgentTool = {
  type: "function",
  function: {
    name: "akm_get_keys_summary",
    description: "返回 AKM 当前已配置 Key 的总数，以及每个 Key 的供应商与模型清单，不返回密钥",
    parameters: { type: "object", properties: {} },
  },
};

// 读取 AKM 运行配置（对应后端内置 akm_get_config，无参数）。
// 只读，作为基础工具始终声明；密钥类字段（agent_api_token、tavily_api_key）不做明文透出，仅标记是否已配置。
const AKM_GET_CONFIG_TOOL: AgentTool = {
  type: "function",
  function: {
    name: "akm_get_config",
    description:
      "读取 AKM 运行配置。密钥类字段（agent_api_token、tavily_api_key）不做明文透出，" +
      "仅标记是否已配置；其余配置项原样返回",
    parameters: { type: "object", properties: {} },
  },
};

// 列出已加载插件（对应后端内置 akm_list_plugins，无参数）。
// 只读，作为基础工具始终声明；返回插件名称、版本、分类、描述、是否内置、是否启用与来源。
const AKM_LIST_PLUGINS_TOOL: AgentTool = {
  type: "function",
  function: {
    name: "akm_list_plugins",
    description: "列出 AKM 已加载插件的非敏感摘要：名称、版本、分类、描述、是否内置、是否启用与来源",
    parameters: { type: "object", properties: {} },
  },
};

// 列出历史 Agent 会话（对应后端内置 akm_list_sessions，无参数）。
// 只读，作为基础工具始终声明；返回会话元信息（会话名、创建/更新时间、消息数、模型），不含消息正文。
const AKM_LIST_SESSIONS_TOOL: AgentTool = {
  type: "function",
  function: {
    name: "akm_list_sessions",
    description: "列出历史 Agent 会话的元信息（会话名、创建/更新时间、消息数、模型），不含消息正文，按更新时间倒序",
    parameters: { type: "object", properties: {} },
  },
};

// 读取历史 Agent 会话（对应后端内置 akm_load_session）。
// 只读，作为基础工具始终声明；读取指定会话最近若干条消息，用于回顾之前会话的上下文。
const AKM_LOAD_SESSION_TOOL: AgentTool = {
  type: "function",
  function: {
    name: "akm_load_session",
    description: "读取历史 Agent 会话的最近若干条消息，用于回顾之前会话的上下文",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "会话名（来自 akm_list_sessions 的 name 字段）" },
        limit: { type: "integer", description: "返回最近的消息条数，1 到 100，默认 20" },
      },
      required: ["name"],
    },
  },
};

// 查询 Token 用量统计（对应后端内置 akm_get_usage_stats，与 /api/stats 同源）。
// 只读，作为基础工具始终声明；默认返回 1/7/30 天窗口，开启 cost_stats_enabled 时附带费用估算。
const AKM_GET_USAGE_STATS_TOOL: AgentTool = {
  type: "function",
  function: {
    name: "akm_get_usage_stats",
    description:
      "查询 AKM 近期 Token 用量统计。默认同时返回最近 1/7/30 天窗口的请求数、" +
      "prompt/completion/total/cached tokens，以及按 model/provider/key 的汇总。" +
      "开启 cost_stats_enabled 时额外返回费用估算（total_cost）与模型单价表" +
      "（input/input_cache/output，单位 USD per 1M tokens）；费用为本地估算，不能替代供应商账单",
    parameters: {
      type: "object",
      properties: {
        days: {
          type: "integer",
          description: "查询窗口：1 / 7 / 30 只返回该窗口；0 或省略时返回 1、7、30 三个窗口",
          enum: [0, 1, 7, 30],
        },
      },
    },
  },
};

// 只读文件工具（对应后端内置工作区文件工具，需在服务端配置 agent_workspace_root 才会注册）。
// 仅提供读取能力：读取内容 / 列出目录 / glob 匹配 / 正则搜索 / 文件元信息，均在服务端工作区沙箱内。
const AKM_READ_FILE_TOOL: AgentTool = {
  type: "function",
  function: {
    name: "akm_read_file",
    description: "读取工作区内文本文件的内容（带行级分页与长度限制）。仅能访问 agent_workspace_root 配置的工作区目录",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "工作区内的文件路径（绝对路径或相对工作区根目录的路径）" },
        offset: { type: "integer", description: "起始行号（从 0 开始），默认 0" },
        limit: { type: "integer", description: "返回的最大行数，-1 表示读到结尾，默认 -1" },
      },
      required: ["path"],
    },
  },
};

const AKM_LIST_DIR_TOOL: AgentTool = {
  type: "function",
  function: {
    name: "akm_list_dir",
    description: "列出工作区内目录下的条目（名称、类型、大小），用于感知工作区结构",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "工作区内的目录路径，留空表示工作区根目录" },
      },
    },
  },
};

const AKM_GLOB_TOOL: AgentTool = {
  type: "function",
  function: {
    name: "akm_glob",
    description: "在工作区内按 glob 模式匹配文件或目录路径（相对工作区根目录返回），如 **/*.py",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "glob 匹配模式，如 **/*.py" },
      },
      required: ["pattern"],
    },
  },
};

const AKM_GREP_TOOL: AgentTool = {
  type: "function",
  function: {
    name: "akm_grep",
    description: "在工作区内按正则搜索文件内容，返回命中的文件、行号与行内容",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "要搜索的正则表达式" },
        path: { type: "string", description: "限定搜索的目录或文件（工作区内），留空递归搜索整个工作区" },
        case_sensitive: { type: "boolean", description: "是否区分大小写，默认 false" },
      },
      required: ["pattern"],
    },
  },
};

const AKM_FILE_INFO_TOOL: AgentTool = {
  type: "function",
  function: {
    name: "akm_file_info",
    description: "返回工作区内文件或目录的元信息（类型、大小、修改时间）",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "工作区内的文件或目录路径" },
      },
      required: ["path"],
    },
  },
};

// 写文件工具（对应后端内置 akm_write_file，需配置 agent_workspace_root 与 agent_write_tools_enabled=true）。
// 新建或覆盖工作区内的文本文件，支持覆盖 / 追加两种模式。
const AKM_WRITE_FILE_TOOL: AgentTool = {
  type: "function",
  function: {
    name: "akm_write_file",
    description:
      "新建或覆盖工作区内的文本文件（mode=overwrite 覆盖 / append 追加）。" +
      "仅 agent_write_tools_enabled=true 时可用",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "工作区内的文件路径（相对工作区根目录的路径）" },
        content: { type: "string", description: "要写入的文本内容" },
        mode: { type: "string", enum: ["overwrite", "append"], description: "overwrite 覆盖（默认）或 append 追加" },
      },
      required: ["path", "content"],
    },
  },
};

// 结构化编辑文件工具（对应后端内置 akm_edit_file，需 agent_write_tools_enabled=true）。
// 支持行号模式（start_line/end_line + new_content）与内容模式（old_string/new_string）。
const AKM_EDIT_FILE_TOOL: AgentTool = {
  type: "function",
  function: {
    name: "akm_edit_file",
    description:
      "结构化编辑工作区内的文本文件，支持两种定位方式：行号模式传 start_line（1-based，可配 end_line）" +
      "把行区间替换为 new_content，推荐先读文件拿到行号后用，另可配 old_string 做锚点校验防止改错位置；" +
      "内容模式将 old_string 替换为 new_string。仅 agent_write_tools_enabled=true 时可用",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "工作区内的文件路径" },
        old_string: { type: "string", description: "行号模式下作为目标行区间的锚点校验内容（可选）；内容模式下为要被替换的原文片段" },
        new_string: { type: "string", description: "内容模式下的替换文本，可留空表示删除（仅内容模式使用）" },
        replace_all: { type: "boolean", description: "内容模式下是否替换所有匹配（默认只替换第一处）" },
        start_line: { type: "integer", description: "行号模式起始行号（1-based）；传此字段进入行号模式，把 [start_line, end_line] 区间整体替换为 new_content" },
        end_line: { type: "integer", description: "行号模式结束行号（含，默认等于 start_line，只替换一行）" },
        new_content: { type: "string", description: "行号模式下的新内容（可多行），替换目标行区间" },
      },
      required: ["path"],
    },
  },
};

// 创建目录工具（对应后端内置 akm_make_dir，需 agent_write_tools_enabled=true）。
const AKM_MAKE_DIR_TOOL: AgentTool = {
  type: "function",
  function: {
    name: "akm_make_dir",
    description: "在工作区内创建目录（含所需父目录）。仅 agent_write_tools_enabled=true 时可用",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "工作区内的目录路径" },
      },
      required: ["path"],
    },
  },
};

// 删除文件工具（对应后端内置 akm_delete_file，需 agent_write_tools_enabled=true）。
// 仅允许删除单个文件，禁止删除目录（防批量删除）。
const AKM_DELETE_FILE_TOOL: AgentTool = {
  type: "function",
  function: {
    name: "akm_delete_file",
    description: "删除工作区内的单个文件。禁止删除目录（防批量删除）。仅 agent_write_tools_enabled=true 时可用",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "工作区内要删除的单个文件路径" },
      },
      required: ["path"],
    },
  },
};

// Shell 执行工具（对应后端内置 akm_run_shell，需 agent_run_shell_enabled=true）。
// 命令由模型直接传入，服务端用系统 shell 解释执行（支持管道、通配符、重定向），cwd 为工作区根目录。
const AKM_RUN_SHELL_TOOL: AgentTool = {
  type: "function",
  function: {
    name: "akm_run_shell",
    description:
      "在工作区用 shell 执行命令字符串并返回 stdout+stderr（支持管道、通配符、重定向；cwd 固定为工作区根目录）。" +
      "仅 agent_run_shell_enabled=true 时可用；属主机级进程执行能力",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "要执行的 shell 命令字符串" },
        timeout: { type: "integer", description: "超时秒数，1-300，默认 60" },
      },
      required: ["command"],
    },
  },
};

// Git 结构化操作工具（对应后端内置 akm_run_git，需 agent_git_enabled=true）。
// 仅支持固定集合的结构化操作，不接受自由命令字符串。
const AKM_RUN_GIT_TOOL: AgentTool = {
  type: "function",
  function: {
    name: "akm_run_git",
    description:
      "在工作区执行结构化 git 操作并返回输出与退出码。仅支持 status、diff、log、show、add、restore、reset、commit、branch；" +
      "不接受自由命令字符串。仅 agent_git_enabled=true 时可用",
    parameters: {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["status", "diff", "log", "show", "add", "restore", "reset", "commit", "branch"], description: "要执行的 git 操作" },
        paths: { type: "array", items: { type: "string" }, description: "add、restore、reset 必填；diff 可选的工作区相对路径" },
        message: { type: "string", description: "commit 操作必填的提交说明" },
        revision: { type: "string", description: "show 操作的 revision，默认 HEAD" },
        staged: { type: "boolean", description: "diff 是否查看暂存区，默认 false" },
        limit: { type: "integer", description: "log 返回条数，1-100，默认 20" },
        timeout: { type: "integer", description: "超时秒数，1-300，默认 60" },
      },
      required: ["operation"],
    },
  },
};

// 按客户端 UI 工具开关（"search" / "image"）映射为显式声明的工具定义列表。
// 工作区文件工具（读/写/编辑/目录/删除）、git 与 shell 工具始终声明，避免白名单注入时丢失；
// "image" 同时声明生成与编辑，模型可先生成拿到 local_path 再编辑，也可对上传图用 base64 编辑。
// 因基础工具始终存在，返回列表非空；调用方会携带 tools 走白名单，
// 后端不会注入未声明的联网搜索/图片生成/编辑工具。
export function resolveDeclaredTools(tools: string[]): AgentTool[] {
  const declared: AgentTool[] = [];
  // 基础只读工具：始终声明，与后端未传 tools 时的默认注入子集对齐
  declared.push(
    AKM_GET_TIME_TOOL,
    AKM_GET_USAGE_STATS_TOOL,
    AKM_GET_KEYS_SUMMARY_TOOL,
    AKM_GET_CONFIG_TOOL,
    AKM_LIST_PLUGINS_TOOL,
    AKM_LIST_SESSIONS_TOOL,
    AKM_LOAD_SESSION_TOOL,
  );
  // 工作区文件工具（读 + 写）：始终声明，可用性由后端配置开关控制
  declared.push(
    AKM_READ_FILE_TOOL,
    AKM_LIST_DIR_TOOL,
    AKM_GLOB_TOOL,
    AKM_GREP_TOOL,
    AKM_FILE_INFO_TOOL,
    AKM_WRITE_FILE_TOOL,
    AKM_EDIT_FILE_TOOL,
    AKM_MAKE_DIR_TOOL,
    AKM_DELETE_FILE_TOOL,
  );
  // shell 与 git：始终声明，可用性由后端配置开关控制
  declared.push(AKM_RUN_SHELL_TOOL, AKM_RUN_GIT_TOOL);
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
