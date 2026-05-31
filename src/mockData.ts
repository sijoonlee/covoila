import type {
  AgentCli,
  AgentConfig,
  Layout,
  LayoutMeta,
  ReasoningEffort,
  TaskRecord,
} from './types';

export const mockTasks: TaskRecord[] = [];

export const LAYOUT_SLOTS: Record<Layout, number> = {
  single: 1,
  '2col': 2,
  '2row': 2,
  '2x2': 4,
};

export const mockAgentConfigs: AgentConfig[] = [
  { id: 'claude-sonnet', cli: 'claude', model: 'claude-sonnet-4-6', reasoningEffort: 'medium' },
  { id: 'claude-opus',   cli: 'claude', model: 'claude-opus-4-7',   reasoningEffort: 'high' },
  { id: 'codex-high',    cli: 'codex',  model: 'gpt-5.4',           reasoningEffort: 'high' },
  { id: 'codex-review',  cli: 'codex',  model: 'gpt-5.5',           reasoningEffort: 'high' },
];

export const MODEL_OPTIONS: Record<AgentCli, string[]> = {
  claude: ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
  codex:  ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex'],
};

export const REASONING_EFFORTS: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh'];

export const layoutOptions: LayoutMeta[] = [
  { id: 'single', label: '1 Terminal' },
  { id: '2col',   label: '2 x 1' },
  { id: '2row',   label: '1 x 2' },
  { id: '2x2',    label: '2 x 2' },
];
