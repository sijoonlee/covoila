import { access } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import pty from 'node-pty'
import type { AgentCli, ReasoningEffort } from '../src/types.js'

export type AgentSessionStatus = 'starting' | 'running' | 'idle' | 'exited' | 'failed'

export type AgentSessionConfig = {
  cli: AgentCli
  model: string
  reasoningEffort?: ReasoningEffort
}

export type AgentSessionSnapshot = {
  id: string
  cli: AgentCli
  model: string
  reasoningEffort?: ReasoningEffort
  taskId?: string
  agentInstanceId?: string
  title: string
  cwd: string
  command: string[]
  status: AgentSessionStatus
  pid: number | null
  exitCode: number | null
  createdAt: string
  lastOutputAt: string | null
  transcript: string[]
}

type AgentOutputListener = (event: { sessionId: string; data: string }) => void
type AgentSessionUpdateListener = (snapshot: AgentSessionSnapshot) => void

type StartAgentSessionInput = {
  id?: string
  taskId?: string
  agentInstanceId?: string
  title?: string
  cwd: string
  extraWritableDirs?: string[]
  config: AgentSessionConfig
  prompt: string
  mcpUrl?: string
  reportToken?: string
  reportTokenEnvVar?: string
  promptDelayMs?: number
  cols?: number
  rows?: number
}

const IDLE_AFTER_MS = 1200
const TRANSCRIPT_LIMIT = 400

type BuiltCommand = {
  command: string[]
  displayCommand: string[]
  env: NodeJS.ProcessEnv
}

function buildAgentCommand(
  config: AgentSessionConfig,
  cwd: string,
  extraWritableDirs: string[] = [],
  mcpUrl?: string,
  reportToken?: string,
  reportTokenEnvVar?: string,
): BuiltCommand {
  const env: NodeJS.ProcessEnv = {}
  if (config.cli === 'codex') {
    const command = [
      'codex',
      '--cd',
      cwd,
      '--ask-for-approval',
      'never',
      '--model',
      config.model,
    ]
    for (const dir of extraWritableDirs) {
      command.push('--add-dir', dir)
    }
    if (mcpUrl && reportToken && reportTokenEnvVar) {
      env[reportTokenEnvVar] = reportToken
      command.push(
        '-c',
        `mcp_servers.covoila-report={ url="${mcpUrl}", bearer_token_env_var="${reportTokenEnvVar}", default_tools_approval_mode="approve", enabled_tools=["report"] }`,
      )
    }
    return { command, displayCommand: command, env }
  }

  const command = ['claude', '--model', config.model]
  for (const dir of extraWritableDirs) {
    command.push('--add-dir', dir)
  }
  if (config.reasoningEffort) {
    command.push('--effort', config.reasoningEffort)
  }
  if (mcpUrl && reportToken) {
    const mcpConfig = {
      mcpServers: {
        'covoila-report': {
          type: 'http',
          url: mcpUrl,
          headers: { Authorization: `Bearer ${reportToken}` },
        },
      },
    }
    const redactedConfig = {
      mcpServers: {
        'covoila-report': {
          type: 'http',
          url: mcpUrl,
          headers: { Authorization: 'Bearer <redacted>' },
        },
      },
    }
    command.push('--strict-mcp-config', '--mcp-config', JSON.stringify(mcpConfig))
    return {
      command,
      displayCommand: [
        'claude',
        '--model',
        config.model,
        ...extraWritableDirs.flatMap(dir => ['--add-dir', dir]),
        ...(config.reasoningEffort ? ['--effort', config.reasoningEffort] : []),
        '--strict-mcp-config',
        '--mcp-config',
        JSON.stringify(redactedConfig),
      ],
      env,
    }
  }
  return { command, displayCommand: command, env }
}

export class AgentSession {
  private terminal: pty.IPty | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private readonly listeners = new Set<AgentOutputListener>()
  private readonly updateListeners = new Set<AgentSessionUpdateListener>()
  // Status must change through setStatus so subscribers receive session.updated events.
  private snapshotData: AgentSessionSnapshot
  private readonly prompt: string
  private readonly promptDelayMs: number
  private readonly command: string[]
  private readonly env: NodeJS.ProcessEnv

  constructor(input: StartAgentSessionInput) {
    const id = input.id ?? `agent_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    const builtCommand = buildAgentCommand(
      input.config,
      input.cwd,
      input.extraWritableDirs,
      input.mcpUrl,
      input.reportToken,
      input.reportTokenEnvVar,
    )
    this.prompt = input.prompt
    this.promptDelayMs = input.promptDelayMs ?? 500
    this.command = builtCommand.command
    this.env = builtCommand.env
    this.snapshotData = {
      id,
      cli: input.config.cli,
      model: input.config.model,
      reasoningEffort: input.config.reasoningEffort,
      taskId: input.taskId,
      agentInstanceId: input.agentInstanceId,
      title: input.title ?? id,
      cwd: input.cwd,
      command: builtCommand.displayCommand,
      status: 'starting',
      pid: null,
      exitCode: null,
      createdAt: new Date().toISOString(),
      lastOutputAt: null,
      transcript: [],
    }
  }

  get id(): string {
    return this.snapshotData.id
  }

  notifyCreated(): void {
    this.notifyChange()
  }

  async start(cols = 120, rows = 36): Promise<AgentSessionSnapshot> {
    if (this.terminal) {
      this.terminal.resize(cols, rows)
      return this.snapshot()
    }

    if (this.snapshotData.status === 'exited' || this.snapshotData.status === 'failed') {
      return this.snapshot()
    }

    try {
      await access(this.snapshotData.cwd)
    } catch {
      this.appendSystemLine(`Working directory does not exist: ${this.snapshotData.cwd}\n`)
      this.setStatus('failed')
      return this.snapshot()
    }

    const [binary, ...args] = this.command
    try {
      this.terminal = pty.spawn(binary, args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: this.snapshotData.cwd,
        env: { ...process.env, ...this.env, TERM: 'xterm-256color' },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown spawn error'
      this.appendSystemLine(`Failed to start ${this.snapshotData.cli}: ${message}\n`)
      this.setStatus('failed')
      return this.snapshot()
    }

    this.snapshotData.pid = this.terminal.pid
    this.setStatus('running')
    this.appendSystemLine(`Started ${this.snapshotData.cli} terminal pid=${this.terminal.pid ?? 'unknown'}.\n`)

    this.terminal.onData((data) => {
      this.setStatus('running')
      this.snapshotData.lastOutputAt = new Date().toISOString()
      this.appendTranscript(data)
      this.scheduleIdle()
      this.emit(data)
    })

    this.terminal.onExit(({ exitCode }) => {
      this.clearIdleTimer()
      this.snapshotData.exitCode = exitCode
      this.setStatus('exited')
      this.appendSystemLine(`${this.snapshotData.cli} terminal exited with code ${exitCode ?? 'unknown'}.\n`)
      this.terminal = null
    })

    this.sendPrompt(this.prompt, this.promptDelayMs)
    this.scheduleIdle()
    return this.snapshot()
  }

  onOutput(listener: AgentOutputListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  onSessionUpdated(listener: AgentSessionUpdateListener): () => void {
    this.updateListeners.add(listener)
    return () => {
      this.updateListeners.delete(listener)
    }
  }

  write(data: string): boolean {
    if (!this.terminal) {
      return false
    }
    this.setStatus('running')
    this.terminal.write(data)
    this.scheduleIdle()
    return true
  }

  submitPrompt(prompt: string): boolean {
    if (!this.write(prompt)) {
      return false
    }
    setTimeout(() => {
      if (this.terminal) {
        this.write('\r')
      }
    }, 150)
    return true
  }

  resize(cols: number, rows: number): boolean {
    if (!this.terminal) {
      return false
    }
    this.terminal.resize(cols, rows)
    return true
  }

  terminate(): boolean {
    if (!this.terminal) {
      return false
    }

    const terminal = this.terminal
    terminal.write('\x03')
    setTimeout(() => {
      if (this.terminal === terminal) {
        terminal.kill()
      }
    }, 800)
    return true
  }

  snapshot(): AgentSessionSnapshot {
    return {
      ...this.snapshotData,
      command: [...this.snapshotData.command],
      transcript: [...this.snapshotData.transcript],
    }
  }

  private sendPrompt(prompt: string, delayMs: number): void {
    setTimeout(() => {
      if (!this.terminal) {
        return
      }
      this.submitPrompt(prompt)
    }, delayMs)
  }

  private scheduleIdle(): void {
    this.clearIdleTimer()
    this.idleTimer = setTimeout(() => {
      if (this.terminal && this.snapshotData.status === 'running') {
        this.setStatus('idle')
      }
    }, IDLE_AFTER_MS)
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  private appendSystemLine(text: string): void {
    const line = `\x1b[36m[system]\x1b[0m ${text}`
    this.appendTranscript(line)
    this.emit(line)
  }

  private appendTranscript(data: string): void {
    this.snapshotData.transcript.push(data)
    if (this.snapshotData.transcript.length > TRANSCRIPT_LIMIT) {
      this.snapshotData.transcript.splice(0, this.snapshotData.transcript.length - TRANSCRIPT_LIMIT)
    }
  }

  private emit(data: string): void {
    for (const listener of this.listeners) {
      listener({ sessionId: this.id, data })
    }
  }

  private setStatus(next: AgentSessionStatus): void {
    if (this.snapshotData.status === next) return
    this.snapshotData.status = next
    this.notifyChange()
  }

  private notifyChange(): void {
    const snapshot = this.snapshot()
    for (const listener of this.updateListeners) {
      listener(snapshot)
    }
  }
}

export class AgentSessionManager {
  private readonly sessions = new Map<string, AgentSession>()
  private readonly outputListeners = new Set<AgentOutputListener>()
  private readonly updateListeners = new Set<AgentSessionUpdateListener>()

  prepare(input: StartAgentSessionInput): AgentSessionSnapshot {
    const session = new AgentSession(input)
    this.registerSession(session)
    session.notifyCreated()
    return session.snapshot()
  }

  async start(
    input: StartAgentSessionInput,
    beforeStart?: (session: AgentSessionSnapshot) => Promise<void>,
  ): Promise<AgentSessionSnapshot> {
    const session = new AgentSession(input)
    this.registerSession(session)
    session.notifyCreated()
    await beforeStart?.(session.snapshot())
    return session.start(input.cols, input.rows)
  }

  async startExisting(id: string, cols?: number, rows?: number): Promise<AgentSessionSnapshot | null> {
    const session = this.sessions.get(id)
    if (!session) return null
    return session.start(cols, rows)
  }

  list(): AgentSessionSnapshot[] {
    return Array.from(this.sessions.values(), (session) => session.snapshot())
  }

  get(id: string): AgentSessionSnapshot | null {
    return this.sessions.get(id)?.snapshot() ?? null
  }

  write(id: string, data: string): boolean {
    return this.sessions.get(id)?.write(data) ?? false
  }

  submitPrompt(id: string, prompt: string): boolean {
    return this.sessions.get(id)?.submitPrompt(prompt) ?? false
  }

  resize(id: string, cols: number, rows: number): boolean {
    return this.sessions.get(id)?.resize(cols, rows) ?? false
  }

  terminate(id: string): boolean {
    return this.sessions.get(id)?.terminate() ?? false
  }

  onOutput(listener: AgentOutputListener): () => void {
    this.outputListeners.add(listener)
    return () => {
      this.outputListeners.delete(listener)
    }
  }

  onSessionUpdated(listener: AgentSessionUpdateListener): () => void {
    this.updateListeners.add(listener)
    return () => {
      this.updateListeners.delete(listener)
    }
  }

  closeAll(): void {
    for (const session of this.sessions.values()) {
      session.terminate()
    }
  }

  private registerSession(session: AgentSession): void {
    this.sessions.set(session.id, session)
    session.onOutput((event) => {
      for (const listener of this.outputListeners) {
        listener(event)
      }
    })
    session.onSessionUpdated((snapshot) => {
      for (const listener of this.updateListeners) {
        listener(snapshot)
      }
    })
  }
}
