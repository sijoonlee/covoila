# Agent Session Events — Design Note

Plan for replacing the 1.5s `refreshAgentSessions` poll in `App.tsx` with WebSocket-pushed session updates, multiplexed onto the existing `/task-events` channel.

---

## What changes during a session

Walking `server/agent.ts`, an `AgentSessionSnapshot` has these mutable fields:

| Field | When it changes | FE uses it? |
|---|---|---|
| `status` | `starting` → `running` → `idle` → `exited` / `failed` | **yes** — agent count in TaskRail, status badge in TerminalPanel header, visibility filters in TerminalGrid |
| `pid` | once, when pty spawns | no |
| `exitCode` | once, on exit | no (only shown inside transcript text) |
| `lastOutputAt` | every `onData` callback | no |
| `transcript` | every `onData` callback | no — already streams via `/agent-terminal` WS |
| everything else (`id`, `cli`, `model`, `taskId`, `cwd`, `command`, `createdAt`) | never | yes, but stable |

The only thing the FE actually re-renders on is `status`. Transcript has its own WS channel. The rest is either set-once or unused.

## What to emit

A single `session.updated` event carrying the full snapshot, fired only on **status transitions**:

1. Session created — `status: 'starting'`. Fires when `prepare()` or `start()` is called.
2. Pty spawns successfully — `starting` → `running`.
3. Idle timer fires after 1200ms quiet — `running` → `idle`.
4. New output arrives after idle — `idle` → `running`. The only flip that can repeat.
5. Pty exits — `running` / `idle` → `exited`.
6. Spawn failed (e.g. cwd missing) — `starting` → `failed`.

Typical volume per session: **3–5 messages total** (start, run, maybe an idle/run flip, exit). Not per-keystroke.

Explicitly **not** emitted:

- `onData` callbacks — transcript has its own channel.
- `lastOutputAt` ticks — derived state the FE doesn't render.
- `pid` set — folded into the `starting` → `running` transition.

## Implementation shape

### `server/agent.ts`

Introduce a single mutation point for status changes so we can't forget to notify:

```ts
private setStatus(next: AgentSessionStatus): void {
  if (this.snapshotData.status === next) return
  this.snapshotData.status = next
  this.notifyChange()  // emits session.updated to subscribers
}
```

Replace every `this.snapshotData.status = '...'` line (~5 sites in `AgentSession`) with `this.setStatus('...')`. That's the only change-detection point — if a future contributor mutates `status` directly, the FE goes stale. Add a short comment on `snapshotData.status` to that effect.

`AgentSessionManager` exposes a parallel emitter:

```ts
onSessionUpdated(listener: (snapshot: AgentSessionSnapshot) => void): () => void
```

Subscribers are registered on construction (same wiring pattern as `onOutput`).

### `server/index.ts`

Subscribe to the manager and broadcast on the existing `taskEventsWss`:

```ts
agentSessions.onSessionUpdated((session) => {
  const payload = JSON.stringify({ type: 'session.updated', session })
  for (const client of taskEventsWss.clients) {
    if (client.readyState === client.OPEN) client.send(payload)
  }
})
```

No new WS endpoint; multiplexing keeps connection count and reconnect logic small.

### `src/App.tsx`

Extend `parseTaskEventMessage` to discriminate on `type`, then upsert in the existing WS handler:

```ts
if (message?.type === 'session.updated') {
  const updated = message.session
  setAgentSessions(current => {
    const idx = current.findIndex(s => s.id === updated.id)
    if (idx === -1) return [...current, updated]
    const next = current.slice()
    next[idx] = updated
    return next
  })
}
```

Drop the 1.5s `refreshAgentSessions` polling interval. The initial fetch in the mount effect stays — it seeds state before the WS catches up.

## Risks / open questions

- **Missed mutation site.** If anyone bypasses `setStatus`, FE goes stale. Mitigation: single setter, grep, short comment.
- **Idle/run thrash.** A talkative agent could flip `running` ↔ `idle` repeatedly. With a 1200ms idle window, worst case ~50 flips/minute — still cheap, but if it shows up as noise we can require the FE to suppress idle/run alternation (the count/badge UI doesn't distinguish them meaningfully).
- **Ordering with `task.updated`.** Status changes in the workflow happen via `markAgentEffectStarted` (task update) and via session pty start (session update). The FE handles both independently, so ordering doesn't matter for correctness.
- **Snapshot includes `transcript`.** That array can grow to `TRANSCRIPT_LIMIT = 400` entries. Sending the full snapshot 3–5 times per session is fine, but if we ever emit on data we'd want to strip transcript first. Currently a non-issue because we only emit on status flips.

## Verification

1. Browser devtools → Network → WS, watch `/task-events` frames during a workflow run. Expect `task.updated` interleaved with `session.updated` messages.
2. Start a workflow with one agent action. Expect: `session.updated` with status `starting`, then `running`, then (after idle) `idle`, then `exited` once the action's report arrives and the agent terminates.
3. Kill the server mid-run, confirm reconnect re-establishes both streams, FE catches up on next status flip.
