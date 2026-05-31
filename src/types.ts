export type TaskStatus = 'RUNNING' | 'BLOCKED' | 'READY' | 'DONE' | 'FAILED' | 'STOPPED' | 'NOT_STARTED';

export type AppView = 'tasks' | 'workflow';

export type Layout = 'single' | '2col' | '2row' | '2x2';

export type LayoutMeta = {
  id: Layout;
  label: string;
};

export type AgentCli = 'claude' | 'codex';
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

export type AgentConfig = {
  id: string;
  cli: AgentCli;
  model: string;
  reasoningEffort: ReasoningEffort;
};

// ── Canonical workflow model ─────────────────────────────────

export type WorkflowNodeKind = 'action' | 'gate' | 'wait' | 'join';
export type ActionExecutorType = 'agent' | 'function' | 'command';

export type WorkflowDefinition = {
  id: string;
  inputSchema?: string;
  agents?: Record<string, { config: string }>;
  start: string;
  nodes: Record<string, WorkflowNodeDefinition>;
};

export type WorkflowNodeDefinition =
  | ActionNodeDefinition
  | GateNodeDefinition
  | WaitNodeDefinition
  | JoinNodeDefinition;

export type ActionNodeDefinition = {
  kind: 'action';
  executor: ActionExecutorDefinition;
  outputSchema?: string;
  next?: string | string[];
};

export type ActionExecutorDefinition =
  | AgentActionExecutor
  | FunctionActionExecutor
  | CommandActionExecutor;

export type AgentActionExecutor = {
  type: 'agent';
  agent: string;
  prompt: string;
  reportSchema?: string;
};

export type FunctionActionExecutor = {
  type: 'function';
  uses: string;
  input?: Record<string, unknown>;
};

export type CommandActionExecutor = {
  type: 'command';
  command: string;
  cwd?: string;
  output?: Record<string, unknown>;
};

export type GateNodeDefinition = {
  kind: 'gate';
  condition: string;
  routes: {
    true?: string;
    false?: string;
  };
};

export type WaitNodeDefinition = {
  kind: 'wait';
  event: {
    type: string;
    match?: Record<string, unknown>;
  };
  next?: string | string[];
};

export type JoinNodeDefinition = {
  kind: 'join';
  from?: string[];
  waitFor?: 'all';
  next?: string | string[];
};

export type WorkflowDag = {
  workflowId: string;
  inputSchema?: string;
  startNodeId: string;
  agents: Record<string, { configId: string }>;
  nodes: Record<string, DagNode>;
  edges: DagEdge[];
};

export type DagNode = {
  id: string;
  kind: WorkflowNodeKind;
  definition: WorkflowNodeDefinition;
  nextNodeIds: string[];
  joinFromNodeIds?: string[];
};

export type DagEdge = {
  from: string;
  to: string;
  route?: 'true' | 'false';
};

export type NodeRunStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'skipped' | 'failed';

export type NodeRun = {
  runId: string;
  nodeId: string;
  visit: number;
  scopeId: string;
  status: NodeRunStatus;
  predecessorRunIds: string[];
  output?: unknown;
  waitingFor?: unknown;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
};

export type WorkItemType = 'run_action' | 'evaluate_gate' | 'register_wait' | 'evaluate_join';

export type WorkItem = {
  id: string;
  type: WorkItemType;
  nodeRunId: string;
  nodeId: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  createdAt: string;
};

export type WorkflowRunMachineState = {
  version: 1;
  workflowId: string;
  status: 'initialized' | 'running' | 'waiting' | 'done' | 'failed' | 'stopped';
  dag: WorkflowDag;
  nodeRuns: Record<string, NodeRun>;
  nodeRunOrder: string[];
  workQueue: WorkItem[];
  outputs: Record<string, unknown[]>;
  agents: Record<string, {
    configId: string;
    status: 'not_started' | 'running' | 'stopped';
    sessionId?: string;
  }>;
  createdAt: string;
  updatedAt: string;
};

export type AgentSessionStatus = 'starting' | 'running' | 'idle' | 'exited' | 'failed';

export type AgentSessionSnapshot = {
  id: string;
  cli: AgentCli;
  model: string;
  reasoningEffort?: ReasoningEffort;
  taskId?: string;
  agentInstanceId?: string;
  title: string;
  cwd: string;
  command: string[];
  status: AgentSessionStatus;
  pid: number | null;
  exitCode: number | null;
  createdAt: string;
  lastOutputAt: string | null;
  transcript: string[];
};

// ── Library types ────────────────────────────────────────────

export type StorageType = 'memory' | 'file';
export type FieldType = 'string' | 'number' | 'boolean' | 'array' | 'object';
export type FieldDefinition = {
  id: string;
  name: string;
  type: FieldType;
  required: boolean;
};

export type Schema = {
  id: string;
  name: string;
  storageType: StorageType;
  fields: FieldDefinition[];
};

// ── Task types ───────────────────────────────────────────────

export type AgentSessionState = {
  status: 'idle' | 'running' | 'done';
  needsHumanAttention?: boolean;
  humanAttentionAt?: string;
};

export type TaskRecord = {
  id: string;
  name: string;
  workDir: string;             // user's project dir, resolves {work-dir}
  taskTmpDir: string;          // auto-generated artifact dir for workflow handoffs
  status: TaskStatus;
  createdAt: string;           // ISO timestamp
  workflowSnapshot: WorkflowDefinition;  // deep copy at creation time
  memory: Record<string, unknown>;
  agentSessions: Record<string, AgentSessionState>;
};
