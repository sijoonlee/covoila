import { useEffect, useMemo, useState } from 'react'
import type { AgentCli, ReasoningEffort } from '../../types'
import { api } from '../../api'
import { MODEL_OPTIONS, REASONING_EFFORTS } from '../../mockData'
import styles from './WorkflowEditor.module.css'

type WorkflowAgentDraft = {
  draftKey: string
  id: string
  name: string
  cli: AgentCli
  model: string
  reasoningEffort: ReasoningEffort
  role: string
}

type WorkflowPhaseDraft = {
  draftKey: string
  id: string
  name: string
  description: string
  agentId: string
  prompt: string
  inputs: string[]
  outputs: string[]
}

type RevisionRuleDraft = {
  draftKey: string
  id: string
  fromPhaseId: string
  revisePhaseId: string
  targetAgentId: string
  maxRevisions: number
  instruction: string
}

type WorkflowFileSummary = {
  filename: string
  id: string
  name: string
}

type ParsedWorkflowDefinition = {
  id: string
  name: string
  agents: Record<string, {
    cli: AgentCli
    model: string
    reasoningEffort?: ReasoningEffort
    role: string
  }>
  stateMachine: {
    initial: string
    states: Record<string, {
      prompt?: string
      wait?: {
        from: string
        on: Array<{
          verb: string
          target?: string
          prompt?: string
          requireArtifacts?: string[]
          max?: number
          next: string
        }>
      }
      final?: boolean
    }>
  }
  prompts: Record<string, string>
}

let draftKeyCounter = 0

function nextDraftKey(prefix: string): string {
  draftKeyCounter += 1
  return `${prefix}-${draftKeyCounter}`
}

const INITIAL_AGENTS: WorkflowAgentDraft[] = [
  {
    draftKey: nextDraftKey('agent'),
    id: 'planner',
    name: 'Planner',
    cli: 'codex',
    model: 'gpt-5.4',
    reasoningEffort: 'high',
    role: 'Creates and revises the implementation plan.',
  },
  {
    draftKey: nextDraftKey('agent'),
    id: 'reviewer',
    name: 'Reviewer',
    cli: 'codex',
    model: 'gpt-5.5',
    reasoningEffort: 'high',
    role: 'Reviews plans and code against the task and artifacts.',
  },
  {
    draftKey: nextDraftKey('agent'),
    id: 'coder',
    name: 'Coder',
    cli: 'codex',
    model: 'gpt-5.4',
    reasoningEffort: 'high',
    role: 'Changes the working project according to the approved plan.',
  },
]

const INITIAL_PHASES: WorkflowPhaseDraft[] = [
  {
    draftKey: nextDraftKey('phase'),
    id: 'planning',
    name: 'Planning',
    description: 'Create the implementation plan from task.md.',
    agentId: 'planner',
    prompt: 'Read task.md and write a concrete implementation plan.',
    inputs: ['task.md'],
    outputs: ['tmp/plan.md'],
  },
  {
    draftKey: nextDraftKey('phase'),
    id: 'plan-reviewing',
    name: 'Plan Reviewing',
    description: 'Review the plan before coding starts.',
    agentId: 'reviewer',
    prompt: 'Review tmp/plan.md against task.md. Approve it or explain what needs revision.',
    inputs: ['task.md', 'tmp/plan.md'],
    outputs: [],
  },
  {
    draftKey: nextDraftKey('phase'),
    id: 'coding',
    name: 'Coding',
    description: 'Implement the approved plan in the working directory.',
    agentId: 'coder',
    prompt: 'Read task.md and tmp/plan.md, then implement the requested changes.',
    inputs: ['task.md', 'tmp/plan.md'],
    outputs: [],
  },
  {
    draftKey: nextDraftKey('phase'),
    id: 'code-reviewing',
    name: 'Code Reviewing',
    description: 'Review the code changes against the task and plan.',
    agentId: 'reviewer',
    prompt: 'Review the working tree against task.md and tmp/plan.md.',
    inputs: ['task.md', 'tmp/plan.md'],
    outputs: [],
  },
]

function nextId(prefix: string, existing: Array<{ id: string }>): string {
  let index = existing.length + 1
  let id = `${prefix}-${index}`
  while (existing.some(item => item.id === id)) {
    index += 1
    id = `${prefix}-${index}`
  }
  return id
}

function normalizeLines(value: string): string[] {
  return value
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
}

function yamlScalar(value: string): string {
  if (/^[A-Za-z0-9._/-]+$/.test(value)) return value
  return JSON.stringify(value)
}

function filenameForWorkflowId(workflowId: string): string {
  const slug = workflowId
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${slug || 'workflow'}.yaml`
}

function blockScalar(value: string, indent: string): string {
  const lines = value.trimEnd().split('\n')
  if (lines.length === 0 || (lines.length === 1 && lines[0] === '')) return `${indent}\n`
  return lines.map(line => `${indent}${line}`).join('\n')
}

function artifactForRuntime(path: string): string {
  return path.replace(/^\.?\/*tmp\//, '')
}

function promptKey(phaseId: string): string {
  return `phase.${phaseId}`
}

function revisionStateId(rule: RevisionRuleDraft): string {
  return `revision-${rule.id}`
}

function revisionPromptKey(rule: RevisionRuleDraft): string {
  return `revision.${rule.id}`
}

function revisionCounterKey(rule: RevisionRuleDraft): string {
  return `revision_${rule.id}`
}

function generateWorkflowYaml(
  workflowId: string,
  workflowName: string,
  agents: WorkflowAgentDraft[],
  phases: WorkflowPhaseDraft[],
  revisionRules: RevisionRuleDraft[],
): string {
  const lines: string[] = [
    `id: ${yamlScalar(workflowId)}`,
    `name: ${yamlScalar(workflowName)}`,
    '',
    'agents:',
  ]

  for (const agent of agents) {
    lines.push(
      `  ${yamlScalar(agent.id)}:`,
      `    cli: ${agent.cli}`,
      `    model: ${yamlScalar(agent.model)}`,
      `    reasoningEffort: ${agent.reasoningEffort}`,
      `    role: ${yamlScalar(agent.role || agent.name || agent.id)}`,
    )
  }

  lines.push(
    '',
    'limits:',
    '  maxConversationTurns: 8',
    '  maxInvalidReports: 3',
    '',
    'sharedContext: |',
    '  Working directory: {workDir}',
    '  Shared artifact directory: {taskTmpDir}',
    '  Canonical task file: {taskTmpDir}/task.md',
    '',
    '  Use the shared artifact directory for durable handoff files.',
    '  Do not rely on another agent terminal transcript as the source of truth.',
    '',
    'stateMachine:',
    `  initial: ${yamlScalar(phases[0]?.id ?? 'done')}`,
    '  states:',
  )

  phases.forEach((phase, index) => {
    const nextPhase = phases[index + 1]
    const phaseRevisionRules = revisionRules.filter(rule => rule.fromPhaseId === phase.id)
    lines.push(
      `    ${yamlScalar(phase.id)}:`,
      `      prompt: ${yamlScalar(promptKey(phase.id))}`,
      '      wait:',
      `        from: ${yamlScalar(phase.agentId)}`,
      '        on:',
      '          - verb: done',
    )
    if (phase.outputs.length > 0) {
      lines.push('            requireArtifacts:')
      for (const output of phase.outputs) {
        lines.push(`              - ${yamlScalar(artifactForRuntime(output))}`)
      }
    }
    lines.push(
      `            next: ${yamlScalar(nextPhase?.id ?? 'done')}`,
    )
    for (const rule of phaseRevisionRules) {
      lines.push(
        '          - verb: talk',
        `            target: ${yamlScalar(rule.targetAgentId)}`,
        `            prompt: ${yamlScalar(revisionPromptKey(rule))}`,
        `            increment: ${yamlScalar(revisionCounterKey(rule))}`,
        `            max: ${rule.maxRevisions}`,
        '            exceeded: needs_user',
        `            next: ${yamlScalar(revisionStateId(rule))}`,
      )
    }
    lines.push(
      '          - verb: failed',
      '            next: needs_user',
      '',
    )
  })

  for (const rule of revisionRules) {
    const revisePhase = phases.find(phase => phase.id === rule.revisePhaseId)
    lines.push(
      `    ${yamlScalar(revisionStateId(rule))}:`,
      '      wait:',
      `        from: ${yamlScalar(rule.targetAgentId)}`,
      '        on:',
      '          - verb: done',
    )
    if (revisePhase && revisePhase.outputs.length > 0) {
      lines.push('            requireArtifacts:')
      for (const output of revisePhase.outputs) {
        lines.push(`              - ${yamlScalar(artifactForRuntime(output))}`)
      }
    }
    lines.push(
      `            next: ${yamlScalar(rule.fromPhaseId)}`,
      '          - verb: failed',
      '            next: needs_user',
      '',
    )
  }

  lines.push(
    '    done:',
    '      final: true',
    '      status: done',
    '',
    '    needs_user:',
    '      final: true',
    '      status: needs_user',
    '',
    'prompts:',
  )

  for (const phase of phases) {
    lines.push(`  ${yamlScalar(promptKey(phase.id))}: |`)
    lines.push(blockScalar(
      renderPrompt(phase, revisionRules.filter(rule => rule.fromPhaseId === phase.id), phases),
      '    ',
    ))
    lines.push('')
  }

  for (const rule of revisionRules) {
    lines.push(`  ${yamlScalar(revisionPromptKey(rule))}: |`)
    lines.push(blockScalar(renderRevisionPrompt(rule, phases), '    '))
    lines.push('')
  }

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`
}

function renderPrompt(
  phase: WorkflowPhaseDraft,
  revisionRules: RevisionRuleDraft[],
  phases: WorkflowPhaseDraft[],
): string {
  const inputs = phase.inputs.length > 0
    ? phase.inputs.map(input => `- ${input}`).join('\n')
    : '- none'
  const outputs = phase.outputs.length > 0
    ? phase.outputs.map(output => `- ${output}`).join('\n')
    : '- none'
  const doneReport = phase.outputs.length > 0
    ? `{ "verb": "done", "artifacts": [${phase.outputs.map(output => JSON.stringify(artifactForRuntime(output))).join(', ')}] }`
    : '{ "verb": "done" }'
  const revisionReports = revisionRules.map(rule => {
    const revisePhase = phases.find(candidate => candidate.id === rule.revisePhaseId)
    return `- { "verb": "talk", "target": "${rule.targetAgentId}", "content": "Explain the needed ${revisePhase?.name || rule.revisePhaseId} revision." }`
  })

  return [
    `You are responsible for the ${phase.name || phase.id} phase.`,
    '',
    '{sharedContext}',
    '',
    phase.description,
    '',
    'Phase prompt:',
    phase.prompt,
    '',
    'Input artifacts:',
    inputs,
    '',
    'Output artifacts:',
    outputs,
    '',
    'Allowed reports:',
    `- ${doneReport}`,
    ...revisionReports,
    '- { "verb": "failed", "reason": "..." }',
  ].join('\n')
}

function renderRevisionPrompt(rule: RevisionRuleDraft, phases: WorkflowPhaseDraft[]): string {
  const fromPhase = phases.find(phase => phase.id === rule.fromPhaseId)
  const revisePhase = phases.find(phase => phase.id === rule.revisePhaseId)
  const outputs = revisePhase && revisePhase.outputs.length > 0
    ? revisePhase.outputs.map(output => `- ${output}`).join('\n')
    : '- none'

  return [
    `You are revising the ${revisePhase?.name || rule.revisePhaseId} phase because ${fromPhase?.name || rule.fromPhaseId} requested changes.`,
    '',
    '{sharedContext}',
    '',
    'Revision request:',
    '{lastReport.content}',
    '',
    rule.instruction,
    '',
    'Revise these output artifacts as needed:',
    outputs,
    '',
    'When revision is complete, report:',
    '- { "verb": "done" }',
    '- { "verb": "failed", "reason": "..." }',
  ].join('\n')
}

function workflowToDraft(workflow: unknown): {
  workflowId: string
  workflowName: string
  agents: WorkflowAgentDraft[]
  phases: WorkflowPhaseDraft[]
  revisionRules: RevisionRuleDraft[]
} {
  const parsed = workflow as ParsedWorkflowDefinition
  const agents = Object.entries(parsed.agents).map(([id, agent]) => ({
    draftKey: nextDraftKey('agent'),
    id,
    name: titleFromId(id),
    cli: agent.cli,
    model: agent.model,
    reasoningEffort: agent.reasoningEffort ?? 'high',
    role: agent.role,
  }))
  const phases = extractPhases(parsed)
  const revisionRules = extractRevisionRules(parsed, phases)

  return {
    workflowId: parsed.id,
    workflowName: parsed.name,
    agents,
    phases,
    revisionRules,
  }
}

function extractPhases(workflow: ParsedWorkflowDefinition): WorkflowPhaseDraft[] {
  const phases: WorkflowPhaseDraft[] = []
  const seen = new Set<string>()
  let stateId = workflow.stateMachine.initial

  while (stateId && !seen.has(stateId)) {
    seen.add(stateId)
    const state = workflow.stateMachine.states[stateId]
    if (!state || state.final || stateId.startsWith('revision-') || !state.wait) break
    const prompt = state.prompt ? workflow.prompts[state.prompt] ?? '' : ''
    const doneTransition = state.wait.on.find(transition => transition.verb === 'done')

    phases.push({
      draftKey: nextDraftKey('phase'),
      id: stateId,
      name: titleFromId(stateId),
      description: extractPromptSection(prompt, '{sharedContext}', 'Phase prompt:'),
      agentId: state.wait.from,
      prompt: extractPromptSection(prompt, 'Phase prompt:', 'Input artifacts:') || prompt,
      inputs: extractArtifactSection(prompt, 'Input artifacts:', 'Output artifacts:'),
      outputs: extractArtifactSection(prompt, 'Output artifacts:', 'Allowed reports:')
        .concat((doneTransition?.requireArtifacts ?? []).map(artifact => `tmp/${artifact}`))
        .filter(uniqueString),
    })

    stateId = doneTransition?.next ?? ''
  }

  return phases
}

function extractRevisionRules(
  workflow: ParsedWorkflowDefinition,
  phases: WorkflowPhaseDraft[],
): RevisionRuleDraft[] {
  const rules: RevisionRuleDraft[] = []

  for (const phase of phases) {
    const state = workflow.stateMachine.states[phase.id]
    for (const transition of state?.wait?.on ?? []) {
      if (transition.verb !== 'talk' || !transition.target || !transition.next) continue
      const fromIndex = phaseIndex(phases, phase.id)
      const revisePhase = phases[Math.max(0, fromIndex - 1)]
      const prompt = transition.prompt ? workflow.prompts[transition.prompt] ?? '' : ''
      rules.push({
        draftKey: nextDraftKey('revision'),
        id: transition.next.replace(/^revision-/, '') || nextId('revision', rules),
        fromPhaseId: phase.id,
        revisePhaseId: revisePhase?.id ?? phases[0]?.id ?? '',
        targetAgentId: transition.target,
        maxRevisions: transition.max ?? 3,
        instruction: extractPromptSection(prompt, '{lastReport.content}', 'Revise these output artifacts as needed:')
          || 'Revise the referenced phase artifacts based on the request, then report done.',
      })
    }
  }

  return rules
}

function extractPromptSection(prompt: string, startMarker: string, endMarker: string): string {
  const start = prompt.indexOf(startMarker)
  if (start === -1) return ''
  const contentStart = start + startMarker.length
  const end = prompt.indexOf(endMarker, contentStart)
  return prompt
    .slice(contentStart, end === -1 ? undefined : end)
    .trim()
}

function extractArtifactSection(prompt: string, startMarker: string, endMarker: string): string[] {
  return extractPromptSection(prompt, startMarker, endMarker)
    .split('\n')
    .map(line => line.trim().replace(/^- /, ''))
    .filter(line => line && line !== 'none')
}

function titleFromId(id: string): string {
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map(part => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ')
}

function uniqueString(value: string, index: number, values: string[]): boolean {
  return values.indexOf(value) === index
}

export default function WorkflowEditor() {
  const [workflowId, setWorkflowId] = useState('multi-agents-coding-flow')
  const [workflowName, setWorkflowName] = useState('Multi-Agent Coding Workflow')
  const [workflowFiles, setWorkflowFiles] = useState<WorkflowFileSummary[]>([])
  const [selectedWorkflowFilename, setSelectedWorkflowFilename] = useState('multi-agents-coding-flow.yaml')
  const [loadingWorkflow, setLoadingWorkflow] = useState(false)
  const [agents, setAgents] = useState<WorkflowAgentDraft[]>(INITIAL_AGENTS)
  const [phases, setPhases] = useState<WorkflowPhaseDraft[]>(INITIAL_PHASES)
  const [revisionRules, setRevisionRules] = useState<RevisionRuleDraft[]>([])
  const [structureLocked, setStructureLocked] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const agentIds = useMemo(() => new Set(agents.map(agent => agent.id)), [agents])
  const canLock = agents.length > 0 && phases.length > 0 && phases.every(phase => agentIds.has(phase.agentId))
  const revisionPolicyValid = revisionRules.every(rule =>
    phases.some(phase => phase.id === rule.fromPhaseId) &&
    phases.some(phase => phase.id === rule.revisePhaseId) &&
    agents.some(agent => agent.id === rule.targetAgentId) &&
    rule.fromPhaseId !== rule.revisePhaseId &&
    phaseIndex(phases, rule.revisePhaseId) < phaseIndex(phases, rule.fromPhaseId) &&
    Number.isFinite(rule.maxRevisions) &&
    rule.maxRevisions > 0,
  )
  const canSave = Boolean(workflowId.trim()) &&
    Boolean(workflowName.trim()) &&
    canLock &&
    uniqueValues(agents.map(agent => agent.id)) &&
    uniqueValues(phases.map(phase => phase.id)) &&
    uniqueValues(revisionRules.map(rule => rule.id)) &&
    revisionPolicyValid
  const structureIsLocked = structureLocked || revisionRules.length > 0

  useEffect(() => {
    refreshWorkflowFiles().catch(console.error)
  }, [])

  async function refreshWorkflowFiles(): Promise<void> {
    const result = await api.workflow.list()
    setWorkflowFiles(result.data)
    setSelectedWorkflowFilename(current => {
      if (current && result.data.some(file => file.filename === current)) return current
      return result.data[0]?.filename || filenameForWorkflowId(workflowId)
    })
  }

  async function loadSelectedWorkflow(): Promise<void> {
    if (!selectedWorkflowFilename || loadingWorkflow) return
    setLoadingWorkflow(true)
    setSaveStatus(null)
    setSaveError(null)
    try {
      const result = await api.workflow.load(selectedWorkflowFilename)
      const draft = workflowToDraft(result.data.workflow)
      setWorkflowId(draft.workflowId)
      setWorkflowName(draft.workflowName)
      setAgents(draft.agents)
      setPhases(draft.phases)
      setRevisionRules(draft.revisionRules)
      setStructureLocked(draft.revisionRules.length > 0)
      setSaveStatus(`Loaded ${result.data.filename}`)
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Failed to load workflow')
      await refreshWorkflowFiles().catch(console.error)
    } finally {
      setLoadingWorkflow(false)
    }
  }

  function updateAgent(agentKey: string, patch: Partial<WorkflowAgentDraft>): void {
    setAgents(current => current.map(agent => agent.draftKey === agentKey ? { ...agent, ...patch } : agent))
  }

  function changeAgentId(agentKey: string, previousId: string, nextId: string): void {
    if (structureIsLocked) return
    setAgents(current => current.map(agent => agent.draftKey === agentKey ? { ...agent, id: nextId } : agent))
    setPhases(current => current.map(phase => phase.agentId === previousId ? { ...phase, agentId: nextId } : phase))
    setRevisionRules(current => current.map(rule => rule.targetAgentId === previousId ? { ...rule, targetAgentId: nextId } : rule))
  }

  function updatePhase(phaseKey: string, patch: Partial<WorkflowPhaseDraft>): void {
    setPhases(current => current.map(phase => phase.draftKey === phaseKey ? { ...phase, ...patch } : phase))
  }

  function changePhaseId(phaseKey: string, previousId: string, nextId: string): void {
    if (structureIsLocked) return
    updatePhase(phaseKey, { id: nextId })
    setRevisionRules(current => current.map(rule => ({
      ...rule,
      fromPhaseId: rule.fromPhaseId === previousId ? nextId : rule.fromPhaseId,
      revisePhaseId: rule.revisePhaseId === previousId ? nextId : rule.revisePhaseId,
    })))
  }

  function addAgent(): void {
    const id = nextId('agent', agents)
    setAgents(current => [...current, {
      draftKey: nextDraftKey('agent'),
      id,
      name: id,
      cli: 'codex',
      model: MODEL_OPTIONS.codex[0],
      reasoningEffort: 'high',
      role: '',
    }])
  }

  function removeAgent(agentId: string): void {
    if (structureIsLocked) return
    setAgents(current => current.filter(agent => agent.id !== agentId))
    setPhases(current => current.map(phase => phase.agentId === agentId ? { ...phase, agentId: '' } : phase))
  }

  function addPhase(): void {
    const id = nextId('phase', phases)
    setPhases(current => [...current, {
      draftKey: nextDraftKey('phase'),
      id,
      name: id,
      description: '',
      agentId: agents[0]?.id ?? '',
      prompt: '',
      inputs: [],
      outputs: [],
    }])
  }

  function removePhase(phaseId: string): void {
    if (structureIsLocked) return
    setPhases(current => current.filter(phase => phase.id !== phaseId))
  }

  function movePhase(phaseId: string, direction: -1 | 1): void {
    if (structureIsLocked) return
    setPhases(current => {
      const index = current.findIndex(phase => phase.id === phaseId)
      const nextIndex = index + direction
      if (index < 0 || nextIndex < 0 || nextIndex >= current.length) return current
      const next = current.slice()
      const [phase] = next.splice(index, 1)
      next.splice(nextIndex, 0, phase)
      return next
    })
  }

  function addRevisionRule(): void {
    if (!structureLocked || phases.length < 2) return
    const fromPhase = phases[1]
    const revisePhase = phases[0]
    setRevisionRules(current => [...current, {
      draftKey: nextDraftKey('revision'),
      id: nextId('revision', current),
      fromPhaseId: fromPhase.id,
      revisePhaseId: revisePhase.id,
      targetAgentId: revisePhase.agentId,
      maxRevisions: 3,
      instruction: 'Revise the referenced phase artifacts based on the request, then report done.',
    }])
  }

  function updateRevisionRule(ruleKey: string, patch: Partial<RevisionRuleDraft>): void {
    setRevisionRules(current => current.map(rule => rule.draftKey === ruleKey ? { ...rule, ...patch } : rule))
  }

  function removeRevisionRule(ruleId: string): void {
    setRevisionRules(current => current.filter(rule => rule.id !== ruleId))
  }

  function clearRevisionPolicy(): void {
    setRevisionRules([])
  }

  function resetWorkflow(): void {
    setWorkflowId('multi-agents-coding-flow')
    setWorkflowName('Multi-Agent Coding Workflow')
    setSelectedWorkflowFilename('multi-agents-coding-flow.yaml')
    setAgents(INITIAL_AGENTS)
    setPhases(INITIAL_PHASES)
    setRevisionRules([])
    setStructureLocked(false)
    setSaveStatus('Reset workflow draft')
    setSaveError(null)
  }

  async function saveWorkflow(): Promise<void> {
    if (!canSave || saving) return
    setSaving(true)
    setSaveStatus(null)
    setSaveError(null)
    try {
      const filename = filenameForWorkflowId(workflowId)
      const yaml = generateWorkflowYaml(workflowId.trim(), workflowName.trim(), agents, phases, revisionRules)
      await api.workflow.save(yaml, filename)
      await refreshWorkflowFiles()
      setSelectedWorkflowFilename(filename)
      setSaveStatus(`Saved .covoila/workflows/${filename}`)
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Failed to save workflow')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className={styles.editor}>
      <div className={styles.header}>
        <div>
          <div className={styles.title}>Workflow Editor</div>
          <div className={styles.meta}>
            {structureLocked
              ? 'Agents and phases are structurally locked for revision policy design.'
              : 'Define agents and a linear phase sequence before adding revision policy.'}
          </div>
        </div>
        <button
          className={styles.lockBtn}
          disabled={!canLock}
          onClick={() => {
            if (revisionRules.length > 0) return
            setStructureLocked(value => !value)
          }}
        >
          {structureIsLocked ? 'STRUCTURE LOCKED' : 'LOCK STRUCTURE'}
        </button>
        <button
          className={styles.resetBtn}
          onClick={resetWorkflow}
          disabled={saving || loadingWorkflow}
        >
          RESET WORKFLOW
        </button>
        <button
          className={styles.saveBtn}
          disabled={!canSave || saving}
          onClick={saveWorkflow}
        >
          {saving ? 'SAVING' : 'SAVE WORKFLOW'}
        </button>
      </div>
      {(saveStatus || saveError || !canSave) && (
        <div className={`${styles.saveStrip} ${saveError ? styles.saveError : ''}`}>
          {saveError ?? saveStatus ?? 'Workflow needs a name, unique ids, valid phase agents, and valid revision rules before saving.'}
        </div>
      )}

      <div className={styles.loadMenu}>
        <label className={styles.field}>
          <span>Load workflow</span>
          <select
            value={selectedWorkflowFilename}
            onChange={event => setSelectedWorkflowFilename(event.target.value)}
          >
            {workflowFiles.length === 0 && <option value="multi-agents-coding-flow.yaml">multi-agents-coding-flow.yaml</option>}
            {workflowFiles.map(file => (
              <option value={file.filename} key={file.filename}>
                {file.name} ({file.filename})
              </option>
            ))}
          </select>
        </label>
        <button className={styles.addBtn} disabled={!selectedWorkflowFilename || loadingWorkflow} onClick={loadSelectedWorkflow}>
          {loadingWorkflow ? 'LOADING' : 'LOAD'}
        </button>
      </div>

      <div className={styles.stageRail}>
        <span className={styles.stageActive}>1 AGENTS</span>
        <span className={styles.stageActive}>2 PHASES</span>
        <span className={structureLocked ? styles.stageNext : styles.stageDisabled}>3 REVISION POLICY</span>
      </div>

      <div className={styles.content}>
        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <div>
              <div className={styles.sectionTitle}>Workflow</div>
              <div className={styles.sectionMeta}>Critical field: id.</div>
            </div>
          </div>
          <div className={styles.workflowFields}>
            <label className={styles.field}>
              <span>Workflow id</span>
              <input
                value={workflowId}
                disabled={structureIsLocked}
                onChange={event => setWorkflowId(event.target.value.trim())}
              />
            </label>
            <label className={styles.field}>
              <span>Name</span>
              <input value={workflowName} onChange={event => setWorkflowName(event.target.value)} />
            </label>
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <div>
              <div className={styles.sectionTitle}>Agents</div>
              <div className={styles.sectionMeta}>Critical fields: id and deletion.</div>
            </div>
            <button className={styles.addBtn} onClick={addAgent} disabled={structureIsLocked}>+ AGENT</button>
          </div>
          <div className={styles.cardGrid}>
            {agents.map(agent => (
              <article className={styles.card} key={agent.draftKey}>
                <div className={styles.cardHeader}>
                  <input
                    className={styles.idInput}
                    value={agent.id}
                    disabled={structureIsLocked}
                    onChange={event => changeAgentId(agent.draftKey, agent.id, event.target.value.trim())}
                    aria-label="Agent id"
                  />
                  <button className={styles.deleteBtn} disabled={structureIsLocked} onClick={() => removeAgent(agent.id)}>x</button>
                </div>
                <label className={styles.field}>
                  <span>Name</span>
                  <input value={agent.name} onChange={event => updateAgent(agent.draftKey, { name: event.target.value })} />
                </label>
                <div className={styles.inlineFields}>
                  <label className={styles.field}>
                    <span>CLI</span>
                    <select
                      value={agent.cli}
                      onChange={event => {
                        const cli = event.target.value as AgentCli
                        updateAgent(agent.draftKey, { cli, model: MODEL_OPTIONS[cli][0] })
                      }}
                    >
                      <option value="codex">codex</option>
                      <option value="claude">claude</option>
                    </select>
                  </label>
                  <label className={styles.field}>
                    <span>Model</span>
                    <select value={agent.model} onChange={event => updateAgent(agent.draftKey, { model: event.target.value })}>
                      {MODEL_OPTIONS[agent.cli].map(model => <option value={model} key={model}>{model}</option>)}
                    </select>
                  </label>
                  <label className={styles.field}>
                    <span>Effort</span>
                    <select
                      value={agent.reasoningEffort}
                      onChange={event => updateAgent(agent.draftKey, { reasoningEffort: event.target.value as ReasoningEffort })}
                    >
                      {REASONING_EFFORTS.map(effort => <option value={effort} key={effort}>{effort}</option>)}
                    </select>
                  </label>
                </div>
                <label className={styles.field}>
                  <span>Role</span>
                  <textarea value={agent.role} onChange={event => updateAgent(agent.draftKey, { role: event.target.value })} />
                </label>
              </article>
            ))}
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <div>
              <div className={styles.sectionTitle}>Phases</div>
              <div className={styles.sectionMeta}>Linear only for now. Critical fields: id, agent, order, and deletion.</div>
            </div>
            <button className={styles.addBtn} onClick={addPhase} disabled={structureIsLocked}>+ PHASE</button>
          </div>
          <div className={styles.artifactNotice}>
            <strong>task.md is created before the workflow starts.</strong>
            <span>The first phase must use it. Later phases can include task.md only when they need the original request.</span>
          </div>
          <div className={styles.phaseList}>
            {phases.map((phase, index) => (
              <article className={styles.phaseCard} key={phase.draftKey}>
                <div className={styles.phaseOrder}>{index + 1}</div>
                <div className={styles.phaseBody}>
                  <div className={styles.cardHeader}>
                    <input
                      className={styles.idInput}
                      value={phase.id}
                      disabled={structureIsLocked}
                      onChange={event => changePhaseId(phase.draftKey, phase.id, event.target.value.trim())}
                      aria-label="Phase id"
                    />
                    <div className={styles.phaseControls}>
                      <button disabled={structureIsLocked || index === 0} onClick={() => movePhase(phase.id, -1)}>UP</button>
                      <button disabled={structureIsLocked || index === phases.length - 1} onClick={() => movePhase(phase.id, 1)}>DOWN</button>
                      <button disabled={structureIsLocked} onClick={() => removePhase(phase.id)}>x</button>
                    </div>
                  </div>
                  <div className={styles.phaseGrid}>
                    <label className={styles.field}>
                      <span>Name</span>
                      <input value={phase.name} onChange={event => updatePhase(phase.draftKey, { name: event.target.value })} />
                    </label>
                    <label className={styles.field}>
                      <span>Agent</span>
                      <select
                        value={phase.agentId}
                        disabled={structureIsLocked}
                        onChange={event => updatePhase(phase.draftKey, { agentId: event.target.value })}
                      >
                        <option value="">Select agent</option>
                        {agents.map(agent => <option value={agent.id} key={agent.id}>{agent.name || agent.id}</option>)}
                      </select>
                    </label>
                  </div>
                  <label className={styles.field}>
                    <span>Description</span>
                    <input value={phase.description} onChange={event => updatePhase(phase.draftKey, { description: event.target.value })} />
                  </label>
                  <label className={styles.field}>
                    <span>Prompt</span>
                    <textarea value={phase.prompt} onChange={event => updatePhase(phase.draftKey, { prompt: event.target.value })} />
                  </label>
                  <div className={styles.phaseGrid}>
                    <label className={styles.field}>
                      <span>{index === 0 ? 'Inputs, must include task.md' : 'Inputs'}</span>
                      <textarea
                        value={phase.inputs.join('\n')}
                        onChange={event => updatePhase(phase.draftKey, { inputs: normalizeLines(event.target.value) })}
                      />
                    </label>
                    <label className={styles.field}>
                      <span>Outputs</span>
                      <textarea
                        value={phase.outputs.join('\n')}
                        onChange={event => updatePhase(phase.draftKey, { outputs: normalizeLines(event.target.value) })}
                      />
                    </label>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className={`${styles.section} ${styles.revisionSection}`}>
          <div className={styles.sectionHeader}>
            <div>
              <div className={styles.sectionTitle}>Revision Policy</div>
              <div className={styles.sectionMeta}>
                {structureLocked
                  ? 'Ready to design revision rules from the locked phase sequence.'
                  : 'Lock agents and phases before configuring revision behavior.'}
              </div>
            </div>
            <div className={styles.revisionActions}>
              <button className={styles.addBtn} disabled={!structureLocked || phases.length < 2} onClick={addRevisionRule}>+ RULE</button>
              <button className={styles.deleteBtn} disabled={revisionRules.length === 0} onClick={clearRevisionPolicy}>CLEAR</button>
            </div>
          </div>
          {!structureLocked && (
            <div className={styles.lockPreview}>
              {phases.map((phase, index) => (
                <span key={phase.draftKey}>{index + 1}. {phase.name || phase.id}</span>
              ))}
            </div>
          )}
          {structureLocked && (
            <div className={styles.revisionList}>
              {revisionRules.length === 0 && (
                <div className={styles.emptyPolicy}>No revision rules. Saving now creates a straight-through workflow.</div>
              )}
              {revisionRules.map(rule => {
                const fromIndex = phaseIndex(phases, rule.fromPhaseId)
                const earlierPhases = phases.filter((_, index) => index < fromIndex)
                return (
                  <article className={styles.revisionCard} key={rule.draftKey}>
                    <div className={styles.cardHeader}>
                      <input
                        className={styles.idInput}
                        value={rule.id}
                        onChange={event => updateRevisionRule(rule.draftKey, { id: event.target.value.trim() })}
                        aria-label="Revision rule id"
                      />
                      <button className={styles.deleteBtn} onClick={() => removeRevisionRule(rule.id)}>x</button>
                    </div>
                    <div className={styles.revisionGrid}>
                      <label className={styles.field}>
                        <span>From phase</span>
                        <select
                          value={rule.fromPhaseId}
                          onChange={event => {
                            const fromPhaseId = event.target.value
                            const revisePhase = phases[Math.max(0, phaseIndex(phases, fromPhaseId) - 1)] ?? phases[0]
                            updateRevisionRule(rule.draftKey, {
                              fromPhaseId,
                              revisePhaseId: revisePhase.id,
                              targetAgentId: revisePhase.agentId,
                            })
                          }}
                        >
                          {phases.slice(1).map(phase => (
                            <option value={phase.id} key={phase.id}>{phase.name || phase.id}</option>
                          ))}
                        </select>
                      </label>
                      <label className={styles.field}>
                        <span>Revise phase</span>
                        <select
                          value={rule.revisePhaseId}
                          onChange={event => {
                            const revisePhaseId = event.target.value
                            const revisePhase = phases.find(phase => phase.id === revisePhaseId)
                            updateRevisionRule(rule.draftKey, {
                              revisePhaseId,
                              targetAgentId: revisePhase?.agentId ?? rule.targetAgentId,
                            })
                          }}
                        >
                          {earlierPhases.map(phase => (
                            <option value={phase.id} key={phase.id}>{phase.name || phase.id}</option>
                          ))}
                        </select>
                      </label>
                      <label className={styles.field}>
                        <span>Talk to agent</span>
                        <select
                          value={rule.targetAgentId}
                          onChange={event => updateRevisionRule(rule.draftKey, { targetAgentId: event.target.value })}
                        >
                          {agents.map(agent => (
                            <option value={agent.id} key={agent.id}>{agent.name || agent.id}</option>
                          ))}
                        </select>
                      </label>
                      <label className={styles.field}>
                        <span>Max revisions</span>
                        <input
                          type="number"
                          min="1"
                          max="20"
                          value={rule.maxRevisions}
                          onChange={event => updateRevisionRule(rule.draftKey, {
                            maxRevisions: Math.max(1, Number(event.target.value) || 1),
                          })}
                        />
                      </label>
                    </div>
                    <label className={styles.field}>
                      <span>Instruction</span>
                      <textarea
                        value={rule.instruction}
                        onChange={event => updateRevisionRule(rule.draftKey, { instruction: event.target.value })}
                      />
                    </label>
                  </article>
                )
              })}
            </div>
          )}
        </section>
      </div>
    </section>
  )
}

function uniqueValues(values: string[]): boolean {
  const normalized = values.map(value => value.trim()).filter(Boolean)
  return normalized.length === values.length && new Set(normalized).size === normalized.length
}

function phaseIndex(phases: WorkflowPhaseDraft[], phaseId: string): number {
  return phases.findIndex(phase => phase.id === phaseId)
}
