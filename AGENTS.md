# AGENTS.md

Incorporeal is an organization of persistent, proactive agents that runs on
Cloudflare Workers Free. This file is what an agent needs in order to work on
this repository — which is, deliberately, the same kind of instruction the
agents give each other.

## What this repository is

- A Cloudflare Worker (`src/index.ts`) that authenticates, routes and
  schedules, and does nothing else.
- One Durable Object class (`src/agents/org-agent.ts`) that hosts every agent.
  The object's **name is the agent id**: `coordinator`, `engineer`,
  `reviewer`.
- One Durable Object per agent, each with its own SQLite database, holding
  that agent's pi-durable transcript, inbox, running generation and task
  checkpoints.
- One D1 database (`migrations/0001_init.sql`) holding what the organization
  shares: agents, goals, tasks, obligations, approvals, knowledge, executions
  and the event log.

The full design is in [docs/architecture.md](docs/architecture.md) and the
decisions are in [docs/adr](docs/adr).

## Commands

```sh
npm install          # Node 22.19 or newer
npm run typecheck    # tsc --noEmit, strict
npm test             # the integration suite, inside workerd
npm run check        # typecheck + tests: the gate before a commit
npm run build        # bundles the worker without deploying
npm run dev          # the local Worker, on http://localhost:8787
npm run deploy       # deploys to the Cloudflare account
node scripts/orgctl.mjs --help   # the operator's console
```

The tests run the real Durable Objects, the real D1 and real alarms inside
`workerd`. They are not mocks, and a change that breaks recovery should break
a test.

## Rules for anyone working here, human or agent

1. **The Free plan is a design constraint, not a preference.** A Worker
   invocation gets 10 ms of CPU; a Durable Object gets 30 s. Real work belongs
   in a Durable Object. Do not introduce Cloudflare Containers, Queues or
   Workflows without saying why the existing primitives do not do the job.
2. **The transcript is not the task database.** Organizational state lives in
   D1. A task's status, owner, attempts and result are rows, not conversation.
3. **Permissions are data, checked on every call.** A tool re-reads the
   agent's row in D1 inside `execute()`; being offered a tool is a
   convenience, not the control. A model's instruction is never authority.
4. **Every externally consequential action is idempotent and gated.** A
   replay after an interruption must not run it twice: use a unique
   idempotency key, and put the action behind a human approval.
5. **A behavioural change needs a test** that fails without the change, using
   the platform's real behaviour where the claim is about durability.
6. **Never log a secret.** The log helper takes ids, counts and labels. If a
   value cannot be logged safely, it does not go in the log.
7. **The schema changes with a migration.** D1 is not the local test
   database; a change to `migrations/` needs `npx wrangler d1 migrations
   apply incorporeal --remote` after it is deployed.

## Conventions

- TypeScript, strict, `noUncheckedIndexedAccess`. No `any` where a real type
  exists.
- No runtime dependencies beyond `agents`, `@earendil-works/pi-durable` and
  `@earendil-works/pi-ai`. The CLI is dependency-free on purpose.
- Comments explain *why*, not *what*. A comment that contradicts the code is
  worse than no comment.
- Errors are values: a refusal is a normal error result with a reason, not a
  crash and not a silent success.
- Logs are JSON, one object per line, with `correlationId`, `agentId` and
  `taskId` where they apply.

## Working on this repository with this organization

The organization can act on this repository. The path is:

1. A goal is created (`POST /api/goals`, or `orgctl goal-add`).
2. The coordinator delegates an investigation to the engineer.
3. The engineer investigates and reports; if it needs to run something, it
   calls `org_run_execution`, which dispatches
   `.github/workflows/agent-task.yml` with a command from the allowlist
   (`test`, `typecheck`, `check`, `build`). A model cannot run an arbitrary
   shell command here: the workflow matches the input against that list and
   refuses anything else.
4. The reviewer assesses the result independently and recommends accept,
   changes, or escalation.
5. The apply step waits for a human (`POST /api/approvals/{id}`), and only
   then does anything happen outside the organization.

To run that loop against this repository, set:

```
GITHUB_TOKEN=...        # a token with actions: read and write
GITHUB_REPO=<owner>/<repo>
GITHUB_WORKFLOW=agent-task.yml
EXECUTION_BACKEND=github-actions
```

## Before you call it done

- `npm run check` passes.
- The change is covered by a test that would fail without it.
- The docs that describe the change were updated with it: this file,
  `README.md`, `docs/architecture.md`, `docs/free-tier.md` and
  `docs/operations.md` are all claims about the code, and a stale claim is a
  defect.
