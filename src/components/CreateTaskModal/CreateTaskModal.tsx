import { useEffect, useState } from 'react'
import { api } from '../../api'
import type { AgentSessionSnapshot, TaskRecord } from '../../types'
import styles from './CreateTaskModal.module.css'

type WorkflowFileSummary = {
  filename: string
  id: string
  name: string
}

type Props = {
  onCreated: (task: TaskRecord, session?: AgentSessionSnapshot | null) => void
  onCancel: () => void
}

export default function CreateTaskModal({ onCreated, onCancel }: Props) {
  const [taskText, setTaskText] = useState('')
  const [workDir, setWorkDir] = useState('')
  const [workflows, setWorkflows] = useState<WorkflowFileSummary[]>([])
  const [workflowFilename, setWorkflowFilename] = useState('')
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.environment.get()
      .then(result => setWorkDir(current => current || result.data.cwd))
      .catch(console.error)
    api.workflow.list()
      .then(result => {
        setWorkflows(result.data)
        setWorkflowFilename(current => current || result.data[0]?.filename || '')
      })
      .catch(error => setError(error instanceof Error ? error.message : 'Failed to load workflows'))
  }, [])

  async function startTask() {
    const task = taskText.trim()
    if (!task || starting) return

    setStarting(true)
    setError(null)
    try {
      const result = await api.orchestrator.startRun({
        name: 'Coding',
        task,
        workflowFilename: workflowFilename || undefined,
        workDir: workDir.trim() || undefined,
      })
      onCreated(result.data.task, result.data.session)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start task')
    } finally {
      setStarting(false)
    }
  }

  return (
    <div className={styles.overlay}>
      <div className={styles.modal}>
        <div className={styles.header}>
          <span className={styles.title}>CREATE TASK</span>
          <button className={styles.closeBtn} onClick={onCancel}>x</button>
        </div>
        <div className={styles.body}>
          <label className={styles.label}>WORKFLOW</label>
          <select
            className={styles.select}
            value={workflowFilename}
            onChange={event => setWorkflowFilename(event.target.value)}
          >
            {workflows.length === 0 && <option value="">No workflows found</option>}
            {workflows.map(workflow => (
              <option value={workflow.filename} key={workflow.filename}>
                {workflow.name} ({workflow.filename})
              </option>
            ))}
          </select>
          <label className={styles.label}>TASK</label>
          <textarea
            className={styles.textarea}
            value={taskText}
            onChange={event => setTaskText(event.target.value)}
            placeholder="Describe what the agents should build or change."
            autoFocus
          />
          <label className={styles.label}>WORK DIR</label>
          <input
            className={styles.input}
            value={workDir}
            onChange={event => setWorkDir(event.target.value)}
            placeholder="Defaults to this Covoila project directory"
          />
          {error && <div className={styles.error}>{error}</div>}
        </div>
        <div className={styles.footer}>
          <button className={styles.cancelBtn} onClick={onCancel} disabled={starting}>CANCEL</button>
          <button className={styles.createBtn} onClick={startTask} disabled={!taskText.trim() || !workflowFilename || starting}>
            {starting ? 'STARTING' : 'START'}
          </button>
        </div>
      </div>
    </div>
  )
}
