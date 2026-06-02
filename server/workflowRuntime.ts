import fs from 'node:fs/promises'
import path from 'node:path'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import type {
  WorkflowGateRoute,
  WorkflowGateRun,
  ReportVerb,
  WorkflowDefinition,
  WorkflowState,
  WorkflowTransition,
} from './workflowParser.js'

const execAsync = promisify(exec)
const gateRequireBase = createRequire(import.meta.url)

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
  lastGate?: WorkflowGateResult
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

export type WorkflowGateResult = {
  state: string
  type: 'command' | 'javascript'
  passed: boolean
  summary: string
  stdout: string
  stderr: string
  exitCode?: number | null
}

export type WorkflowGateEvent = {
  state: string
  route: 'onPass' | 'onFail'
  result: WorkflowGateResult
}

export type AdvanceWorkflowResult = {
  run: WorkflowRunState
  dispatch: PromptDispatch | null
  gateEvents: WorkflowGateEvent[]
}

const HUMAN_TARGET = 'HUMAN'
const NEEDS_USER_STATE = 'needs_user'
const DEFAULT_GATE_TIMEOUT_MS = 30_000
const MAX_AUTOMATIC_GATES = 25

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

export async function advanceWorkflow(
  workflow: WorkflowDefinition,
  run: WorkflowRunState,
  context: WorkflowTaskContext,
  promptIdOverride?: string,
): Promise<AdvanceWorkflowResult> {
  let currentRun = run
  let nextPromptId = promptIdOverride
  const gateEvents: WorkflowGateEvent[] = []

  for (let index = 0; index < MAX_AUTOMATIC_GATES; index += 1) {
    const state = getState(workflow, currentRun.currentState)
    if (!state.gate) {
      return {
        run: currentRun,
        dispatch: getCurrentPromptDispatch(workflow, currentRun, context, nextPromptId),
        gateEvents,
      }
    }

    const gateResult = await executeGateRun(state.gate.run, state, currentRun, context)
    const routeName = gateResult.passed ? 'onPass' : 'onFail'
    const route = state.gate[routeName]
    const routed = applyGateRoute(workflow, currentRun, route, gateResult)
    currentRun = routed.run
    nextPromptId = route.prompt
    gateEvents.push({
      state: gateResult.state,
      route: routeName,
      result: gateResult,
    })
  }

  throw new Error(`Workflow exceeded automatic gate limit (${MAX_AUTOMATIC_GATES})`)
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

  if (isHumanTalk(report)) {
    validateReportArtifacts(report)
    const transition: WorkflowTransition = {
      verb: 'talk',
      target: HUMAN_TARGET,
      next: NEEDS_USER_STATE,
    }
    const nextState = getState(workflow, transition.next)
    const nextRun: WorkflowRunState = {
      ...run,
      currentState: transition.next,
      lastReport: report,
      status: statusForState(nextState),
    }
    return {
      run: nextRun,
      dispatch: null,
      transition,
    }
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
    dispatch: null,
    transition,
  }
}

async function executeGateRun(
  run: WorkflowGateRun,
  state: WorkflowState,
  workflowRun: WorkflowRunState,
  context: WorkflowTaskContext,
): Promise<WorkflowGateResult> {
  const cwd = resolveGateCwd(run, context)
  const timeout = run.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS
  if (run.type === 'command') {
    return executeCommandGate(run.command ?? '', cwd, timeout, workflowRun.currentState)
  }
  return executeJavaScriptGate(run.script ?? '', cwd, timeout, workflowRun.currentState, context, state)
}

async function executeCommandGate(
  command: string,
  cwd: string,
  timeoutMs: number,
  state: string,
): Promise<WorkflowGateResult> {
  try {
    const output = await execAsync(command, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 128 * 1024,
    })
    return {
      state,
      type: 'command',
      passed: true,
      summary: `Command gate passed: ${command}`,
      stdout: output.stdout,
      stderr: output.stderr,
      exitCode: 0,
    }
  } catch (error) {
    const execError = error as { stdout?: string; stderr?: string; code?: number | null; signal?: string }
    return {
      state,
      type: 'command',
      passed: false,
      summary: execError.signal === 'SIGTERM'
        ? `Command gate timed out after ${timeoutMs}ms: ${command}`
        : `Command gate failed: ${command}`,
      stdout: execError.stdout ?? '',
      stderr: execError.stderr ?? '',
      exitCode: execError.code ?? null,
    }
  }
}

async function executeJavaScriptGate(
  script: string,
  cwd: string,
  timeoutMs: number,
  state: string,
  context: WorkflowTaskContext,
  workflowState: WorkflowState,
): Promise<WorkflowGateResult> {
  const logs: string[] = []
  const gateRequire = (name: string) => {
    if (name === 'fs' || name === 'node:fs') return gateRequireBase('node:fs')
    if (name === 'path' || name === 'node:path') return gateRequireBase('node:path')
    throw new Error(`Module is not allowed in gate script: ${name}`)
  }
  const gateContext = {
    workDir: context.workDir,
    taskTmpDir: resolveTaskTmpDir(context),
    cwd,
    state: workflowState,
  }
  try {
    const fn = new Function('context', 'require', 'console', script)
    const result = await withTimeout(
      Promise.resolve(fn(gateContext, gateRequire, {
        log: (...values: unknown[]) => logs.push(values.map(String).join(' ')),
      })),
      timeoutMs,
    )
    const passed = Boolean(result)
    return {
      state,
      type: 'javascript',
      passed,
      summary: passed ? 'JavaScript gate passed' : 'JavaScript gate returned a falsey value',
      stdout: logs.join('\n'),
      stderr: '',
    }
  } catch (error) {
    return {
      state,
      type: 'javascript',
      passed: false,
      summary: error instanceof Error ? `JavaScript gate failed: ${error.message}` : 'JavaScript gate failed',
      stdout: logs.join('\n'),
      stderr: error instanceof Error ? error.stack ?? error.message : String(error),
    }
  }
}

function applyGateRoute(
  workflow: WorkflowDefinition,
  run: WorkflowRunState,
  route: WorkflowGateRoute,
  gateResult: WorkflowGateResult,
): { run: WorkflowRunState } {
  const nextCounters = { ...run.counters }
  let nextStateId = route.next
  if (route.increment) {
    nextCounters[route.increment] = (nextCounters[route.increment] ?? 0) + 1
    if (route.max !== undefined && nextCounters[route.increment] > route.max) {
      nextStateId = route.exceeded ?? NEEDS_USER_STATE
    }
  }
  const nextState = getState(workflow, nextStateId)
  return {
    run: {
      ...run,
      currentState: nextStateId,
      counters: nextCounters,
      lastGate: gateResult,
      status: statusForState(nextState),
    },
  }
}

function resolveGateCwd(run: WorkflowGateRun, context: WorkflowTaskContext): string {
  return run.cwd === 'taskTmpDir' ? resolveTaskTmpDir(context) : context.workDir
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs)
    promise.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      error => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
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

function isHumanTalk(report: AgentReport): boolean {
  return report.verb === 'talk' && report.target === HUMAN_TARGET
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
    'lastGate.summary': run.lastGate?.summary ?? '',
    'lastGate.stdout': run.lastGate?.stdout ?? '',
    'lastGate.stderr': run.lastGate?.stderr ?? '',
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
