import fs from 'node:fs/promises'
import path from 'node:path'

export type WorkflowJsonlEventKind =
  | 'run'
  | 'prompt'
  | 'message'
  | 'report'
  | 'transition'
  | 'artifact'
  | 'gate'
  | 'error'

export type WorkflowJsonlEvent = {
  time?: string
  runId: string
  taskId: string
  step: string
  who: string
  kind: WorkflowJsonlEventKind
  message: string
  data?: Record<string, unknown>
}

export type WorkflowJsonlSessionContext = {
  runId: string
  taskId: string
  taskTmpDir: string
  step: string
  who: string
}

const sessionContexts = new Map<string, WorkflowJsonlSessionContext>()

export function setWorkflowJsonlSessionContext(
  sessionId: string,
  context: WorkflowJsonlSessionContext,
): void {
  sessionContexts.set(sessionId, context)
}

export function clearWorkflowJsonlSessionContext(sessionId: string): void {
  sessionContexts.delete(sessionId)
}

export async function appendWorkflowJsonlEvent(
  taskTmpDir: string,
  input: WorkflowJsonlEvent,
): Promise<void> {
  await fs.mkdir(taskTmpDir, { recursive: true })
  const event = {
    ...input,
    time: input.time ?? new Date().toISOString(),
  }
  await fs.appendFile(
    path.join(taskTmpDir, 'events.jsonl'),
    `${JSON.stringify(event)}\n`,
    'utf-8',
  )
}

export async function appendWorkflowJsonlSessionOutput(input: {
  sessionId: string
  data: string
}): Promise<void> {
  const context = sessionContexts.get(input.sessionId)
  if (!context) return

  await appendWorkflowJsonlEvent(context.taskTmpDir, {
    runId: context.runId,
    taskId: context.taskId,
    step: context.step,
    who: context.who,
    kind: 'message',
    message: input.data,
    data: {
      sessionId: input.sessionId,
    },
  })
}
