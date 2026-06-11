import express from 'express'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { WebSocketServer } from 'ws'
import { ensureDir, readData, writeData, initData, CONFIG_DIR } from './storage.js'
import {
  deleteTask,
  getTask,
  initTaskDatabase,
  listTaskEvents,
  listTasks,
  onTaskUpdated,
  replaceTasks,
  updateTask,
} from './db.js'
import { AgentSessionManager, type AgentSessionConfig } from './agent.js'
import {
  handleReportMcpRequest,
  listActionReportEvents,
  onActionReport,
} from './report.js'
import {
  mockAgentConfigs,
} from '../src/mockData.js'
import type { TaskRecord } from '../src/types.js'
import {
  DEFAULT_WORKFLOW_PATH,
  loadWorkflowDefinition,
  loadInitialWorkflowFile,
  loadWorkflowFile,
  listWorkflowFiles,
  saveWorkflowDefinitionYaml,
  workflowPathForFilename,
  type WorkflowDefinition,
} from './workflowParser.js'
import { Orchestrator } from './orchestrator.js'
import { appendWorkflowJsonlSessionOutput } from './workflowJsonlLog.js'

const app = express()
const httpServer = createServer(app)
const agentSessions = new AgentSessionManager()
const PORT = Number(process.env.PORT ?? 3001)
let workflowDefinition: WorkflowDefinition | null = null
let orchestrator: Orchestrator | null = null
let workflowFilename = 'multi-agents-coding-flow.yaml'
app.use(express.json())
app.use('/vendor/xterm', express.static('node_modules/@xterm/xterm'))
app.use('/vendor/xterm-addon-fit', express.static('node_modules/@xterm/addon-fit'))

const RESOURCES = ['agentConfigs'] as const
type Resource = typeof RESOURCES[number]

const DEFAULTS: Record<Resource, unknown> = {
  agentConfigs: mockAgentConfigs,
}

for (const name of RESOURCES) {
  app.get(`/api/${name}`, async (_req, res) => {
    const data = await readData(name, DEFAULTS[name])
    res.json({ data })
  })

  app.put(`/api/${name}`, async (req, res) => {
    const { data } = req.body as { data: unknown }
    await writeData(name, data)
    res.json({ ok: true })
  })
}

app.get('/api/tasks', async (_req, res) => {
  res.json({ data: await listTasks() })
})

app.put('/api/tasks', async (req, res) => {
  const { data } = req.body as { data?: TaskRecord[] }
  if (!Array.isArray(data)) {
    res.status(400).json({ error: 'Expected task array' })
    return
  }
  await replaceTasks(data)
  res.json({ ok: true })
})

app.delete('/api/tasks/:taskId', async (req, res) => {
  await deleteTask(req.params.taskId)
  res.json({ ok: true })
})

app.get('/api/task-events', async (req, res) => {
  const taskId = typeof req.query.taskId === 'string' ? req.query.taskId : undefined
  res.json({ data: await listTaskEvents(taskId) })
})

app.get('/api/environment', (_req, res) => {
  res.json({ data: { cwd: process.cwd() } })
})

app.get('/api/workflow', (_req, res) => {
  if (!workflowDefinition) {
    res.status(503).json({ error: 'Workflow definition is not loaded' })
    return
  }
  res.json({ data: workflowDefinition })
})

app.get('/api/workflows', async (_req, res) => {
  try {
    res.json({ data: await listWorkflowFiles() })
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Failed to list workflows' })
  }
})

app.get('/api/workflows/:filename', async (req, res) => {
  try {
    res.json({ data: await loadWorkflowFile(req.params.filename) })
  } catch (error) {
    const status = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 400
    res.status(status).json({ error: error instanceof Error ? error.message : 'Failed to load workflow' })
  }
})

app.put('/api/workflow', async (req, res) => {
  const { filename, yaml } = req.body as { filename?: unknown; yaml?: unknown }
  if (typeof yaml !== 'string' || !yaml.trim()) {
    res.status(400).json({ error: 'Missing workflow YAML' })
    return
  }

  try {
    const targetPath = typeof filename === 'string' && filename.trim()
      ? workflowPathForFilename(filename)
      : DEFAULT_WORKFLOW_PATH
    const nextWorkflow = await saveWorkflowDefinitionYaml(yaml, targetPath)
    workflowDefinition = nextWorkflow
    workflowFilename = typeof filename === 'string' && filename.trim() ? filename : workflowFilename
    orchestrator = new Orchestrator({
      workflow: workflowDefinition,
      agentSessions,
      mcpUrl: `http://127.0.0.1:${PORT}/mcp`,
    })
    res.json({ data: workflowDefinition })
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid workflow YAML' })
  }
})

app.post('/api/orchestrator/runs', async (req, res) => {
  const { name, workflowFilename: requestedWorkflowFilename, workDir, task } = req.body as {
    name?: unknown
    workflowFilename?: unknown
    workDir?: unknown
    task?: unknown
  }
  if (typeof name !== 'string' || !name.trim()) {
    res.status(400).json({ error: 'Missing run name' })
    return
  }
  if (typeof task !== 'string' || !task.trim()) {
    res.status(400).json({ error: 'Missing task' })
    return
  }

  try {
    const selectedWorkflow = typeof requestedWorkflowFilename === 'string' && requestedWorkflowFilename.trim()
      ? (await loadWorkflowFile(requestedWorkflowFilename)).workflow
      : workflowDefinition
    if (!selectedWorkflow) {
      res.status(503).json({ error: 'No workflow is available' })
      return
    }

    const selectedOrchestrator = new Orchestrator({
      workflow: selectedWorkflow,
      agentSessions,
      mcpUrl: `http://127.0.0.1:${PORT}/mcp`,
    })
    const result = await selectedOrchestrator.startRun({
      name,
      workDir: typeof workDir === 'string' && workDir.trim() ? workDir : process.cwd(),
      task,
    })
    res.status(201).json({ data: result })
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Failed to start orchestrator run' })
  }
})

app.post('/api/tasks/:taskId/stop-agent-sessions', async (req, res) => {
  for (const session of agentSessions.list()) {
    if (session.taskId !== req.params.taskId) continue
    if (session.status === 'exited' || session.status === 'failed') continue
    agentSessions.terminate(session.id)
  }

  const task = await updateTask(req.params.taskId, existing => ({
    ...existing,
    status: 'STOPPED',
    agentSessions: Object.fromEntries(
      Object.entries(existing.agentSessions).map(([agentName]) => [agentName, { status: 'done' as const }]),
    ),
  }))
  if (!task) {
    res.status(404).json({ error: 'Task not found' })
    return
  }
  res.json({ data: task })
})

app.post('/mcp', async (req, res) => {
  try {
    await handleReportMcpRequest({ req, res })
  } catch (error) {
    console.error(error)
    if (!res.headersSent) {
      res.status(500).json({ error: 'MCP request failed' })
    }
  }
})

app.get('/api/action-report-events', (_req, res) => {
  res.json({ data: listActionReportEvents() })
})

app.get('/api/agent-sessions', (_req, res) => {
  res.json({ data: agentSessions.list() })
})

app.get('/api/agent-sessions/:sessionId', (req, res) => {
  const session = agentSessions.get(req.params.sessionId)
  if (!session) {
    res.status(404).json({ error: 'Agent session not found' })
    return
  }
  res.json({ data: session })
})

app.post('/api/agent-sessions', async (req, res) => {
  const body = req.body as {
    taskId?: string
    agentInstanceId?: string
    config?: AgentSessionConfig
    cwd?: string
    prompt?: string
    title?: string
    cols?: number
    rows?: number
  }

  let task: TaskRecord | undefined
  if (body.taskId) {
    task = await getTask(body.taskId) ?? undefined
    if (!task) {
      res.status(404).json({ error: 'Task not found' })
      return
    }
  }

  const config = body.config ?? null
  if (!config) {
    res.status(400).json({ error: 'Missing agent config' })
    return
  }

  const cwd = body.cwd ?? task?.workDir ?? process.cwd()

  const prompt = body.prompt ?? ''
  if (!prompt.trim()) {
    res.status(400).json({ error: 'Missing prompt' })
    return
  }

  const sessionId = `session_${randomUUID().replaceAll('-', '').slice(0, 12)}`

  const session = await agentSessions.start({
    id: sessionId,
    taskId: task?.id,
    agentInstanceId: body.agentInstanceId,
    title: body.title ?? task?.name,
    cwd,
    config,
    prompt,
    cols: body.cols,
    rows: body.rows,
  })

  res.status(201).json({ data: session })
})

app.post('/api/agent-sessions/:sessionId/input', (req, res) => {
  const { data } = req.body as { data?: string }
  if (typeof data !== 'string') {
    res.status(400).json({ error: 'Missing input data' })
    return
  }
  res.json({ ok: agentSessions.write(req.params.sessionId, data) })
})

app.post('/api/agent-sessions/:sessionId/resize', (req, res) => {
  const { cols, rows } = req.body as { cols?: number; rows?: number }
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
    res.status(400).json({ error: 'Invalid terminal size' })
    return
  }
  res.json({
    ok: agentSessions.resize(
      req.params.sessionId,
      Math.max(20, Math.min(240, Math.floor(cols))),
      Math.max(6, Math.min(80, Math.floor(rows))),
    ),
  })
})

app.post('/api/agent-sessions/:sessionId/attach', async (req, res) => {
  const { cols, rows } = req.body as { cols?: number; rows?: number }
  const session = await agentSessions.startExisting(
    req.params.sessionId,
    Number.isFinite(cols) ? Math.max(20, Math.min(240, Math.floor(cols))) : undefined,
    Number.isFinite(rows) ? Math.max(6, Math.min(80, Math.floor(rows))) : undefined,
  )
  if (!session) {
    res.status(404).json({ error: 'Agent session not found' })
    return
  }
  res.json({ data: session })
})

app.delete('/api/agent-sessions/:sessionId', (req, res) => {
  res.json({ ok: agentSessions.terminate(req.params.sessionId) })
})

type TerminalMessage =
  | { type: 'input'; sessionId: string; data: string }
  | { type: 'resize'; sessionId: string; cols: number; rows: number }
  | { type: 'attach'; sessionId: string; cols?: number; rows?: number }

function parseTerminalMessage(raw: string): TerminalMessage | null {
  try {
    const message = JSON.parse(raw) as TerminalMessage
    if (
      message.type === 'input' &&
      typeof message.sessionId === 'string' &&
      typeof message.data === 'string'
    ) {
      return message
    }

    if (
      message.type === 'attach' &&
      typeof message.sessionId === 'string'
    ) {
      return {
        type: 'attach',
        sessionId: message.sessionId,
        cols: Number.isFinite(message.cols) ? Math.max(20, Math.min(240, Math.floor(message.cols))) : undefined,
        rows: Number.isFinite(message.rows) ? Math.max(6, Math.min(80, Math.floor(message.rows))) : undefined,
      }
    }

    if (
      message.type === 'resize' &&
      typeof message.sessionId === 'string' &&
      Number.isFinite(message.cols) &&
      Number.isFinite(message.rows)
    ) {
      return {
        type: 'resize',
        sessionId: message.sessionId,
        cols: Math.max(20, Math.min(240, Math.floor(message.cols))),
        rows: Math.max(6, Math.min(80, Math.floor(message.rows))),
      }
    }
  } catch {
    return null
  }
  return null
}

const terminalWss = new WebSocketServer({ noServer: true, perMessageDeflate: false })
const taskEventsWss = new WebSocketServer({ noServer: true, perMessageDeflate: false })

httpServer.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).pathname
  if (pathname === '/agent-terminal') {
    terminalWss.handleUpgrade(req, socket, head, (ws) => {
      terminalWss.emit('connection', ws, req)
    })
    return
  }

  if (pathname === '/task-events') {
    taskEventsWss.handleUpgrade(req, socket, head, (ws) => {
      taskEventsWss.emit('connection', ws, req)
    })
    return
  }

  socket.destroy()
})

terminalWss.on('connection', (socket) => {
  const unsubscribe = agentSessions.onOutput((event) => {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify({ type: 'output', ...event }))
    }
  })

  socket.on('message', (raw) => {
    const message = parseTerminalMessage(raw.toString())
    if (!message) return

    if (message.type === 'attach') {
      agentSessions.startExisting(message.sessionId, message.cols, message.rows).catch(console.error)
    } else if (message.type === 'input') {
      agentSessions.write(message.sessionId, message.data)
    } else {
      agentSessions.resize(message.sessionId, message.cols, message.rows)
    }
  })

  socket.on('close', unsubscribe)
})

const unsubscribeTaskUpdates = onTaskUpdated((task) => {
  const payload = JSON.stringify({ type: 'task.updated', task })
  for (const client of taskEventsWss.clients) {
    if (client.readyState === client.OPEN) {
      client.send(payload)
    }
  }
})

const unsubscribeSessionUpdates = agentSessions.onSessionUpdated((session) => {
  const payload = JSON.stringify({ type: 'session.updated', session })
  for (const client of taskEventsWss.clients) {
    if (client.readyState === client.OPEN) {
      client.send(payload)
    }
  }
})

const unsubscribeJsonlOutput = agentSessions.onOutput((event) => {
  appendWorkflowJsonlSessionOutput(event).catch(console.error)
})

await ensureDir()
await initTaskDatabase()
const initialWorkflow = await loadInitialWorkflowFile()
if (initialWorkflow) {
  workflowDefinition = initialWorkflow.workflow
  workflowFilename = initialWorkflow.filename
  orchestrator = new Orchestrator({
    workflow: workflowDefinition,
    agentSessions,
    mcpUrl: `http://127.0.0.1:${PORT}/mcp`,
  })
}
onActionReport(async event => {
  await orchestrator?.handleActionReport(event)
})
for (const name of RESOURCES) {
  await initData(name, DEFAULTS[name])
}

function shutdown() {
  unsubscribeTaskUpdates()
  unsubscribeSessionUpdates()
  unsubscribeJsonlOutput()
  agentSessions.closeAll()
  terminalWss.close()
  taskEventsWss.close()
  httpServer.close()
  setTimeout(() => process.exit(0), 1000)
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)

httpServer.listen(PORT, () => {
  console.log(`Covoila API  →  http://localhost:${PORT}`)
  console.log(`Config dir   →  ${CONFIG_DIR}`)
  console.log(`Workflow     →  ${workflowDefinition?.id ?? 'not loaded'}`)
})
