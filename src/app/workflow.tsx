import { Fragment, memo, useEffect, useMemo, useState } from "react";
import { AlertCircle, ArrowRight, Check, ChevronLeft, Loader2, Pencil, Plus, Trash2, Workflow as WorkflowIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { Background, BackgroundVariant, Controls, Handle, Position, ReactFlow, addEdge, useEdgesState, useNodesState, type Connection, type Edge, type Node, type NodeProps, type NodeTypes } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { createWorkflow, deleteWorkflow, instantiateFlowTemplate, listFlowTemplates, listWorkflows, updateWorkflow, type FlowNodeType, type NodeExecutor, type Workflow, type WorkflowEdge, type WorkflowNode, type WorkflowNodeData } from "@/lib/agent-api";
import { clearModalResidue, formatDisplayTime } from "./helpers";
import { PageHeader } from "./sidebar";
import type { ChatModel } from "./types";

// ---- 工作流节点显示元信息（类型/颜色/执行器），flow 类型定义与 API 在 agent-api.ts ----
// 节点类型：与 flow 引擎的 10 种内置节点一致；节点显示元信息（中文名/颜色/描述）参考 flow 配置页。
const NODE_META: Record<FlowNodeType, { label: string; color: string; description: string }> = {
  intake: { label: "需求输入", color: "#22c55e", description: "接收需求或用户输入" },
  plan: { label: "方案规划", color: "#8b5cf6", description: "规划实现方案" },
  code: { label: "编码实现", color: "#3b82f6", description: "编写代码" },
  review: { label: "代码审查", color: "#f59e0b", description: "审查变更" },
  test: { label: "测试验证", color: "#06b6d4", description: "运行测试" },
  fix: { label: "修复迭代", color: "#ef4444", description: "修复失败项" },
  human: { label: "人工审批", color: "#ec4899", description: "人工审批门" },
  router: { label: "条件路由", color: "#14b8a6", description: "按条件分支" },
  merge: { label: "汇合", color: "#64748b", description: "合并多条路径" },
  output: { label: "交付输出", color: "#10b981", description: "汇总输出结果" },
};

// 节点执行器：决定该节点由谁执行，参考 flow 配置页的执行器下拉。
const EXECUTOR_META: Record<NodeExecutor, { label: string; description: string }> = {
  llm: { label: "LLM", description: "对话模型调用" },
  "pi-agent": { label: "Pi Agent", description: "本机 pi CLI 编码代理" },
  "opencode-cli": { label: "Opencode CLI", description: "本机 Opencode CLI 编码" },
  human: { label: "人工", description: "人工审批门" },
  none: { label: "无", description: "透传 / 合并，不调模型" },
};

// 按节点数组顺序自动生成相邻连线（展示用；后端可自行解析）。
function buildFlowEdges(nodes: WorkflowNode[]): WorkflowEdge[] {
  return nodes.slice(0, -1).map((node, index) => ({
    id: `edge-${node.id}-${nodes[index + 1].id}`,
    source: node.id,
    target: nodes[index + 1].id,
  }));
}

// 构造一个流程节点（新建工作流时的起始节点链、表单内添加节点共用）。
function demoNode(id: string, type: FlowNodeType, label: string, data: Partial<WorkflowNodeData> = {}): WorkflowNode {
  return { id, type, position: { x: 0, y: 0 }, data: { label, modelId: "", systemPrompt: "", userPromptTemplate: "", ...data } };
}

// ---- 工作流可视化编辑器（@xyflow/react）辅助类型与组件 ----
// 画布节点：在 WorkflowNodeData 基础上合并 nodeType，供自定义节点渲染出类型色点/徽章。
type CanvasNode = Node<WorkflowNodeData & { nodeType: FlowNodeType }>;
// 画布边：condition/loop 等业务字段放在 data 里（React Flow 的边也支持 data）。
type CanvasEdge = Edge<{ condition?: string; loop?: boolean }>;

// WorkflowNode[] → 画布节点[]：把 type 合并进 data.nodeType。
// position 缺失（旧数据或后端未返回）时兜底为原点，避免 ReactFlow 读取 position.x 白屏。
function toCanvasNodes(nodes: WorkflowNode[]): CanvasNode[] {
  return nodes.map(node => ({
    id: node.id,
    position: node.position ?? { x: 0, y: 0 },
    type: "flowNode",
    data: { ...node.data, nodeType: node.type },
  }));
}

// 画布节点[] → WorkflowNode[]：从 data 解构回 type，其余字段作为节点数据。
function toWorkflowNodes(canvasNodes: CanvasNode[]): WorkflowNode[] {
  return canvasNodes.map(node => {
    const { nodeType, ...data } = node.data;
    return { id: node.id, type: nodeType, position: node.position, data };
  });
}

// 画布边[] → WorkflowEdge[]：取出 data 里的 condition/loop 业务字段，label 若为空不写入。
function toWorkflowEdges(edges: CanvasEdge[]): WorkflowEdge[] {
  return edges.map(edge => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    ...(typeof edge.label === "string" && edge.label ? { label: edge.label } : {}),
    ...(edge.data?.condition ? { condition: edge.data.condition } : {}),
    ...(edge.data?.loop ? { loop: true } : {}),
  }));
}

// 自定义画布节点：色点 + 名称 + 类型徽章 + 执行器徽章 + 模型名截断 + 左右连接点。
// 参考 flow 项目的 FlowNode 组件，配色适配本项目的浅色主题。
const WorkflowCanvasNode = memo(({ data, selected }: NodeProps<CanvasNode>) => {
  const meta = NODE_META[data.nodeType];
  const executorShort: Partial<Record<NodeExecutor, string>> = { "pi-agent": "Pi", "opencode-cli": "Opencode", human: "人工", none: "透传" };
  const executorText = data.executor ? (executorShort[data.executor] ?? "LLM") : "LLM";
  return (
    <div className={cn(
      "min-w-[180px] max-w-[240px] rounded-xl border bg-card px-3 py-2 shadow-sm transition-shadow",
      selected ? "border-primary ring-2 ring-primary/30" : "border-border",
    )}>
      <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border-0 !bg-muted-foreground" />
      <div className="flex items-center gap-1.5">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: meta.color }} />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">{data.label || meta.label}</span>
      </div>
      <div className="mt-1.5 flex items-center gap-1">
        <span className="rounded bg-muted px-1 py-px text-[10px] font-medium text-muted-foreground">{meta.label}</span>
        <span className="rounded bg-muted px-1 py-px text-[10px] text-muted-foreground">{executorText}</span>
        {data.modelId ? <span className="min-w-0 flex-1 truncate text-right text-[10px] text-muted-foreground/70">{data.modelId}</span> : null}
      </div>
      <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border-0 !bg-muted-foreground" />
    </div>
  );
});

// React Flow 自定义节点注册表：flowNode 用于渲染业务节点。
const workflowNodeTypes: NodeTypes = { flowNode: WorkflowCanvasNode };

// 工作流页面：展示工作流列表，支持新建/编辑（弹窗内配置节点参数，字段组织参考 flow 配置页）、删除。
// 当前使用本地假数据（DEFAULT_WORKFLOWS），后续 ccs /v1/flow 稳定后切换到真实 API。
// 工作流可视化编辑器（三栏）：左侧节点库、中间 ReactFlow 画布（拖拽/连线/缩放）、
// 右侧属性面板（节点/边/工作流级参数）。整体参考 flow 项目的 StudioPage。
function WorkflowEditor({ models, initial, onCancel, onSave }: {
  models: ChatModel[];
  initial: { mode: "new" } | { mode: "edit"; workflow: Workflow };
  onCancel: () => void;
  onSave: (name: string, description: string, nodes: WorkflowNode[], edges: WorkflowEdge[], variables: Record<string, string>) => Promise<void>;
}) {
  const [name, setName] = useState(initial.mode === "edit" ? initial.workflow.name : "");
  const [description, setDescription] = useState(initial.mode === "edit" ? (initial.workflow.description ?? "") : "");
  const [variables, setVariables] = useState<Record<string, string>>(initial.mode === "edit" ? { ...initial.workflow.variables } : {});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);

  // 初始画布：编辑模式用现有定义；新建模式预置"输入 → 规划 → 输出"并水平排布。
  const initialCanvasNodes = useMemo<CanvasNode[]>(() => {
    if (initial.mode === "edit") return toCanvasNodes(initial.workflow.nodes);
    const now = Date.now();
    const nodes: WorkflowNode[] = [
      demoNode(`wfnode-${now}-1`, "intake", NODE_META.intake.label, { userPromptTemplate: "{{input.prompt}}", executor: "none" }),
      demoNode(`wfnode-${now}-2`, "plan", NODE_META.plan.label, { executor: "llm", temperature: 0.3, maxTokens: 2000 }),
      demoNode(`wfnode-${now}-3`, "output", NODE_META.output.label, { executor: "none" }),
    ];
    return toCanvasNodes(nodes.map((node, index) => ({ ...node, position: { x: index * 260, y: 0 } })));
  }, [initial]);

  const initialCanvasEdges = useMemo<CanvasEdge[]>(() => {
    if (initial.mode === "edit") {
      return (initial.workflow.edges ?? []).map(edge => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        ...(edge.label ? { label: edge.label } : {}),
        ...(edge.condition || edge.loop ? { data: { condition: edge.condition, loop: edge.loop } } : {}),
      }));
    }
    // 新建模式：预置的 intake→plan→output 起始链自动连线（与旧弹窗行为一致）。
    const now = Date.now();
    const nodes: WorkflowNode[] = [
      demoNode(`wfnode-${now}-1`, "intake", NODE_META.intake.label, { userPromptTemplate: "{{input.prompt}}", executor: "none" }),
      demoNode(`wfnode-${now}-2`, "plan", NODE_META.plan.label, { executor: "llm", temperature: 0.3, maxTokens: 2000 }),
      demoNode(`wfnode-${now}-3`, "output", NODE_META.output.label, { executor: "none" }),
    ];
    return buildFlowEdges(nodes).map(edge => ({ id: edge.id, source: edge.source, target: edge.target }));
  }, [initial]);

  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<CanvasNode>(initialCanvasNodes);
  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState<CanvasEdge>(initialCanvasEdges);

  const selectedNode = rfNodes.find(node => node.id === selectedNodeId) ?? null;
  const selectedEdge = rfEdges.find(edge => edge.id === selectedEdgeId) ?? null;

  // 连线：新增边时补一个稳定 id，避免 React Flow 的占位 id 导致 key 不稳定。
  const onConnect = (connection: Connection) => {
    setRfEdges(edges => addEdge({ ...connection, id: `edge-${Date.now()}` }, edges));
  };

  // 更新选中节点的 data 字段。
  const patchNode = (patch: Partial<WorkflowNodeData>) => {
    if (!selectedNodeId) return;
    setRfNodes(nodes => nodes.map(node => node.id === selectedNodeId ? { ...node, data: { ...node.data, ...patch } } : node));
  };

  // 修改选中节点的类型（data.nodeType）。
  const changeNodeType = (type: FlowNodeType) => {
    if (!selectedNodeId) return;
    setRfNodes(nodes => nodes.map(node => node.id === selectedNodeId ? { ...node, data: { ...node.data, nodeType: type } } : node));
  };

  // 从节点库点击添加：放在画布内错落位置，避免与新节点完全重叠。
  const addNode = (type: FlowNodeType) => {
    const id = `wfnode-${Date.now()}-${rfNodes.length + 1}`;
    const canvas = toCanvasNodes([demoNode(id, type, NODE_META[type].label, { executor: type === "human" ? "human" : "llm" })])[0];
    setRfNodes(nodes => [...nodes, { ...canvas, position: { x: 80 + (nodes.length % 6) * 48, y: 60 + Math.floor(nodes.length / 6) * 48 } }]);
    setSelectedNodeId(id);
    setSelectedEdgeId(null);
  };

  const removeSelectedNode = () => {
    if (!selectedNodeId) return;
    setRfNodes(nodes => nodes.filter(node => node.id !== selectedNodeId));
    setRfEdges(edges => edges.filter(edge => edge.source !== selectedNodeId && edge.target !== selectedNodeId));
    setSelectedNodeId(null);
  };

  // 更新选中边的 label 与 data（condition/loop）。
  const patchEdge = (patch: { label?: string; condition?: string; loop?: boolean }) => {
    if (!selectedEdgeId) return;
    setRfEdges(edges => edges.map(edge => {
      if (edge.id !== selectedEdgeId) return edge;
      const next: CanvasEdge = { ...edge };
      if (patch.label !== undefined) next.label = patch.label;
      const data = { ...(edge.data ?? {}) };
      if (patch.condition !== undefined) data.condition = patch.condition || undefined;
      if (patch.loop !== undefined) data.loop = patch.loop;
      next.data = data;
      return next;
    }));
  };

  const removeSelectedEdge = () => {
    if (!selectedEdgeId) return;
    setRfEdges(edges => edges.filter(edge => edge.id !== selectedEdgeId));
    setSelectedEdgeId(null);
  };

  const submit = async () => {
    const trimmedName = name.trim();
    if (!trimmedName || rfNodes.length === 0 || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(trimmedName, description.trim(), toWorkflowNodes(rfNodes), toWorkflowEdges(rfEdges), variables);
      onCancel();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "保存工作流失败");
    } finally {
      setSaving(false);
    }
  };

  const selectClass = "w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:border-primary/60";
  const labelClass = "mb-1 block text-xs font-medium text-foreground/80";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 顶部工具条：返回 / 名称 / 错误提示 / 保存 */}
      <div className="flex shrink-0 items-center gap-3 border-b border-black/[0.06] bg-white px-4 py-2.5 dark:border-border dark:bg-card">
        <Button variant="ghost" size="sm" className="gap-1 text-xs" onClick={onCancel}><ChevronLeft size={14} />返回</Button>
        <input value={name} onChange={event => setName(event.target.value)} placeholder="工作流名称" className="w-56 rounded-lg border bg-background px-3 py-1.5 text-sm outline-none focus:border-primary/60" />
        {error ? <span className="min-w-0 flex-1 truncate text-xs text-destructive">{error}</span> : <span className="flex-1" />}
        <Button size="sm" className="gap-1" onClick={submit} disabled={!name.trim() || rfNodes.length === 0 || saving}>
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}保存
        </Button>
      </div>
      <div className="flex min-h-0 flex-1">
        {/* 左：节点库 */}
        <div className="w-44 shrink-0 overflow-y-auto border-r border-black/[0.06] bg-white p-2 dark:border-border dark:bg-card">
          <div className="px-1 pb-1 pt-0.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">节点库</div>
          <div className="space-y-1">
            {(Object.keys(NODE_META) as FlowNodeType[]).map(type => (
              <button key={type} type="button" onClick={() => addNode(type)} className="flex w-full items-center gap-2 rounded-lg border border-transparent px-2 py-1.5 text-left text-xs transition-colors hover:border-border hover:bg-muted/50" title={NODE_META[type].description}>
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: NODE_META[type].color }} />
                <span className="font-medium text-foreground">{NODE_META[type].label}</span>
                <span className="ml-auto text-[10px] text-muted-foreground">添加</span>
              </button>
            ))}
          </div>
        </div>
        {/* 中：画布 */}
        <div className="min-w-0 flex-1 bg-background">
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, node) => { setSelectedNodeId(node.id); setSelectedEdgeId(null); }}
            onEdgeClick={(_, edge) => { setSelectedEdgeId(edge.id); setSelectedNodeId(null); }}
            onPaneClick={() => { setSelectedNodeId(null); setSelectedEdgeId(null); }}
            nodeTypes={workflowNodeTypes}
            defaultEdgeOptions={{ style: { stroke: "#52525b", strokeWidth: 1.5 } }}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#d4d4d8" />
            <Controls />
          </ReactFlow>
        </div>
        {/* 右：属性面板 */}
        <div className="w-72 shrink-0 overflow-y-auto border-l border-black/[0.06] bg-white p-3 dark:border-border dark:bg-card">
          {selectedNode ? (
            <div className="space-y-3">
              <div className="text-xs font-semibold text-foreground/80">节点配置</div>
              <div>
                <label className={labelClass}>节点名称</label>
                <input value={selectedNode.data.label} onChange={event => patchNode({ label: event.target.value })} placeholder="节点在流程中的显示名称" className={selectClass} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelClass}>类型</label>
                  <select value={selectedNode.data.nodeType} onChange={event => changeNodeType(event.target.value as FlowNodeType)} className={selectClass}>
                    {(Object.keys(NODE_META) as FlowNodeType[]).map(type => <option key={type} value={type}>{NODE_META[type].label}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelClass}>执行器</label>
                  <select value={selectedNode.data.executor ?? "llm"} onChange={event => patchNode({ executor: event.target.value as NodeExecutor })} className={selectClass}>
                    {(Object.keys(EXECUTOR_META) as NodeExecutor[]).map(key => <option key={key} value={key}>{EXECUTOR_META[key].label}</option>)}
                  </select>
                </div>
              </div>
              {selectedNode.data.executor !== "none" ? (
                <>
                  <div>
                    <label className={labelClass}>模型</label>
                    <select value={selectedNode.data.modelId} onChange={event => patchNode({ modelId: event.target.value })} className={selectClass}>
                      <option value="">默认模型</option>
                      {models.map(model => <option key={model.key} value={model.key}>{model.label}</option>)}
                    </select>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className={labelClass}>温度</label>
                      <input type="number" step="0.1" min={0} max={2} value={selectedNode.data.temperature ?? ""} onChange={event => patchNode({ temperature: event.target.value ? Number(event.target.value) : undefined })} placeholder="0~2" className={selectClass} />
                    </div>
                    <div>
                      <label className={labelClass}>最大输出</label>
                      <input type="number" min={0} value={selectedNode.data.maxTokens ?? ""} onChange={event => patchNode({ maxTokens: event.target.value ? Number(event.target.value) : undefined })} placeholder="留空不限制" className={selectClass} />
                    </div>
                  </div>
                  <div>
                    <label className={labelClass}>系统提示 systemPrompt</label>
                    <textarea rows={3} value={selectedNode.data.systemPrompt} onChange={event => patchNode({ systemPrompt: event.target.value })} placeholder="角色设定与行为约束" className={cn(selectClass, "resize-y leading-relaxed")} />
                  </div>
                  <div>
                    <label className={labelClass}>用户提示模板 userPromptTemplate</label>
                    <textarea rows={2} value={selectedNode.data.userPromptTemplate} onChange={event => patchNode({ userPromptTemplate: event.target.value })} placeholder="支持 {{input.prompt}} / {{vars.*}} / {{artifacts.别名}}" className={cn(selectClass, "resize-y leading-relaxed")} />
                  </div>
                  <div>
                    <label className={labelClass}>产物别名 artifactKey</label>
                    <input value={selectedNode.data.artifactKey ?? ""} onChange={event => patchNode({ artifactKey: event.target.value })} placeholder="供下游模板引用，如 report" className={selectClass} />
                  </div>
                </>
              ) : (
                <p className="py-2 text-xs leading-relaxed text-muted-foreground">执行器为「无」时透传或合并，不调用模型。</p>
              )}
              <Button variant="outline" size="sm" className="w-full gap-1 text-xs text-destructive hover:text-destructive" onClick={removeSelectedNode}><Trash2 size={12} />删除节点</Button>
            </div>
          ) : selectedEdge ? (
            <div className="space-y-3">
              <div className="text-xs font-semibold text-foreground/80">连线配置</div>
              <div>
                <label className={labelClass}>标签 label</label>
                <input value={typeof selectedEdge.label === "string" ? selectedEdge.label : ""} onChange={event => patchEdge({ label: event.target.value })} placeholder="可选，如「通过」" className={selectClass} />
              </div>
              <div>
                <label className={labelClass}>条件 condition</label>
                <input value={selectedEdge.data?.condition ?? ""} onChange={event => patchEdge({ condition: event.target.value })} placeholder="如 pass / fail" className={selectClass} />
              </div>
              <label className="flex cursor-pointer items-center gap-2 text-xs text-foreground/80">
                <input type="checkbox" checked={Boolean(selectedEdge.data?.loop)} onChange={event => patchEdge({ loop: event.target.checked })} className="h-3.5 w-3.5 accent-primary" />
                回边 loop（有界迭代，不计入环检测）
              </label>
              <Button variant="outline" size="sm" className="w-full gap-1 text-xs text-destructive hover:text-destructive" onClick={removeSelectedEdge}><Trash2 size={12} />删除连线</Button>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="text-xs font-semibold text-foreground/80">工作流配置</div>
              <div>
                <label className={labelClass}>描述</label>
                <textarea rows={3} value={description} onChange={event => setDescription(event.target.value)} placeholder="这个工作流做什么？" className={cn(selectClass, "resize-y leading-relaxed")} />
              </div>
              <div>
                <label className={labelClass}>节点访问上限 maxNodeVisits</label>
                <input value={variables.maxNodeVisits ?? ""} onChange={event => setVariables(prev => ({ ...prev, maxNodeVisits: event.target.value }))} placeholder="留空不限制" className={selectClass} />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function WorkflowPage({ sidebarOpen, onToggle, models }: {
  sidebarOpen: boolean;
  onToggle: () => void;
  models: ChatModel[];
}) {
  // 列表数据：直接从 /v1/flow 拉取（ccs 后端 flow 已稳定）。
  const [workflows, setWorkflows] = useState<Workflow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // 可视化编辑器：null 表示停留在列表页；{mode:"new"} 新建，{mode:"edit",workflow} 编辑。
  const [editor, setEditor] = useState<{ mode: "new" } | { mode: "edit"; workflow: Workflow } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Workflow | null>(null);
  // 内置模板：后端只读模板列表，点击「使用」实例化为工作流（参考 flow 项目 Sidebar 模板区）。
  const [templates, setTemplates] = useState<Workflow[] | null>(null);
  const [templateBusy, setTemplateBusy] = useState<string | null>(null);

  // 拉取工作流列表；失败时顶部显示错误提示，不打断其它操作。
  const loadWorkflows = async () => {
    setLoading(true);
    try {
      setWorkflows(await listWorkflows());
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "加载工作流失败");
    } finally {
      setLoading(false);
    }
  };

  // 首次进入页面时加载工作流列表与内置模板。
  useEffect(() => {
    void loadWorkflows();
    listFlowTemplates().then(setTemplates).catch(() => setTemplates([]));
  }, []);

  // 实例化模板：成功后刷新列表，让新工作流出现在下方。
  const useTemplate = async (templateId: string) => {
    if (templateBusy !== null) return;
    setTemplateBusy(templateId);
    try {
      await instantiateFlowTemplate(templateId);
      setError(null);
      await loadWorkflows();
    } catch (templateError) {
      setError(templateError instanceof Error ? templateError.message : "实例化模板失败");
    } finally {
      setTemplateBusy(null);
    }
  };

  // 关闭删除弹窗：延迟清除 body 残留的滚动/交互锁定（与其他弹窗一致）。
  const closeDelete = () => {
    setDeleteTarget(null);
    window.setTimeout(clearModalResidue, 250);
  };

  // 新建 / 编辑：进入可视化编辑器（新建不带定义，编辑带入现有工作流）。
  const openCreate = () => setEditor({ mode: "new" });
  const openEdit = (workflow: Workflow) => setEditor({ mode: "edit", workflow });

  // 可视化编辑器保存回调：新建走 createWorkflow，编辑走 updateWorkflow，成功后刷新列表。
  // 保存失败会抛出，由编辑器内展示错误并停留在编辑页。
  const saveEditor = async (nameValue: string, descriptionValue: string, nodesValue: WorkflowNode[], edgesValue: WorkflowEdge[], variablesValue: Record<string, string>) => {
    if (editor?.mode === "edit") {
      await updateWorkflow(editor.workflow.id, { name: nameValue, description: descriptionValue, nodes: nodesValue, edges: edgesValue, variables: variablesValue });
    } else {
      await createWorkflow({ name: nameValue, description: descriptionValue, nodes: nodesValue, edges: edgesValue, variables: variablesValue });
    }
    setError(null);
    await loadWorkflows();
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    closeDelete();
    try {
      await deleteWorkflow(deleteTarget.id);
      setError(null);
      void loadWorkflows();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "删除工作流失败");
    }
  };

  return (
    <>
      {editor ? (
        <WorkflowEditor initial={editor} models={models} onCancel={() => setEditor(null)} onSave={saveEditor} />
      ) : (
        <>
      <PageHeader title="工作流" subtitle="把多个步骤连接成可重复使用的流程" sidebarOpen={sidebarOpen} onToggle={onToggle} />
      <ScrollArea className="min-h-0 flex-1 bg-white dark:bg-card">
        <div className="mx-auto max-w-4xl space-y-6 px-4 py-6 sm:px-8">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold">我的工作流</h2>
              <p className="mt-1 text-sm text-muted-foreground">把多个 AI 步骤连接成可重复使用的流程。</p>
            </div>
            <Button className="gap-2" onClick={openCreate}><Plus size={15} />新建工作流</Button>
          </div>
          {error ? (
            <div className="flex items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"><AlertCircle size={16} className="shrink-0" />{error}</div>
          ) : null}
          {templates && templates.length > 0 ? (
            <div>
              <div className="mb-2 text-sm font-semibold text-foreground/80">模板</div>
              <div className="space-y-2">
                {templates.map(template => (
                  <div key={template.name} className="flex items-center gap-3 rounded-xl border border-dashed border-border bg-card/40 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-foreground">{template.name}</div>
                      {template.description ? <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{template.description}</p> : null}
                    </div>
                    <span className="shrink-0 text-xs text-muted-foreground">{template.nodes.length} 个节点</span>
                    <Button size="sm" variant="outline" className="h-8 shrink-0 gap-1 px-2.5 text-xs" onClick={() => void useTemplate(template.name)} disabled={templateBusy !== null}>
                      {templateBusy === template.name ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}使用
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {loading && workflows === null ? (
            <div className="flex items-center justify-center rounded-xl border border-dashed border-border bg-card/50 py-16 text-muted-foreground"><Loader2 size={18} className="mr-2 animate-spin" />加载中…</div>
          ) : (workflows ?? []).length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card/50 px-6 py-16 text-center">
              <WorkflowIcon size={28} className="mb-3 text-foreground/25" />
              <p className="text-sm font-medium text-foreground/70">还没有工作流</p>
              <p className="mt-1 text-xs text-muted-foreground">点击「新建工作流」创建你的第一个自动化流程。</p>
            </div>
          ) : (
            <div className="space-y-3">
              {(workflows ?? []).map(workflow => (
                <div key={workflow.id} className="group relative rounded-xl border bg-card p-4 shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md">
                  <div className="absolute right-2.5 top-2.5 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                    <button type="button" onClick={() => openEdit(workflow)} className="rounded p-1 text-foreground/25 hover:bg-black/[0.06] hover:text-foreground focus:outline-none dark:hover:bg-white/10" title="编辑工作流"><Pencil size={14} /></button>
                    <button type="button" onClick={() => setDeleteTarget(workflow)} className="rounded p-1 text-foreground/25 hover:bg-black/[0.06] hover:text-red-500 focus:outline-none dark:hover:bg-white/10" title="删除工作流"><Trash2 size={14} /></button>
                  </div>
                  <div className="pr-16">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold text-foreground">{workflow.name}</h3>
                      <Badge variant="secondary" className="h-4 px-1.5 py-0 text-xs">v{workflow.version}</Badge>
                    </div>
                    {workflow.description ? <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{workflow.description}</p> : null}
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-1.5">
                    {workflow.nodes.map((node, index) => (
                      <Fragment key={node.id}>
                        {index > 0 && <ArrowRight size={12} className="shrink-0 text-muted-foreground/50" />}
                        <span className="inline-flex items-center gap-1 rounded-md border bg-background px-1.5 py-0.5 text-xs text-foreground/80">
                          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: NODE_META[node.type].color }} />
                          {node.data.label || NODE_META[node.type].label}
                        </span>
                      </Fragment>
                    ))}
                  </div>
                  <div className="mt-3 border-t border-border/60 pt-2 text-xs text-muted-foreground">{workflow.nodes.length} 个节点 · 更新于 {formatDisplayTime(workflow.updatedAt)}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </ScrollArea>

      {/* 删除工作流确认弹窗 */}
      <Dialog open={deleteTarget !== null} onOpenChange={value => { if (!value) closeDelete(); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>删除工作流</DialogTitle>
            <DialogDescription>确定要删除「{deleteTarget?.name}」吗？此操作不可撤销。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={closeDelete}>取消</Button>
            <Button variant="destructive" onClick={confirmDelete}>删除</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
        </>
      )}
    </>
  );
}

export { NODE_META, EXECUTOR_META, buildFlowEdges, demoNode, toCanvasNodes, toWorkflowNodes, toWorkflowEdges, WorkflowEditor, WorkflowPage };
