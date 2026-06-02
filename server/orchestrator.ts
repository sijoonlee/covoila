import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { appendTaskEvent, createTask, getTask, updateTask } from './db.js'
import type { AgentSessionManager, AgentSessionConfig, AgentSessionSnapshot } from './agent.js'
import {
  generateReportToken,
  registerReportSession,
  tokenEnvVarForSession,
  type ActionReportEvent,
} from './report.js'
import {
  advanceWorkflow,
  applyWorkflowReport,
  createWorkflowRun,
  resolveTaskTmpDir,
  writeTaskFile,
  type AgentReport,
  type PromptDispatch,
  type WorkflowRunState,
  type WorkflowTaskContext,
} from './workflowRuntime.js'
import type { WorkflowDefinition } from './workflowParser.js'
import { CONFIG_DIR } from './storage.js'
import type { TaskRecord } from '../src/types.js'

type OrchestratorInput = {
  workflow: WorkflowDefinition
  agentSessions: AgentSessionManager
  mcpUrl: string
}

type StartRunInput = {
  name: string
  workDir: string
  task: string
}

export type OrchestratorStartResult = {
  task: TaskRecord
  run: WorkflowRunState
  dispatch: PromptDispatch | null
  session: AgentSessionSnapshot | null
}

export class Orchestrator {
  private readonly workflow: WorkflowDefinition
  private readonly agentSessions: AgentSessionManager
  private readonly mcpUrl: string

  constructor(input: OrchestratorInput) {
    this.workflow = input.workflow
    this.agentSessions = input.agentSessions
    this.mcpUrl = input.mcpUrl
  }

  async startRun(input: StartRunInput): Promise<OrchestratorStartResult> {
    const workflow = this.workflow
    const taskId = `task_${randomToken()}`
    const workDir = await resolveWorkDir(input.workDir)
    const taskTmpDir = path.join(
      CONFIG_DIR,
      'tmp',
      `${slugify(input.name || 'task')}-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-${randomToken(5)}`,
    )
    const context: WorkflowTaskContext = {
      workDir,
      taskTmpDir,
    }

    await writeTaskFile(context, input.task)

    const initialRun = createWorkflowRun(workflow)
    const advanced = await advanceWorkflow(workflow, initialRun, context)
    const run = advanced.run
    const task = createTaskRecord({
      id: taskId,
      name: input.name,
      context,
      run,
      workflow,
    })
    await createTask(task)
    await appendTaskEvent({
      taskId,
      type: 'ORCHESTRATOR_RUN_STARTED',
      payload: {
        workflowId: workflow.id,
        initialState: run.currentState,
        taskTmpDir,
      },
    })
    await appendGateEvents(task.id, advanced.gateEvents)

    const dispatch = advanced.dispatch
    let dispatched: { session: AgentSessionSnapshot; run: WorkflowRunState } | null = null
    try {
      dispatched = dispatch ? await this.dispatchPrompt(task, run, dispatch, workflow) : null
    } catch (error) {
      await markTaskDispatchFailed(task.id, run, error)
      throw error
    }
    const updatedTask = await getTask(taskId)
    const updatedRun = updatedTask ? readRun(updatedTask) ?? run : run

    return {
      task: updatedTask ?? task,
      run: updatedRun,
      dispatch,
      session: dispatched?.session ?? null,
    }
  }

  async handleActionReport(event: ActionReportEvent): Promise<{
    task: TaskRecord
    run: WorkflowRunState
    dispatch: PromptDispatch | null
    session: AgentSessionSnapshot | null
  } | null> {
    const task = await getTask(event.taskId)
    if (!task) return null

    const run = readRun(task)
    if (!run) {
      await appendTaskEvent({
        taskId: task.id,
        type: 'ORCHESTRATOR_REPORT_IGNORED',
        payload: { reason: 'Task has no orchestrator run', report: event },
      })
      return null
    }

    const context = contextFromTask(task)
    const workflow = workflowFromTask(task) ?? this.workflow
    const fromAgent = findAgentForSession(run, event.sessionId)
    if (!fromAgent) {
      await appendTaskEvent({
        taskId: task.id,
        type: 'ORCHESTRATOR_REPORT_IGNORED',
        payload: { reason: 'No agent mapped to report session', report: event },
      })
      return null
    }

    const report = parseAgentReport(event.output)
    const result = await applyWorkflowReport(workflow, run, context, fromAgent, report)
    const advanced = await advanceWorkflow(workflow, result.run, context, result.transition.prompt)
    const needsHumanAttention = report.verb === 'talk' && report.target === 'HUMAN'
    const nextTask = await updateTask(task.id, current => ({
      ...current,
      status: taskStatusForRun(advanced.run),
      memory: {
        ...current.memory,
        orchestratorRun: advanced.run,
      },
      agentSessions: {
        ...current.agentSessions,
        [fromAgent]: {
          ...(current.agentSessions[fromAgent] ?? { status: 'running' as const }),
          needsHumanAttention,
          humanAttentionAt: needsHumanAttention ? event.receivedAt : current.agentSessions[fromAgent]?.humanAttentionAt,
        },
      },
    }))

    await appendTaskEvent({
      taskId: task.id,
      type: 'ORCHESTRATOR_TRANSITIONED',
      payload: {
        fromAgent,
        report,
        currentState: advanced.run.currentState,
        status: advanced.run.status,
        dispatch: advanced.dispatch ? {
          agent: advanced.dispatch.agent,
          promptId: advanced.dispatch.promptId,
          state: advanced.dispatch.state,
        } : null,
      },
    })
    await appendGateEvents(task.id, advanced.gateEvents)

    const dispatched = advanced.dispatch && nextTask
      ? await this.dispatchPrompt(nextTask, advanced.run, advanced.dispatch, workflow)
      : null
    const updatedTask = nextTask ? await getTask(nextTask.id) : null
    const updatedRun = updatedTask ? readRun(updatedTask) ?? advanced.run : advanced.run

    return updatedTask
      ? { task: updatedTask, run: updatedRun, dispatch: advanced.dispatch, session: dispatched?.session ?? null }
      : null
  }

  private async dispatchPrompt(
    task: TaskRecord,
    run: WorkflowRunState,
    dispatch: PromptDispatch,
    workflow: WorkflowDefinition,
  ): Promise<{ session: AgentSessionSnapshot; run: WorkflowRunState }> {
    const existingSessionId = run.agentSessions[dispatch.agent]
    const existingSession = existingSessionId ? this.agentSessions.get(existingSessionId) : null
    if (existingSession && existingSession.status !== 'exited' && existingSession.status !== 'failed') {
      if (existingSession.pid) {
        if (!this.agentSessions.submitPrompt(existingSession.id, dispatch.prompt)) {
          throw new Error(`Agent session is not accepting prompts: ${existingSession.id}`)
        }
      } else {
        const started = await this.agentSessions.startExisting(existingSession.id)
        if (!started || started.status === 'failed') {
          throw new Error(`Agent session failed to start: ${existingSession.id}`)
        }
        if (!this.agentSessions.submitPrompt(existingSession.id, dispatch.prompt)) {
          throw new Error(`Agent session is not accepting prompts: ${existingSession.id}`)
        }
      }
      return { session: this.agentSessions.get(existingSession.id) ?? existingSession, run }
    }

    const config = this.resolveAgentConfig(dispatch.agent, workflow)
    const sessionId = `session_${randomToken()}`
    const rawToken = generateReportToken()
    const tokenEnvVar = tokenEnvVarForSession(sessionId)

    registerReportSession({
      sessionId,
      task,
      title: `${task.name}: ${dispatch.state}`,
      nodeId: dispatch.state,
      nodeRunId: dispatch.promptId,
      rawToken,
    })

    const session = await this.agentSessions.start({
      id: sessionId,
      taskId: task.id,
      agentInstanceId: dispatch.agent,
      title: `${task.name}: ${dispatch.state}`,
      cwd: task.workDir,
      extraWritableDirs: [resolveTaskTmpDir(contextFromTask(task))],
      config,
      prompt: dispatch.prompt,
      mcpUrl: this.mcpUrl,
      reportToken: rawToken,
      reportTokenEnvVar: tokenEnvVar,
    })
    if (session.status === 'failed') {
      throw new Error(`Agent session failed to start: ${session.transcript.join('').trim() || session.id}`)
    }

    const nextRun: WorkflowRunState = {
      ...run,
      agentSessions: {
        ...run.agentSessions,
        [dispatch.agent]: session.id,
      },
    }
    await updateTask(task.id, current => ({
      ...current,
      memory: {
        ...current.memory,
        orchestratorRun: nextRun,
      },
    }))

    return { session, run: nextRun }
  }

  private resolveAgentConfig(agentName: string, workflow: WorkflowDefinition): AgentSessionConfig {
    const workflowAgent = workflow.agents[agentName]
    if (!workflowAgent) throw new Error(`Workflow agent not found: ${agentName}`)
    return {
      cli: workflowAgent.cli,
      model: workflowAgent.model,
      reasoningEffort: workflowAgent.reasoningEffort,
    }
  }
}

async function markTaskDispatchFailed(
  taskId: string,
  run: WorkflowRunState,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : 'Failed to dispatch workflow prompt'
  const failedRun: WorkflowRunState = {
    ...run,
    status: 'failed',
  }
  await updateTask(taskId, current => ({
    ...current,
    status: 'FAILED',
    memory: {
      ...current.memory,
      orchestratorRun: failedRun,
    },
  }))
  await appendTaskEvent({
    taskId,
    type: 'ORCHESTRATOR_DISPATCH_FAILED',
    payload: { error: message },
  })
}

async function appendGateEvents(
  taskId: string,
  gateEvents: Array<{
    state: string
    route: string
    result: unknown
  }>,
): Promise<void> {
  for (const event of gateEvents) {
    await appendTaskEvent({
      taskId,
      type: 'ORCHESTRATOR_GATE_EVALUATED',
      payload: event,
    })
  }
}

async function resolveWorkDir(raw: string): Promise<string> {
  const normalized = stripWrappingQuotes(raw.trim())
  if (!normalized) {
    throw new Error('Missing working directory')
  }
  const absolute = path.resolve(normalized)
  let stat
  try {
    stat = await fs.stat(absolute)
  } catch {
    throw new Error(`Working directory does not exist: ${absolute}`)
  }
  if (!stat.isDirectory()) {
    throw new Error(`Working directory is not a directory: ${absolute}`)
  }
  return fs.realpath(absolute)
}

function stripWrappingQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1).trim()
    }
  }
  return value
}

function createTaskRecord(input: {
  id: string
  name: string
  context: WorkflowTaskContext
  workflow: WorkflowDefinition
  run: WorkflowRunState
}): TaskRecord {
  return {
    id: input.id,
    name: input.name,
    workDir: input.context.workDir,
    taskTmpDir: input.context.taskTmpDir,
    status: taskStatusForRun(input.run),
    createdAt: new Date().toISOString(),
    workflowSnapshot: input.workflow as unknown as TaskRecord['workflowSnapshot'],
    memory: {
      orchestratorRun: input.run,
    },
    agentSessions: {},
  }
}

function workflowFromTask(task: TaskRecord): WorkflowDefinition | null {
  const snapshot = task.workflowSnapshot as unknown as Partial<WorkflowDefinition>
  if (!snapshot || typeof snapshot !== 'object') return null
  if (!snapshot.agents || !snapshot.stateMachine || !snapshot.prompts) return null
  return snapshot as WorkflowDefinition
}

function readRun(task: TaskRecord): WorkflowRunState | null {
  const run = task.memory.orchestratorRun
  if (!run || typeof run !== 'object') return null
  return run as WorkflowRunState
}

function contextFromTask(task: TaskRecord): WorkflowTaskContext {
  return {
    workDir: task.workDir,
    taskTmpDir: task.taskTmpDir,
  }
}

function findAgentForSession(run: WorkflowRunState, sessionId: string): string | null {
  for (const [agentName, mappedSessionId] of Object.entries(run.agentSessions)) {
    if (mappedSessionId === sessionId) return agentName
  }
  return null
}

function parseAgentReport(output: Record<string, unknown>): AgentReport {
  const verb = output.verb
  if (verb !== 'talk' && verb !== 'broadcast' && verb !== 'done' && verb !== 'failed') {
    throw new Error('Report must include verb: talk, broadcast, done, or failed')
  }
  const report: AgentReport = { verb }
  if (typeof output.target === 'string') report.target = output.target
  if (Array.isArray(output.targets)) report.targets = output.targets.filter((value): value is string => typeof value === 'string')
  if (typeof output.content === 'string') report.content = output.content
  if (typeof output.reason === 'string') report.reason = output.reason
  if (Array.isArray(output.artifacts)) report.artifacts = output.artifacts.filter((value): value is string => typeof value === 'string')
  return report
}

function taskStatusForRun(run: WorkflowRunState): TaskRecord['status'] {
  if (run.status === 'done') return 'DONE'
  if (run.status === 'failed') return 'FAILED'
  if (run.status === 'needs_user') return 'BLOCKED'
  return 'RUNNING'
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'task'
}

function randomToken(length = 12): string {
  return randomUUID().replaceAll('-', '').slice(0, length)
}
