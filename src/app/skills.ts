// Skill = 本轮约束，不是整段会话人格。
//
// 用户在输入框用 `$` 触发上拉后选中某个 Skill，会将对应的 trigger 文本替换成
// chip（见 chat.tsx），发送时前端把 chip 对应的模板展开进请求（P1 落地，本期只做
// 交互层：常量定义 + 上拉展示），模型看到的正文是展开后的 template（{{input}} 替换
// 为用户原文）。
//
// 工作流是 Skill 的一种执行后端（kind === "workflow"），第一期只留数据位不实现。
// 助手（整段会话人格）不进 `$`；会话引用也不是 Skill（没有 template / tools）。
type Skill = {
  id: string;                 // 唯一标识，如 "image-gen"
  name: string;               // 展示名，如「生图」
  trigger: string;            // 输入 token，如 "生图"
  description: string;        // 上拉列表的副文案
  template: string;           // 发给模型的正文模板，含 {{input}} 占位
  tools?: string[];           // 本轮强制打开的 UI 工具（如 ["image"]），P1 展开时并入 tools
  extraInstructions?: string; // 仅本轮追加到 instructions 的说明，P1 使用
  kind: "prompt" | "workflow";
  workflowId?: string;        // kind === "workflow" 时使用（本期不使用）
};

// 内置 Skill 常量列表。P0 阶段只供上拉展示与 chip 回填；
// 模板展开 / 强制工具等约束力逻辑放在 P1（发送展开）实现。
const BUILTIN_SKILLS: Skill[] = [
  {
    id: "image-gen",
    name: "生图",
    trigger: "生图",
    description: "按描述生成一张图片",
    // 模板内锁定生图约束：电影感、高细节、无文字水印、构图完整；
    // 并要求模型把返回的图片 URL 用 Markdown 图片语法写进回复正文。
    template: [
      "请调用 akm_generate_image 生成图片。",
      "约束：电影感、高细节、无文字水印、构图完整。",
      "用户描述：{{input}}",
      "生成完成后把返回的图片 URL 用 Markdown 图片语法 ![图片](url) 写进回复正文。",
    ].join("\n"),
    tools: ["image"],
    kind: "prompt",
  },
  {
    id: "translate",
    name: "翻译",
    trigger: "翻译",
    description: "把内容翻译为简洁通顺的中文",
    // 非工具类模板示例：不依赖任何 UI 工具开关，纯文本约束。
    template: [
      "请把下面的内容翻译成简洁通顺的中文，保留原意与语气，不要额外解释。",
      "需要翻译的内容：{{input}}",
    ].join("\n"),
    kind: "prompt",
  },
];

// 依据用户输入的 trigger / 名称 / 描述对 Skill 列表做前缀或子串过滤，
// 供上拉列表展示。
function filterSkills(query: string): Skill[] {
  const key = query.trim().toLowerCase();
  if (!key) return BUILTIN_SKILLS;
  return BUILTIN_SKILLS.filter(skill =>
    skill.name.toLowerCase().includes(key) ||
    skill.trigger.toLowerCase().includes(key) ||
    skill.description.toLowerCase().includes(key),
  );
}

export { BUILTIN_SKILLS, filterSkills };
export type { Skill };