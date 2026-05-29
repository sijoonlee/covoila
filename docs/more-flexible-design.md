# More Flexible Orchestration Design

## Goal

Move from a schema/output-driven workflow runner to an orchestrator-driven multi-agent system.

The orchestrator should:

- Give each agent only the prompt it needs for the current step.
- Define which actions are possible in each state.
- Mediate agent-to-agent communication.
- Use shared files as the durable collaboration layer.
- Act as a circuit breaker when agents loop, fail too early, target the wrong agent, or cannot make progress.

Agents should not receive the whole workflow upfront. They should receive narrow, step-specific prompts from the orchestrator.

## Core Model

Each task has:

- `workDir`: the project working directory. All agents work in this same directory.
- `taskTmpDir`: the shared artifact directory for the task. Agents use this as their mailbox and scratchpad.
- `workflowRun`: minimal runtime state for the orchestrator.
- `taskEvents`: audit log for reports, prompts, routed messages, invalid reports, and state transitions.

The source of truth for agent collaboration is the filesystem:

```text
<workDir>/
  .covoila/tmp/<task-id-or-slug>/
    plan.md
    review-notes.md
    implementation-notes.md
    failure.md
```

The orchestrator owns state. Agents only submit intents through the report tool.

## Report Tool Verbs

Keep the report tool small and flexible:

```ts
type ReportVerb = 'talk' | 'broadcast' | 'done' | 'failed'

type AgentReport =
  | {
      verb: 'talk'
      target: string
      content: string
      artifacts?: string[]
    }
  | {
      verb: 'broadcast'
      targets?: string[]
      content: string
      artifacts?: string[]
    }
  | {
      verb: 'done'
      artifacts?: string[]
    }
  | {
      verb: 'failed'
      reason?: string
      artifacts?: string[]
    }
```

These reports are intents, not commands. The orchestrator validates each report against the current state machine before taking action.

Examples:

- `talk`: one agent wants to send a 1:1 message to another agent.
- `broadcast`: one agent wants to send a message to multiple agents, or to a state-defined recipient group.
- `done`: the agent believes the current assigned step is complete.
- `failed`: the agent believes the current assigned step cannot be completed.

Do not add `blocked` as a report verb. Blocked states should be calculated by the orchestrator when an agent report is invalid, impossible, repeated too often, or reaches a retry/turn limit.

## Orchestrator Responsibilities

For every report, the orchestrator should:

1. Identify the task, current state, reporting agent, and report verb.
2. Check that the reporting agent is allowed to act in the current state.
3. Check that the verb is allowed in the current state.
4. Validate verb-specific constraints:
   - `talk.target` is allowed.
   - `broadcast.targets` are allowed, or derive targets from state.
   - required artifacts exist under `taskTmpDir`.
   - conversation/retry limits are not exceeded.
5. Append a task event.
6. Transition state deterministically.
7. Send the next step prompt to the selected agent(s), if any.

The orchestrator, not the agent, decides whether a report advances the workflow, routes a message, fails a phase, or pauses for the user.

## Step-Wise Prompting

Agents should receive prompts only when the state machine activates them.

Prompt context should include:

- Current phase/state.
- Agent role.
- Working directory.
- Shared artifact directory.
- Relevant incoming message, if any.
- Files to read or write.
- Allowed report verbs for this state.

Example routed prompt:

```text
Phase: planning.revision
Your role: planner
Working directory: {workDir}
Shared artifact directory: {taskTmpDir}

Reviewer message:
{lastReport.content}

Update {taskTmpDir}/plan.md if needed.

Allowed reports:
- { "verb": "done", "artifacts": ["plan.md"] }
- { "verb": "talk", "target": "reviewer", "content": "..." }
- { "verb": "failed", "reason": "...", "artifacts": [...] }
```

## Deterministic YAML State Machines

Workflow phases can be represented as deterministic state machines in YAML.

The state machine defines:

- Which agent receives a prompt.
- Which agent report is expected.
- Which verbs are accepted.
- Which targets are valid.
- Which artifacts are required.
- Which counters/limits apply.
- Which state comes next.

Agents do not choose transitions directly. They only report an intent, and the state machine decides the transition.

## Planning Phase Example

Stories covered:

1. Planner writes `plan.md`, reviewer approves, phase completes.
2. Planner writes `plan.md`, reviewer asks for revisions, planner and reviewer talk for a few turns, reviewer approves, phase completes.
3. Planner writes `plan.md`, reviewer asks for revisions, agents keep talking until the max turn limit is reached, orchestrator pauses for user intervention.

```yaml
id: planning

agents:
  planner: planner
  reviewer: reviewer

limits:
  maxConversationTurns: 6
  maxInvalidReports: 3

initial: prompt_planner

states:
  prompt_planner:
    type: prompt
    agent: planner
    prompt: |
      Create or update the implementation plan.

      Working directory: {workDir}
      Shared artifact directory: {taskTmpDir}

      Write the plan to {taskTmpDir}/plan.md.

      Allowed reports:
      - { "verb": "done", "artifacts": ["plan.md"] }
      - { "verb": "failed", "reason": "...", "artifacts": [...] }
    next: await_planner_done

  await_planner_done:
    type: wait_report
    from: planner
    accepts:
      done:
        requireArtifacts:
          - plan.md
        next: prompt_reviewer
      failed:
        next: phase_failed
    onInvalidReport:
      increment: invalidReports
      next: maybe_blocked

  prompt_reviewer:
    type: prompt
    agent: reviewer
    prompt: |
      Review {taskTmpDir}/plan.md.

      If the plan is acceptable, report done.
      If it needs changes, talk to planner.

      Allowed reports:
      - { "verb": "done" }
      - { "verb": "talk", "target": "planner", "content": "..." }
      - { "verb": "failed", "reason": "...", "artifacts": [...] }
    next: await_reviewer_decision

  await_reviewer_decision:
    type: wait_report
    from: reviewer
    accepts:
      done:
        next: phase_done
      talk:
        target: planner
        increment: conversationTurns
        if:
          conversationTurns:
            lte: 6
        next: prompt_planner_revision
      failed:
        next: phase_failed
    onLimitExceeded:
      next: needs_user
    onInvalidReport:
      increment: invalidReports
      next: maybe_blocked

  prompt_planner_revision:
    type: prompt
    agent: planner
    prompt: |
      Reviewer requested changes:

      {lastReport.content}

      Review and update {taskTmpDir}/plan.md if needed.

      Allowed reports:
      - { "verb": "done", "artifacts": ["plan.md"] }
      - { "verb": "talk", "target": "reviewer", "content": "..." }
      - { "verb": "failed", "reason": "...", "artifacts": [...] }
    next: await_planner_revision

  await_planner_revision:
    type: wait_report
    from: planner
    accepts:
      done:
        requireArtifacts:
          - plan.md
        next: prompt_reviewer
      talk:
        target: reviewer
        increment: conversationTurns
        if:
          conversationTurns:
            lte: 6
        next: prompt_reviewer_response
      failed:
        next: phase_failed
    onLimitExceeded:
      next: needs_user
    onInvalidReport:
      increment: invalidReports
      next: maybe_blocked

  prompt_reviewer_response:
    type: prompt
    agent: reviewer
    prompt: |
      Planner replied:

      {lastReport.content}

      Review the current {taskTmpDir}/plan.md again.

      Allowed reports:
      - { "verb": "done" }
      - { "verb": "talk", "target": "planner", "content": "..." }
      - { "verb": "failed", "reason": "...", "artifacts": [...] }
    next: await_reviewer_decision

  maybe_blocked:
    type: decision
    if:
      invalidReports:
        gte: 3
    then: needs_user
    else: reprompt_current_agent

  reprompt_current_agent:
    type: prompt
    agent: "{currentAgent}"
    prompt: |
      Your previous report was not valid for the current state.

      Current state: {currentState}
      Allowed reports:
      {allowedReports}

      Submit one valid report.
    next: "{currentWaitState}"

  phase_done:
    type: final
    status: done

  phase_failed:
    type: final
    status: failed

  needs_user:
    type: final
    status: needs_user
```

## Circuit Breaker Behavior

Circuit breaker states are derived by the orchestrator. Agents do not directly report `blocked`.

Examples:

- Agent reports `done`, but required artifact is missing.
- Agent reports `talk` to an invalid target.
- Agent reports `broadcast`, but the current state does not allow broadcast.
- Agent reports `failed` in a state where the state machine wants a retry or user intervention first.
- Conversation turn count exceeds the configured maximum.
- Invalid report count exceeds the configured maximum.

The orchestrator should record these as task events and transition to either:

- a reprompt state,
- a phase failure state, or
- a `needs_user` state.

## What This Lets Us Discard

This design can remove or de-emphasize:

- `memory` as an agent output or handoff store.
- `workflowRun.outputs` as the source of truth for collaboration.
- Schema-driven report payload validation.
- The schema editor as a core workflow feature.
- Generic gate expression language for early versions.
- Mocked function and command executors.

The remaining persisted runtime state can be small:

- current phase/state,
- active/waiting agent,
- counters,
- agent session IDs,
- last report/event references,
- task status.

## Implementation Direction

Start with the planning phase only.

Suggested steps:

1. Change the MCP report schema to accept `verb`, `target`, `targets`, `content`, `reason`, and `artifacts`.
2. Add an orchestrator handler that validates reports against a hard-coded planning state machine.
3. Ensure `taskTmpDir` exists under `workDir` before any agent starts.
4. Prompt planner to write `plan.md`.
5. Route planner `done` to reviewer.
6. Route reviewer `talk` to planner.
7. Route planner `talk` to reviewer.
8. Route reviewer `done` to planning phase completion.
9. Add conversation and invalid-report limits.
10. Move the hard-coded state machine into YAML once the semantics feel correct.

The first implementation should prefer clarity over generality. Once the planning phase works, the same state machine shape can drive coding and review phases.
