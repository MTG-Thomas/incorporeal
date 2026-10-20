# Roadmap

Things this repository deliberately does not do yet, and what it would take.
Each item is a real gap or a natural extension, not a wish list.

## Organization

- **More than one goal per agent.** A goal is currently delegated to a single
  investigation. Goals could carry their own acceptance criteria, and the
  coordinator could judge them against those criteria.
- **Task dependencies.** Tasks are independent. A "review" knows which task it
  reviews, but nothing expresses "this must finish before that starts".
- **Budgets are ceilings, not allocations.** A per-task tool-call ceiling, a
  per-task token ceiling and a per-agent daily tool-call ceiling are
  enforced, and a task that passes its token ceiling is failed with the
  reason. There is no organization-wide budget that the coordinator divides
  between agents, and no reservation of one agent's share for another.
- **Cost accounting in currency.** pi-durable reports cost per model call, and
  it is stored on the task, but the organization's own cost of running is not
  aggregated across agents and days.

## Knowledge

- **Shared knowledge is a flat list.** `org_read_knowledge` returns the most
  recent entries. There is no search, no linking, and no notion of a
  superseded decision. A minimal interface — a `supersedes` field and a
  title/body search — would cover most real use without a vector store.
- **Knowledge is not fed back to agents automatically.** An agent has to ask
  for it. The prompt section is deliberately static, because a section that
  changes on every request defeats prompt caching; a good middle ground is
  to pin the relevant decisions into the task instruction when it is created.

## Execution

- **The execution backend reports back, but it does not wait.** A submitted
  run is reconciled by the coordinator's sweep, so it ends as `succeeded` or
  `failed` in the store. An agent cannot *wait* for a run it started: there
  is no poll-and-collect tool, and no way for a run's output to come back
  into a conversation.
- **No repository access.** The engineer cannot read the repository it is
  asked to fix. The Agents SDK's `@cloudflare/computer` workspace provides
  files, `exec` and `git` inside a Durable Object, and is the natural
  integration point; it is deliberately not wired in here because it is a
  larger surface than this MVP needs.
- **Sandboxed execution beyond GitHub Actions.** Cloudflare Containers would
  give a first-party sandbox, but it is a Workers Paid feature and would make
  the MVP require a paid subscription, which this project refuses to do.

## Model providers

- **One provider per deployment.** The Agents SDK's `createAI` handles Workers
  AI and the AI Gateway catalog; the harness does not route a single agent to
  two providers at once.
- **No per-role fallback chain.** `ai(id, { fallback })` exists in the SDK, and
  the harness does not use it: a role has one model, and when that model is
  unavailable the run fails, the task is marked failed with the reason, and
  the coordinator escalates. A fallback chain would turn a transient provider
  outage into a non-event.

## Observability

- **The event log is append-only and unbounded.** It is cheap to read and
  cheap to write, but it grows forever. A retention policy (or a periodic
  roll-up into a summary row) would be needed before long-running use.
- **No tracing.** The event log and the structured logs carry correlation ids,
  and pi-durable can emit OpenTelemetry spans, but nothing joins a model's
  internal spans to an organizational event yet.

## Durability

- **The event log is not the audit trail of record.** The Durable Object's
  SQLite is. The event log in D1 is a convenience for inspection; it is not
  tamper-evident and not transactional with the tasks it describes.
- **Reconciliation is a sweep, not a protocol.** An agent reconciles the
  shared store with its own state when it starts, and the coordinator sweeps
  for stalled work every fifteen minutes. A tighter protocol — a per-agent
  lease renewed while work is running — would detect a dead agent faster than
  a deadline.

## Platform

- **No Wrangler environments.** The configuration has one environment. A
  `staging` environment would let a change be rehearsed against its own D1
  database and its own Durable Object namespace.
- **No R2.** Artifacts are stored as JSON in D1. A plan or a diff larger than
  a comfortable row belongs in R2, with the row holding the reference.
- **One class, many agents.** A hundred Durable Object classes are available
  on Free and one is used. Distinct classes per role would let the platform
  schedule them differently, at the cost of a migration per new role.
