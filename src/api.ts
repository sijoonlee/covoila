import type { TaskRecord, AgentConfig, AgentSessionSnapshot } from './types'

async function get<T>(resource: string): Promise<T[]> {
  const res = await fetch(`/api/${resource}`)
  if (!res.ok) throw new Error(`GET /api/${resource} failed: ${res.status}`)
  const { data } = await res.json() as { data: T[] }
  return data
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`)
  return res.json() as Promise<T>
}

async function put<T>(resource: string, data: T[]): Promise<void> {
  const res = await fetch(`/api/${resource}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data }),
  })
  if (!res.ok) throw new Error(`PUT /api/${resource} failed: ${res.status}`)
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`POST ${url} failed: ${res.status}`)
  return res.json() as Promise<T>
}

async function deleteJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { method: 'DELETE' })
  if (!res.ok) throw new Error(`DELETE ${url} failed: ${res.status}`)
  return res.json() as Promise<T>
}

export const api = {
  environment: {
    get: () => getJson<{ data: { cwd: string } }>('/api/environment'),
  },
  workflow: {
    list: () => getJson<{ data: Array<{ filename: string; id: string; name: string }> }>('/api/workflows'),
    load: (filename: string) =>
      getJson<{ data: { filename: string; id: string; name: string; yaml: string; workflow: unknown } }>(
        `/api/workflows/${encodeURIComponent(filename)}`,
      ),
    save: async (yaml: string, filename?: string) => {
      const res = await fetch('/api/workflow', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, yaml }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `PUT /api/workflow failed: ${res.status}` })) as { error?: string }
        throw new Error(body.error ?? `PUT /api/workflow failed: ${res.status}`)
      }
      return res.json() as Promise<{ data: unknown }>
    },
  },
  orchestrator: {
    startRun: (body: { name: string; task: string; workflowFilename?: string; workDir?: string }) =>
      postJson<{
        data: {
          task: TaskRecord
          run: unknown
          dispatch: unknown
          session: AgentSessionSnapshot | null
        }
      }>('/api/orchestrator/runs', body),
  },
  tasks: {
    get: () => get<TaskRecord>('tasks'),
    put: (d: TaskRecord[]) => put('tasks', d),
    delete: (taskId: string) => deleteJson<{ ok: boolean }>(`/api/tasks/${taskId}`),
    stopAgentSessions: (taskId: string) =>
      postJson<{ data: TaskRecord }>(`/api/tasks/${taskId}/stop-agent-sessions`, {}),
  },
  agentConfigs: { get: () => get<AgentConfig>('agentConfigs'), put: (d: AgentConfig[]) => put('agentConfigs', d) },
  agentSessions: {
    get: () => get<AgentSessionSnapshot>('agent-sessions'),
    start: (body: {
      config: AgentConfig
      taskId?: string
      cwd?: string
      prompt: string
      title: string
      cols?: number
      rows?: number
    }) => postJson<{ data: AgentSessionSnapshot; tokenEnvVar?: string; mcpUrl?: string }>('/api/agent-sessions', body),
    attach: (sessionId: string, body: { cols?: number; rows?: number }) =>
      postJson<{ data: AgentSessionSnapshot }>(`/api/agent-sessions/${sessionId}/attach`, body),
    terminate: (sessionId: string) => deleteJson<{ ok: boolean }>(`/api/agent-sessions/${sessionId}`),
  },
}
