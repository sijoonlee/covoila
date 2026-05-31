import { type Dispatch, type SetStateAction, useCallback, useEffect, useState } from 'react'
import type { AppView, Layout, TaskRecord, AgentConfig, AgentSessionSnapshot, TaskStatus } from './types'
import { api } from './api'
import { LAYOUT_SLOTS } from './mockData'
import Header from './components/Header/Header'
import TerminalGrid from './components/TerminalGrid/TerminalGrid'
import CreateTaskModal from './components/CreateTaskModal/CreateTaskModal'
import WorkflowEditor from './components/WorkflowEditor/WorkflowEditor'
import styles from './App.module.css'

export default function App() {
  const [activeView, setActiveView] = useState<AppView>('tasks')
  const [layout, setLayout] = useState<Layout>('single')
  const [tasks, setTasks] = useState<TaskRecord[]>([])
  const [agentConfigs, setAgentConfigs] = useState<AgentConfig[]>([])
  const [agentSessions, setAgentSessions] = useState<AgentSessionSnapshot[]>([])
  const [createTaskOpen, setCreateTaskOpen] = useState(false)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [taskRailCollapsed, setTaskRailCollapsed] = useState(false)
  const [activeScreenIndex, setActiveScreenIndex] = useState(0)
  const [dismissedHumanAttention, setDismissedHumanAttention] = useState<Set<string>>(() => new Set())

  const refreshTasks = useCallback(async () => {
    const next = await api.tasks.get()
    setTasks(next)
    return next
  }, [])

  useEffect(() => {
    refreshTasks().catch(console.error)
    api.agentSessions.get().then(setAgentSessions).catch(console.error)
    api.agentConfigs.get().then(setAgentConfigs).catch(console.error)
  }, [refreshTasks])

  useEffect(() => {
    let socket: WebSocket | null = null
    let reconnectTimer: number | null = null
    let cancelled = false

    function connect() {
      if (cancelled) return
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const host = window.location.port === '4318'
        ? `${window.location.hostname}:3001`
        : window.location.host
      socket = new WebSocket(`${protocol}//${host}/task-events`)

      socket.addEventListener('message', (event) => {
        const message = parseTaskEventMessage(event.data)
        if (message?.type === 'task.updated') {
          const updated = message.task
          setTasks(current => {
            const idx = current.findIndex(task => task.id === updated.id)
            if (idx === -1) return [...current, updated]
            const next = current.slice()
            next[idx] = updated
            return next
          })
        } else if (message?.type === 'session.updated') {
          upsertAgentSession(message.session, setAgentSessions)
        }
      })

      socket.addEventListener('close', () => {
        socket = null
        if (cancelled) return
        reconnectTimer = window.setTimeout(connect, 1000)
      })
    }

    connect()

    return () => {
      cancelled = true
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer)
      socket?.close()
    }
  }, [])

  function handleTaskCreated(task: TaskRecord, session?: AgentSessionSnapshot | null) {
    setCreateTaskOpen(false)
    setSelectedTaskId(task.id)
    setActiveScreenIndex(0)
    setTasks(current => {
      const idx = current.findIndex(item => item.id === task.id)
      if (idx === -1) return [...current, task]
      const next = current.slice()
      next[idx] = task
      return next
    })
    if (session) {
      upsertAgentSession(session, setAgentSessions)
    }
    refreshTasks().catch(console.error)
  }

  function handleSessionStarted(session: AgentSessionSnapshot) {
    upsertAgentSession(session, setAgentSessions)
  }

  function handleSessionTerminated(sessionId: string) {
    setAgentSessions(current => current.map(session =>
      session.id === sessionId ? { ...session, status: 'exited' } : session,
    ))
  }

  async function stopTaskSessions(taskId: string): Promise<void> {
    const result = await api.tasks.stopAgentSessions(taskId)
    setTasks(current => current.map(task => task.id === taskId ? result.data : task))
    setAgentSessions(current => current.map(session =>
      session.taskId === taskId && session.status !== 'exited' && session.status !== 'failed'
        ? { ...session, status: 'exited' }
        : session,
    ))
  }

  async function handleStopTaskSessions(taskId: string) {
    try {
      await stopTaskSessions(taskId)
    } catch (error) {
      console.error(error)
    }
  }

  async function handleDeleteTask(taskId: string) {
    try {
      await stopTaskSessions(taskId)
      await api.tasks.delete(taskId)
      setTasks(current => current.filter(task => task.id !== taskId))
      setSelectedTaskId(current => current === taskId ? null : current)
    } catch (error) {
      console.error(error)
    }
  }

  const selectedTaskSessions = selectedTaskId
    ? sessionsForTask(agentSessions, selectedTaskId)
    : []
  const selectedTask = selectedTaskId
    ? tasks.find(task => task.id === selectedTaskId) ?? null
    : null
  const humanAttentionSessionIds = selectedTask
    ? humanAttentionSessionsForTask(selectedTask)
        .filter(sessionKey => !dismissedHumanAttention.has(sessionKey))
        .map(sessionKey => sessionKey.split(':')[0])
    : []
  const humanAttentionSessionIdSet = new Set(humanAttentionSessionIds)
  const screenSize = LAYOUT_SLOTS[layout]
  const screenCount = selectedTaskId
    ? Math.max(1, Math.ceil(selectedTaskSessions.length / screenSize))
    : 1

  useEffect(() => {
    setActiveScreenIndex(current => Math.min(current, screenCount - 1))
  }, [screenCount])

  useEffect(() => {
    setActiveScreenIndex(0)
  }, [selectedTaskId])

  function handleHumanAttentionCleared(sessionId: string) {
    setDismissedHumanAttention(current => {
      const next = new Set(current)
      for (const key of humanAttentionSessionsForTasks(tasks)) {
        if (key.startsWith(`${sessionId}:`)) {
          next.add(key)
        }
      }
      return next
    })
  }

  return (
    <div className={styles.app}>
      <Header
        activeView={activeView}
        layout={layout}
        onViewChange={setActiveView}
        onLayoutChange={setLayout}
      />
      <main className={styles.main}>
        {activeView === 'workflow' ? (
          <WorkflowEditor />
        ) : (
          <div className={styles.workspace}>
            <TaskRail
              tasks={tasks}
              sessions={agentSessions}
              selectedTaskId={selectedTaskId}
              collapsed={taskRailCollapsed}
              onSelect={setSelectedTaskId}
              onToggleCollapsed={() => setTaskRailCollapsed(value => !value)}
              onCreateTask={() => setCreateTaskOpen(true)}
              onStopTaskSessions={handleStopTaskSessions}
              onDeleteTask={handleDeleteTask}
            />
            <section className={styles.terminalWorkspace}>
              <div className={styles.workspaceHeader}>
                <div>
                  <div className={styles.workspaceTitle}>
                    {selectedTaskId ? tasks.find(task => task.id === selectedTaskId)?.name ?? 'Task' : 'Playground'}
                  </div>
                  <div className={styles.workspaceMeta}>
                    {selectedTaskId
                      ? `${taskSessionCount(agentSessions, selectedTaskId)} live agent${taskSessionCount(agentSessions, selectedTaskId) === 1 ? '' : 's'}`
                      : 'Task-free agent terminals'}
                  </div>
                </div>
                {selectedTaskId && screenCount > 1 && (
                  <ScreenTabs
                    sessions={selectedTaskSessions}
                    screenSize={screenSize}
                    activeScreenIndex={activeScreenIndex}
                    onSelect={setActiveScreenIndex}
                  />
                )}
              </div>
              <TerminalGrid
                layout={layout}
                agentConfigs={agentConfigs}
                sessions={agentSessions}
                activeTaskId={selectedTaskId}
                activeScreenIndex={activeScreenIndex}
                attentionSessionIds={humanAttentionSessionIdSet}
                onHumanAttentionCleared={handleHumanAttentionCleared}
                onSessionStarted={handleSessionStarted}
                onSessionTerminated={handleSessionTerminated}
              />
            </section>
          </div>
        )}
      </main>

      {createTaskOpen && (
        <CreateTaskModal
          onCreated={handleTaskCreated}
          onCancel={() => setCreateTaskOpen(false)}
        />
      )}
    </div>
  )
}

function taskSessionCount(sessions: AgentSessionSnapshot[], taskId: string): number {
  return sessions.filter(session => session.taskId === taskId && session.status !== 'exited' && session.status !== 'failed').length
}

function sessionsForTask(sessions: AgentSessionSnapshot[], taskId: string): AgentSessionSnapshot[] {
  return sessions
    .filter(session => session.taskId === taskId)
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

function humanAttentionSessionsForTasks(tasks: TaskRecord[]): string[] {
  return tasks.flatMap(humanAttentionSessionsForTask)
}

function humanAttentionSessionsForTask(task: TaskRecord): string[] {
  const run = task.memory.orchestratorRun as {
    agentSessions?: Record<string, string>
  } | undefined
  if (!run?.agentSessions) return []

  return Object.entries(task.agentSessions).flatMap(([agentName, state]) => {
    if (!state.needsHumanAttention) return []
    const sessionId = run.agentSessions?.[agentName]
    if (!sessionId) return []
    return [`${sessionId}:${state.humanAttentionAt ?? ''}`]
  })
}

function ScreenTabs({
  sessions,
  screenSize,
  activeScreenIndex,
  onSelect,
}: {
  sessions: AgentSessionSnapshot[]
  screenSize: number
  activeScreenIndex: number
  onSelect: (screenIndex: number) => void
}) {
  const screenCount = Math.ceil(sessions.length / screenSize)
  return (
    <div className={styles.screenTabs} role="tablist" aria-label="Terminal screens">
      {Array.from({ length: screenCount }, (_, screenIndex) => {
        const screenSessions = sessions.slice(screenIndex * screenSize, (screenIndex + 1) * screenSize)
        const label = `Screen ${screenIndex + 1}`
        const names = screenSessions.map(session => agentSessionLabel(session)).join(', ')
        const activeCount = screenSessions.filter(session => session.status !== 'exited' && session.status !== 'failed').length
        return (
          <button
            key={screenIndex}
            type="button"
            role="tab"
            aria-selected={activeScreenIndex === screenIndex}
            className={`${styles.screenTab} ${activeScreenIndex === screenIndex ? styles.screenTabActive : ''}`}
            onClick={() => onSelect(screenIndex)}
            title={names}
          >
            <span className={styles.screenTabLabel}>{label}</span>
            <span className={styles.screenTabMeta}>{activeCount}/{screenSessions.length}</span>
          </button>
        )
      })}
    </div>
  )
}

function agentSessionLabel(session: AgentSessionSnapshot): string {
  return session.agentInstanceId || session.title || session.id
}

function statusClass(status: TaskStatus): string {
  if (status === 'RUNNING') return styles.statusRunning
  if (status === 'BLOCKED') return styles.statusBlocked
  if (status === 'DONE') return styles.statusDone
  if (status === 'FAILED') return styles.statusFailed
  if (status === 'STOPPED') return styles.statusStopped
  return ''
}

function TaskRail({
  tasks,
  sessions,
  selectedTaskId,
  collapsed,
  onSelect,
  onToggleCollapsed,
  onCreateTask,
  onStopTaskSessions,
  onDeleteTask,
}: {
  tasks: TaskRecord[]
  sessions: AgentSessionSnapshot[]
  selectedTaskId: string | null
  collapsed: boolean
  onSelect: (taskId: string | null) => void
  onToggleCollapsed: () => void
  onCreateTask: () => void
  onStopTaskSessions: (taskId: string) => void
  onDeleteTask: (taskId: string) => void
}) {
  return (
    <aside className={`${styles.taskRail} ${collapsed ? styles.taskRailCollapsed : ''}`}>
      <div className={styles.taskRailHeader}>
        {!collapsed && <span>TASKS</span>}
        <button className={styles.railIconBtn} onClick={onToggleCollapsed} title={collapsed ? 'Expand tasks' : 'Collapse tasks'}>
          {collapsed ? '>' : '<'}
        </button>
      </div>
      <button
        className={`${styles.taskTab} ${selectedTaskId === null ? styles.taskTabActive : ''}`}
        onClick={() => onSelect(null)}
        title="Playground"
      >
        <span className={styles.taskTabName}>{collapsed ? 'P' : 'Playground'}</span>
        {!collapsed && <span className={styles.taskTabMeta}>local terminals</span>}
      </button>
      <div className={styles.taskTabList}>
        {tasks.map((task, index) => {
          const count = taskSessionCount(sessions, task.id)
          const hasActiveSessions = count > 0
          const displayName = taskDisplayName(task)
          return (
            <div
              key={task.id}
              role="button"
              tabIndex={0}
              className={`${styles.taskTab} ${selectedTaskId === task.id ? styles.taskTabActive : ''}`}
              onClick={() => onSelect(task.id)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                onSelect(task.id)
              }}
              title={displayName}
            >
              <div className={styles.taskTabName}>
                {collapsed ? shortTaskLabel(displayName, index) : displayName}
              </div>
              {!collapsed && (
                <div className={styles.taskActions}>
                  <button
                    type="button"
                    className={styles.taskActionBtn}
                    title={hasActiveSessions ? `Stop active agents for ${displayName}` : `No active agents for ${displayName}`}
                    disabled={!hasActiveSessions}
                    onClick={(event) => {
                      event.stopPropagation()
                      onStopTaskSessions(task.id)
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return
                      event.preventDefault()
                      event.stopPropagation()
                      onStopTaskSessions(task.id)
                    }}
                  >
                    ■
                  </button>
                  <button
                    type="button"
                    className={styles.taskActionBtn}
                    title={`Delete ${displayName}`}
                    onClick={(event) => {
                      event.stopPropagation()
                      onDeleteTask(task.id)
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return
                      event.preventDefault()
                      event.stopPropagation()
                      onDeleteTask(task.id)
                    }}
                  >
                    x
                  </button>
                </div>
              )}
              {!collapsed && (
                <span className={styles.taskTabMeta}>
                  <span className={statusClass(task.status)}>{task.status}</span>
                  <span>{count} agent{count === 1 ? '' : 's'}</span>
                </span>
              )}
            </div>
          )
        })}
      </div>
      {!collapsed && (
        <button className={styles.createTaskBtn} onClick={onCreateTask}>
          + TASK
        </button>
      )}
    </aside>
  )
}

function taskDisplayName(task: TaskRecord): string {
  const title = (task as TaskRecord & { title?: unknown }).title
  const candidates = [
    task.name,
    typeof title === 'string' ? title : '',
    task.workflowSnapshot.id,
    nameFromTmpDir(task.taskTmpDir),
    task.id,
  ]
  return candidates.map(value => value.trim()).find(Boolean) ?? 'Untitled task'
}

function shortTaskLabel(name: string, index: number): string {
  const trimmed = name.trim()
  if (!trimmed) return String(index + 1)
  return trimmed.slice(0, 2).toUpperCase()
}

type TaskEventMessage =
  | { type: 'task.updated'; task: TaskRecord }
  | { type: 'session.updated'; session: AgentSessionSnapshot }

function parseTaskEventMessage(raw: unknown): TaskEventMessage | null {
  if (typeof raw !== 'string') return null
  try {
    const parsed = JSON.parse(raw) as { type?: unknown; task?: unknown; session?: unknown }
    if (parsed.type === 'task.updated' && parsed.task) {
      return { type: 'task.updated', task: parsed.task as TaskRecord }
    }
    if (parsed.type === 'session.updated' && parsed.session) {
      return { type: 'session.updated', session: parsed.session as AgentSessionSnapshot }
    }
    return null
  } catch {
    return null
  }
}

function upsertAgentSession(
  session: AgentSessionSnapshot,
  setAgentSessions: Dispatch<SetStateAction<AgentSessionSnapshot[]>>,
): void {
  setAgentSessions(current => {
    if (current.some(item => item.id === session.id)) {
      return current.map(item => item.id === session.id ? session : item)
    }
    return [...current, session]
  })
}

function nameFromTmpDir(taskTmpDir: string): string {
  const parts = taskTmpDir.split('/').filter(Boolean)
  const last = parts[parts.length - 1] ?? ''
  return last.replace(/-\d{8}-\d{6}-[a-z]+$/, '').replace(/-/g, ' ')
}
