import fs from 'node:fs/promises'
import path from 'node:path'
import type {
  ReportVerb,
  WorkflowDefinition,
  WorkflowState,
  WorkflowTransition,
} from './workflowParser.js'

export type AgentReport = {
  verb: ReportVerb
  target?: string
  targets?: string[]
  content?: string
  reason?: string
  artifacts?: string[]
}

export type WorkflowRunState = {
  workflowId: string
  currentState: string
  counters: Record<string, number>
  agentSessions: Record<string, string>
  lastReport?: AgentReport
  status: 'running' | 'done' | 'failed' | 'needs_user'
}

export type WorkflowTaskContext = {
  workDir: string
  taskTmpDir: string
}

export type PromptDispatch = {
  agent: string
  promptId: string
  prompt: string
  state: string
}

export type ApplyReportResult = {
  run: WorkflowRunState
  dispatch: PromptDispatch | null
  transition: WorkflowTransition
}

export function createWorkflowRun(workflow: WorkflowDefinition): WorkflowRunState {
  const initialState = workflow.stateMachine.states[workflow.stateMachine.initial]
  if (!initialState) {
    throw new Error(`Initial state not found: ${workflow.stateMachine.initial}`)
  }

  return {
    workflowId: workflow.id,
    currentState: workflow.stateMachine.initial,
    counters: {},
    agentSessions: {},
    status: statusForState(initialState),
  }
}

export function getCurrentPromptDispatch(
  workflow: WorkflowDefinition,
  run: WorkflowRunState,
  context: WorkflowTaskContext,
  promptIdOverride?: string,
): PromptDispatch | null {
  const state = getState(workflow, run.currentState)
  if (state.final) return null
  if (!state.wait) throw new Error(`State ${run.currentState} has no wait configuration`)

  const promptId = promptIdOverride ?? state.prompt
  if (!promptId) return null

  const promptTemplate = workflow.prompts[promptId]
  if (!promptTemplate) throw new Error(`Prompt not found: ${promptId}`)

  return {
    agent: state.wait.from,
    promptId,
    prompt: renderPrompt(workflow, run, context, promptTemplate),
    state: run.currentState,
  }
}

export async function applyWorkflowReport(
  workflow: WorkflowDefinition,
  run: WorkflowRunState,
  context: WorkflowTaskContext,
  fromAgent: string,
  report: AgentReport,
): Promise<ApplyReportResult> {
  const state = getState(workflow, run.currentState)
  if (state.final) {
    throw new Error(`Workflow is already final: ${run.currentState}`)
  }
  if (!state.wait) {
    throw new Error(`State ${run.currentState} is not waiting for a report`)
  }
  if (state.wait.from !== fromAgent) {
    throw new Error(`State ${run.currentState} is waiting for ${state.wait.from}, not ${fromAgent}`)
  }

  const transition = findTransition(state, report)
  await validateRequiredArtifacts(context, transition)
  validateReportArtifacts(report)

  const nextCounters = { ...run.counters }
  if (transition.increment) {
    nextCounters[transition.increment] = (nextCounters[transition.increment] ?? 0) + 1
    if (transition.max !== undefined && nextCounters[transition.increment] > transition.max) {
      const exceededState = transition.exceeded ?? 'needs_user'
      const exceededRun = {
        ...run,
        currentState: exceededState,
        counters: nextCounters,
        lastReport: report,
        status: statusForState(getState(workflow, exceededState)),
      }
      return {
        run: exceededRun,
        dispatch: getCurrentPromptDispatch(workflow, exceededRun, context),
        transition,
      }
    }
  }

  const nextState = getState(workflow, transition.next)
  const nextRun: WorkflowRunState = {
    ...run,
    currentState: transition.next,
    counters: nextCounters,
    lastReport: report,
    status: statusForState(nextState),
  }

  return {
    run: nextRun,
    dispatch: getCurrentPromptDispatch(workflow, nextRun, context, transition.prompt),
    transition,
  }
}

export async function writeTaskFile(
  context: WorkflowTaskContext,
  taskBody: string,
): Promise<string> {
  const dir = resolveTaskTmpDir(context)
  await fs.mkdir(dir, { recursive: true })
  const filePath = path.join(dir, 'task.md')
  await fs.writeFile(filePath, formatTaskMarkdown(taskBody), 'utf-8')
  return filePath
}

export function resolveTaskTmpDir(context: WorkflowTaskContext): string {
  return path.isAbsolute(context.taskTmpDir)
    ? context.taskTmpDir
    : path.join(context.workDir, context.taskTmpDir)
}

function findTransition(state: WorkflowState, report: AgentReport): WorkflowTransition {
  const transition = state.wait?.on.find(candidate => {
    if (candidate.verb !== report.verb) return false
    if (candidate.target !== undefined && candidate.target !== report.target) return false
    return true
  })
  if (!transition) {
    const allowed = state.wait?.on.map(candidate =>
      candidate.target ? `${candidate.verb}:${candidate.target}` : candidate.verb,
    ).join(', ')
    throw new Error(`Report ${report.verb}${report.target ? `:${report.target}` : ''} is not allowed. Allowed: ${allowed}`)
  }
  return transition
}

async function validateRequiredArtifacts(
  context: WorkflowTaskContext,
  transition: WorkflowTransition,
): Promise<void> {
  for (const artifact of transition.requireArtifacts ?? []) {
    validateRelativeArtifactPath(artifact)
    const artifactPath = path.join(resolveTaskTmpDir(context), artifact)
    try {
      const stat = await fs.stat(artifactPath)
      if (!stat.isFile()) throw new Error()
    } catch {
      throw new Error(`Required artifact not found: ${artifact}`)
    }
  }
}

function validateReportArtifacts(report: AgentReport): void {
  for (const artifact of report.artifacts ?? []) {
    validateRelativeArtifactPath(artifact)
  }
}

function validateRelativeArtifactPath(value: string): void {
  if (!value || path.isAbsolute(value) || value.split(/[\\/]/).includes('..')) {
    throw new Error(`Invalid artifact path: ${value}`)
  }
}

function renderPrompt(
  workflow: WorkflowDefinition,
  run: WorkflowRunState,
  context: WorkflowTaskContext,
  template: string,
): string {
  const sharedContext = renderTemplate(workflow.sharedContext, {
    workDir: context.workDir,
    taskTmpDir: context.taskTmpDir,
  })

  return renderTemplate(template, {
    workDir: context.workDir,
    taskTmpDir: context.taskTmpDir,
    sharedContext,
    currentState: run.currentState,
    'lastReport.content': run.lastReport?.content ?? '',
    'lastReport.reason': run.lastReport?.reason ?? '',
    'lastReport.artifacts': (run.lastReport?.artifacts ?? []).join(', '),
  })
}

function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{([^{}]+)\}/g, (match, key: string) => values[key] ?? match)
}

function statusForState(state: WorkflowState): WorkflowRunState['status'] {
  if (!state.final) return 'running'
  if (state.status === 'done') return 'done'
  if (state.status === 'failed') return 'failed'
  return 'needs_user'
}

function getState(workflow: WorkflowDefinition, stateId: string): WorkflowState {
  const state = workflow.stateMachine.states[stateId]
  if (!state) throw new Error(`State not found: ${stateId}`)
  return state
}

function formatTaskMarkdown(taskBody: string): string {
  return [
    '# Task',
    '',
    taskBody.trim(),
    '',
    '## Created',
    '',
    new Date().toISOString(),
    '',
  ].join('\n')
}
