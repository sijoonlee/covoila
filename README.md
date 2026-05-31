# Covoila

Covoila is a local multi-agent coding workspace. It provides a React UI for starting and monitoring agent CLI sessions, plus an Express server that coordinates task workflows, terminal streams, task state, and structured agent reports.

The app is designed around two main views:

- **Tasks**: create a coding task, launch the selected workflow, and watch live agent terminals in configurable layouts.
- **Workflow Editor**: define agent roles, phase order, revision rules, and save workflows as YAML files under `workflows/`.

## Features

- Local browser workspace built with React, Vite, and TypeScript.
- Embedded xterm.js terminals backed by `node-pty`.
- Support for Codex and Claude CLI agent sessions.
- Task orchestration through deterministic YAML workflows.
- Agent-to-orchestrator reporting through an MCP `report` tool.
- WebSocket updates for terminal output, task changes, and session status.
- Local persistence in `.covoila` for runtime data, with workflow YAML files kept in top-level `workflows/` so they can be committed.

## Requirements

- Node.js 24, matching `.nvmrc`.
- pnpm.
- Agent CLIs available on your `PATH` if you want to start real sessions:
  - `codex`
  - `claude`

The app can start without the agent CLIs installed, but launching a terminal session for a missing CLI will fail when the server tries to spawn it.

## Install

```bash
pnpm install
```

## Run In Development

```bash
pnpm run dev
```

This starts both:

- Vite frontend on `http://localhost:4318`
- Covoila API server on `http://localhost:3001`

The frontend is configured to proxy `/api`, `/mcp`, `/agent-terminal`, and `/task-events` requests to the API server.

You can also run only the API server:

```bash
pnpm run server
```

## Build

```bash
pnpm run build
```

Preview the production build with:

```bash
pnpm run preview
```

## How It Works

When you create a task, Covoila:

1. Loads the selected workflow YAML from `workflows/`.
2. Creates a task record in `.covoila/covoila.db`.
3. Writes the task prompt to the task artifact directory.
4. Starts the first workflow agent as a CLI session.
5. Injects an MCP report server configuration so the agent can call `report`.
6. Advances the workflow when agents submit structured reports such as `done`, `talk`, `broadcast`, or `failed`.

Agent sessions run in the selected task working directory. Workflow artifacts are stored under this Covoila project, and each spawned agent is granted access to its task-specific artifact directory:

```text
.covoila/tmp/<task-name>-<timestamp>-<id>/
```

## Local Data

Covoila stores app runtime data in this app's project-local `.covoila` directory:

```text
.covoila/
  agentConfigs.json
  covoila.db
  tmp/
    <task artifacts>
```

This directory is ignored by git and is intended to remain local. Workflow definitions live outside it:

```text
workflows/
  *.yaml
```

## Project Structure

```text
src/
  App.tsx                         # Main React app and task workspace state
  api.ts                          # Frontend API client
  mockData.ts                     # Default layouts, models, and agent configs
  components/
    CreateTaskModal/              # Task creation flow
    Header/                       # View and layout controls
    TerminalGrid/                 # Terminal layout selection
    TerminalPanel/                # xterm.js agent terminal panel
    WorkflowEditor/               # Workflow YAML builder/editor

server/
  index.ts                        # Express API, WebSocket endpoints, startup
  agent.ts                        # node-pty agent session manager
  db.ts                           # SQLite task and event persistence
  orchestrator.ts                 # Workflow task orchestration
  workflowParser.ts               # YAML workflow parser/validator
  workflowRuntime.ts              # Workflow state machine runtime
  report.ts                       # MCP report tool server
  storage.ts                      # JSON config storage helpers

docs/
  agent-session-events.md
  more-flexible-design.md
```

## Main API And WebSocket Endpoints

- `GET /api/environment`: returns the server working directory.
- `GET /api/tasks`: lists task records.
- `POST /api/orchestrator/runs`: creates a task and starts a workflow run.
- `GET /api/workflows`: lists available workflow YAML files.
- `GET /api/workflows/:filename`: loads one workflow.
- `PUT /api/workflow`: validates and saves workflow YAML.
- `GET /api/agent-sessions`: lists active and recent agent sessions.
- `POST /api/agent-sessions`: starts an agent CLI session.
- `DELETE /api/agent-sessions/:sessionId`: terminates an agent session.
- `POST /mcp`: MCP report endpoint used by agents.
- `WS /agent-terminal`: streams terminal input/output.
- `WS /task-events`: streams task and session updates.

## Workflow Files

Workflow YAML files live in `workflows/`. The current workflow format includes:

- `id` and `name`
- `agents` with CLI, model, reasoning effort, and role
- `limits`
- `sharedContext`
- `stateMachine`
- `prompts`

The Workflow Editor can generate this YAML from a linear phase model plus optional revision rules.

## Notes

- The server listens on `PORT` if set, otherwise `3001`.
- Vite serves the frontend on port `4318`.
- `dist/` contains built frontend output and is ignored by git.
- There is no test script currently defined in `package.json`.
