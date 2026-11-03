# Operations runbook

This is the runbook for deploying and running Incorporeal: the resources you
create, the commands you run, the API you call, the things that go wrong and
what you do about them.

Every command and route below is taken from the repository. Where a command
depends on the deployed state, the state it depends on is stated.

## 0. The current deployment

This organization is deployed at

```
https://incorporeal.midtown-technology-group.workers.dev
```

with its own D1 database (`incorporeal`, id
`7a2b6d43-3a63-4586-bd1e-29c9238ce06c`). The management token and the
webhook secret are set as Worker secrets; the token is in the repository's
gitignored `.env` together with the URL, so the CLI finds both without any
setup:

```sh
node scripts/orgctl.mjs agents
```

Everything below is how to create a deployment like it, or to change this
one.

## 1. Prerequisites

| Requirement | Detail |
| --- | --- |
| Node.js | 22.19 or newer (`package.json` sets `engines.node >= 22.19`) |
| npm | Ships with Node |
| A Cloudflare account | Only needed to deploy. The test suite and `npm run dev` run entirely locally. |
| A Cloudflare Workers Paid plan | **Not** required. See [free-tier.md](free-tier.md). |
| A model provider | Not required for a credential-free run: `MODEL_PROVIDER=faux` answers from a deterministic script. The default is Workers AI, which is included in the Free allocation. |

Install the dependencies:

```sh
npm install
```

## 2. Create the Cloudflare resources

### 2.1 The D1 database

The organization's shared state — agents, goals, tasks, obligations,
approvals, knowledge, executions and the event log — lives in one D1
database.

```sh
npx wrangler d1 create incorporeal
```

The command prints the database's id. Open `wrangler.jsonc` and replace the
placeholder in the `d1_databases` binding:

```jsonc
"d1_databases": [
  {
    "binding": "ORG_DB",
    "database_name": "incorporeal",
    "database_id": "<the id printed by wrangler d1 create>",
    "migrations_dir": "migrations"
  }
]
```

The binding name is `ORG_DB` and it is what the code refers to
(`env.ORG_DB` in `src/env.ts`). The database name is `incorporeal`; the
commands below use it.

### 2.2 Apply the migrations

The schema is in `migrations/0001_init.sql` and `wrangler.jsonc` points
`migrations_dir` at `migrations`.

```sh
npx wrangler d1 migrations apply incorporeal --remote
```

This creates the tables `agents`, `goals`, `tasks`, `obligations`,
`approvals`, `knowledge`, `executions`, `agent_usage` and `events`, with
their indexes. Applying migrations is idempotent: re-running it applies only
what is pending.

Verify:

```sh
npx wrangler d1 execute incorporeal --remote --command "SELECT name FROM sqlite_master WHERE type='table'"
```

### 2.3 The secrets

Two secrets, for two different trust boundaries.

```sh
npx wrangler secret put ORG_API_TOKEN
npx wrangler secret put WEBHOOK_SECRET
```

- `ORG_API_TOKEN` is the bearer token for the management API. Every route
  except `GET /api/health` requires it.
- `WEBHOOK_SECRET` authorizes inbound webhooks (`POST /api/webhooks/{source}`),
  which come from an external system that does not hold the management token.
  It is sent in the `X-Webhook-Secret` header.

Choose two different long random values. They are compared in constant time
(`src/auth.ts`) and never logged. Keep them out of the repository.

### 2.4 Deploy

```sh
npx wrangler deploy
```

Wrangler prints the deployed URL, of the form
`https://incorporeal.<your-subdomain>.workers.dev`. The first deploy also
creates the Durable Object namespace, because `wrangler.jsonc` declares the
`OrgAgent` class with the `v1` SQLite migration.

Check it:

```sh
curl -s https://incorporeal.<your-subdomain>.workers.dev/api/health
```

The expected body is `{"status":"ok","env":"local"}` — `env` echoes
`ORG_ENV`, whose default in `wrangler.jsonc` is `local`. Change it to
`production` in `wrangler.jsonc` before deploying for real.

### 2.5 Cap model dollars with a spend rule (Workers Paid)

Past the free 10,000 neurons/day, every model call bills. The shipped
posture is **$0**: no paid inference until you say so.

1. In the Cloudflare dashboard, go to **AI > AI Gateway** and create a
gateway (for example `incorporeal`).
2. On that gateway, go to **Settings > Spend limits** and add a rule with
a **$0** budget. Every agent's calls carry its id as `agent_id` metadata,
so you can split the budget per agent later; start with one shared bucket.
3. Point the deployment at it:

   ```jsonc
   "vars": { "AI_GATEWAY_ID": "incorporeal" }
   ```

   Redeploy. `AI_GATEWAY_ID` empty or unset means the Workers AI binding is
called directly, exactly as before — including past the free allocation,
where it bills.

4. Verify live, because no test can prove these: send an agent a note
(`POST /api/agents/engineer/note`) and confirm the call succeeds inside
the free allocation, then check the gateway's analytics that the request
carried the `agent_id` metadata. Only then consider raising the $0 rule.

A blocked call answers `429` and settles through the existing `model_error`
path: the task fails with the reason, the event is recorded, and the
coordinator is notified. See "A spend rule is blocking model calls" below.

### 2.6 Point the CLI at it

`scripts/orgctl.mjs` is a dependency-free operator console for the
management API. It reads two environment variables:

```sh
export ORG_URL=https://incorporeal.<your-subdomain>.workers.dev
export ORG_API_TOKEN=<the token you set in step 2.3>

node scripts/orgctl.mjs agents
```

`npm run cli` is a shorthand for `node scripts/orgctl.mjs`. Run
`node scripts/orgctl.mjs --help` for the full command list.

## 3. Local development

```sh
npm install
cp .dev.vars.example .dev.vars
npm run dev
```

`npm run dev` is `wrangler dev`. It serves the worker on
`http://localhost:8787`, with the Durable Objects and D1 running locally
inside workerd.

### How `.dev.vars` works

`.dev.vars` is a gitignored file of `KEY=value` lines that `wrangler dev`
reads automatically. It holds **secrets only**: `ORG_API_TOKEN`,
`WEBHOOK_SECRET`, `GITHUB_TOKEN`, `GITHUB_REPO` and `GITHUB_WORKFLOW` are
the slots it offers. The non-secret
configuration — the model ids, `THINKING_LEVEL`, `MODEL_PROVIDER`,
`EXECUTION_BACKEND`, `REPO_PROVIDER`, `SIMULATED_REPO_STATE` — lives in
`wrangler.jsonc` under `vars`, so it is versioned and shared.

`.dev.vars.example` is the template. Copy it and replace the placeholder
values; never commit `.dev.vars` and never paste a real secret into the
example file.

To run the whole organization with no model provider and no account:

```sh
echo "MODEL_PROVIDER=faux" >> .dev.vars
```

The agents then answer from the deterministic script in `src/agents/faux.ts`
and the organization still does its real work: delegation, review, approval
and recovery.

### Running the tests

```sh
npm test
```

`npm test` is `vitest run`. The suite runs inside **workerd** through
`@cloudflare/vitest-plugin` (configured in `vitest.config.ts`), against real
Durable Objects and a real D1 database. Nothing is mocked except the model
itself, which is the point: the durability claims have to hold against the
platform's behaviour.

- `test/setup.ts` resets every Durable Object and re-applies
  `migrations/0001_init.sql` before each test, so no test sees another's
  state.
- `test/organization.test.ts` covers the goal → task → review → approval
  loop and the permission model.
- `test/durability.test.ts` covers eviction and recovery: `evictDurableObject`
  puts an agent to sleep, and the test asserts that identity, permissions,
  transcript and outstanding work survive.

The vitest configuration sets `fileParallelism: false`, because the eviction
tests reach every object in the runtime.

Other scripts:

```sh
npm run typecheck   # tsc --noEmit
npm run check       # typecheck + tests
npm run test:watch  # vitest in watch mode
```

The same two commands run in CI (`.github/workflows/ci.yml`).

## 4. Environment variables

Where a value is set:

- **Secrets** — `ORG_API_TOKEN`, `WEBHOOK_SECRET`, and `GITHUB_TOKEN` — go in
  `npx wrangler secret put` on a deployment, or in `.dev.vars` locally.
- **`vars` in `wrangler.jsonc`** — `ORG_ENV`, `MODEL_DEFAULT`,
  `MODEL_COORDINATOR`, `MODEL_ENGINEER`, `MODEL_REVIEWER`, `THINKING_LEVEL`,
  `EXECUTION_BACKEND`, `REPO_PROVIDER` and `SIMULATED_REPO_STATE` are already
  there. `MODEL_PROVIDER` and `FAUX_SCRIPT` are not; add them under `vars`
  (or to `.dev.vars` locally) if you want to change them.
- **Everything else** — `GITHUB_REPO`, `GITHUB_WORKFLOW`, `GITHUB_API_BASE` —
  is plain configuration. Add them under `vars` in `wrangler.jsonc`, or set
  them as secrets if you prefer to keep them out of the repository.

| Name | Required? | Default | Meaning |
| --- | --- | --- | --- |
| `ORG_API_TOKEN` | Yes | none | Bearer token for the management API. Sent as `Authorization: Bearer <token>`. Every route except `GET /api/health` requires it. |
| `WEBHOOK_SECRET` | Yes, if you use webhooks | none | Shared secret for inbound webhooks. Sent as `X-Webhook-Secret`. Compared in constant time; never logged. |
| `MODEL_PROVIDER` | No | Workers AI (anything that is not `faux`) | `workers-ai` uses the `AI` binding; `faux` answers from the deterministic script in `src/agents/faux.ts`. `src/agents/org-agent.ts` selects the faux provider only when the value is exactly `faux`. |
| `FAUX_SCRIPT` | No | built-in default script | JSON describing what the faux provider answers. `{"default": [{"text": "..."}], "rules": [{"match": "Review:", "actions": [{"tool": "org_report_result", "args": {...}}]}]}`. The first rule whose `match` appears in the prompt wins. Only used when `MODEL_PROVIDER=faux`. |
| `MODEL_DEFAULT` | No | `@cf/zai-org/glm-4.7-flash` | The model used by an agent with no role-specific model. |
| `MODEL_COORDINATOR` | No | `@cf/zai-org/glm-4.7-flash` | The coordinator's model. |
| `MODEL_ENGINEER` | No | `@cf/moonshotai/kimi-k2.7-code` | The engineer's model. |
| `MODEL_REVIEWER` | No | `@cf/zai-org/glm-4.7-flash` | The reviewer's model. |
| `THINKING_LEVEL` | No | `low` | The model thinking level: `off`, `minimal`, `low`, `medium`, `high`. The largest single lever on neuron spend. |
| `AI_GATEWAY_ID` | No | none (direct binding) | AI Gateway id that Workers AI traffic is routed through, so a spend rule can cap model dollars. Empty means the binding is called directly. Every call carries the agent's id as `agent_id` metadata for per-agent rules. |
| `EXECUTION_BACKEND` | No | `simulated` | `simulated` performs no external work and costs nothing; `github-actions` dispatches a workflow (cost: GitHub Actions minutes, not Cloudflare credits); `none` refuses every action. |
| `REPO_PROVIDER` | No | `simulated` | Where the deterministic repository check looks: `simulated` reads `SIMULATED_REPO_STATE`; `github` reads the newest workflow runs (only selected when `GITHUB_REPO` is also set). |
| `SIMULATED_REPO_STATE` | No | a failing CI run on `main` | JSON read by the simulated repository check: `{"ciStatus":"failing","workflow":"build-and-test","branch":"main","issue":"..."}`. With `ciStatus` not `failing`, the check reports a healthy repository. |
| `GITHUB_TOKEN` | No | none | Token for the GitHub API. A fine-grained token with `actions: read` (and `actions: write` to dispatch) on one repository is enough. |
| `GITHUB_REPO` | No | none | The repository, as `owner/name`. Required for the GitHub repository check and for the GitHub Actions backend. |
| `GITHUB_WORKFLOW` | No | none | The workflow file to dispatch, as a path relative to the repository root. Required for the GitHub Actions backend. |
| `GITHUB_API_BASE` | No | `https://api.github.com` | The GitHub API root. Change it for GitHub Enterprise. |
| `MODEL_PROVIDER` | No | `workers-ai` | `workers-ai` (the AI binding), `cloudflare-rest` (the same models over the Cloudflare REST API, with no binding) or `faux` (a deterministic stand-in). |
| `CF_ACCOUNT_ID` | With `cloudflare-rest` | none | A Cloudflare account id. Used instead of the `AI` binding. |
| `CF_API_TOKEN` | With `cloudflare-rest` | none | An API token with Workers AI Read and AI Gateway Run. Used instead of the `AI` binding. |
| `ORG_ENV` | No | `local` | A label. It is echoed by `GET /api/health` and is available for tagging in logs and events. Set it to `production` for a real deployment. |

An external model provider needs no secret in `.dev.vars`: put a
Cloudflare AI Gateway id in a `MODEL_*` variable (for example
`openai/gpt-4o-mini` or `anthropic/claude-haiku-4-5`) and the gateway holds
the provider's credentials and does the billing.

## 5. The management API

Base URL: `https://incorporeal.<your-subdomain>.workers.dev`.

Authentication: `Authorization: Bearer $ORG_API_TOKEN` on every route except
`GET /api/health` (no token) and `POST /api/webhooks/{source}` (which uses
`X-Webhook-Secret`). A missing or wrong token returns `401
{"error":"unauthorized"}`, which does not say which part was wrong.

| Method | Path | Token | What it does |
| --- | --- | --- | --- |
| `GET` | `/api/health` | none | Liveness. `{"status":"ok","env":"..."}`. |
| `GET` | `/api/agents` | bearer | The roster: every agent with its role, status, model and permissions. |
| `GET` | `/api/agents/{id}` | bearer | One agent: the identity row plus its live status — open tasks, pending operations, transcript preview and token usage. |
| `POST` | `/api/agents/{id}/note` | bearer | Send a message to an agent. Body: `{"text":"...", "operationId":"..."}` (the operation id is optional). Returns the submission receipt. |
| `POST` | `/api/agents/{id}/successor` | bearer | Replace an agent with a successor. Body: `{"successorId":"engineer-2"}`. The successor inherits the role, permissions, budgets, open tasks, goals and obligations; the predecessor is retired and the successor starts with an empty transcript. |
| `GET` | `/api/goals` | bearer | List the goals. |
| `POST` | `/api/goals` | bearer | Create a goal. Body: `{"title":"...", "description":"..."}`. The coordinator immediately turns it into an investigation task. Returns `201` with the goal and the delegation result. |
| `GET` | `/api/goals/{id}` | bearer | One goal and the tasks under it. |
| `GET` | `/api/tasks` | bearer | The task board. Query parameters: `status`, `assignee`, `goal`, `limit` (default 50). |
| `GET` | `/api/tasks/{id}` | bearer | One task, with its result and artifact. |
| `GET` | `/api/tasks/{id}/events` | bearer | One task and its events. |
| `GET` | `/api/events` | bearer | The most recent 200 events, newest first. The API does not filter; `orgctl events --task/--agent/--type` filters locally. |
| `GET` | `/api/obligations` | bearer | The recurring obligations, with their intervals and next run times. |
| `POST` | `/api/obligations` | bearer | Create a recurring obligation. Body: `{"name":"...", "intervalSeconds":900, "check":{...}}`. `intervalSeconds` must be at least 60; the default is 900. The owner is the coordinator. The `check` object is stored as the obligation's `check_spec`; the check that actually runs is selected by `REPO_PROVIDER`, not by this field. |
| `POST` | `/api/obligations/{id}/run` | bearer | Run the coordinator's sweep now, instead of waiting for the cron trigger. Note that this runs the **whole** sweep — all due obligations and the stalled-task check — not only the named obligation. |
| `GET` | `/api/approvals` | bearer | The approval requests, with their status, their reason, and the action each one authorises. |
| `POST` | `/api/approvals/{id}` | bearer | Decide an approval. Body: `{"decision":"approve"\|"reject", "decidedBy":"name"}`. Approving moves the task to `assigned` and starts it; rejecting cancels it. |
| `POST` | `/api/webhooks/{source}` | `X-Webhook-Secret` | An inbound event becomes a goal, which the coordinator turns into work. Body: `{"title":"...", "description":"..."}` (both optional). Returns `201`. |
| `POST` | `/api/sweep` | bearer | Run the coordinator's sweep now. The handler does not check the method, so `GET /api/sweep` works too — which is what `orgctl sweep` uses. |
| `GET` | `/api/knowledge` | bearer | The shared knowledge base: decisions, conventions and findings. |
| `GET` | `/api/providers/credentials` | bearer | The model providers that have a credential. Metadata only: the credential itself is never returned. |
| `POST` | `/api/providers/credentials/{provider}` | bearer | Store a credential: `{"credential": {"type": "api_key" or "oauth", ...}}`. |
| `DELETE` | `/api/providers/credentials/{provider}` | bearer | Remove a credential. |

`GET /` and `GET /api` return a short JSON description of the service and
need no token.

### Curl examples

Health, no token:

```sh
curl -s https://incorporeal.example.workers.dev/api/health
```

Create a goal, which makes the coordinator delegate:

```sh
curl -s -X POST https://incorporeal.example.workers.dev/api/goals \
  -H "Authorization: Bearer $ORG_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"Keep the test repository healthy","description":"Investigate the failing workflow and propose a fix."}'
```

List the tasks:

```sh
curl -s "https://incorporeal.example.workers.dev/api/tasks?status=running&limit=20" \
  -H "Authorization: Bearer $ORG_API_TOKEN"
```

Inspect one agent:

```sh
curl -s https://incorporeal.example.workers.dev/api/agents/engineer \
  -H "Authorization: Bearer $ORG_API_TOKEN"
```

Decide an approval:

```sh
curl -s -X POST https://incorporeal.example.workers.dev/api/approvals/apv_xxxxxxxx \
  -H "Authorization: Bearer $ORG_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"decision":"approve","decidedBy":"alice"}'
```

Run the sweep by hand:

```sh
curl -s -X POST https://incorporeal.example.workers.dev/api/sweep \
  -H "Authorization: Bearer $ORG_API_TOKEN"
```

Push an inbound event:

```sh
curl -s -X POST https://incorporeal.example.workers.dev/api/webhooks/github \
  -H "X-Webhook-Secret: $WEBHOOK_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"title":"Nightly build failed","description":"The build-and-test workflow failed on main."}'
```

## 6. Day-to-day operations

Everything below is available both as a `curl` call and as an `orgctl`
command. The CLI prints an aligned table; add `--json` for the raw payload.

Set once:

```sh
export ORG_URL=https://incorporeal.example.workers.dev
export ORG_API_TOKEN=<token>
```

### See what the organization is doing

```sh
node scripts/orgctl.mjs tasks                    # the task board
node scripts/orgctl.mjs tasks --status running
node scripts/orgctl.mjs tasks --assignee engineer
node scripts/orgctl.mjs task task_xxxxxxxx       # one task, its result and its events
node scripts/orgctl.mjs events                   # the event log, newest first
node scripts/orgctl.mjs events --type task.failed
node scripts/orgctl.mjs agents                   # the roster
node scripts/orgctl.mjs agent engineer           # one agent in full
node scripts/orgctl.mjs goals
node scripts/orgctl.mjs goal goal_xxxxxxxx
```

### Approve or reject a pending approval

```sh
node scripts/orgctl.mjs approvals
node scripts/orgctl.mjs approve apv_xxxxxxxx --by alice
node scripts/orgctl.mjs reject  apv_xxxxxxxx --by alice
```

An approval is requested when the coordinator escalates: the reviewer
recommended escalation, or the work is externally consequential and needs a
human. Approving starts the task immediately; rejecting cancels it.

### Replace an agent with a successor

```sh
node scripts/orgctl.mjs successor engineer --to engineer-2
```

The successor inherits the role, the permissions, the budgets, the open
tasks, the goals and the obligations. It does **not** inherit the
predecessor's transcript: it starts with an empty working memory and a
handoff note telling it to read the shared store for the state of the
organization. The predecessor is retired.

### Run a sweep by hand

```sh
node scripts/orgctl.mjs sweep
```

The sweep runs the coordinator's due obligations and re-issues assignments
that have passed their deadline. It is exactly what the 15-minute cron
trigger does; running it by hand is how you get a result without waiting.

### Add a recurring obligation

```sh
node scripts/orgctl.mjs obligation-add --name "Watch the repository" --interval 900
```

or:

```sh
curl -s -X POST https://incorporeal.example.workers.dev/api/obligations \
  -H "Authorization: Bearer $ORG_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Watch the repository","intervalSeconds":900}'
```

The obligation's `next_run_at` is set to now plus the interval, and each
sweep that claims it pushes `next_run_at` forward by the same interval. The
minimum interval is 60 seconds. The check that runs is selected by
`REPO_PROVIDER`, not by the obligation's `check` field.

### Send an agent a message

```sh
node scripts/orgctl.mjs note engineer "Please look at the flaky test in the API client."
```

## 7. Failure playbooks

### A task is stuck

A task is stuck when its status stays `assigned` or `running` past its
deadline. The sweep detects this: `#recoverStalledTasks()` in
`src/agents/org-agent.ts` finds open tasks whose `deadline_at` has passed,
bumps `attempt`, extends the deadline by 30 minutes and re-assigns them. If
the attempt limit is reached, the task is marked `failed` with the reason
`the assignment did not finish before its deadline`.

Do this:

1. Look at the task:

   ```sh
   node scripts/orgctl.mjs task task_xxxxxxxx
   ```

   The events show where it stopped: `task.started` but no `task.reported`,
   or `task.reported` with no review behind it.

2. Look at the events for the task:

   ```sh
   node scripts/orgctl.mjs events --task task_xxxxxxxx
   ```

3. Force a sweep, which re-issues the task:

   ```sh
   node scripts/orgctl.mjs sweep
   ```

4. If the agent itself is the problem — it is wedged, or its transcript is
   full — replace it with a successor (see the next section).

### A task failed

A failed task has `status = "failed"` and a `result` whose `summary` is the
reason. The reason is also in the `task.failed` event.

The reason is a short code from the harness, not a sentence: the summary is
`result.reason` from the settled model run — for example `model_error`,
`faulted`, `aborted` or `no_model` — or the fallback `the model run did not
produce an answer` when the harness gave no reason. The underlying error
message is in the logs, not in the task row.

```sh
node scripts/orgctl.mjs task task_xxxxxxxx
```

The common reasons:

| Reason | Meaning | What to do |
| --- | --- | --- |
| `model_error` | The model call failed — most often the Workers AI daily allocation was exhausted, or the provider returned an error. | Check the allocation (see the next section). The task can be re-issued with a sweep once the allocation is restored. |
| `faulted` | The generation was interrupted or faulted inside pi-durable. | Check the logs. The task can be re-issued with a sweep. |
| `the model run did not produce an answer` | The submission settled without a `done` status. | Check the logs for the underlying error. |
| `the assignment did not finish before its deadline` | The sweep gave up on it after the attempt limit. | Look for a wedged agent or an exhausted allocation, then re-issue. |
| `permission denied: this agent may not use ...` | A tool call was refused. | The permission set is data in D1. Check the agent's row; see `src/policy/permissions.ts` for what each role may do. |
| `task tool-call budget exhausted (n/m)` | The task made more tool calls than `max_tool_calls` allows. | Raise the agent's `max_tool_calls` in D1, or split the work. |
| `agent daily tool-call budget exhausted (n/200)` | The agent made more than 200 tool calls in a day. | Raise `DAILY_TOOL_CALL_LIMIT` in `src/policy/budget.ts`, or let the day roll over. |
| `running anything externally needs an approved human request` | The task asked to run something outside the organization with no approved request attached. | This is the gate, not a fault. Raise an approval for the task (`org_request_approval` from the coordinator, or a row in `approvals`) and assign the task again. |
| `the approved request does not name an action` | The approval on the task does not say what it authorises. | Approve an approval that names the action: `{"command": "npm test"}`. An approval that names no action authorises nothing. |
| `the approved request authorises "...", not "..."` | The action the agent asked for is not the one a human approved. | Either the agent asked for more than it was given, or the approval names the wrong action. Adjust the approval to the action that was reviewed. |
| `the task spent n tokens, over its budget of m` | The run cost more tokens than the agent's `max_tokens` allows. | Raise `max_tokens` on the agent's row, or narrow the task. |
| `execution is disabled for this deployment` | `EXECUTION_BACKEND=none`. | Set the backend to `simulated` or `github-actions`. |

A failed task does not automatically retry. The sweep re-issues open tasks,
and a failed task is not open. To retry, create a new task with
`org_delegate`, or reset the row's status by hand in D1.

### The Workers AI allocation ran out

Symptoms: tasks fail with a `model_error` reason, and the log shows model
failures for several agents at once.

1. Confirm it:

   ```sh
   npx wrangler tail
   ```

   Look for repeated model errors, and check the daily allocation in the
   Cloudflare dashboard under Workers AI.

2. Keep the organization alive without a provider while you work on it:

   ```sh
   # .dev.vars for local, or wrangler.jsonc vars for a deployment
   MODEL_PROVIDER=faux
   ```

   The agents answer deterministically and the organization still does its
   real work — delegation, review, approval, recovery.

3. Reduce the spend: lower `THINKING_LEVEL` from `low` to `minimal` or
   `off`, and put a smaller model on `MODEL_REVIEWER` than on
   `MODEL_ENGINEER`.

4. Once the allocation resets, the sweep re-issues the open tasks. Tasks
   already marked `failed` stay failed; re-create them if you want them
   done.

### A spend rule is blocking model calls

Symptoms: tasks fail with a `model_error` reason even though the free
allocation is not exhausted, and the gateway analytics show blocked `429`s.

1. Confirm it: the task's result names the 429, and the gateway's
   analytics show the spend rule over budget.
2. Decide: raise the rule in **AI Gateway > Settings > Spend limits**, or
   leave it and let the work wait for the window to reset. Do not "fix" it
   by clearing `AI_GATEWAY_ID` — that removes the dollar boundary instead of
   answering the budget question.
3. Re-create the failed tasks if you want them done; failed tasks do not
   retry on their own.

### A Durable Object is wedged

Symptoms: an agent stops responding — `GET /api/agents/{id}` hangs or times
out, its tasks never progress, and the log shows errors for that agent id.

There is no administrative endpoint for a Durable Object, so the practical
remedy is to move the work to a new object:

```sh
node scripts/orgctl.mjs successor engineer --to engineer-2
```

The successor is a different Durable Object (its name is the id), so a wedged
object is left behind and the new one starts clean. The open tasks, goals and
obligations move.

Other things worth checking before replacing an agent:

- The object may simply be busy or evicted; the log line `agent started`
  appears each time it wakes. An evicted agent recovers on its own: it
  reconciles with D1 on start and rejoins its open assignments.
- `npx wrangler tail` shows whether the agent is still logging. Silence
  combined with non-progressing tasks is the wedge signature.
- A wedged object can also be a full one: 1 GB of storage on Free produces
  `SQLITE_FULL`, and new writes fail while reads still work. A successor
  starts at zero bytes.

### The D1 database was deleted by accident

Symptoms: every API call that touches the shared store fails, or the
organization starts with no agents.

If the database was deleted, the rows are gone. The Durable Objects survive
(their transcripts are in their own SQLite databases), but the shared
organization — tasks, goals, obligations, approvals, events — is lost.

Recovery:

1. Create a new database:

   ```sh
   npx wrangler d1 create incorporeal
   ```

2. Apply the schema:

   ```sh
   npx wrangler d1 migrations apply incorporeal --remote
   ```

3. Put the new `database_id` into `wrangler.jsonc` and redeploy:

   ```sh
   npx wrangler deploy
   ```

4. The three built-in agents re-seed themselves on the next request
   (`ensureBuiltInAgents` in `src/agents/identity.ts` creates the
   coordinator, engineer and reviewer if their rows are absent; it never
   overwrites an existing row).

5. Re-create the obligations and the pending work. There is no automatic
   restore: the lost rows are gone.

To avoid this, back the database up before destructive changes:

```sh
npx wrangler d1 export incorporeal --remote --output backup.sql --skip-confirmation
```

## 8. Observability

### Structured logs

`src/logging.ts` emits one JSON object per line, so the Workers log view and
any Logpush pipeline filter on the same fields. The fields are:

| Field | Meaning |
| --- | --- |
| `ts` | ISO timestamp |
| `level` | `debug`, `info`, `warn` or `error` |
| `msg` | A short human-readable message |
| `correlationId` | The id that ties the log lines, the events and the Durable Object trace together |
| `agentId` | The agent the line is about |
| `taskId` | The task the line is about |
| `goalId` | The goal the line is about |
| `obligationId` | The obligation the line is about |
| `kind` | The kind of work |
| `durationMs` | How long something took |

The messages worth knowing by name:

| Message | Level | Means |
| --- | --- | --- |
| `agent started` | info | An agent's Durable Object woke up. |
| `sweep complete` | info | The cron trigger's sweep finished. Carries `durationMs` and the result counts. |
| `sweep failed` | error | The cron trigger's sweep threw. |
| `task run failed` | error | A task's model run threw. Carries the agent and task ids. |
| `task settled without a structured report` | warn | The model finished but did not call `org_report_result`; the task was closed with the final text. |
| `a tool call failed` | error | A tool was refused or threw. Carries the tool name. |
| `pi reported a failure` | warn | The pi harness reported an internal failure. Carries the agent id and the pi error type. |
| `execution failed` | warn | The execution backend could not run the action. |
| `could not notify the coordinator` | warn | A hand-off failed. The coordinator's sweep repairs a missed handoff. |
| `could not assign a task` | warn | An assignment RPC failed. |
| `re-issued a stalled assignment` | warn | The sweep found a task past its deadline and re-assigned it. |
| `finding already has an open task` | info | A recurring finding was deduplicated by fingerprint. |
| `agent replaced` | info | A successor took over. |
| `seeded an agent` | info | A built-in agent was created on first use. |

Secrets never appear in a log line: the logging helpers only accept ids,
counts and short labels.

Tail the logs:

```sh
npx wrangler tail
```

`npx wrangler tail --format pretty` is more readable; the default format
keeps the JSON intact.

### The event log

The `events` table is the inspectable history: who did what, why and when.
Each row has `event_id`, `ts`, `correlation_id`, `agent_id`, `task_id`,
`type` and a JSON `payload`. It is indexed on `task_id`, on
`(agent_id, ts)` and on `(type, ts)`.

The event types the code records:

| Type | Recorded when |
| --- | --- |
| `goal.created` | A goal was created through the API. |
| `goal.achieved` / `goal.blocked` | The coordinator closed a goal. |
| `task.created` | The coordinator delegated a goal into an investigation. |
| `task.created_from_finding` | An obligation's finding became a task. |
| `task.delegated` | An agent delegated work to another agent. |
| `task.started` | A task moved to `running`. |
| `task.reported` | An agent reported the result of a task. |
| `task.settled_without_report` | The harness closed a task because the model did not report. |
| `task.blocked` | A task was blocked because it needs a human approval. |
| `task.failed` | A task failed. The payload carries the reason. |
| `task.review_requested` | The coordinator asked the reviewer to assess a task. |
| `task.rework_requested` | The reviewer asked for changes and the coordinator started a retry. |
| `task.stalled_retried` | The sweep re-issued an assignment past its deadline. |
| `task.stalled_failed` | The sweep gave up on an assignment. |
| `approval.requested` | A human was asked to decide. |
| `approval.approved` / `approval.rejected` | A human decided. |
| `obligation.created` | A recurring obligation was created. |
| `execution.submitted` | An external action was submitted to a backend. |
| `webhook.received` | An inbound webhook became a goal. |
| `agent.replaced` | An agent was replaced by a successor. |
| `agent.note.settled` | A note to an agent settled. |

Read the log with `orgctl`:

```sh
node scripts/orgctl.mjs events --task task_xxxxxxxx
node scripts/orgctl.mjs events --agent engineer
node scripts/orgctl.mjs events --type task.failed
```

### Querying D1 directly

```sh
npx wrangler d1 execute incorporeal --remote --command "SELECT type, COUNT(*) FROM events GROUP BY type"
```

The recent task board:

```sh
npx wrangler d1 execute incorporeal --remote --command \
  "SELECT task_id, kind, status, assignee, deadline_at FROM tasks ORDER BY created_at DESC LIMIT 20"
```

What is waiting for a human:

```sh
npx wrangler d1 execute incorporeal --remote --command \
  "SELECT approval_id, task_id, requested_by, reason FROM approvals WHERE status = 'pending'"
```

The day's spend per agent:

```sh
npx wrangler d1 execute incorporeal --remote --command \
  "SELECT usage_date, agent_id, tool_calls, tokens FROM agent_usage ORDER BY usage_date DESC"
```

Add `--json` to get machine-readable output, and use `--local` instead of
`--remote` to query the local development database.

## 9. Deploy checklist

- [ ] `npx wrangler d1 create incorporeal` run, and the `database_id` pasted into `wrangler.jsonc`.
- [ ] `npx wrangler d1 migrations apply incorporeal --remote` run.
- [ ] `ORG_API_TOKEN` set with `npx wrangler secret put`, and a different value used for `WEBHOOK_SECRET`.
- [ ] `ORG_ENV` changed from `local` to `production` in `wrangler.jsonc`.
- [ ] `MODEL_PROVIDER` and the model ids chosen deliberately; `THINKING_LEVEL` set with the neuron budget in mind.
- [ ] `EXECUTION_BACKEND` and `REPO_PROVIDER` set to what you actually want: `simulated` (free), `github-actions` (GitHub Actions minutes) or `none`.
- [ ] `npx wrangler deploy` run and `GET /api/health` returns `{"status":"ok","env":"production"}`.
- [ ] `node scripts/orgctl.mjs agents` shows the coordinator, engineer and reviewer.
- [ ] `node scripts/orgctl.mjs sweep` returns a result without an error.
- [ ] A goal created end to end: `node scripts/orgctl.mjs goal-add --title "..."` and the task board shows the work.
