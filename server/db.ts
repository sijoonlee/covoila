import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { CONFIG_DIR, readData } from './storage.js'
import { mockTasks } from '../src/mockData.js'
import type { TaskRecord } from '../src/types.js'

const DB_PATH = path.join(CONFIG_DIR, 'covoila.db')

type TaskRow = {
  id: string
  name: string
  work_dir: string
  task_tmp_dir: string
  status: TaskRecord['status']
  created_at: string
  workflow_snapshot_json: string
  memory_json: string
  agent_sessions_json: string
}

type TaskEventRow = {
  id: string
  task_id: string | null
  type: string
  payload_json: string
  created_at: string
}

export type TaskEventRecord = {
  id: string
  taskId: string | null
  type: string
  payload: unknown
  createdAt: string
}

let db: DatabaseSync | null = null
const taskUpdateListeners = new Set<(task: TaskRecord) => void>()

export function onTaskUpdated(listener: (task: TaskRecord) => void): () => void {
  taskUpdateListeners.add(listener)
  return () => {
    taskUpdateListeners.delete(listener)
  }
}

export async function initTaskDatabase(): Promise<void> {
  const firstOpen = !existsSync(DB_PATH)
  const database = getDb()

  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      work_dir TEXT NOT NULL,
      task_tmp_dir TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      workflow_snapshot_json TEXT NOT NULL,
      memory_json TEXT NOT NULL,
      agent_sessions_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_events (
      id TEXT PRIMARY KEY,
      task_id TEXT,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_task_events_task_id_created_at
      ON task_events(task_id, created_at);
  `)

  dropLegacyNodeIndexColumn(database)
  await migrateTasksJsonIfNeeded(firstOpen)
}

export async function listTasks(): Promise<TaskRecord[]> {
  const rows = getDb()
    .prepare('SELECT * FROM tasks ORDER BY created_at ASC')
    .all() as TaskRow[]
  return rows.map(taskFromRow)
}

export async function getTask(id: string): Promise<TaskRecord | null> {
  const row = getDb()
    .prepare('SELECT * FROM tasks WHERE id = ?')
    .get(id) as TaskRow | undefined
  return row ? taskFromRow(row) : null
}

export async function createTask(task: TaskRecord): Promise<void> {
  upsertTask(task)
  emitTaskUpdated(task)
}

export async function updateTask(
  id: string,
  updater: (task: TaskRecord) => TaskRecord,
): Promise<TaskRecord | null> {
  const existing = await getTask(id)
  if (!existing) return null
  const next = updater(existing)
  upsertTask(next)
  emitTaskUpdated(next)
  return next
}

export async function deleteTask(id: string): Promise<boolean> {
  const result = getDb()
    .prepare('DELETE FROM tasks WHERE id = ?')
    .run(id)
  return result.changes > 0
}

export async function replaceTasks(tasks: TaskRecord[]): Promise<void> {
  const database = getDb()
  const existingRows = database.prepare('SELECT id FROM tasks').all() as Array<{ id: string }>
  const nextIds = new Set(tasks.map(task => task.id))

  database.exec('BEGIN IMMEDIATE')
  try {
    for (const row of existingRows) {
      if (!nextIds.has(row.id)) {
        database.prepare('DELETE FROM tasks WHERE id = ?').run(row.id)
      }
    }
    for (const task of tasks) {
      upsertTask(task)
    }
    database.exec('COMMIT')
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }

  for (const task of tasks) {
    emitTaskUpdated(task)
  }
}

export async function appendTaskEvent(input: {
  taskId?: string | null
  type: string
  payload: unknown
  createdAt?: string
}): Promise<TaskEventRecord> {
  const event: TaskEventRecord = {
    id: `event_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    taskId: input.taskId ?? null,
    type: input.type,
    payload: input.payload,
    createdAt: input.createdAt ?? new Date().toISOString(),
  }

  getDb()
    .prepare(`
      INSERT INTO task_events (id, task_id, type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `)
    .run(event.id, event.taskId, event.type, JSON.stringify(event.payload), event.createdAt)

  return event
}

export async function listTaskEvents(taskId?: string): Promise<TaskEventRecord[]> {
  const statement = taskId
    ? getDb().prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at ASC')
    : getDb().prepare('SELECT * FROM task_events ORDER BY created_at ASC')
  const rows = (taskId ? statement.all(taskId) : statement.all()) as TaskEventRow[]
  return rows.map(eventFromRow)
}

function getDb(): DatabaseSync {
  db ??= new DatabaseSync(DB_PATH)
  return db
}

function dropLegacyNodeIndexColumn(database: DatabaseSync): void {
  const columns = database.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>
  if (!columns.some(column => column.name === 'node_index')) return
  database.exec('ALTER TABLE tasks DROP COLUMN node_index')
}

async function migrateTasksJsonIfNeeded(firstOpen: boolean): Promise<void> {
  const count = getDb().prepare('SELECT COUNT(*) AS count FROM tasks').get() as { count: number }
  if (!firstOpen && count.count > 0) return

  const tasks = await readData<TaskRecord[]>('tasks', mockTasks)
  if (tasks.length === 0) return

  for (const task of tasks) {
    upsertTask(task)
  }
}

function upsertTask(task: TaskRecord): void {
  const now = new Date().toISOString()
  getDb()
    .prepare(`
      INSERT INTO tasks (
        id,
        name,
        work_dir,
        task_tmp_dir,
        status,
        created_at,
        workflow_snapshot_json,
        memory_json,
        agent_sessions_json,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        work_dir = excluded.work_dir,
        task_tmp_dir = excluded.task_tmp_dir,
        status = excluded.status,
        created_at = excluded.created_at,
        workflow_snapshot_json = excluded.workflow_snapshot_json,
        memory_json = excluded.memory_json,
        agent_sessions_json = excluded.agent_sessions_json,
        updated_at = excluded.updated_at
    `)
    .run(
      task.id,
      task.name,
      task.workDir,
      task.taskTmpDir,
      task.status,
      task.createdAt,
      JSON.stringify(task.workflowSnapshot),
      JSON.stringify(task.memory),
      JSON.stringify(task.agentSessions),
      now,
    )
}

function emitTaskUpdated(task: TaskRecord): void {
  for (const listener of taskUpdateListeners) {
    listener(task)
  }
}

function taskFromRow(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    name: row.name,
    workDir: row.work_dir,
    taskTmpDir: row.task_tmp_dir,
    status: row.status,
    createdAt: row.created_at,
    workflowSnapshot: JSON.parse(row.workflow_snapshot_json) as TaskRecord['workflowSnapshot'],
    memory: JSON.parse(row.memory_json) as TaskRecord['memory'],
    agentSessions: JSON.parse(row.agent_sessions_json) as TaskRecord['agentSessions'],
  }
}

function eventFromRow(row: TaskEventRow): TaskEventRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    type: row.type,
    payload: JSON.parse(row.payload_json) as unknown,
    createdAt: row.created_at,
  }
}
