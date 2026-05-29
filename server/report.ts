import { createHash, randomBytes } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import type express from 'express'
import type { TaskRecord } from '../src/types.js'
import { appendTaskEvent } from './db.js'

export type ActionReportEvent = {
  type: 'ACTION_REPORT'
  taskId: string
  sessionId: string
  nodeRunId: string | null
  nodeId: string | null
  output: Record<string, unknown>
  receivedAt: string
}

export type AgentReportEvent = {
  type: 'AGENT_REPORT'
  sessionId: string
  title?: string
  output: Record<string, unknown>
  receivedAt: string
}

type ReportSession = {
  sessionId: string
  task?: TaskRecord
  title?: string
  nodeRunId?: string
  nodeId?: string
  tokenHash: string
}

const reportSessions = new Map<string, ReportSession>()
const actionReportEvents: Array<ActionReportEvent | AgentReportEvent> = []
let actionReportListener: ((event: ActionReportEvent) => Promise<void>) | null = null

export const tokenEnvVarForSession = (sessionId: string) =>
  `COVOILA_REPORT_TOKEN_${sessionId.replaceAll('-', '_').toUpperCase()}`

export function generateReportToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashReportToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function registerReportSession(input: {
  sessionId: string
  task?: TaskRecord
  title?: string
  nodeRunId?: string
  nodeId?: string
  rawToken: string
}): void {
  reportSessions.set(input.sessionId, {
    sessionId: input.sessionId,
    task: input.task,
    title: input.title,
    nodeRunId: input.nodeRunId,
    nodeId: input.nodeId,
    tokenHash: hashReportToken(input.rawToken),
  })
}

export function updateReportSessionContext(input: {
  sessionId: string
  task?: TaskRecord
  title?: string
  nodeRunId?: string
  nodeId?: string
}): boolean {
  const session = reportSessions.get(input.sessionId)
  if (!session) return false
  reportSessions.set(input.sessionId, {
    ...session,
    task: input.task,
    title: input.title,
    nodeRunId: input.nodeRunId,
    nodeId: input.nodeId,
  })
  return true
}

export function listActionReportEvents(): Array<ActionReportEvent | AgentReportEvent> {
  return [...actionReportEvents]
}

export function onActionReport(listener: (event: ActionReportEvent) => Promise<void>): void {
  actionReportListener = listener
}

function parseBearer(value: string | undefined): string | null {
  if (!value) return null
  const match = value.match(/^Bearer\s+(.+)$/i)
  return match?.[1] ?? null
}

function findReportSessionByToken(rawToken: string): ReportSession | null {
  const tokenHash = hashReportToken(rawToken)
  for (const session of reportSessions.values()) {
    if (session.tokenHash === tokenHash) {
      return session
    }
  }
  return null
}

function createReportMcpServer(session: ReportSession): McpServer {
  const server = new McpServer({
    name: 'covoila-report',
    version: '0.1.0',
  })

  server.registerTool(
    'report',
    {
      title: 'Report action result',
      description: 'Report structured output for the current Covoila agent action.',
      inputSchema: {
        payload: z.record(z.string(), z.unknown()),
      },
    },
    async ({ payload }) => {
      if (!session.task) {
        const event: AgentReportEvent = {
          type: 'AGENT_REPORT',
          sessionId: session.sessionId,
          title: session.title,
          output: payload,
          receivedAt: new Date().toISOString(),
        }
        actionReportEvents.push(event)
        await appendTaskEvent({
          type: event.type,
          payload: event,
        })

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ ok: true, event }, null, 2),
            },
          ],
        }
      }

      const event: ActionReportEvent = {
        type: 'ACTION_REPORT',
        taskId: session.task.id,
        sessionId: session.sessionId,
        nodeRunId: session.nodeRunId ?? null,
        nodeId: session.nodeId ?? null,
        output: payload,
        receivedAt: new Date().toISOString(),
      }
      actionReportEvents.push(event)
      await appendTaskEvent({
        taskId: event.taskId,
        type: event.type,
        payload: event,
        createdAt: event.receivedAt,
      })
      await actionReportListener?.(event)

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ok: true, event }, null, 2),
          },
        ],
      }
    },
  )

  return server
}

export async function handleReportMcpRequest(input: {
  req: express.Request
  res: express.Response
}): Promise<void> {
  const rawToken = parseBearer(input.req.headers.authorization)
  if (!rawToken) {
    input.res.status(401).json({ error: 'Missing bearer token' })
    return
  }

  const session = findReportSessionByToken(rawToken)
  if (!session) {
    input.res.status(401).json({ error: 'Invalid or expired bearer token' })
    return
  }

  const server = createReportMcpServer(session)
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  })
  await server.connect(transport)
  await transport.handleRequest(input.req, input.res, input.req.body)
}
