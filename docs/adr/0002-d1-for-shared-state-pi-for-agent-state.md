# ADR 0002: D1 for shared state, pi for agent state

## Status

Accepted

## Context

The system has two kinds of state, with opposite properties.

The first is organizational: who the agents are, what goals exist, what work
is owed and to whom, what was decided, what was executed, what happened.
This state is relational. A task references a goal, an assignee, a creator, a
parent task, a review and an approval, and every agent reads the same rows.

The second is agent-private: the pi-durable transcript, the inbox, the
sessions, the running generation, the checkpoints and the record of which
organizational task the agent is working on (`AssignmentDoc`). This state is
append-heavy, unstructured, and meaningful only to the agent that wrote it.

The temptation is to use one store for both. Which store should hold which?

The chat transcript is a particularly tempting candidate for the task
database, because a model reads and writes tasks in natural language there.
It should not be.

## Decision

Split the state.

**D1 holds the shared operational state**: agents, goals, tasks, obligations,
approvals, shared knowledge, executions, per-agent usage and the event log.
The schema is `migrations/0001_init.sql`.

**Each agent's own Durable Object SQLite database holds its private state**,
owned by pi-durable through `PiHarness`. Nothing else writes there.

D1 is the right home for the shared state because it is genuinely relational
and shared, and because correctness depends on conditional multi-row updates.
A late assignment must not pull a completed task back to `running`; a
replayed approval decision must not overwrite a human's earlier choice; two
overlapping sweeps must not both run the same obligation. These are settled
with conditional SQL — `markTaskRunning` updates only `WHERE status NOT IN
('completed', 'failed', 'cancelled')`, `decideApproval` only `WHERE status =
'pending'`, `claimObligation` only when the lease has expired. Uniqueness is
enforced by indexes: one review per source task, one open task per finding
fingerprint, one task per chain step, one execution per idempotency key.

The transcript is not the task database because it is the wrong shape for
every question the organization asks. It is per agent, so it cannot be
queried across agents. It is unstructured, so it cannot enforce a uniqueness
rule. It is not shared, and must not be: a successor agent inherits the
organization's commitments but starts with an empty working memory, and the
test suite asserts the predecessor's transcript does not leak into it.

## Consequences

The two stores can be reasoned about separately, and each is small enough to
reason about at all. The split is also what makes agent replacement cheap:
the successor inherits the D1 rows and nothing else, so there is no
transcript migration.

### What this makes harder

- Two stores mean two consistency stories. A task's D1 row and the
  assignment document in the agent's SQLite are updated separately; a crash
  between them leaves the agent to rejoin the task on its next start. The
  code accepts this and makes the recovery path explicit.
- D1 is one database for the whole deployment. There is no partitioning and
  no per-agent isolation of writes.
- Cross-store queries are impossible. Anything needing both "what the agent
  said" and "the state of the task" is joined in application code, not SQL.
- The event log in D1 grows without bound; there is no retention policy.

## Alternatives considered

- **All state in D1, transcripts included.** Rejected: the transcript is
  append-heavy and agent-private, and it would make agent replacement require
  copying rows between two logical agents.
- **All state in the Durable Object, broadcast for shared state.**
  Rejected: coordination state that every agent must read consistently does
  not belong behind an agent's private storage, and broadcasts are a push
  model, not a query model.
- **KV for shared state.** Rejected: no multi-row transactions and no
  conditional update with a read-modify-write check, which the
  race-sensitive transitions here need.
