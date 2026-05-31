import fs from 'node:fs/promises'
import path from 'node:path'

import type { AgentCli, ReasoningEffort } from '../src/types.js'

export const WORKFLOW_DIR = path.join(process.cwd(), 'workflows')
export const DEFAULT_WORKFLOW_PATH = path.join(WORKFLOW_DIR, 'multi-agents-coding-flow.yaml')

export type WorkflowAgent = {
  cli: AgentCli
  model: string
  reasoningEffort?: ReasoningEffort
  role: string
}

export type ReportVerb = 'talk' | 'broadcast' | 'done' | 'failed'

export type WorkflowTransition = {
  verb: ReportVerb
  target?: string
  prompt?: string
  requireArtifacts?: string[]
  increment?: string
  max?: number
  exceeded?: string
  next: string
}

export type WorkflowWait = {
  from: string
  on: WorkflowTransition[]
}

export type WorkflowState = {
  prompt?: string
  wait?: WorkflowWait
  final?: boolean
  status?: string
}

export type WorkflowDefinition = {
  id: string
  name: string
  agents: Record<string, WorkflowAgent>
  limits: Record<string, number>
  sharedContext: string
  stateMachine: {
    initial: string
    states: Record<string, WorkflowState>
  }
  prompts: Record<string, string>
}

export type WorkflowFileSummary = {
  filename: string
  id: string
  name: string
}

const HUMAN_TARGET = 'HUMAN'

export type LoadedWorkflowFile = WorkflowFileSummary & {
  yaml: string
  workflow: WorkflowDefinition
}

type ParsedYaml = Record<string, unknown>

type Line = {
  indent: number
  text: string
  raw: string
}

export async function loadWorkflowDefinition(filePath = DEFAULT_WORKFLOW_PATH): Promise<WorkflowDefinition> {
  const raw = await fs.readFile(filePath, 'utf-8')
  return parseWorkflowDefinition(raw)
}

export async function loadInitialWorkflowFile(): Promise<LoadedWorkflowFile | null> {
  try {
    return await loadWorkflowFile(path.basename(DEFAULT_WORKFLOW_PATH))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const files = await listWorkflowFiles()
  if (files.length === 0) return null
  return loadWorkflowFile(files[0].filename)
}

export async function listWorkflowFiles(): Promise<WorkflowFileSummary[]> {
  await fs.mkdir(WORKFLOW_DIR, { recursive: true })
  const filenames = (await fs.readdir(WORKFLOW_DIR))
    .filter(filename => /\.ya?ml$/i.test(filename))
    .sort((a, b) => a.localeCompare(b))
  const summaries: WorkflowFileSummary[] = []

  for (const filename of filenames) {
    try {
      const raw = await fs.readFile(workflowPathForFilename(filename), 'utf-8')
      const workflow = parseWorkflowDefinition(raw)
      summaries.push({ filename, id: workflow.id, name: workflow.name })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
  }

  return summaries
}

export async function loadWorkflowFile(filename: string): Promise<LoadedWorkflowFile> {
  const safeFilename = workflowFilename(filename)
  const yaml = await fs.readFile(workflowPathForFilename(safeFilename), 'utf-8')
  const workflow = parseWorkflowDefinition(yaml)
  return {
    filename: safeFilename,
    id: workflow.id,
    name: workflow.name,
    yaml,
    workflow,
  }
}

export async function saveWorkflowDefinitionYaml(
  raw: string,
  filePath = DEFAULT_WORKFLOW_PATH,
): Promise<WorkflowDefinition> {
  const workflow = parseWorkflowDefinition(raw)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const normalized = raw.endsWith('\n') ? raw : `${raw}\n`
  const tmp = `${filePath}.tmp`
  await fs.writeFile(tmp, normalized, 'utf-8')
  await fs.rename(tmp, filePath)
  return workflow
}

export function workflowPathForFilename(filename: string): string {
  return path.join(WORKFLOW_DIR, workflowFilename(filename))
}

function workflowFilename(filename: string): string {
  if (path.basename(filename) !== filename || !/^[A-Za-z0-9._-]+\.ya?ml$/.test(filename)) {
    throw new Error(`Invalid workflow filename: ${filename}`)
  }
  return filename
}

export function parseWorkflowDefinition(raw: string): WorkflowDefinition {
  const parsed = parseYamlSubset(raw)
  return validateWorkflowDefinition(parsed)
}

export function parseYamlSubset(raw: string): ParsedYaml {
  const lines = raw
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line): Line => ({
      indent: line.match(/^ */)?.[0].length ?? 0,
      text: line.trim(),
      raw: line,
    }))

  const parser = new YamlSubsetParser(lines)
  const parsed = parser.parseBlock(0)
  if (!isRecord(parsed)) {
    throw new Error('Workflow YAML must be an object')
  }
  return parsed
}

class YamlSubsetParser {
  private index = 0

  constructor(private readonly lines: Line[]) {}

  parseBlock(indent: number): unknown {
    this.skipIgnorable()
    const line = this.peek()
    if (!line || line.indent < indent) return {}
    return line.text.startsWith('- ') ? this.parseArray(indent) : this.parseObject(indent)
  }

  private parseObject(indent: number): Record<string, unknown> {
    const result: Record<string, unknown> = {}

    while (this.index < this.lines.length) {
      this.skipIgnorable()
      const line = this.peek()
      if (!line || line.indent < indent) break
      if (line.indent > indent) {
        throw new Error(`Unexpected indentation at line ${this.index + 1}: ${line.raw}`)
      }
      if (line.text.startsWith('- ')) break

      const match = line.text.match(/^([^:]+):(.*)$/)
      if (!match) {
        throw new Error(`Expected key/value at line ${this.index + 1}: ${line.raw}`)
      }

      const key = match[1].trim()
      const rest = match[2].trim()
      this.index += 1

      if (rest === '|') {
        result[key] = this.parseBlockScalar(indent)
      } else if (rest === '') {
        result[key] = this.parseBlock(this.nextIndent(indent))
      } else {
        result[key] = parseScalar(rest)
      }
    }

    return result
  }

  private parseArray(indent: number): unknown[] {
    const result: unknown[] = []

    while (this.index < this.lines.length) {
      this.skipIgnorable()
      const line = this.peek()
      if (!line || line.indent < indent) break
      if (line.indent > indent) {
        throw new Error(`Unexpected indentation at line ${this.index + 1}: ${line.raw}`)
      }
      if (!line.text.startsWith('- ')) break

      const itemText = line.text.slice(2).trim()
      this.index += 1

      if (itemText === '') {
        result.push(this.parseBlock(this.nextIndent(indent)))
        continue
      }

      const inlineObject = parseInlineObjectEntry(itemText)
      if (inlineObject) {
        const child = this.hasChild(indent) ? this.parseBlock(this.nextIndent(indent)) : {}
        if (!isRecord(child)) {
          throw new Error(`Expected object item continuation at line ${this.index + 1}`)
        }
        result.push({ ...inlineObject, ...child })
        continue
      }

      result.push(parseScalar(itemText))
    }

    return result
  }

  private parseBlockScalar(parentIndent: number): string {
    const collected: string[] = []
    const baseIndent = this.findBlockScalarIndent(parentIndent)

    while (this.index < this.lines.length) {
      const line = this.peek()
      if (!line) break
      if (line.text !== '' && line.indent <= parentIndent) break

      if (line.text === '') {
        collected.push('')
      } else {
        collected.push(line.raw.slice(Math.min(baseIndent, line.raw.length)))
      }
      this.index += 1
    }

    return collected.join('\n').replace(/\n+$/, '\n')
  }

  private findBlockScalarIndent(parentIndent: number): number {
    for (let i = this.index; i < this.lines.length; i += 1) {
      const line = this.lines[i]
      if (line.text === '') continue
      if (line.indent <= parentIndent) break
      return line.indent
    }
    return parentIndent + 2
  }

  private nextIndent(current: number): number {
    for (let i = this.index; i < this.lines.length; i += 1) {
      const line = this.lines[i]
      if (line.text === '' || line.text.startsWith('#')) continue
      if (line.indent <= current) break
      return line.indent
    }
    return current + 2
  }

  private hasChild(current: number): boolean {
    for (let i = this.index; i < this.lines.length; i += 1) {
      const line = this.lines[i]
      if (line.text === '' || line.text.startsWith('#')) continue
      return line.indent > current
    }
    return false
  }

  private peek(): Line | undefined {
    return this.lines[this.index]
  }

  private skipIgnorable(): void {
    while (this.index < this.lines.length) {
      const line = this.lines[this.index]
      if (line.text !== '' && !line.text.startsWith('#')) break
      this.index += 1
    }
  }
}

function parseInlineObjectEntry(value: string): Record<string, unknown> | null {
  const match = value.match(/^([^:]+):(.*)$/)
  if (!match) return null
  return { [match[1].trim()]: parseScalar(match[2].trim()) }
}

function parseScalar(value: string): unknown {
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value)
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim()
    if (!inner) return []
    return inner.split(',').map(item => parseScalar(item.trim()))
  }
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }
  return value
}

export function validateWorkflowDefinition(value: unknown): WorkflowDefinition {
  const root = assertRecord(value, 'workflow')
  const id = assertString(root.id, 'id')
  const name = assertString(root.name, 'name')
  const agents = validateAgents(root.agents)
  const limits = validateLimits(root.limits)
  const sharedContext = assertString(root.sharedContext, 'sharedContext')
  const stateMachine = validateStateMachine(root.stateMachine, agents)
  const prompts = validatePrompts(root.prompts)

  validateStateReferences(stateMachine.states, stateMachine.initial)
  validatePromptReferences(stateMachine.states, prompts)

  return {
    id,
    name,
    agents,
    limits,
    sharedContext,
    stateMachine,
    prompts,
  }
}

function validateAgents(value: unknown): Record<string, WorkflowAgent> {
  const input = assertRecord(value, 'agents')
  return Object.fromEntries(Object.entries(input).map(([name, raw]) => {
    const agent = assertRecord(raw, `agents.${name}`)
    return [name, {
      cli: assertAgentCli(agent.cli, `agents.${name}.cli`),
      model: assertString(agent.model, `agents.${name}.model`),
      reasoningEffort: agent.reasoningEffort === undefined
        ? undefined
        : assertReasoningEffort(agent.reasoningEffort, `agents.${name}.reasoningEffort`),
      role: assertString(agent.role, `agents.${name}.role`),
    }]
  }))
}

function validateLimits(value: unknown): Record<string, number> {
  const input = assertRecord(value, 'limits')
  return Object.fromEntries(Object.entries(input).map(([key, raw]) => {
    if (!Number.isFinite(raw)) throw new Error(`Expected number at limits.${key}`)
    return [key, raw as number]
  }))
}

function validateStateMachine(
  value: unknown,
  agents: Record<string, WorkflowAgent>,
): WorkflowDefinition['stateMachine'] {
  const input = assertRecord(value, 'stateMachine')
  const initial = assertString(input.initial, 'stateMachine.initial')
  const rawStates = assertRecord(input.states, 'stateMachine.states')
  const states = Object.fromEntries(Object.entries(rawStates).map(([name, raw]) => [
    name,
    validateState(raw, name, agents),
  ]))
  return { initial, states }
}

function validateState(
  value: unknown,
  name: string,
  agents: Record<string, WorkflowAgent>,
): WorkflowState {
  const input = assertRecord(value, `stateMachine.states.${name}`)
  const state: WorkflowState = {}
  if (input.prompt !== undefined) state.prompt = assertString(input.prompt, `${name}.prompt`)
  if (input.final !== undefined) state.final = assertBoolean(input.final, `${name}.final`)
  if (input.status !== undefined) state.status = assertString(input.status, `${name}.status`)
  if (input.wait !== undefined) state.wait = validateWait(input.wait, name, agents)
  if (!state.final && !state.wait) {
    throw new Error(`State ${name} must define wait or final`)
  }
  return state
}

function validateWait(
  value: unknown,
  stateName: string,
  agents: Record<string, WorkflowAgent>,
): WorkflowWait {
  const input = assertRecord(value, `${stateName}.wait`)
  const from = assertString(input.from, `${stateName}.wait.from`)
  if (!agents[from]) throw new Error(`Unknown wait agent "${from}" in state ${stateName}`)
  const on = assertArray(input.on, `${stateName}.wait.on`).map((item, index) =>
    validateTransition(item, `${stateName}.wait.on[${index}]`, agents),
  )
  return { from, on }
}

function validateTransition(
  value: unknown,
  pathName: string,
  agents: Record<string, WorkflowAgent>,
): WorkflowTransition {
  const input = assertRecord(value, pathName)
  const verb = assertVerb(input.verb, `${pathName}.verb`)
  const transition: WorkflowTransition = {
    verb,
    next: assertString(input.next, `${pathName}.next`),
  }

  if (input.target !== undefined) {
    transition.target = assertString(input.target, `${pathName}.target`)
    if (transition.target !== HUMAN_TARGET && !agents[transition.target]) {
      throw new Error(`Unknown target "${transition.target}" at ${pathName}`)
    }
  }
  if (input.prompt !== undefined) transition.prompt = assertString(input.prompt, `${pathName}.prompt`)
  if (input.requireArtifacts !== undefined) {
    transition.requireArtifacts = assertArray(input.requireArtifacts, `${pathName}.requireArtifacts`)
      .map((item, index) => assertString(item, `${pathName}.requireArtifacts[${index}]`))
  }
  if (input.increment !== undefined) transition.increment = assertString(input.increment, `${pathName}.increment`)
  if (input.max !== undefined) {
    if (!Number.isFinite(input.max)) throw new Error(`Expected number at ${pathName}.max`)
    transition.max = input.max as number
  }
  if (input.exceeded !== undefined) transition.exceeded = assertString(input.exceeded, `${pathName}.exceeded`)

  return transition
}

function validatePrompts(value: unknown): Record<string, string> {
  const input = assertRecord(value, 'prompts')
  return Object.fromEntries(Object.entries(input).map(([key, raw]) => [
    key,
    assertString(raw, `prompts.${key}`),
  ]))
}

function validateStateReferences(states: Record<string, WorkflowState>, initial: string): void {
  if (!states[initial]) throw new Error(`Initial state not found: ${initial}`)
  for (const [stateName, state] of Object.entries(states)) {
    for (const transition of state.wait?.on ?? []) {
      if (!states[transition.next]) throw new Error(`State ${stateName} references missing next state ${transition.next}`)
      if (transition.exceeded && !states[transition.exceeded]) {
        throw new Error(`State ${stateName} references missing exceeded state ${transition.exceeded}`)
      }
    }
  }
}

function validatePromptReferences(states: Record<string, WorkflowState>, prompts: Record<string, string>): void {
  for (const [stateName, state] of Object.entries(states)) {
    if (state.prompt && !prompts[state.prompt]) {
      throw new Error(`State ${stateName} references missing prompt ${state.prompt}`)
    }
    for (const transition of state.wait?.on ?? []) {
      if (transition.prompt && !prompts[transition.prompt]) {
        throw new Error(`State ${stateName} transition references missing prompt ${transition.prompt}`)
      }
    }
  }
}

function assertRecord(value: unknown, pathName: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Expected object at ${pathName}`)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function assertString(value: unknown, pathName: string): string {
  if (typeof value !== 'string') throw new Error(`Expected string at ${pathName}`)
  return value
}

function assertBoolean(value: unknown, pathName: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Expected boolean at ${pathName}`)
  return value
}

function assertArray(value: unknown, pathName: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Expected array at ${pathName}`)
  return value
}

function assertVerb(value: unknown, pathName: string): ReportVerb {
  if (value !== 'talk' && value !== 'broadcast' && value !== 'done' && value !== 'failed') {
    throw new Error(`Expected report verb at ${pathName}`)
  }
  return value
}

function assertAgentCli(value: unknown, pathName: string): AgentCli {
  if (value !== 'claude' && value !== 'codex') {
    throw new Error(`Expected agent cli at ${pathName}`)
  }
  return value
}

function assertReasoningEffort(value: unknown, pathName: string): ReasoningEffort {
  if (value !== 'low' && value !== 'medium' && value !== 'high' && value !== 'xhigh') {
    throw new Error(`Expected reasoning effort at ${pathName}`)
  }
  return value
}
