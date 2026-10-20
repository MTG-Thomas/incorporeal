# ADR 0003: The Free plan is the deployment target

## Status

Accepted

## Context

Most agent systems are designed on a paid plan and deployed on one. The
constraints of the free tier are discovered late, and they reshape the
architecture.

This system inverts that. The Workers Free plan is the deployment target, and
its limits are design inputs rather than an afterthought:

- A Worker invocation gets roughly 10 ms of CPU. A Durable Object invocation
  gets 30 s of CPU and about 15 minutes of wall time.
- SQLite-backed Durable Objects are the only storage backend available.
- The plan allows 100 Durable Object classes.
- Workers AI grants 10,000 neurons per day.
- Cron triggers are coarse. The repository uses one, at `*/15 * * * *`.

These numbers are not negotiable in the code. They decide where work runs,
how state is stored, how many classes exist, and how the model budget is
protected.

## Decision

Design every part of the system against those limits, and say so in the code.

**The Worker is ingress and scheduler only.** It authenticates, routes and
hands off, and holds no agent state. A model call, a tool loop and a
multi-agent handshake all need far more than 10 ms, so none of them happen in
a Worker invocation. The comment at the top of `src/index.ts` says so.

**The cron trigger does the least possible work.** It asks the coordinator's
Durable Object to `runSweep()`. The sweep — running due obligations, running
a repository check, turning findings into tasks, detecting stalled
assignments — happens inside the Durable Object, with its 30 s of CPU instead
of 10 ms. Handing off to one addressable agent is also why the trigger can
address a single object: `runSweep()` checks the caller's role and returns
immediately for anyone who is not the coordinator.

**One Durable Object class.** Identity comes from the object's name, not its
class, so all agents share one class. That keeps the count at one instead of
three and leaves the Free-plan budget of 100 untouched.

**Budgets that degrade rather than fail.** The per-task tool-call ceiling
(`agents.max_tool_calls`, default 20) and the per-agent daily ceiling
(`DAILY_TOOL_CALL_LIMIT = 200`) are charged on every tool call, whether or
not the call then succeeds, so a failing task cannot drain the shared
allocation. When a ceiling is reached the tool refuses the call with a normal
error result: the model can report what it has and stop.

**Deterministic substitutes for anything that costs money.** The model
provider can be `faux` instead of Workers AI, the execution backend
`simulated` instead of GitHub Actions, and the repository check `simulated`
instead of GitHub. A deployment can therefore demonstrate the whole proactive
loop with no external account and no allocation. Cloudflare Containers are
excluded for the same reason: they are a Workers Paid feature.

## Consequences

The system runs on the Free plan end to end, and a new deployment needs only
a D1 database, two secrets and a Workers AI binding.

### What this makes harder

- The 10 ms Worker budget forbids doing anything useful in the request path.
  Every feature must be expressible as "write a row, then hand off", which
  is more indirection than a straightforward handler.
- One class means a defect in the harness affects every agent, and per-role
  isolation must come from the identity row rather than separate classes.
- The daily tool-call ceiling is blunt: it stops the organization from
  spending the shared allocation, but not one agent from consuming its share
  before the others have had a turn.
- The 15-minute cron cadence means a scheduled obligation can be up to 15
  minutes late. Fine for CI-failure detection; not fine for a
  latency-sensitive trigger.

## Alternatives considered

- **Design for Paid, deploy on Free.** Rejected: it produces a system whose
  architecture assumes things the Free plan lacks, and the failure appears at
  deployment time rather than at design time.
- **Call Workers AI directly from the Worker.** Rejected: 10 ms of CPU does
  not fit a model call plus a tool loop.
- **A separate scheduler service outside Cloudflare.** Rejected: it adds an
  always-on component and a failure mode the Durable Object sweep does not
  have.