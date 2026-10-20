# The Workers Free budget

Incorporeal runs on the Cloudflare Workers **Free** plan. It does not need a
paid subscription, and it does not quietly assume one. This document states
exactly what the Free plan allows, where each design decision keeps inside
those limits, what actually happens when an allocation is exhausted, and what
costs money outside Cloudflare.

Nothing in this document was measured on a deployed account. The limit figures
are quoted from Cloudflare's published limit pages (see **Sources**). The
"how the design stays inside it" and "what happens at the limit" columns are
derived from reading the code, and the workload estimates are arithmetic from
the code's write and call patterns, not observations. They are labelled as
estimates.

## The limits that matter

| Limit | Free plan value | Where the design keeps inside it | What happens at the limit |
| --- | --- | --- | --- |
| Worker requests per day | 100,000 across all scripts | The Worker only authenticates, routes and hands off. All real work is in Durable Objects, which are addressed by RPC from a handful of entry points. | The platform rejects further requests with a platform error. Nothing in this codebase retries a platform-level quota error. |
| Worker CPU per HTTP request | 10 ms | The Worker performs a small number of D1 queries and at most one or two Durable Object RPC hand-offs. It never runs a model call, a tool loop or a repository check. | The invocation is terminated. The Worker catches its own exceptions and returns `500 {"error":"internal error"}`; a CPU overrun surfaces as a platform error instead. |
| Worker CPU per Cron Trigger | 10 ms | The cron handler is a hand-off only: seed the built-in agents, find the coordinator, one RPC to `runSweep()`. It does not scan, decide or fetch. | Same as above: the cron invocation fails, the sweep is skipped, and the next trigger retries. |
| Worker memory per isolate | 128 MB | The Worker holds no agent state. Agent transcripts live in each Durable Object's SQLite database. | The isolate is evicted. Work in flight inside a Durable Object is unaffected; a Worker request in flight is lost. |
| Subrequests per Worker request | 50 | One request touches D1 (a handful of queries) and at most a couple of Durable Object stubs. | The request fails with a platform error. The design has no path that approaches 50. |
| Simultaneous outgoing connections per request | 6 | No code path fans out concurrently. The check backends and the GitHub backend each make one outbound request. | The request fails. Not reachable in this design. |
| Durable Objects availability | Available on Free, **SQLite backend only** (the key-value backend is Workers Paid only) | `wrangler.jsonc` declares `new_sqlite_classes: ["OrgAgent"]`, so the class is SQLite-backed from its first migration. | Not applicable: the design never requests a key-value-backed class, so it is deployable on Free as written. |
| Durable Object CPU per invocation | 30 s of active CPU, reset by each incoming request; identical on Free and Paid | Every model call, tool loop and sweep happens inside a Durable Object. | The invocation is terminated. The task stays open in D1, the agent reconciles on its next start, and the operation id makes the replay idempotent rather than duplicated. |
| Durable Object wall time | Unlimited while a caller stays connected; 15 minutes for a Cron Trigger or a Durable Object Alarm | The sweep runs inside a Durable Object alarm/RPC context with the 15-minute budget. Model runs that would exceed it are resumed by a later invocation. | The invocation is ended. Work is not lost: it is re-derived from D1 on the next start. |
| Durable Object storage per object | 1 GB on Free (10 GB on Workers Paid) | Each agent is one object holding one transcript and one inbox. A long-lived agent's transcript grows with its work. | SQLite reports `SQLITE_FULL`. Reads and deletes still work; new writes fail. See "When an allocation is exhausted". |
| Durable Object storage per account | 5 GB on Free | At most a handful of objects exist (one per agent id, plus successors). The transcript, not the schema, is what grows. | New object writes fail with `SQLITE_FULL`. |
| Durable Object classes | 100 on Free (500 on Paid) | One class hosts every agent. Identity comes from the object's *name*, not from the class. | Not applicable: the design uses one class. |
| Durable Object outgoing connections | 6 simultaneous per request | No code path fans out concurrently inside an object either: the check backends and the GitHub backend each make one outbound request. | The request fails. Not reachable in this design. |
| Durable Object alarms | 15 minutes wall time per alarm invocation; each alarm counts as a request | The Agents SDK's lifecycle arms a wake alarm on a ~30-second heartbeat only while an agent has work in flight, and disarms it when the agent is idle. | See "The request budget". An alarm overrun ends the invocation; the work is resumed. |
| D1 storage | 5 GB total on Free | The shared store holds identities, goals, tasks, obligations, approvals, knowledge, executions and the event log — rows, not documents. The transcript is not here. | Writes fail with a storage error. Reads still work. |
| D1 rows read per day | 5,000,000 | Reads are bounded and indexed: the task board, the event log and the roster are all indexed by the columns actually queried. | Since 2026-09-01, queries fail once the daily limit is exceeded, until midnight UTC. |
| D1 rows written per day | 100,000 | Roughly one row per task, one per event, one per execution, one per agent-usage update (one per charged tool call) and a few updates per task. See "The D1 write budget". | Since 2026-09-01, queries fail once the daily limit is exceeded, until midnight UTC. |
| D1 databases | Up to 10 databases of 500 MB each | One database, named `incorporeal`. | Not applicable. |
| Workers AI | 10,000 neurons/day on Free | The default provider is Workers AI; the model is chosen per role and the thinking level is `low`. `MODEL_PROVIDER=faux` removes the dependency entirely. | The model call fails, the run settles as unanswered, the task is marked failed with the reason, and the coordinator is notified. See "When an allocation is exhausted". |
| Workers AI beyond the Free allocation | Requires Workers Paid; priced at $0.011 per 1,000 neurons | Not applicable — the design stays inside the Free allocation at its intended workload. | Workers Paid is required. Model-specific rate limits may also apply. |
| Workers Paid (for contrast) | 5 minutes of CPU per request (30 s default), no daily request cap | — | An upgrade, not a requirement. See "Upgrading". |

## Why the work runs inside Durable Objects

The whole architecture follows from one number: **a Workers Free invocation
gets 10 ms of CPU, and a Durable Object invocation gets 30 seconds.**

A single model call, a tool round trip, a repository check and an obligation
sweep do not fit in 10 ms. So the Worker is deliberately thin:

- `src/index.ts` `fetch()` authenticates nothing itself but routes, and it
  performs one call into `ensureBuiltInAgents()` and then `handleApi()`.
- Every agent is a Durable Object (`src/agents/org-agent.ts`). The object's
  *name* is the agent id, so identity, permissions, budgets and model all come
  from a D1 row and an agent can be replaced without a migration.
- The expensive step — the model call, the tool loop, the sweep — always
  happens inside the Durable Object that owns it.

### The cron trigger is a hand-off, not a job

`wrangler.jsonc` declares exactly one cron trigger:

```jsonc
"triggers": {
  "crons": ["*/15 * * * *"]
}
```

The Worker's `scheduled()` handler does the smallest thing that can possibly
work: it makes sure the three built-in agents exist, finds the coordinator,
and makes one RPC call:

```ts
const result = await env.ORG_AGENTS.getByName(coordinatorId).runSweep();
```

It does not list obligations, does not run the repository check, does not
decide anything and does not write a row. All of that is inside the
coordinator's Durable Object, which has 30 s of CPU and 15 minutes of wall
time instead of 10 ms. The handler logs `sweep complete` with the duration and
the result, and returns.

This is why the trigger fires every 15 minutes rather than every minute: the
sweep is not a timer-resolution problem, it is a cost problem. See the next
section.

## The request budget

Three kinds of thing consume the Free plan's daily request allowance.

**1. Inbound API calls.** Every request to the management API is one Worker
request. These are operator-driven (or webhook-driven), so their volume is
small and under the operator's control. `GET /api/health` needs no token and
can be polled freely.

**2. The cron trigger.** One trigger every 15 minutes is 96 Worker requests
per day, plus 96 Durable Object invocations (the RPC into the coordinator).
This is a fixed, known cost.

**3. Durable Object RPCs and alarms between agents.** This is the part that
scales with the work.

- Every hand-off is a Durable Object RPC: `assign()` from the coordinator to
  an agent, `onTaskCompleted()` back to the coordinator, `note()` from a
  human to an agent, `runSweep()` from the cron trigger, `status()` from
  `GET /api/agents/{id}`.
- **Durable Object alarms also count as requests.** The Agents SDK's lifecycle
  arms a wake alarm on a roughly 30-second heartbeat *while an agent has work
  in flight*, and disarms it when the agent goes idle
  (`node_modules/agents/dist/harness/pi/index.js`, `HEARTBEAT_MS = 30e3`).
  A single task that occupies an agent for five minutes therefore costs
  roughly ten alarm invocations, each of which is a request and each of which
  gets 30 s of CPU and 15 minutes of wall time.

This is the direct reason for two design choices:

- **The sweep is 15-minute, not per-minute.** A per-minute poll would be
  1,440 cron requests plus 1,440 coordinator invocations plus 1,440 alarm
  wake-ups per day, and it would buy nothing: the check it runs is
  deterministic and idempotent, and the obligation carries its own interval.
- **Every obligation carries an interval.** `obligations.interval_seconds` is
  stored on the row, and `claimObligation()` only runs an obligation whose
  `next_run_at` has passed. The sweep is a scheduler that consults the
  obligation, not a busy loop that polls one thing per minute.

### What a busy day costs

Take a day with `N` tasks, each of which produces a review, and assume each
agent is occupied for roughly three minutes per task.

| Source | Count per day (estimate) |
| --- | --- |
| Cron trigger | 96 Worker requests + 96 Durable Object invocations |
| Operator API calls | tens |
| Task hand-offs (assign + report + review + apply) | roughly 4–6 Durable Object RPCs per task, so about `5N` |
| Alarm wake-ups while agents are busy | roughly 2 per agent-minute of work (the 30-second heartbeat); with three agents and three minutes per task, about `18N` |
| **Total** | roughly `96 + 5N + 18N` requests per day |

With `N = 100` tasks a day that is roughly 2,400 requests: about 2% of the
100,000/day allowance. With `N = 1,000` tasks a day it is roughly 23,000
requests, about 23% of the allowance. The allowance is not the binding
constraint at any plausible workload; the model allocation and the operator's
patience are.

These are arithmetic estimates from the code's control flow. They have not
been measured against a deployed account.

## The D1 write budget

D1 on Free allows 100,000 rows written per day. The shared store writes:

| What | Rows written |
| --- | --- |
| A task | 1 row in `tasks` (`createTask`), plus updates to the same row as it progresses (`markTaskRunning`, `updateTask`, `completeTask`) |
| An event | 1 row in `events` (`recordEvent`) |
| An execution | 1 row in `executions` (`recordExecution`), plus an update when it is submitted or fails |
| An agent-usage update | 1 upsert into `agent_usage` (`bumpAgentUsage`) — one per charged tool call, plus one at settle time for the task's tokens. So this scales with tool calls, not with tasks. |
| A goal, obligation, approval, knowledge row | 1 row each, on creation |

### Estimating your own day

Take `N` tasks a day, each producing `M` events:

```
writes/day  ≈  N × (1 task insert
                     + ~4 task updates  (running, reported, tokens, status)
                     + M events
                     + T agent-usage upserts, where T = tool calls per task)
             +  N × 1 execution row        (only when the task runs something)
             +  a handful of goal/obligation/approval rows
```

With `M = 5` events and `T = 6` tool calls per task, that is about
`N × 17` writes. Concretely:

| Tasks per day | Approximate writes | Share of the 100,000/day limit |
| --- | --- | --- |
| 100 | ~1,700 | ~2% |
| 1,000 | ~17,000 | ~17% |
| 5,000 | ~85,000 | ~85% |
| 9,000 | ~153,000 | over the limit |

A single task that runs the full loop — investigate, review, apply — writes
roughly ten rows across its own lifecycle and creates two more task rows
(the review task and the apply task), so the practical figure is somewhat
higher than the formula above. The order of magnitude is what matters: a
thousand tasks a day uses about a sixth of the write allowance, and the
limit arrives somewhere around five to six thousand tasks a day.

Reads are cheap by comparison. The 5,000,000 rows/day read limit is reached
by something like half a million single-row API reads.

Note that every inbound request re-reads the agent roster: the Worker calls
`ensureBuiltInAgents()` before routing, and it reads the whole `agents` table
(`listAgents`) each time. That is one small, indexed read per request. It is
cheap, but it means the read counter grows with the request counter, not just
with the work the agents do.

## Storage

Two different stores, on two different limits.

**Each agent's Durable Object SQLite** holds the agent-private state:
pi-durable's transcript, the inbox, the running generation, the task
checkpoints, and the document that records what the agent is working on.
pi-durable's own tables carry the `pi_` prefix in that database
(`pi_entries`, `pi_conversations`, `pi_tasks`, `pi_submissions`,
`pi_documents`, `pi_document_revisions`, `pi_record_ids`, `pi_durable_schema`,
`pi_durable_metadata`), because the Agents SDK's `PiHarness` opens the
session store with the prefix `pi_`
(`node_modules/agents/dist/harness/pi/index.js`, `DEFAULT_PREFIX = "pi_"`).
The host's own tables live in the same SQLite database.

The limit is **1 GB per Durable Object on Free** and **5 GB per account**.

The important property: a long-lived agent's transcript grows with the work
it does. pi-durable compacts the *model context* it sends to the provider, so
a long conversation does not keep sending the whole history, but the entries
themselves are kept — the transcript is the agent's memory and deleting it
would delete the agent's ability to know what it has already done. A
long-running agent with a very large transcript is therefore the first thing
to approach 1 GB.

**D1** holds the organization's shared state: agents, goals, tasks,
obligations, approvals, knowledge, executions and the event log. Rows, not
documents: a task is a row with a JSON result column. The 5 GB account limit
is a long way off for this schema.

## Model cost

**The default is Workers AI.** The Free plan grants 10,000 neurons per day.
The model is chosen per role:

| Variable | Default in `wrangler.jsonc` |
| --- | --- |
| `MODEL_DEFAULT` | `@cf/zai-org/glm-4.7-flash` |
| `MODEL_COORDINATOR` | `@cf/zai-org/glm-4.7-flash` |
| `MODEL_ENGINEER` | `@cf/moonshotai/kimi-k2.7-code` |
| `MODEL_REVIEWER` | `@cf/zai-org/glm-4.7-flash` |
| `THINKING_LEVEL` | `low` |

The thinking level is the largest single lever on neuron spend: a higher
level makes the model produce and keep more reasoning tokens per call.

**A deterministic faux provider is available.** `MODEL_PROVIDER=faux` makes
every agent answer from a script (`src/agents/faux.ts`) instead of calling a
provider. It exists so that the test suite and a credential-free demonstration
run the real organization — delegation, review, approval, recovery — without
spending a neuron or needing a network. It is not a model and it produces no
intelligence; it produces a repeatable transcript.

**An external model provider bills separately and independently of
Cloudflare.** There is no separate set of environment variables for one: the
model ids are plain strings, and a Cloudflare AI Gateway id such as
`openai/gpt-4o-mini` or `anthropic/claude-haiku-4-5` in a `MODEL_*` variable
routes the organization through the gateway, which holds the provider's
credentials. `src/agents/org-agent.ts` selects the faux provider when
`MODEL_PROVIDER === "faux"` and the AI Gateway otherwise, so an external
provider is a configuration change, not a code change. The cost is that
provider's, on that provider's terms, with no relationship to the Cloudflare
allocation.

The formula, which is the only honest way to state a price you do not control:

```
cost  =  (tokens_in  × rate_in)
      +  (tokens_out × rate_out)
      +  (cached_in  × rate_cached_in, if the provider caches)
```

**Example only — check the provider's current pricing before relying on any
number here.** As an illustration, if an external provider charged $3 per
million input tokens and $15 per million output tokens, a task with 4,000
input tokens and 1,000 output tokens would cost:

```
(4,000  / 1,000,000 × $3) + (1,000 / 1,000,000 × $15)
= $0.012 + $0.015
= $0.027
```

At 100 tasks a day that is about $2.70 a day, about $81 a month. The
arithmetic is what matters; the rates are placeholders. A cheap model with a
large output is a different bill from an expensive model with a small one.

**Workers AI beyond the Free allocation** requires Workers Paid and is priced
at $0.011 per 1,000 neurons. Model-specific rate limits may also apply on
top of the daily allocation.

## Execution cost

The execution backend is pluggable (`src/execution/index.ts`).

- **`simulated` (the default).** It performs no external work: it records
  that the action was requested and reports success. It costs nothing at all,
  on any plan. It is the backend the tests use and the one a demonstration
  deployment should use.
- **`github-actions`.** It dispatches a workflow in a repository and looks the
  run up afterwards. The coordinator's sweep reconciles the executions that
  are still in flight, so each one ends as `succeeded` or `failed` in the
  store rather than reading `submitted` for ever. The cost is GitHub's, not
  Cloudflare's: Actions minutes are free for public repositories and billed
  for private ones. This is an independent cost of using this backend and
  has nothing to do with the Workers plan.
- **`none`.** Every action is refused. Useful for a read-only deployment.

Cloudflare Containers are deliberately not used: they are a Workers Paid
feature and would make the project require a paid subscription.

## When an allocation is exhausted

This section describes what this codebase actually does. Where a limit is
merely survivable rather than handled gracefully, that is said.

### The Workers AI allocation runs out

Handled, gracefully.

1. The model call fails. Inside pi-durable this is a `model_error`: the run's
   inputs settle as `unanswered` and the generation fails
   (`node_modules/@earendil-works/pi-durable/dist/harness/generation.js`,
   `failModelError`).
2. The harness `wait()` returns a settled submission whose status is not
   `done`.
3. `OrgAgent.#settle()` in `src/agents/org-agent.ts` sees
   `result.status !== "done"`, calls `#failTask()` with the reason, and then
   calls `#notifyCoordinator()`.
4. `#failTask()` sets the task to `failed` with the reason as its summary and
   writes a `task.failed` event with the reason in the payload.
5. `#notifyCoordinator()` calls the coordinator's `onTaskCompleted()`. The
   coordinator sees a non-completed task and returns `not_completed`, so the
   chain stops there. A failure notification that cannot be delivered is
   logged as a warning and is not fatal — the coordinator's own sweep repairs
   a missed handoff.

No work is silently lost: the task is failed, the reason is in the row and in
the event log, and the organization knows.

The one thing that is *not* handled is the daily agent tool-call budget
enforced in `src/policy/budget.ts`: `checkAgentDailyBudget()` reads
`agent_usage.tool_calls`, and `chargeToolCall()` in `src/agents/tools.ts`
writes that counter on every charged tool call — the five tools that cause a
side effect (`org_report_result`, `org_delegate`, `org_request_approval`,
`org_write_knowledge`, `org_run_execution`); the three read-only tools
(`org_read_task`, `org_list_tasks`, `org_read_knowledge`) are not charged —
so the daily ceiling of 200 charged tool calls per agent per day does bind.
The per-task ceiling (`agents.max_tool_calls`, default 20) binds the same
way. Both refusals are thrown as ordinary tool errors, which the model
receives as an error result: the agent is told to report what it has and
stop.

### A D1 daily limit is exceeded

Survivable, and visible.

Since 2026-09-01, D1 queries fail once the daily read or write limit is
exceeded, until midnight UTC. A failed write throws. Where that write
happened decides what the operator sees:

- Inside a tool call (`src/agents/tools.ts`), the throw propagates out of the
  tool's `execute()`. The `guarded()` wrapper logs it as `a tool call failed`
  and rethrows. The model receives the failure as an error result, so the
  agent can report what it already has rather than proceeding on a false
  assumption. The refusal is visible in the log and in the event stream.
- Inside the settle path (`src/agents/org-agent.ts`), a failure to write the
  task's result propagates to `#runTask()`'s catch block, which logs
  `task run failed` and calls `#failTask()` — which needs another write. If
  that also fails, the task stays open in D1, and the coordinator's
  `#recoverStalledTasks()` re-issues it once its deadline passes and then
  fails it with `the assignment did not finish before its deadline`. The
  outcome is a task that fails with a deadline reason rather than with the
  real reason. This is survivable, not graceful.

**The budget system does not protect against this.** The tool-call budgets
limit how much work an agent does; they do not know about D1's daily quota,
and nothing in the codebase counts D1 writes against a daily allowance.

### The daily request limit is exceeded

Not handled. Cloudflare rejects further requests with a platform error. The
Worker's `fetch()` catches its own exceptions and returns
`500 {"error":"internal error"}`; a platform-level rejection is not an
exception the code catches, so the caller sees a platform error response.
No retry logic exists for it, because at that point the organization is
over its allowance for the day and retrying makes it worse. The cron
trigger's next invocation simply fails too, and the log shows
`sweep failed`.

### A Durable Object hits its storage limit

Survivable, and partly graceful.

A Durable Object that exceeds its storage limit fails new writes with
`SQLITE_FULL`. Reads and deletes still work: SQLite can read existing pages
and reclaim space from deleted rows. So the agent's transcript becomes
read-only — the agent can still be queried, and `GET /api/agents/{id}` still
returns its identity, permissions and transcript preview, but it cannot
record new entries, new inbox items or new checkpoints.

What the codebase does with that is limited. The failure surfaces as an
exception from the pi-durable write, which is logged (`pi reported a
failure` via the harness's `onReport`, or an error log from the call site),
and the task in D1 is left open until the coordinator's sweep re-issues it
and then fails it on its deadline. There is no specific handling of
`SQLITE_FULL`, no storage-level pruning of the transcript, and no alert.
(pi-durable's compaction reduces the *model context*, not the stored
entries, so it does not free storage.)

The practical remedy is to replace the agent with a successor
(`POST /api/agents/{id}/successor`): the successor inherits the role, the
permissions, the budgets and the open tasks, and starts with an empty
transcript, so it begins at 0 bytes instead of at the ceiling.

## What would break first

In rough order of likelihood for a real deployment:

1. **The Workers AI daily allocation (10,000 neurons/day).** This is the
   most likely first failure, because a model call per task is expensive
   relative to a free daily allocation, and one agent with a long context
   uses more than one might expect. Symptoms: tasks failing with a
   `model_error` reason and `task.failed` events. What to do: set
   `MODEL_PROVIDER=faux` to keep the organization running deterministically
   while you investigate; lower `THINKING_LEVEL`; use a smaller model for
   `MODEL_REVIEWER` than for `MODEL_ENGINEER`; or upgrade to Workers Paid.
2. **The D1 daily write limit (100,000 rows/day).** Reachable at roughly
   5,000–6,000 tasks a day, depending on how many events and tool calls each
   task produces. Symptoms: tool calls failing with a D1 error, tasks failing
   with a deadline reason. What to do: reduce the number of obligations, raise
   their intervals, or archive the `events` table — it is an append-only log
   that grows with every event the organization records, and it has three
   indexes on it (`events_task`, `events_agent`, `events_type`).
3. **A Durable Object's 1 GB storage limit.** Reachable for a single
   long-lived agent with a very large transcript, over months of continuous
   work. Symptoms: `SQLITE_FULL`, an agent that cannot record new work,
   tasks that stall and then fail on their deadline. What to do: replace the
   agent with a successor (`POST /api/agents/{id}/successor`), which starts a
   fresh transcript and inherits the commitments.
4. **The daily request limit (100,000/day).** Unlikely at any plausible
   workload — the estimate above puts 1,000 tasks a day at roughly 23% of
   the allowance — but it becomes reachable if the alarm heartbeat is
   multiplied by a large number of concurrently busy agents. What to do:
   check `npx wrangler tail` for alarm churn and reduce the number of
   agents doing work at once.
5. **The 15-minute Durable Object wall-time limit.** A single sweep that
   runs many obligations, or a model run that waits a long time, can hit it.
   The outcome is a terminated invocation with the work resumable from D1,
   so it is an interruption rather than a loss.

## Upgrading

Workers Paid is an upgrade, not a requirement. The whole project runs on Free
as written: SQLite-backed Durable Objects, one class, one D1 database, one
cron trigger, Workers AI inside the daily allocation.

What changes on Paid:

| | Free | Workers Paid |
| --- | --- | --- |
| CPU per Worker request | 10 ms | 5 minutes (30 s default) |
| CPU per Cron Trigger | 10 ms | 5 minutes (30 s default) |
| Daily request cap | 100,000 | none |
| Durable Object storage per object | 1 GB | 10 GB |
| Durable Object storage per account | 5 GB | higher |
| Durable Object classes | 100 | 500 |
| Workers AI beyond 10,000 neurons/day | not available | $0.011 per 1,000 neurons |

What does **not** change: the architecture. The Worker still only
authenticates, routes and hands off. Every agent is still one Durable Object
whose name is its agent id. The shared state is still in D1. The transcript is
still in the agent's own SQLite database. The permissions model, the budgets,
the idempotency keys, the event log and the approval gate are all unchanged.
Nothing in this repository has a "paid plan" code path, and nothing in it
would need one.

## Sources

- Workers limits (requests, CPU, memory, subrequests, connections):
  https://developers.cloudflare.com/workers/platform/limits/
- Durable Objects limits (CPU per invocation, wall time, storage, classes,
  SQLite backend availability):
  https://developers.cloudflare.com/durable-objects/platform/limits/
- D1 limits (storage, rows read and written per day, database count and size,
  and the behaviour of exceeding the daily limits since 2026-09-01):
  https://developers.cloudflare.com/d1/platform/limits/
- Workers AI pricing (the Free allocation and the per-neuron price beyond it):
  https://developers.cloudflare.com/workers-ai/platform/pricing/
- Workers AI limits (model-specific rate limits):
  https://developers.cloudflare.com/workers-ai/platform/limits/

The limit values in this document are quoted from those pages as they stood in
October 2026. Cloudflare changes them; re-check before relying on a number.
