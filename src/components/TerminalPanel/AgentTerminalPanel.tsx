import { useEffect, useMemo, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { AgentCli, AgentConfig, AgentSessionSnapshot, ReasoningEffort } from '../../types'
import { api } from '../../api'
import { MODEL_OPTIONS, REASONING_EFFORTS } from '../../mockData'
import styles from './TerminalPanel.module.css'

const TERMINAL_THEME = {
  background: '#080808',
  foreground: '#cccccc',
  cursor: '#eeeeee',
  black: '#0d0d0d',
  red: '#e04040',
  green: '#3dba3d',
  yellow: '#f0a500',
  blue: '#5d8cff',
  magenta: '#cc78fa',
  cyan: '#4fc3c7',
  white: '#cccccc',
  brightBlack: '#555555',
  brightRed: '#ff6b6b',
  brightGreen: '#5fe05f',
  brightYellow: '#ffc34d',
  brightBlue: '#83a8ff',
  brightMagenta: '#df9cff',
  brightCyan: '#7adadd',
  brightWhite: '#eeeeee',
}

type Props = {
  agentConfigs: AgentConfig[]
  existingSession?: AgentSessionSnapshot
  slotIndex?: number
  title?: string
  taskId?: string
  emptyMessage?: string
  hidden?: boolean
  spanRows?: boolean
  spanCols?: boolean
  onSessionStarted?: (session: AgentSessionSnapshot) => void
  onSessionTerminated?: (sessionId: string) => void
}

function initialPrompt(config: AgentConfig, title: string): string {
  return [
    `You are connected to Covoila terminal panel "${title}".`,
    '',
    'Introduce the active CLI/model briefly, then wait for user instructions in the terminal.',
    '',
    `CLI: ${config.cli}`,
    `Model: ${config.model}`,
  ].join('\n')
}

function selectDefaultConfig(agentConfigs: AgentConfig[]): AgentConfig | null {
  return agentConfigs.find(config => config.cli === 'codex') ?? agentConfigs[0] ?? null
}

function defaultModelForCli(cli: AgentCli): string {
  return MODEL_OPTIONS[cli][0] ?? ''
}

function socketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const host = window.location.port === '4318'
    ? `${window.location.hostname}:3001`
    : window.location.host
  return `${protocol}//${host}/agent-terminal`
}

export default function AgentTerminalPanel({
  agentConfigs,
  existingSession,
  slotIndex = 0,
  title = 'Agent CLI',
  taskId,
  emptyMessage,
  hidden = false,
  spanRows,
  spanCols,
  onSessionStarted,
  onSessionTerminated,
}: Props) {
  const extra = `${spanRows ? styles.spanRows : spanCols ? styles.spanCols : ''} ${hidden ? styles.hiddenPanel : ''}`
  const containerRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const socketRef = useRef<WebSocket | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const attachedSessionIdsRef = useRef<Set<string>>(new Set())
  const hydratedSessionIdsRef = useRef<Set<string>>(new Set())
  const hiddenRef = useRef(hidden)
  const [session, setSession] = useState<AgentSessionSnapshot | null>(existingSession ?? null)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const defaultConfig = useMemo(() => selectDefaultConfig(agentConfigs), [agentConfigs])
  const [selectedCli, setSelectedCli] = useState<AgentCli>(() => defaultConfig?.cli ?? 'codex')
  const [selectedModel, setSelectedModel] = useState(() => defaultConfig?.model ?? defaultModelForCli('codex'))
  const [selectedEffort, setSelectedEffort] = useState<ReasoningEffort>(() => defaultConfig?.reasoningEffort ?? 'high')
  const [cwd, setCwd] = useState('')
  const config = useMemo<AgentConfig>(() => ({
    id: `playground-${selectedCli}`,
    cli: selectedCli,
    model: selectedModel || defaultModelForCli(selectedCli),
    reasoningEffort: selectedEffort,
  }), [selectedCli, selectedModel, selectedEffort])

  function hasVisibleSize(): boolean {
    const element = containerRef.current
    return Boolean(element && element.clientWidth > 0 && element.clientHeight > 0)
  }

  function safeFit(): void {
    if (hiddenRef.current || !hasVisibleSize()) return
    try {
      fitAddonRef.current?.fit()
    } catch {
      // xterm can throw if its renderer has not measured the container yet.
    }
  }

  function safeWrite(data: string): void {
    try {
      terminalRef.current?.write(data)
    } catch {
      requestAnimationFrame(() => terminalRef.current?.write(data))
    }
  }

  function safeWriteln(data: string): void {
    try {
      terminalRef.current?.writeln(data)
    } catch {
      requestAnimationFrame(() => terminalRef.current?.writeln(data))
    }
  }

  function closeSocket(): void {
    const socket = socketRef.current
    socketRef.current = null
    if (!socket) return
    if (socket.readyState === WebSocket.CONNECTING) {
      socket.addEventListener('open', () => socket.close(), { once: true })
      return
    }
    socket.close()
  }

  function hydrateTranscriptOnce(nextSession: AgentSessionSnapshot): void {
    if (hydratedSessionIdsRef.current.has(nextSession.id)) return
    hydratedSessionIdsRef.current.add(nextSession.id)
    renderSessionSnapshot(nextSession)
  }

  function renderSessionSnapshot(nextSession: AgentSessionSnapshot): void {
    terminalRef.current?.clear()
    if (nextSession.transcript.length === 0) {
      safeWriteln(`[system] ${nextSession.cli} session ${nextSession.status}.`)
      return
    }

    for (const chunk of nextSession.transcript) {
      safeWrite(chunk)
    }
  }

  function sessionEnded(nextSession: AgentSessionSnapshot): boolean {
    return nextSession.status === 'exited' || nextSession.status === 'failed'
  }

  useEffect(() => {
    hiddenRef.current = hidden
  }, [hidden])

  useEffect(() => {
    if (!containerRef.current || terminalRef.current) return

    const terminal = new Terminal({
      allowTransparency: false,
      convertEol: true,
      cursorBlink: true,
      disableStdin: false,
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
      fontSize: 12,
      rows: 18,
      theme: TERMINAL_THEME,
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(containerRef.current)
    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    terminal.onData((data) => {
      sendTerminalMessage({ type: 'input', data })
    })
    terminal.onResize(({ cols, rows }) => {
      sendTerminalMessage({ type: 'resize', cols, rows })
    })

    if (existingSession && sessionEnded(existingSession)) {
      renderSessionSnapshot(existingSession)
    } else {
      safeWriteln(`Covoila terminal ${slotIndex + 1}`)
      safeWriteln(existingSession ? 'Connecting to live agent session...' : (emptyMessage ?? 'Click START to launch an agent CLI.'))
    }

    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(safeFit)
    })
    resizeObserver.observe(containerRef.current)
    requestAnimationFrame(safeFit)

    return () => {
      resizeObserver.disconnect()
      closeSocket()
      terminal.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
    }
  }, [slotIndex])

  useEffect(() => {
    if (!existingSession || sessionIdRef.current === existingSession.id) return
    sessionIdRef.current = existingSession.id
    setSession(existingSession)
    if (sessionEnded(existingSession)) {
      renderSessionSnapshot(existingSession)
      requestAnimationFrame(safeFit)
      return
    }
    attachSession(existingSession.id, true)
      .then(() => ensureSocket())
      .catch(console.error)
    requestAnimationFrame(safeFit)
  }, [existingSession])

  useEffect(() => {
    if (!existingSession || sessionIdRef.current !== existingSession.id) return
    setSession(existingSession)
    if (sessionEnded(existingSession)) {
      renderSessionSnapshot(existingSession)
    }
  }, [existingSession])

  useEffect(() => {
    if (!hidden) {
      requestAnimationFrame(safeFit)
    }
  }, [hidden, spanRows, spanCols])

  useEffect(() => {
    if (existingSession || session) return
    api.environment.get()
      .then(result => setCwd(current => current || result.data.cwd))
      .catch(console.error)
  }, [existingSession, session])

  async function startSession() {
    if (starting || session) return
    setStarting(true)
    setError(null)
    terminalRef.current?.clear()
    safeWriteln(`Starting ${config.cli} ${config.model}...`)

    try {
      safeFit()
      const dimensions = fitAddonRef.current?.proposeDimensions()
      const result = await api.agentSessions.start({
        config,
        taskId,
        cwd: cwd.trim() || undefined,
        title,
        prompt: initialPrompt(config, title),
        cols: dimensions?.cols,
        rows: dimensions?.rows,
      })
      sessionIdRef.current = result.data.id
      setSession(result.data)
      onSessionStarted?.(result.data)
      ensureSocket()
      requestAnimationFrame(safeFit)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to start session'
      setError(message)
      safeWriteln(`\r\n${message}`)
    } finally {
      setStarting(false)
    }
  }

  async function terminateSession() {
    if (!sessionIdRef.current) return
    await api.agentSessions.terminate(sessionIdRef.current).catch(console.error)
    onSessionTerminated?.(sessionIdRef.current)
    sessionIdRef.current = null
    setSession(null)
    safeWriteln('\r\n[system] terminate requested')
  }

  function ensureSocket(): WebSocket {
    if (
      socketRef.current &&
      (socketRef.current.readyState === WebSocket.CONNECTING ||
        socketRef.current.readyState === WebSocket.OPEN)
    ) {
      if (socketRef.current.readyState === WebSocket.OPEN) {
        sendAttach(socketRef.current)
      }
      return socketRef.current
    }

    const socket = new WebSocket(socketUrl())
    socket.addEventListener('open', () => sendAttach(socket))
    socket.addEventListener('message', (event) => {
      const message = parseSocketMessage(event.data)
      if (!message || message.type !== 'output' || message.sessionId !== sessionIdRef.current) {
        return
      }
      safeWrite(message.data)
    })
    socketRef.current = socket
    return socket
  }

  function sendAttach(socket: WebSocket): void {
    const sessionId = sessionIdRef.current
    if (!sessionId || socket.readyState !== WebSocket.OPEN) return
    safeFit()
    const dimensions = fitAddonRef.current?.proposeDimensions()
    socket.send(JSON.stringify({
      type: 'attach',
      sessionId,
      cols: dimensions?.cols,
      rows: dimensions?.rows,
    }))
    attachSession(sessionId, false).catch(console.error)
  }

  async function attachSession(sessionId: string, hydrateTranscript: boolean): Promise<void> {
    if (attachedSessionIdsRef.current.has(sessionId)) return
    attachedSessionIdsRef.current.add(sessionId)
    safeFit()
    const dimensions = fitAddonRef.current?.proposeDimensions()
    const result = await api.agentSessions.attach(sessionId, {
      cols: dimensions?.cols,
      rows: dimensions?.rows,
    })
    if (hydrateTranscript) {
      hydrateTranscriptOnce(result.data)
    }
    setSession(result.data)
    onSessionStarted?.(result.data)
  }

  function sendTerminalMessage(message: { type: 'input'; data: string } | { type: 'resize'; cols: number; rows: number }) {
    const sessionId = sessionIdRef.current
    if (!sessionId) return
    const socket = ensureSocket()
    const serialized = JSON.stringify({ ...message, sessionId })
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(serialized)
      return
    }
    socket.addEventListener('open', () => socket.send(serialized), { once: true })
  }

  return (
    <div className={`${styles.panel} ${extra}`}>
      <div className={styles.header}>
        <span className={styles.title}>
          <span className={styles.agentId}>{session?.cli ?? config.cli}</span>
          <span className={styles.dot}> · </span>
          <span className={styles.taskTitle}>{session?.title ?? title}</span>
          {session && <span className={styles.sessionStatus}> {session.status}</span>}
        </span>
        <div className={styles.controls}>
          {!session && (
            <button className={styles.startCtrlBtn} onClick={startSession} disabled={starting}>
              {starting ? 'STARTING' : 'START'}
            </button>
          )}
          {session && <button className={styles.ctrlBtn} title="Kill session" onClick={terminateSession}>x</button>}
          <button className={styles.ctrlBtn} title="Fit terminal" onClick={() => fitAddonRef.current?.fit()}>[]</button>
        </div>
      </div>
      {!session && !existingSession && (
        <div className={styles.configBar}>
          <select
            className={styles.configSelect}
            value={selectedCli}
            title="CLI"
            onChange={event => {
              const cli = event.target.value as AgentCli
              setSelectedCli(cli)
              setSelectedModel(defaultModelForCli(cli))
            }}
          >
            <option value="codex">codex</option>
            <option value="claude">claude</option>
          </select>
          <select
            className={styles.configSelect}
            value={selectedModel}
            title="Model"
            onChange={event => setSelectedModel(event.target.value)}
          >
            {MODEL_OPTIONS[selectedCli].map(model => (
              <option key={model} value={model}>{model}</option>
            ))}
          </select>
          <select
            className={styles.configSelect}
            value={selectedEffort}
            title="Reasoning effort"
            onChange={event => setSelectedEffort(event.target.value as ReasoningEffort)}
          >
            {REASONING_EFFORTS.map(effort => (
              <option key={effort} value={effort}>{effort}</option>
            ))}
          </select>
          <input
            className={styles.cwdInput}
            value={cwd}
            title="Working directory"
            onChange={event => setCwd(event.target.value)}
          />
        </div>
      )}
      {error && <div className={styles.errorStrip}>{error}</div>}
      <div className={styles.xtermBody} ref={containerRef} />
    </div>
  )
}

function parseSocketMessage(raw: string): { type: string; sessionId: string; data: string } | null {
  try {
    return JSON.parse(raw) as { type: string; sessionId: string; data: string }
  } catch {
    return null
  }
}
