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

// 知识库检索工具（对应后端内置 akm_search_kb）。
// 通过本机 markdown-kb 插件（POST /api/markdown-kb/query）检索已索引的 Markdown 知识库，
// 返回命中片段（标题/文件名/相关度分数/正文摘要）。只读，作为基础工具始终声明；
// 需本机已启用并索引 markdown-kb 插件。显式传 workspace_root 可按指定目录跨目录检索，否则自动锁定当前 Agent 工作区。
const AKM_SEARCH_KB_TOOL: AgentTool = {
  type: "function",
  function: {
    name: "akm_search_kb",
    description:
      "通过 markdown-kb 知识库检索与问题最相关的文档片段，返回命中内容的标题、文件名、相关度分数与正文摘要。需要 markdown-kb 插件已启用且已学习文档",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "检索问题" },
        top_k: { type: "integer", description: "返回命中条数，1 到 20，默认 5" },
        embedding_model: { type: "string", description: "向量模型，默认取插件配置" },
        reranker_model: { type: "string", description: "重排模型，默认取插件配置" },
        workspace_root: {
          type: "string",
          description: "显式指定检索的知识库工作目录（绝对路径），用于跨目录检索；不传时自动锁定当前 Agent 工作区",
        },
      },
      required: ["question"],
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

// 读取 AKM 服务健康状态（对应后端内置 akm_get_status，无参数）。
// 只读，作为基础工具始终声明；返回服务健康、审计队列与插件运行状态。
const AKM_GET_STATUS_TOOL: AgentTool = {
  type: "function",
  function: {
    name: "akm_get_status",
    description: "读取 AKM 服务健康、审计队列和插件运行状态",
    parameters: { type: "object", properties: {} },
  },
};

// 列出已配置 Key（对应后端内置 akm_list_keys，无参数）。
// 只读，作为基础工具始终声明；返回 Key 的非敏感状态与模型信息，不返回密钥。
const AKM_LIST_KEYS_TOOL: AgentTool = {
  type: "function",
  function: {
    name: "akm_list_keys",
    description: "列出 AKM 中已配置 Key 的非敏感状态与模型信息，不返回密钥",
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

// 交互澄清工具（对应后端内置 akm_ask_user）：AI 信息不完整/有歧义时主动询问用户，
// 而不是自己猜测。后端在默认注入与白名单注入（传了 tools）时都可用，仅显式传
// 空数组 [] 才被排除，因此这里始终声明，保证走白名单时不被丢弃。触发时后端
// 下发 ask_user SSE 事件（含 question/options/multiple 与可续跑的 messages），
// 由前端 UI 展示并续跑。三种模式：只传 question=自由文本输入；加 options=从
// 候选里单选（multiple 缺省 false）；options + multiple=true=可多选。
const AKM_ASK_USER_TOOL: AgentTool = {
  type: "function",
  function: {
    name: "akm_ask_user",
    description: "当你需要向用户确认信息才能继续时调用本工具：用户上一条消息信息不完整、存在歧义、缺少关键参数，或你需要用户做选择时，把想确认的内容作为 question 传给本工具，等待用户回答后继续。问题要具体、一次只问一件事，避免让用户费解。如果不传 options，用户以自由文本回答；传了 options 则用户从选项中挑选（multiple=true 可多选，否则单选）",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "需要向用户确认的问题，需具体明确" },
        options: {
          type: "array",
          items: { type: "string" },
          description: "可选的候选答案列表。不传时用户自由文本回答；传入后用户从这些选项中挑选回答",
        },
        multiple: {
          type: "boolean",
          description: "传了 options 时是否允许用户多选（默认 false 单选）。不传 options 时本字段无意义",
        },
      },
      required: ["question"],
    },
  },
};

// 列出定时任务（对应后端内置 akm_list_tasks）。
// 只读，作为基础工具始终声明；返回任务 id、名称、类型、间隔、启用状态与执行时间。
const AKM_LIST_TASKS_TOOL: AgentTool = {
  type: "function",
  function: {
    name: "akm_list_tasks",
    description: "列出已配置的定时任务（akm 后台任务系统）：返回任务 id、名称、类型（agent_call / usage_query）、间隔、启用状态与执行时间，可用 task_type 过滤类型、enabled=1 只看启用任务",
    parameters: {
      type: "object",
      properties: {
        task_type: { type: "string", description: "按任务类型过滤：agent_call 或 usage_query，留空不过滤" },
        enabled: { type: "string", description: "传 1 时只返回启用的任务，留空返回全部" },
      },
      required: [],
    },
  },
};

// 创建定时任务（对应后端内置 akm_create_task）。
// 非只读，作为基础工具始终声明，供 Agent 自主编排重复任务。
const AKM_CREATE_TASK_TOOL: AgentTool = {
  type: "function",
  function: {
    name: "akm_create_task",
    description: "创建一条定时任务（akm 后台任务系统）：agent_call 类型周期调用 Agent Loop 跑一轮对话（payload 需含 messages，可带 model/tools/instructions/max_turns）；usage_query 类型对指定 alias 执行用量查询脚本（payload 需含 alias）。interval_sec 为循环间隔秒数，0 表示单次执行后自动禁用；cron 为预留字段。返回创建后的完整任务记录",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "任务名称" },
        task_type: { type: "string", description: "任务类型：agent_call 或 usage_query" },
        payload: { type: "object", description: "任务参数：agent_call 需 messages（对话历史，可带 model/tools/instructions/max_turns）；usage_query 需 alias" },
        interval_sec: { type: "integer", description: "循环间隔秒数，0（默认）表示单次执行后自动禁用" },
        cron: { type: "string", description: "预留字段，暂不解析" },
        enabled: { type: "boolean", description: "是否立即启用，默认 true" },
      },
      required: ["name", "task_type"],
    },
  },
};

// 删除定时任务（对应后端内置 akm_delete_task）。
// 非只读，作为基础工具始终声明，供 Agent 按需清理任务。
const AKM_DELETE_TASK_TOOL: AgentTool = {
  type: "function",
  function: {
    name: "akm_delete_task",
    description: "删除一条定时任务（akm 后台任务系统），按 akm_list_tasks 返回的 task_id 删除，返回是否删除成功",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "要删除的任务 id（来自 akm_list_tasks）" },
      },
      required: ["task_id"],
    },
  },
};

// 工作流引擎工具组（对应后端 akm_flow_*，build_builtin_tools 注册）：
// 默认注入（未传 tools）时后端会注入全部内置工具含 akm_flow_*；显式传 tools 走
// 白名单时需前端声明，这里始终声明，保证白名单注入时不被丢弃。
// 6 个工具覆盖工作流引擎的查询/读取/保存/删除/运行/运行记录查看。

const AKM_FLOW_LIST_TOOL: AgentTool = {
  type: "function",
  function: {
    name: "akm_flow_list",
    description: "列出已配置的工作流（akm flow 工作流引擎）：返回工作流的 id、名称、描述、节点数与更新时间，不含完整定义",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
};

const AKM_FLOW_GET_TOOL: AgentTool = {
  type: "function",
  function: {
    name: "akm_flow_get",
    description: "按 id 读取一条工作流的完整定义（nodes / edges / variables），供检查流程结构或复制修改",
    parameters: {
      type: "object",
      properties: {
        workflow_id: { type: "string", description: "工作流 id（来自 akm_flow_list）" },
      },
      required: ["workflow_id"],
    },
  },
};

const AKM_FLOW_SAVE_TOOL: AgentTool = {
  type: "function",
  function: {
    name: "akm_flow_save",
    description: "创建或更新一条工作流定义：workflow_id 留空则新建，传 id 则更新已有工作流。nodes 为节点数组（含 type / label / data）、edges 为连线数组（含 source / target / condition / loop）、variables 为运行变量（如 projectPath / maxNodeVisits）",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "工作流名称" },
        nodes: { type: "array", description: "节点数组，每项含 type（intake/plan/code/review/test/fix/human/router/merge/output）与 data（label/modelId/systemPrompt/userPromptTemplate 等）" },
        edges: { type: "array", description: "连线数组，每项含 source / target（节点 id），可选 condition（pass/fail/子串）与 loop" },
        variables: { type: "object", description: "运行变量，如 projectPath / maxNodeVisits / useWorktree" },
        description: { type: "string", description: "工作流描述，可选" },
        workflow_id: { type: "string", description: "留空创建新工作流；传已有 id 则更新该工作流" },
      },
      required: ["name"],
    },
  },
};

const AKM_FLOW_DELETE_TOOL: AgentTool = {
  type: "function",
  function: {
    name: "akm_flow_delete",
    description: "删除一条工作流及其全部运行记录，返回是否删除成功",
    parameters: {
      type: "object",
      properties: {
        workflow_id: { type: "string", description: "工作流 id（来自 akm_flow_list）" },
      },
      required: ["workflow_id"],
    },
  },
};

const AKM_FLOW_RUN_TOOL: AgentTool = {
  type: "function",
  function: {
    name: "akm_flow_run",
    description: "启动一次工作流运行：传入工作流 id 与用户提示词 prompt，后台执行 DAG（LLM 节点 / 条件分支 / 循环重入 / 并行），返回运行 id 与初始状态；可用 akm_flow_runs 查询进度",
    parameters: {
      type: "object",
      properties: {
        workflow_id: { type: "string", description: "工作流 id（来自 akm_flow_list）" },
        prompt: { type: "string", description: "用户提示词，作为工作流输入注入 {{input.prompt}}" },
        variables: { type: "object", description: "本次运行的临时变量（如 projectPath / language），覆盖工作流默认 variables，仅本次生效，不修改工作流定义" },
      },
      required: ["workflow_id", "prompt"],
    },
  },
};

const AKM_FLOW_RUNS_TOOL: AgentTool = {
  type: "function",
  function: {
    name: "akm_flow_runs",
    description: "列出工作流运行记录（按创建时间倒序）：返回运行 id、状态、输入摘要、token 用量与起止时间；可按 workflow_id 过滤",
    parameters: {
      type: "object",
      properties: {
        workflow_id: { type: "string", description: "按工作流 id 过滤，留空返回全部" },
        limit: { type: "integer", description: "返回条数，默认 20，最大 100" },
        offset: { type: "integer", description: "分页偏移，默认 0" },
      },
      required: [],
    },
  },
};

const AKM_FLOW_RUN_GET_TOOL: AgentTool = {
  type: "function",
  function: {
    name: "akm_flow_run_get",
    description: "查询一次工作流运行的节点级状态：返回各节点（id / label / 执行器 / 状态 / 错误 / token / 文件差异）与最近日志，用于定位工作流卡住或失败的节点",
    parameters: {
      type: "object",
      properties: {
        run_id: { type: "string", description: "运行 id（来自 akm_flow_run 或 akm_flow_runs）" },
      },
      required: ["run_id"],
    },
  },
};

// 子 Agent 递归委托（对应后端内置 akm_subagent_spawn/wait/kill，agent_subagent_enabled 默认开启才注册）。
// 主 Agent 可开启独立子进程会话，子进程调用 /v1/agent 运行次级对话，进程级隔离（默认独立临时工作区）。
// 嵌套层数上限由 config.json 的 agent_subagent_max_depth 控制（默认 1，即主会话可开子进程、子进程内不可再开）。
const AKM_SUBAGENT_SPAWN_TOOL: AgentTool = {
  type: "function",
  function: {
    name: "akm_subagent_spawn",
    description: "开启一个独立的子 Agent 子进程（子进程调用 /v1/agent 运行次级对话，进程级隔离，默认使用独立临时工作区）。返回 task_id，随后用 akm_subagent_wait 等待结果、akm_subagent_kill 终止。嵌套层数有上限，且并发数量有上限",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "子 Agent 需要独立完成的任务指令" },
        model: { type: "string", description: "可选，子 Agent 使用的模型，默认继承当前模型" },
        workspace_root: {
          type: "string",
          description: "可选，显式指定子 Agent 的工作目录（须为已存在的绝对路径）；不传时使用独立临时工作区",
        },
        timeout_ms: { type: "number", description: "可选，子 Agent 内部请求超时（毫秒），默认 600000" },
      },
      required: ["prompt"],
    },
  },
};

const AKM_SUBAGENT_WAIT_TOOL: AgentTool = {
  type: "function",
  function: {
    name: "akm_subagent_wait",
    description: "等待指定子 Agent 完成并返回其结果文本。超时返回「仍在运行」状态而非失败，可稍后再次调用或改用 akm_subagent_kill 终止",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "子 Agent 任务 id（来自 akm_subagent_spawn）" },
        timeout_ms: { type: "number", description: "可选，本次等待超时（毫秒），默认 600000" },
      },
      required: ["task_id"],
    },
  },
};

const AKM_SUBAGENT_KILL_TOOL: AgentTool = {
  type: "function",
  function: {
    name: "akm_subagent_kill",
    description: "终止指定子 Agent 子进程（含其进程组），释放资源",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "子 Agent 任务 id（来自 akm_subagent_spawn）" },
      },
      required: ["task_id"],
    },
  },
};

// 发送邮件（对应后端内置 akm_send_email，agent_email_enabled 为 true 且配置了 SMTP 才注册）。
// 非只读，作为基础工具始终声明；向指定邮箱发送纯文本通知，可用性由后端配置开关控制。
const AKM_SEND_EMAIL_TOOL: AgentTool = {
  type: "function",
  function: {
    name: "akm_send_email",
    description:
      "发送邮件（SMTP）。需要管理员在 config.json 中配置 agent_email_smtp_host/user/password 且 agent_email_enabled=true。用于向指定邮箱发送纯文本通知",
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", description: "收件人邮箱地址" },
        subject: { type: "string", description: "邮件主题" },
        body: { type: "string", description: "邮件正文（纯文本）" },
        from_: { type: "string", description: "可选发件人地址，留空使用 SMTP 账号" },
      },
      required: ["to", "subject", "body"],
    },
  },
};

// 发送 macOS 原生系统通知（对应后端内置 akm_send_notification，agent_notify_enabled 默认开启才注册）。
// 非只读，作为基础工具始终声明；适合 Agent 主动推送任务完成、定时提醒等短消息，不产生网络流量。
const AKM_SEND_NOTIFICATION_TOOL: AgentTool = {
  type: "function",
  function: {
    name: "akm_send_notification",
    description:
      "发送 macOS 原生系统通知，在用户当前 Mac 桌面弹出提醒（需通过菜单栏启动 AKM 才能正常展示）。" +
      "适合向用户主动推送任务完成、定时提醒、重要事件等短消息；不产生网络流量",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "通知标题，建议简短" },
        message: { type: "string", description: "通知正文内容" },
        subtitle: { type: "string", description: "可选副标题" },
      },
      required: ["title", "message"],
    },
  },
};

// 读取 macOS 系统剪贴板（对应后端内置 akm_clipboard_get，agent_native_tools_enabled 默认开启才注册）。
// 只读，作为基础工具始终声明；超 100000 字符截断并标记 truncated，不产生网络流量。
const AKM_CLIPBOARD_GET_TOOL: AgentTool = {
  type: "function",
  function: {
    name: "akm_clipboard_get",
    description: "读取本机 macOS 系统剪贴板纯文本内容，返回内容与长度（超 100000 字符截断并标记 truncated）。只读本机剪贴板，不产生网络流量",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
};

// 写入 macOS 系统剪贴板（对应后端内置 akm_clipboard_set）。
// 非只读，作为基础工具始终声明；会覆盖用户当前剪贴板，适合把模型生成的文本交给用户直接粘贴。
const AKM_CLIPBOARD_SET_TOOL: AgentTool = {
  type: "function",
  function: {
    name: "akm_clipboard_set",
    description: "把纯文本写入本机 macOS 系统剪贴板，替换当前内容（会覆盖用户当前剪贴板，请确认模型意图后再调用）",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "要写入剪贴板的纯文本内容" },
      },
      required: ["content"],
    },
  },
};

// 采集本机只读系统信息（对应后端内置 akm_system_info）。
// 只读，作为基础工具始终声明；返回 macOS 版本、架构、CPU、内存、主机名、Python 版本与服务器时间。
const AKM_SYSTEM_INFO_TOOL: AgentTool = {
  type: "function",
  function: {
    name: "akm_system_info",
    description: "采集本机只读系统信息：macOS 版本、架构、CPU 型号与核数、内存、主机名、Python 版本、服务器时间。只读无副作用",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
};

// 打开本机资源（对应后端内置 akm_open）。
// 非只读，作为基础工具始终声明；仅放行 http/https URL、工作区内文件与已安装应用名，后端做安全校验。
const AKM_OPEN_TOOL: AgentTool = {
  type: "function",
  function: {
    name: "akm_open",
    description: "打开本机资源：URL（仅限 http/https）、工作区内文件或已安装应用。kind 为 url/path/app，默认 url；path 必须位于工作区内，app 只接受应用名",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["url", "path", "app"], description: "打开类型，默认 url" },
        target: { type: "string", description: "目标：http/https URL、工作区内文件路径或应用名" },
      },
      required: ["target"],
    },
  },
};

// 查询本机当前前台应用（对应后端内置 akm_frontmost_app）。
// 只读，作为基础工具始终声明；返回应用名、Bundle ID 与进程号，无前台应用时 app 为 null。
const AKM_FRONTMOST_APP_TOOL: AgentTool = {
  type: "function",
  function: {
    name: "akm_frontmost_app",
    description: "返回本机当前前台应用的名称、Bundle ID 与进程号（只读）；无前台应用（无活跃 GUI 会话）时 app 为 null",
    parameters: {
      type: "object",
      properties: {},
      required: [],
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

// 查询近期审计日志（对应后端内置 akm_list_logs）。
// 只读，作为基础工具始终声明；返回 AKM 审计日志摘要，不返回请求体、响应体或请求头。
const AKM_LIST_LOGS_TOOL: AgentTool = {
  type: "function",
  function: {
    name: "akm_list_logs",
    description: "查询近期 AKM 审计日志摘要，不返回请求体、响应体或请求头",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "返回条数，1 到 50，默认 20" },
        status: { type: "string", enum: ["all", "success", "failed"], description: "状态筛选，默认 all" },
        days: { type: "integer", description: "最近自然日范围，0 表示不限制，默认 1" },
        key_alias: { type: "string", description: "按 Key 别名筛选，可选" },
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
// recursive=false（默认）只删除单个文件；recursive=true 可删除目录并递归清除其中所有内容。
const AKM_DELETE_FILE_TOOL: AgentTool = {
  type: "function",
  function: {
    name: "akm_delete_file",
    description: "删除工作区内的文件或目录。recursive=false（默认）只删除单个文件；recursive=true 可删除目录并递归清除其中所有内容。禁止删除工作区根目录。仅 agent_write_tools_enabled=true 时可用",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "工作区内要删除的文件或目录路径" },
        recursive: { type: "boolean", description: "是否递归删除目录（含其中所有文件），默认 false" },
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

// 创建/修改 xlsx 电子表格工具（对应后端内置 akm_xlsx，需 agent_write_tools_enabled=true）。
// action=create 用二维数组或 {工作表名: 二维数组} 新建；action=edit 用 updates=[{sheet, cell, value}] 写入已有文件单元格。
const AKM_XLSX_TOOL: AgentTool = {
  type: "function",
  function: {
    name: "akm_xlsx",
    description:
      "创建或修改工作区内的 .xlsx 电子表格文件。action=create 新建（data 为二维数组或 {sheet名: 二维数组}，目标已存在时需 overwrite=true）；" +
      "action=edit 修改已有文件（updates 为 [{sheet, cell, value}] 单元格写入列表）。两种 action 共用可选自定义参数：styles 设置单元格字体/背景/对齐/数字格式，" +
      "column_widths / row_heights 设列宽行高，merge_cells 合并单元格，freeze_panes 冻结窗格，charts 添加柱状/折线/饼图等图表；value 以 = 开头按公式写入。" +
      "仅 agent_write_tools_enabled=true 时可用",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "edit"], description: "create 新建 / edit 修改" },
        path: { type: "string", description: "工作区内的 .xlsx 文件路径" },
        data: { type: "object", description: "create 用：二维数组（[[...],[...]]）或 {sheet名: 二维数组} 映射" },
        sheet: { type: "string", description: "create 时纯数组数据写入的工作表名，默认 Sheet1" },
        overwrite: { type: "boolean", description: "create 时目标已存在是否覆盖，默认 false" },
        updates: { type: "array", items: { type: "object" }, description: "edit 用：[{sheet, cell, value}] 单元格写入列表，cell 如 A1；value 以 = 开头写公式" },
        styles: { type: "array", items: { type: "object" }, description: "单元格样式：[{sheet?, cell, bold?, italic?, size?, color?, fill?, align?, number_format?}]，color/fill 为十六进制色值（如 FF0000）" },
        column_widths: { type: "object", description: "列宽：{sheet?: {列名: 宽度}}，如 {\"Sheet1\": {\"A\": 20}}，sheet 键可省略默认 Sheet1" },
        row_heights: { type: "object", description: "行高：{sheet?: {行号: 高度}}" },
        merge_cells: { type: "object", description: "合并单元格：{sheet?: [区间...]}，如 {\"Sheet1\": [\"A1:C1\"]}" },
        freeze_panes: { type: "object", description: "冻结窗格：{sheet?: \"A2\"}" },
        charts: { type: "array", items: { type: "object" }, description: "图表列表：[{sheet?, type, title?, data_range, categories_range?, x_title?, y_title?, anchor?, legend?}]，type 为 bar/line/pie/scatter/area/doughnut，data_range 如 B2:B6" },
      },
      required: ["action", "path"],
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
    // 知识库检索：后端默认注入（markdown-kb 插件注册），这里始终声明，避免白名单时丢失
    AKM_SEARCH_KB_TOOL,
    AKM_GET_STATUS_TOOL,
    AKM_LIST_KEYS_TOOL,
    AKM_GET_TIME_TOOL,
    AKM_GET_USAGE_STATS_TOOL,
    AKM_GET_KEYS_SUMMARY_TOOL,
    AKM_GET_CONFIG_TOOL,
    AKM_LIST_PLUGINS_TOOL,
    AKM_LIST_SESSIONS_TOOL,
    AKM_LOAD_SESSION_TOOL,
    AKM_LIST_LOGS_TOOL,
    // 交互澄清工具：后端默认注入，这里始终声明，保证显式传 tools 走白名单时不被丢弃
    AKM_ASK_USER_TOOL,
    // 定时任务工具：后端默认注入，这里始终声明，保证显式传 tools 走白名单时不被丢弃
    AKM_LIST_TASKS_TOOL,
    AKM_CREATE_TASK_TOOL,
    AKM_DELETE_TASK_TOOL,
    // 工作流引擎工具：后端默认注入（build_builtin_tools 注册），这里始终声明，避免白名单时丢失
    AKM_FLOW_LIST_TOOL,
    AKM_FLOW_GET_TOOL,
    AKM_FLOW_SAVE_TOOL,
    AKM_FLOW_DELETE_TOOL,
    AKM_FLOW_RUN_TOOL,
    AKM_FLOW_RUNS_TOOL,
    AKM_FLOW_RUN_GET_TOOL,
    // 子 Agent 递归委托工具：后端默认注入（agent_subagent_enabled 开启），这里始终声明，避免白名单时丢失
    AKM_SUBAGENT_SPAWN_TOOL,
    AKM_SUBAGENT_WAIT_TOOL,
    AKM_SUBAGENT_KILL_TOOL,
    // 原生通知工具：后端默认注入（agent_notify_enabled 开启），这里始终声明，避免白名单时丢失
    AKM_SEND_NOTIFICATION_TOOL,
    // 邮件工具：后端条件注册（agent_email_enabled 开启），这里始终声明，可用性由后端配置开关控制
    AKM_SEND_EMAIL_TOOL,
    // 原生系统工具：后端默认注入（agent_native_tools_enabled 开启），这里始终声明，避免白名单时丢失
    AKM_CLIPBOARD_GET_TOOL,
    AKM_CLIPBOARD_SET_TOOL,
    AKM_SYSTEM_INFO_TOOL,
    AKM_OPEN_TOOL,
    AKM_FRONTMOST_APP_TOOL,
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
    AKM_XLSX_TOOL,
  );
  // shell 与 git：始终声明，可用性由后端配置开关控制
  declared.push(AKM_RUN_SHELL_TOOL, AKM_RUN_GIT_TOOL);
  if (tools.includes("search")) declared.push(TAVILY_SEARCH_TOOL);
  if (tools.includes("image")) {
    declared.push(AKM_GENERATE_IMAGE_TOOL, AKM_EDIT_IMAGE_TOOL);
  }
  return declared;
}

export type AgentStreamEventName = "reasoning_delta" | "model_delta" | "turn_start" | "tool_call" | "tool_result" | "context_warning" | "ask_user" | "final" | "error";

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
    // 交互澄清：ask_user 事件携带 AI 想问的问题（question）、候选答案（options，
    // 不传为自由文本）、是否可多选（multiple，仅 options 有值时有效）以及可续跑
    // 的完整上下文（messages，working_messages）。客户端在用户回答后把回答追加进
    // messages 重新请求。
    question?: string;
    options?: string[];
    multiple?: boolean;
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
// 打包为 AKM 插件时传 VITE_AKM_API_URL=""（空字符串，同源部署），请求即走
// 相对路径 /v1/agent。这里用空值合并（??）而非 ||，使空字符串可覆盖默认值。
export const API_BASE_URL = (import.meta.env.VITE_AKM_API_URL ?? "/akm-api").replace(/\/+$/, "");

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
    max_turns: 50,
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
  form.append("max_turns", "50");
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
  return value === "reasoning_delta" || value === "model_delta" || value === "turn_start" || value === "tool_call" || value === "tool_result" || value === "context_warning" || value === "ask_user" || value === "final" || value === "error";
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
  // 传入中断信号后，点击"停止"会 abort 该请求：前端停止读取，
  // 后端检测到连接断开后停止生成，避免中断后继续烧 token。
  signal?: AbortSignal;
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
    signal: options.signal,
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

// ---- 定时任务（/v1/tasks）----

// 任务类型：agent_call 定时调用 Agent 完成一轮对话，usage_query 定时执行用量查询
export type TaskType = "agent_call" | "usage_query";

// 任务 payload：按类型携带不同字段；调度器执行后会把结果摘要写回
// last_result / last_result_time（usage_query 的结果写入 usage_data，不在 payload）
export type TaskPayload = {
  model?: string;
  messages?: AgentMessage[];
  tools?: AgentTool[];
  instructions?: string;
  max_turns?: number;
  api_path?: string;
  workspace_root?: string;
  alias?: string;
  last_result?: { ok: boolean; final_message?: string } | null;
  last_result_time?: string | null;
  [key: string]: unknown;
};

// 一条定时任务记录（对应后端 scheduled_tasks 表）
export type ScheduledTask = {
  id: string;
  name: string;
  task_type: TaskType;
  interval_sec: number;
  cron?: string | null;
  payload: TaskPayload;
  enabled: boolean;
  last_run_at?: string | null;
  next_run_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

// 创建 / 更新任务的入参（字段与后端 /v1/tasks 路由保持一致）
export type TaskInput = {
  name: string;
  task_type: TaskType;
  interval_sec: number;
  cron?: string;
  enabled?: boolean;
  payload?: Record<string, unknown>;
};

// 拉取全部定时任务，按创建时间倒序返回
export async function listTasks(): Promise<ScheduledTask[]> {
  const payload = await requestJson<{ tasks?: ScheduledTask[] }>("/v1/tasks");
  if (!Array.isArray(payload?.tasks)) throw new Error("任务列表格式无效");
  return payload.tasks;
}

// 创建一条定时任务，成功后返回完整记录
export async function createTask(input: TaskInput): Promise<ScheduledTask> {
  const payload = await requestJson<{ task?: ScheduledTask }>("/v1/tasks", {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (!payload?.task) throw new Error("创建任务失败：响应缺少 task");
  return payload.task;
}

// 更新任务的指定字段，返回更新后的记录
export async function updateTask(taskId: string, input: Partial<TaskInput>): Promise<ScheduledTask> {
  const payload = await requestJson<{ task?: ScheduledTask }>(`/v1/tasks/${encodeURIComponent(taskId)}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
  if (!payload?.task) throw new Error("更新任务失败：响应缺少 task");
  return payload.task;
}

// 删除一条定时任务
export async function deleteTask(taskId: string): Promise<void> {
  await requestJson<{ ok?: boolean }>(`/v1/tasks/${encodeURIComponent(taskId)}`, { method: "DELETE" });
}

// 立即执行一次任务（绕过调度器，不改变 last_run_at / next_run_at）
export async function runTask(taskId: string): Promise<void> {
  await requestJson<{ ok?: boolean }>(`/v1/tasks/${encodeURIComponent(taskId)}/run`, { method: "POST" });
}

// ── 工作流（/v1/flow）类型与 API，数据结构与 ccs flow 模块一致 ──
export type FlowNodeType = "intake" | "plan" | "code" | "review" | "test" | "fix" | "human" | "router" | "merge" | "output";

export type NodeExecutor = "llm" | "pi-agent" | "human" | "none";

export type WorkflowNodeData = {
  label: string;
  modelId: string;
  systemPrompt: string;
  userPromptTemplate: string;
  executor?: NodeExecutor;
  temperature?: number;
  maxTokens?: number;
  artifactKey?: string;
};

export type WorkflowNode = {
  id: string;
  type: FlowNodeType;
  position: { x: number; y: number };
  data: WorkflowNodeData;
};

export type WorkflowEdge = {
  id: string;
  source: string;
  target: string;
  condition?: string;
  label?: string;
  loop?: boolean;
};

export type Workflow = {
  id: string;
  name: string;
  description?: string;
  version: number;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  variables: Record<string, string>;
  createdAt: string;
  updatedAt: string;
};

export type WorkflowInput = {
  name: string;
  description?: string;
  nodes?: WorkflowNode[];
  edges?: WorkflowEdge[];
  variables?: Record<string, string>;
};

// 拉取全部工作流
export async function listWorkflows(): Promise<Workflow[]> {
  const payload = await requestJson<{ workflows?: Workflow[] }>("/v1/flow/workflows");
  if (!Array.isArray(payload?.workflows)) throw new Error("工作流列表格式无效");
  return payload.workflows;
}

// 创建工作流，成功后返回完整记录
export async function createWorkflow(input: WorkflowInput): Promise<Workflow> {
  const payload = await requestJson<{ workflow?: Workflow }>("/v1/flow/workflows", {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (!payload?.workflow) throw new Error("创建工作流失败：响应缺少 workflow");
  return payload.workflow;
}

// 更新工作流指定字段，返回更新后的记录
export async function updateWorkflow(workflowId: string, input: Partial<WorkflowInput>): Promise<Workflow> {
  const payload = await requestJson<{ workflow?: Workflow }>(`/v1/flow/workflows/${encodeURIComponent(workflowId)}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
  if (!payload?.workflow) throw new Error("更新工作流失败：响应缺少 workflow");
  return payload.workflow;
}

// 删除工作流
export async function deleteWorkflow(workflowId: string): Promise<void> {
  await requestJson<{ ok?: boolean }>(`/v1/flow/workflows/${encodeURIComponent(workflowId)}`, { method: "DELETE" });
}

// 拉取内置工作流模板（后端返回不含 id 的模板定义，实例化时重新生成 id）
export async function listFlowTemplates(): Promise<Workflow[]> {
  const payload = await requestJson<{ templates?: Workflow[] }>("/v1/flow/templates");
  if (!Array.isArray(payload?.templates)) throw new Error("工作流模板列表格式无效");
  return payload.templates;
}

// 实例化模板：按模板名（或 id）匹配，保存为真实工作流并返回完整记录
export async function instantiateFlowTemplate(templateId: string): Promise<Workflow> {
  const payload = await requestJson<{ workflow?: Workflow }>(`/v1/flow/templates/${encodeURIComponent(templateId)}/instantiate`, {
    method: "POST",
  });
  if (!payload?.workflow) throw new Error("实例化模板失败：响应缺少 workflow");
  return payload.workflow;
}
