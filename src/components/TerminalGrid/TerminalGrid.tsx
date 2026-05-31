import { useEffect, useState } from 'react'
import type { AgentConfig, AgentSessionSnapshot, Layout } from '../../types'
import { LAYOUT_SLOTS } from '../../mockData'
import AgentTerminalPanel from '../TerminalPanel/AgentTerminalPanel'
import styles from './TerminalGrid.module.css'

const LAYOUT_CLASS: Record<Layout, string> = {
  single:   styles.layoutSingle,
  '2col':   styles.layout2col,
  '2row':   styles.layout2row,
  '2x2':    styles.layout2x2,
}

type Props = {
  layout: Layout
  agentConfigs: AgentConfig[]
  sessions?: AgentSessionSnapshot[]
  activeTaskId?: string | null
  activeScreenIndex?: number
  attentionSessionIds?: Set<string>
  title?: string
  onHumanAttentionCleared?: (sessionId: string) => void
  onSessionStarted?: (session: AgentSessionSnapshot) => void
  onSessionTerminated?: (sessionId: string) => void
}

export default function TerminalGrid({
  layout,
  agentConfigs,
  sessions = [],
  activeTaskId = null,
  activeScreenIndex = 0,
  attentionSessionIds = new Set(),
  title = 'Playground',
  onHumanAttentionCleared,
  onSessionStarted,
  onSessionTerminated,
}: Props) {
  const [mountedTaskSessionIds, setMountedTaskSessionIds] = useState<Set<string>>(() => new Set())
  const slotCount = LAYOUT_SLOTS[layout]
  const taskSessions = sessions.filter(session => session.taskId)
  const activeTaskSessions = activeTaskId
    ? taskSessions
      .filter(session => session.taskId === activeTaskId)
      .slice()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    : []
  const screenStart = activeScreenIndex * slotCount
  const visibleTaskSessions = activeTaskSessions.slice(screenStart, screenStart + slotCount)
  const activeTaskSessionKey = activeTaskSessions.map(session => session.id).join('|')
  const visibleTaskSlotById = new Map(visibleTaskSessions.map((session, index) => [session.id, index]))
  const taskSlotById = new Map<string, number>()
  const nextSlotByTaskId = new Map<string, number>()
  for (const session of taskSessions) {
    const taskId = session.taskId
    if (!taskId) continue
    const slot = nextSlotByTaskId.get(taskId) ?? 0
    taskSlotById.set(session.id, slot)
    nextSlotByTaskId.set(taskId, slot + 1)
  }
  const playgroundSlots = Array.from({ length: 4 }, (_, i) => i)

  useEffect(() => {
    if (activeTaskSessions.length === 0) return
    setMountedTaskSessionIds(current => {
      const next = new Set(current)
      for (const session of activeTaskSessions) {
        next.add(session.id)
      }
      return next
    })
  }, [activeTaskSessionKey])

  return (
    <div className={`${styles.grid} ${LAYOUT_CLASS[layout]}`}>
      {playgroundSlots.map((slot) => {
        const hidden = activeTaskId !== null || slot >= slotCount
        return (
          <AgentTerminalPanel
            key={`terminal-slot-playground-${slot}`}
            agentConfigs={agentConfigs}
            slotIndex={slot}
            title={`${title} CLI ${slot + 1}`}
            hidden={hidden}
            needsHumanAttention={false}
            onSessionStarted={onSessionStarted}
            onSessionTerminated={onSessionTerminated}
          />
        )
      })}
      {taskSessions.filter(session => mountedTaskSessionIds.has(session.id)).map((session) => {
        const visibleSlot = visibleTaskSlotById.get(session.id) ?? -1
        const stableSlot = taskSlotById.get(session.id) ?? 0
        const hidden = activeTaskId === null || session.taskId !== activeTaskId || visibleSlot < 0
        return (
          <AgentTerminalPanel
            key={session.id}
            agentConfigs={agentConfigs}
            existingSession={session}
            slotIndex={stableSlot}
            title={session.title}
            emptyMessage="Waiting for agent output."
            hidden={hidden}
            needsHumanAttention={attentionSessionIds.has(session.id)}
            onHumanAttentionCleared={onHumanAttentionCleared}
            onSessionStarted={onSessionStarted}
            onSessionTerminated={onSessionTerminated}
          />
        )
      })}
    </div>
  )
}
