# ADR 0001: Durable agents on Durable Objects with pi-durable

## Status

Accepted

## Context

The system needs agents that outlive the request that woke them. An agent has
an identity, a role, a set of permissions and a working memory. It must
survive an eviction, a deploy, and the gap between one instruction and the
next. It must also be able to act on its own, without a human present.

Cloudflare Workers Free constrains the choice. A Worker invocation gets about
10 ms of CPU; a Durable Object invocation gets 30 s of CPU and roughly 15
minutes of wall time. SQLite-backed Durable Objects are the only storage
backend on the Free plan, which allows 100 Durable Object classes. Workers AI
grants 10,000 neurons per day.

The agent runtime already exists. `@earendil-works/pi-durable` provides a
durable harness over SQLite: a transcript, an inbox, sessions, a running
generation, checkpoints and idempotent submissions keyed by an operation id.
The Cloudflare `agents` package provides `PiHarness`, a `Lifecycle` for
Durable Objects, and a model registry. The question is what to build on.

## Decision

Every agent is a Durable Object of a single class, `OrgAgent`. The Durable
Object's **name** is the agent id. Its working memory lives in that object's
own SQLite database, through pi-durable's `Harness.open()` as adapted by the
Agents SDK's `PiHarness`.

The Worker is ingress and scheduler only: it authenticates, routes and hands
off, and holds no agent state.

Two consequences follow from one class. The class count stays at one, far
below the Free-plan limit of 100. And an agent can be replaced without a
migration: `POST /api/agents/{id}/successor` retires the old row, creates a
new object under a new id, and moves the goals, obligations and open tasks
across. The new agent starts with an empty working memory — the commitments
move, the transcript does not.

Because the Durable Object is the unit of durability, a task's model run is
submitted under a stable operation id, `task:<task_id>`. A replay after an
interruption rejoins the run already under way instead of starting a second
one. On every start the agent reconciles the shared store with its own state
and rejoins any assignment it still owns.

## Consequences

The agent survives eviction without losing its identity, its permissions or
its memory. The platform handles the wake-up: an agent is addressed by name
and the runtime restores it.

### What this makes harder

- Durable Object RPC is the only way one agent addresses another, so the
  coordination protocol is coupled to the platform's RPC semantics.
- Every agent shares one class, so a defect in the harness affects every
  agent. Isolation comes from the identity row, not from separate classes.
- SQLite-backed Durable Objects are a Free-plan constraint; moving to a paid
  plan means revisiting the storage decision, not just the billing tier.
- Replacing an agent means moving state by hand in the API layer, because the
  platform has no notion of transferring one object to another.

## Alternatives considered

- **One class per role.** Rejected: it triples the class count for no
  benefit, and it makes adding a role a migration.
- **D1 only, with the agent as a plain row.** Rejected: no per-agent working
  memory, no inbox, and no in-flight operation to rejoin after an eviction.
- **The Agents SDK's default `Agent` class.** Rejected: it is designed for a
  chat-shaped agent with WebSocket and HTTP surfaces; this system needs a
  batch-shaped agent that reports into a shared task board.
- **Cloudflare Queues or Workflows for the handoffs.** Deferred, not
  rejected: they would give retry and backpressure for free, but the Durable
  Object already provides the durability they would add.
