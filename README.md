# Incorporeal

A small organization of persistent, proactive AI agents that runs on
**Cloudflare Workers Free**.

Three agents — a **Coordinator**, an **Engineer** and a **Reviewer** — hold
real obligations, accept work asynchronously, hand it to each other, review
each other's output, and ask a human when something is consequential. They
survive restarts, they sleep when idle, and they act on a schedule without
being prompted.

> **The central principle: agents are durable members of an organization, while
> tasks, model calls and execution environments are disposable.**

Nothing here needs a paid Cloudflare plan. See [docs/free-tier.md](docs/free-tier.md)
for the exact limits the design is built around, and what happens when one of
them runs out.

---

## What it actually does

```
                 ┌──────────────────────────────────────────────┐
  webhook ───▶  │  Worker: authenticate, route, hand off        │  (10 ms CPU on Free)
  cron     ───▶  └───────────────┬──────────────────────────────┘
                                 │  Durable Object RPC
              ┌──────────────────▼───────────────────┐
              │  Coordinator  (Durable Object)        │  owns goals, delegates,
              │  pi-durable session + inbox + tasks   │  detects stalls, escalates
              └───────┬──────────────────────┬────────┘
                      │ task                │ task
              ┌───────▼────────┐     ┌───────▼────────┐
              │ Engineer       │     │ Reviewer       │
              │ investigates,  │     │ assesses,      │
              │ runs code,     │     │ asks for       │
              │ reports        │     │ corrections    │
              └───────┬────────┘     └───────┬────────┘
                      └──────┬───────────────┘
                             │ result
                     ┌───────▼────────┐
                     │  D1: the      │  agents, goals, tasks, obligations,
                     │  shared state │  approvals, knowledge, events
                     └────────────────┘
```

Each agent is a Durable Object whose **name is the agent id**. The transcript,
the inbox, the running generation and the task checkpoints live in that
object's own SQLite database, through [pi-durable](https://github.com/earendil-works/pi/tree/main/packages/durable)
and the Agents SDK's `PiHarness`. The organization itself — who the agents
are, what they owe each other, what is running, what was decided — lives in
D1, so any agent can be replaced without losing the organization's
commitments.

## The three agents

| Agent | Holds | May do | May not do |
| --- | --- | --- | --- |
| **Coordinator** | goals, assignments, deadlines | create and delegate tasks, ask a human to approve | run code itself |
| **Engineer** | its own working memory | investigate, report, run code through an execution backend | delegate, approve |
| **Reviewer** | its own working memory | read the engineer's work, report findings, recommend accept / request changes / escalate | write tasks, delegate, approve, execute |

The reviewer cannot approve its own work: it has no permission to delegate,
approve or execute, and a review is always attached to the task it assesses,
never to the agent that produced it.

The coordinator also gets a small planning task of its own when a goal
arrives, so its model can delegate something narrower or deeper than the
default investigation. The default investigation does not wait for it.

## Wake mechanisms

The organization does not wait to be spoken to. It wakes in three ways:

1. **An inbound event.** `POST /api/webhooks/{source}` turns an external
   system into a goal, which the coordinator turns into bounded work.
2. **A scheduled obligation.** The coordinator sweeps its obligations every
   15 minutes. A deterministic check (a failing CI workflow, for example)
   produces a finding, and a finding becomes a task — deduplicated by
   fingerprint, so the same failure never stacks duplicate work.
3. **An asynchronous assignment.** When the engineer finishes, the coordinator
   gives the reviewer a review. The handover is a row in D1 plus a Durable
   Object call; it is not a chat between agents.

A stalled assignment — one that passes its deadline without finishing — is
detected by the same sweep, re-issued once, and then escalated.

## Quick start (local)

Requirements: Node 22.19 or newer, and a Cloudflare account only if you
intend to deploy. The test suite and the local dev server both run the real
Workers runtime locally.

```sh
npm install
cp .dev.vars.example .dev.vars      # choose a local token and webhook secret
npm run dev                          # http://localhost:8787
```

Drive it:

```sh
export ORG_URL=http://localhost:8787
export ORG_API_TOKEN=<the token from .dev.vars>

node scripts/orgctl.mjs goal-add --title "Keep the test repo healthy" \
  --description "Investigate the failing workflow and propose a fix."
node scripts/orgctl.mjs tasks
node scripts/orgctl.mjs events
```

The local dev server uses Workers AI by default. To run the whole loop with
no model provider and no account at all, set `MODEL_PROVIDER=faux` in
`.dev.vars`: the agents then answer from a deterministic script and the
organization still does its real work — delegation, review, approval,
recovery.

## Deploying to Cloudflare

```sh
# 1. The shared store.
npx wrangler d1 create incorporeal
#    → copy the printed database_id into wrangler.jsonc

# 2. The schema.
npx wrangler d1 migrations apply incorporeal --remote

# 3. The secrets. The management API and the webhooks use different ones.
npx wrangler secret put ORG_API_TOKEN
npx wrangler secret put WEBHOOK_SECRET

# 4. Deploy.
npx wrangler deploy
```

Then point the CLI at it:

```sh
export ORG_URL=https://incorporeal.<your-subdomain>.workers.dev
export ORG_API_TOKEN=<the token you set>
node scripts/orgctl.mjs agents
```

The whole runbook, including the optional GitHub integration, is in
[docs/operations.md](docs/operations.md).

## Configuration

Secrets (`wrangler secret put`):

| Variable | Meaning |
| --- | --- |
| `ORG_API_TOKEN` | Bearer token for the management API. Every agent-control endpoint requires it. |
| `WEBHOOK_SECRET` | Shared secret for inbound webhooks. A different trust boundary from the API token. |

Configuration (`vars` in `wrangler.jsonc`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `MODEL_PROVIDER` | `workers-ai` | `workers-ai` or `faux` (a deterministic, credential-free stand-in). |
| `MODEL_DEFAULT`, `MODEL_COORDINATOR`, `MODEL_ENGINEER`, `MODEL_REVIEWER` | Workers AI ids | The model each role uses. |
| `THINKING_LEVEL` | `low` | `off`, `minimal`, `low`, `medium`, `high`. |
| `EXECUTION_BACKEND` | `simulated` | `simulated`, `github-actions` or `none`. |
| `REPO_PROVIDER` | `simulated` | Where the deterministic repository check looks: `simulated` or `github`. |
| `SIMULATED_REPO_STATE` | a failing CI run | The state the simulated check reads. |
| `GITHUB_TOKEN`, `GITHUB_REPO`, `GITHUB_WORKFLOW` | — | The optional GitHub integration. Costs GitHub Actions minutes, not Cloudflare credits. |

## The management API

Every route needs `Authorization: Bearer $ORG_API_TOKEN`, except the health
check and the webhook route (which uses `X-Webhook-Secret`).

| Method | Path | What it does |
| --- | --- | --- |
| `GET` | `/api/health` | Liveness. No token. |
| `GET` | `/api/agents` | The roster: every agent, its role and its status. |
| `GET` | `/api/agents/{id}` | One agent: identity, permissions, open tasks, usage, transcript preview. |
| `POST` | `/api/agents/{id}/note` | Send a message to an agent. |
| `POST` | `/api/agents/{id}/successor` | Replace an agent with a successor that inherits its duties. |
| `GET` | `/api/goals` · `POST` | List and create goals. A new goal makes the coordinator delegate. |
| `GET` | `/api/goals/{id}` | One goal and its tasks. |
| `GET` | `/api/tasks` · `/api/tasks/{id}` | The task board, filterable by status, assignee and goal. |
| `GET` | `/api/tasks/{id}/events` · `/api/events` | The inspectable history: who did what, why, and when. |
| `GET` | `/api/obligations` · `POST` | The recurring obligations. |
| `POST` | `/api/obligations/{id}/run` | Run the coordinator's sweep now: the obligations and the stall check. |
| `GET` | `/api/approvals` · `POST /api/approvals/{id}` | What is waiting for a human, and the decision. |
| `GET` | `/api/knowledge` | The shared knowledge: decisions, conventions and verified findings. |
| `POST` | `/api/webhooks/{source}` | An inbound event becomes a goal. |
| `POST` | `/api/sweep` | Run the coordinator's sweep now. |

## Guarantees the tests check

The suite runs inside `workerd` with real Durable Objects, real D1 and real
alarms — not mocks. It proves, among other things:

- an agent sleeps and wakes with its identity, permissions and memory intact;
- an assignment made while the agent was down is picked up when it wakes;
- a message is not lost across an interruption;
- an external action is not run twice after a replay;
- a stalled assignment is detected, re-issued, and eventually given up on;
- a reviewer can send findings back to the engineer, which starts rework;
- a successor inherits the organization's duties without inheriting the
  predecessor's transcript;
- a recurring obligation never stacks duplicate work.

```sh
npm test        # the integration suite
npm run check   # typecheck + tests
```

## The definition of done, and where it stands

| # | What was asked for | Where it is |
| --- | --- | --- |
| 1 | Deploy to my Cloudflare account | `npx wrangler deploy`; the runbook is [docs/operations.md](docs/operations.md) |
| 2 | See three stable, independent agent identities | `GET /api/agents` — one Durable Object each, addressed by name |
| 3 | Assign a repository goal to the coordinator | `POST /api/goals`, or `orgctl goal-add` |
| 4 | Observe the coordinator delegate work | A task row with an owner, a deadline and an attempt limit, and an event saying who created it |
| 5 | Observe the engineer produce a useful artifact | The engineer's report, its evidence, and the artifact it recorded |
| 6 | Observe the reviewer independently assess it | A review task owned by a different agent, with findings and a recommendation |
| 7 | Interrupt an agent and verify recovery | `evictDurableObject` in the test suite; the agent rejoins its open assignments |
| 8 | Let a scheduled obligation start work without prompting | The cron trigger, the obligation sweep, the deterministic check, the finding, the task |
| 9 | Inspect who did what, why and at what cost | `GET /api/tasks/{id}/events`, the structured logs, the usage on each task |
| 10 | Replace an agent without losing its duties | `POST /api/agents/{id}/successor`: the duties move, the transcript does not |

## What this is not

- Not a multi-tenant SaaS platform, a Kubernetes deployment, or a web console.
- Not a bespoke message broker: D1 rows and Durable Object calls are the
  coordination mechanism, because Cloudflare already has good ones.
- Not a new agent harness: [pi-durable](https://github.com/earendil-works/pi/tree/main/packages/durable)
  provides the durable execution, and the Agents SDK provides the Durable
  Object lifecycle. This repository is the organization around them.
- Not autonomous: anything that changes the outside world waits for a human,
  and a human approves a **specific action** — the command, and optionally
  the arguments, the backend, the repository and the branch — not a task.

The honest gaps are listed in [docs/architecture.md](docs/architecture.md)
under "known limitations", and the design decisions are in
[docs/adr](docs/adr).

## Layout

```
src/
  index.ts            the Worker: ingress, authentication, the cron trigger
  api/routes.ts       the management API
  agents/
    org-agent.ts      the Durable Object: one persistent agent
    tools.ts          the tools a model can use, and the policy that guards them
    identity.ts       who an agent is, and what it may do
    docs.ts           the agent's private, durable state
    faux.ts           the deterministic model used by the tests and by demos
  db/org.ts           the shared store: agents, goals, tasks, obligations, approvals
  policy/             permissions and budgets
  execution/          pluggable execution backends
  checks/             the deterministic repository checks
test/                 integration tests, inside workerd
docs/                 architecture, ADRs, the free-tier budget, the runbook
```

## Authentication

The deployment is gated in two layers. **Cloudflare Access** sits in front of
the Worker, so an unauthenticated visitor never reaches the application, and
the Worker learns *who* the caller is — which is what an approval records.
The **management token** still applies: Access answers "is this an
authenticated human?" and the token answers "is this an authorized
management client?", and both have to agree. See
[docs/access.md](docs/access.md).

The model provider is a separate concern, and equally gated: the API key or
the ChatGPT subscription credential is written through the management API,
stored in the shared store, read only by the agent that is about to call the
provider, and never returned by the API. See
[docs/providers.md](docs/providers.md).

## Running it somewhere else

The organization was also stood up on
[celld](https://github.com/denoland/celld), the self-hosted Durable Objects
runtime, and the whole chain ran there with **no product code changed**: the
Agent SDK's `PiHarness` boots in a celld Durable Object, the pi-durable
SQLite adapter works verbatim, and D1's `meta.changes` behaves the same way
for the conditional updates the race discipline depends on. The delta is a
configuration file, a bucket and a migration command. What was verified, and
what was not, is in [docs/celld.md](docs/celld.md).

## Licence

MIT. See [LICENSE](LICENSE).
