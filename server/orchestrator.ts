import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { appendTaskEvent, createTask, getTask, updateTask } from './db.js'
import type { AgentSessionManager, AgentSessionConfig, AgentSessionSnapshot } from './agent.js'
import {
  generateReportToken,
  registerReportSession,
  tokenEnvVarForSession,
  updateReportSessionContext,
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
import {
  appendWorkflowJsonlEvent,
  setWorkflowJsonlSessionContext,
} from './workflowJsonlLog.js'
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

    const taskFilePath = await writeTaskFile(context, input.task)

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
    await appendWorkflowJsonlEvent(resolveTaskTmpDir(context), {
      runId: taskId,
      taskId,
      step: run.currentState,
      who: 'orchestrator',
      kind: 'run',
      message: `Started workflow run ${input.name}`,
      data: {
        workflowId: workflow.id,
        initialState: run.currentState,
        workDir,
        taskTmpDir,
        task: input.task,
      },
    })
    await appendWorkflowJsonlEvent(resolveTaskTmpDir(context), {
      runId: taskId,
      taskId,
      step: run.currentState,
      who: 'orchestrator',
      kind: 'artifact',
      message: 'task.md',
      data: {
        path: 'task.md',
        absolutePath: taskFilePath,
        content: await fs.readFile(taskFilePath, 'utf-8'),
      },
    })
    await appendTaskEvent({
      taskId,
      type: 'ORCHESTRATOR_RUN_STARTED',
      payload: {
        workflowId: workflow.id,
        initialState: run.currentState,
        taskTmpDir,
      },
    })
    await appendGateEvents(task, context, advanced.gateEvents)
    await appendRunFinishedIfFinal(task, context, run)

    const dispatch = advanced.dispatch
    let dispatched: { session: AgentSessionSnapshot; run: WorkflowRunState } | null = null
    try {
      dispatched = dispatch ? await this.dispatchPrompt(task, run, dispatch, workflow) : null
    } catch (error) {
      await markTaskDispatchFailed(task, run, error)
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
    await appendWorkflowJsonlEvent(resolveTaskTmpDir(context), {
      runId: task.id,
      taskId: task.id,
      step: run.currentState,
      who: fromAgent,
      kind: 'report',
      message: summarizeReport(report),
      data: {
        sessionId: event.sessionId,
        nodeId: event.nodeId,
        nodeRunId: event.nodeRunId,
        report,
        rawOutput: event.output,
      },
    })
    await appendReportedArtifacts(task, context, fromAgent, run.currentState, report)

    const result = await applyWorkflowReport(workflow, run, context, fromAgent, report)
    await appendArtifacts(
      task,
      context,
      fromAgent,
      run.currentState,
      (result.transition.requireArtifacts ?? []).filter(artifact => !(report.artifacts ?? []).includes(artifact)),
    )
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

    await appendWorkflowJsonlEvent(resolveTaskTmpDir(context), {
      runId: task.id,
      taskId: task.id,
      step: run.currentState,
      who: 'orchestrator',
      kind: 'transition',
      message: `${run.currentState} -> ${advanced.run.currentState}`,
      data: {
        from: run.currentState,
        to: advanced.run.currentState,
        fromAgent,
        verb: report.verb,
        target: report.target,
        status: advanced.run.status,
        transition: result.transition,
        dispatch: advanced.dispatch ? {
          agent: advanced.dispatch.agent,
          promptId: advanced.dispatch.promptId,
          state: advanced.dispatch.state,
        } : null,
      },
    })
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
    await appendGateEvents(task, context, advanced.gateEvents)
    await appendRunFinishedIfFinal(task, context, advanced.run)

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
    const taskTmpDir = resolveTaskTmpDir(contextFromTask(task))
    await appendWorkflowJsonlEvent(taskTmpDir, {
      runId: task.id,
      taskId: task.id,
      step: dispatch.state,
      who: 'orchestrator',
      kind: 'prompt',
      message: `Dispatched ${dispatch.promptId} to ${dispatch.agent}`,
      data: {
        agent: dispatch.agent,
        promptId: dispatch.promptId,
        prompt: dispatch.prompt,
      },
    })

    const existingSessionId = run.agentSessions[dispatch.agent]
    const existingSession = existingSessionId ? this.agentSessions.get(existingSessionId) : null
    if (existingSession && existingSession.status !== 'exited' && existingSession.status !== 'failed') {
      setWorkflowJsonlSessionContext(existingSession.id, {
        runId: task.id,
        taskId: task.id,
        taskTmpDir,
        step: dispatch.state,
        who: dispatch.agent,
      })
      updateReportSessionContext({
        sessionId: existingSession.id,
        task,
        title: `${task.name}: ${dispatch.state}`,
        nodeId: dispatch.state,
        nodeRunId: dispatch.promptId,
      })
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
    setWorkflowJsonlSessionContext(sessionId, {
      runId: task.id,
      taskId: task.id,
      taskTmpDir,
      step: dispatch.state,
      who: dispatch.agent,
    })

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
  task: TaskRecord,
  run: WorkflowRunState,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : 'Failed to dispatch workflow prompt'
  const failedRun: WorkflowRunState = {
    ...run,
    status: 'failed',
  }
  await updateTask(task.id, current => ({
    ...current,
    status: 'FAILED',
    memory: {
      ...current.memory,
      orchestratorRun: failedRun,
    },
  }))
  await appendWorkflowJsonlEvent(resolveTaskTmpDir(contextFromTask(task)), {
    runId: task.id,
    taskId: task.id,
    step: run.currentState,
    who: 'orchestrator',
    kind: 'error',
    message,
  })
  await appendTaskEvent({
    taskId: task.id,
    type: 'ORCHESTRATOR_DISPATCH_FAILED',
    payload: { error: message },
  })
}

async function appendGateEvents(
  task: TaskRecord,
  context: WorkflowTaskContext,
  gateEvents: Array<{
    state: string
    route: string
    result: {
      passed?: boolean
      summary?: string
      stdout?: string
      stderr?: string
    }
  }>,
): Promise<void> {
  for (const event of gateEvents) {
    await appendWorkflowJsonlEvent(resolveTaskTmpDir(context), {
      runId: task.id,
      taskId: task.id,
      step: event.state,
      who: 'orchestrator',
      kind: 'gate',
      message: event.result.summary ?? `Gate ${event.route}`,
      data: event,
    })
    await appendTaskEvent({
      taskId: task.id,
      type: 'ORCHESTRATOR_GATE_EVALUATED',
      payload: event,
    })
  }
}

async function appendRunFinishedIfFinal(
  task: TaskRecord,
  context: WorkflowTaskContext,
  run: WorkflowRunState,
): Promise<void> {
  if (run.status === 'running') return

  await appendWorkflowJsonlEvent(resolveTaskTmpDir(context), {
    runId: task.id,
    taskId: task.id,
    step: run.currentState,
    who: 'orchestrator',
    kind: 'run',
    message: `Workflow run finished with status ${run.status}`,
    data: {
      status: run.status,
      currentState: run.currentState,
    },
  })
}

async function appendReportedArtifacts(
  task: TaskRecord,
  context: WorkflowTaskContext,
  who: string,
  step: string,
  report: AgentReport,
): Promise<void> {
  await appendArtifacts(task, context, who, step, report.artifacts ?? [])
}

async function appendArtifacts(
  task: TaskRecord,
  context: WorkflowTaskContext,
  who: string,
  step: string,
  artifacts: string[],
): Promise<void> {
  const seen = new Set<string>()
  for (const artifact of artifacts) {
    if (seen.has(artifact)) continue
    seen.add(artifact)
    const artifactPath = safeArtifactPath(resolveTaskTmpDir(context), artifact)
    if (!artifactPath) {
      await appendWorkflowJsonlEvent(resolveTaskTmpDir(context), {
        runId: task.id,
        taskId: task.id,
        step,
        who,
        kind: 'artifact',
        message: artifact,
        data: {
          path: artifact,
          error: 'Invalid artifact path',
        },
      })
      continue
    }

    try {
      const content = await fs.readFile(artifactPath, 'utf-8')
      await appendWorkflowJsonlEvent(resolveTaskTmpDir(context), {
        runId: task.id,
        taskId: task.id,
        step,
        who,
        kind: 'artifact',
        message: artifact,
        data: {
          path: artifact,
          absolutePath: artifactPath,
          content,
        },
      })
    } catch (error) {
      await appendWorkflowJsonlEvent(resolveTaskTmpDir(context), {
        runId: task.id,
        taskId: task.id,
        step,
        who,
        kind: 'artifact',
        message: artifact,
        data: {
          path: artifact,
          absolutePath: artifactPath,
          error: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }
}

function safeArtifactPath(taskTmpDir: string, artifact: string): string | null {
  if (!artifact || path.isAbsolute(artifact) || artifact.split(/[\\/]/).includes('..')) return null
  return path.join(taskTmpDir, artifact)
}

function summarizeReport(report: AgentReport): string {
  if (report.verb === 'talk') {
    const target = report.target ? ` to ${report.target}` : ''
    return `talk${target}: ${report.content ?? ''}`.trim()
  }
  if (report.verb === 'failed') {
    return `failed: ${report.reason ?? report.content ?? ''}`.trim()
  }
  return report.verb
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
