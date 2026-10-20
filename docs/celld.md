# Running on celld

celld is "self-hosted, distributed Durable Objects"
([denoland/celld](https://github.com/denoland/celld), Apache-2.0, Rust). It
runs Cloudflare Workers applications — Workers, Durable Objects, KV, Queues,
D1, R2, Workflows, Cron — on your own machines, with durable state in an
S3-compatible bucket.

This document records what was **verified** by standing this repository up on
celld v0.6.2 and running the product on it. It is not a plan; it is a
result.

## The result

The port is **configuration-shaped**. No product code changed.

The whole chain ran on a celld node, unmodified:

```
POST /api/goals
  → "delegation": { "action": "delegated", "taskId": "task_…" }

GET /api/tasks
  task_…  investigate  completed  engineer
  task_…  review      completed  reviewer
  task_…  plan        completed  coordinator
  task_…  apply       blocked    engineer      ← waiting for a human

POST /api/approvals/{id}  {"decision":"approve"}
  → the apply step runs

GET /api/goals
  goal_…  achieved
```

Three questions decided it, and all three came back clean:

| Question | Answer |
| --- | --- |
| Does `agents@0.29.0`'s `PiHarness` boot in a celld Durable Object? | **Yes.** celld's own `examples/pi` is *not* comparable evidence — it pins a preview build of the SDK with a different API. Ours is the version that matters, and it works. |
| Does D1 `meta.changes` behave the way the race discipline needs? | **Yes.** A conditional UPDATE reports 1 when it matched a row and 0 when it did not, on both a dev node and a fleet node. The four places the code reads `meta.changes` are all conditional UPDATEs, and none of them is a read. The late-assignment case behaves: `markTaskRunning` returns false and a completed task stays completed. |
| Does the pi-durable Cloudflare SQLite adapter work verbatim? | **Yes.** It uses only `storage.sql.exec(...)` and `storage.transaction(...)`, both of which celld implements. The adapter drains every cursor, so celld's "an unfinished write cursor holds uncommitted writes" rule is never reached. |

Durability was also checked: killing the node and starting a new one against
the same bucket brought back the engineer's pi transcript and every task.

## The delta

Configuration only. In `wrangler.jsonc`, for the celld deployment:

- **remove** `"ai"`, `"observability"` and `"workers_dev"`. celld's
  `SUPPORTED_KEYS` (in `crates/celld/deploy.rs`) does not include them, and
  `celld deploy` refuses the file: *"does not support these config keys: ai,
  observability, workers_dev."*
- **add** `MODEL_PROVIDER`, `ORG_API_TOKEN` and `WEBHOOK_SECRET` to `vars`.
  `celld deploy` takes variables from the configuration only; `.dev.vars` is
  a `celld dev` feature. Without the token in `vars`, every API call answers
  `401`.
- keep a Cloudflare configuration beside it, because the Cloudflare
  deployment needs the `ai` binding.

Then:

```sh
celld deploy . --bucket s3://celld --endpoint http://127.0.0.1:5000 --region us-east-1
celld --bucket s3://celld --endpoint http://127.0.0.1:5000 --region us-east-1 \
      --listen 127.0.0.1:8080 --internal-listen 127.0.0.1:8081 --advertise 127.0.0.1:8081 &
celld d1 migrations apply incorporeal . --bucket s3://celld --endpoint http://127.0.0.1:5000 --region us-east-1
```

`celld deploy` builds with esbuild, so esbuild has to be on the node's
`PATH`.

## The model provider

celld does not implement the Workers AI binding — by construction, not by
accident. The binding-free path added for this (`MODEL_PROVIDER=cloudflare-rest`
with `CF_ACCOUNT_ID` and `CF_API_TOKEN`) reaches the same models over the
Cloudflare REST API and needs no binding, so it works on celld unchanged. The
faux provider was used for the experiment; the real-model path on celld is
the one thing that was **not** exercised.

## What was not verified

- The real-model path on celld (only the deterministic provider was run).
- True concurrency of the race discipline: the claims were sequential. A
  two-parallel-sweep test against a fleet would close it.
- A multi-node fleet: a second node, an owner takeover, LTX replication
  between nodes.
- Eviction and hibernation with a live pi session — pi's scheduler is in
  memory, and the object has to wake itself.
- `celld dev` and the schema: the dev node's bucket is deliberately
  internal, so `celld d1 migrations apply` cannot reach it. A real port
  either runs a bucket-backed fleet or the application grows an idempotent
  "ensure the schema" step.
- Native Windows: celld publishes no Windows binary (linux and darwin only).
  The experiment ran under WSL2.

## The honest cost

The *code* does not change; the *operations* do. A celld deployment gives up
`wrangler deploy`, wrangler-managed D1, the Workers AI binding and
`observability`, and takes on a bucket, a fleet, esbuild and celld's own
telemetry. Whether that trade is worth it is a question about control and
cost, not about portability — and this document answers the portability
half of it: the answer is yes, cheaply.
