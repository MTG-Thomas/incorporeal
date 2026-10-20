# ADR 0005: The approval waits as a task, not as a stopped chain

## Status

Proposed (deferred). The current implementation is described under
"the approval gate" in [docs/architecture.md](../architecture.md); this
records the alternative and the reason it is not adopted yet.

## Context

An approval in this organization is a row: a task is `blocked`, an
`approvals` row says `pending`, and when a human decides, the task is
assigned again and the agent starts a **new run**.

That works, and it is simple. It has three costs, which the sibling
project `disler/durable-pi` makes visible because it solves the same
problem with a different deployment model.

1. **The agent forgets why it wanted to act.** The run that asked for the
   approval has ended. The run that starts after the decision has the same
   transcript, but not the same context, and the reasoning that led to the
   specific action is not carried across.
2. **Waiting is not a state a tool can see.** `blocked` is a status on a
   row. In pi-durable, a task that waits is *parked*: it holds no invocation,
   it appears in the task graph as `waiting on <task ids>`, and it resumes
   from a checkpoint. The difference matters for durability: a checkpoint is
   resumed, an absence is re-derived.
3. **The approval is bound to a task, not to an action.** The human approves
   "this task may act", and the command is chosen by the model afterwards.

`disler/durable-pi` answers (3) by binding the approval to a specific
commit and a diff, and answers (1) and (2) by making the deploy a durable
pi task that owns the wait: the tool call creates a child task, the parent
parks on it, and the child's phase polls a committed document until the
human decides. Killing the backend during the wait leaves the same task
waiting.

## Decision

Not yet. The mechanism is portable — pi-durable's `waiting` state, the
`on`/`policy` join and the checkpoint all exist in the version this project
uses — but the **cost profile is not**, and the difference is decisive.

`disler/durable-pi` runs a Node process on a machine the user owns. A
process can sit idle for an hour for free. Here, the agent is a Durable
Object: a live task keeps the object's lifecycle job heart-beating, a
Durable Object alarm is a request against the Workers Free allocation, and
a request has a wall-clock limit measured in minutes, not hours. Parking a
task for a human decision means holding a Durable Object alive, and
"alive" is exactly the thing the Free plan charges for.

Before this is adopted, the following must be measured, not assumed:

- the wall-clock and request cost of a Durable Object kept alive by a
  pending approval, over the distribution of human decision times;
- whether pi's `waiting` state truly parks without an invocation under the
  Agents SDK's `PiHarness` lifecycle job, or whether the heartbeat keeps
  running anyway;
- the number of approvals a single organization can have outstanding at
  once without exhausting the daily request allocation.

The smaller parts of the idea are adopted already, and are not deferred:
the approval is bound to the task's action rather than to the task in
general (an execution needs an approved request on the task, whatever the
task's own flags say), and the external action is recorded under a unique
idempotency key so a replay cannot run it twice.

## Consequences

### What this makes harder

- A human decision that arrives after the object's request window closes
  needs the wait to survive an eviction, which the current implementation
  gets from D1 and the reconciliation sweep rather than from a checkpoint.
- Binding the approval to an *action* rather than to a task is a smaller
  step in the same direction, and it is the one that matters for safety.

### What this makes easier

- Nothing, yet. The deferred change would buy continuity across a human's
  thinking time, and a visible "waiting" state in the task graph.

## Alternatives considered

- **Keep the chain stopped (today).** The chain stops at a `blocked` task
  and the sweep and the approval API restart it. Simple, and it costs
  nothing while the approval is outstanding. This is the current state.
- **A durable task that waits, on this platform.** The mechanism from
  `disler/durable-pi`, with the cost measured first. Deferred for the
  reason above.
- **Ask the human inside the run.** The run would block on the decision.
  A Durable Object request has a wall-clock limit, so a human who takes
  longer than that loses the run. Rejected.
