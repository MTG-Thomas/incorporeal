# Model providers

The organization does not care which provider answers: it asks for a model by
id, and the provider turns that id into a call. Which provider is in use is
configuration, not code.

Every provider **fails closed**. If its credential is missing, the run is
refused with the reason. It never falls back to another provider, because a
silent fallback would send the work somewhere the operator did not choose.

| `MODEL_PROVIDER` | What it is | What it needs | What it costs |
| --- | --- | --- | --- |
| `workers-ai` | The Workers AI binding. The default. | The `ai` binding | The Free plan's 10,000 neurons/day, or Workers AI pricing |
| `cloudflare-rest` | The same models over the Cloudflare REST API | `CF_ACCOUNT_ID`, `CF_API_TOKEN` | The same neurons; no binding needed |
| `opencode-go` | OpenCode Go, an OpenAI-compatible service | `OPENCODE_API_KEY` | The Go subscription ($10/month) or Go Plus ($40/month) |
| `chatgpt` | A ChatGPT **subscription** | an OAuth credential, pushed by the operator | The subscription the operator already pays for |
| `faux` | A deterministic stand-in | nothing | nothing |

## Workers AI (the default)

```jsonc
"ai": { "binding": "AI" }
```

Not every model is on the Free plan: a paid-only model answers
`AiError 5035 - not available on the Workers Free plan`, and the run fails
with that reason. The defaults in `wrangler.jsonc` were checked against a
Free account.

### Capping model dollars with an AI Gateway

Past the free 10,000 neurons/day, Workers AI bills per neuron — and nothing
in the per-task budgets stops a runaway context from converting into an
invoice. Set `AI_GATEWAY_ID` to route every Workers AI call through that
gateway, carrying the agent's id as `agent_id` metadata:

```jsonc
"vars": { "AI_GATEWAY_ID": "incorporeal" }
```

The gateway owns the dollar boundary with a spend rule. The shipped posture
is **one cent a day**: a fresh gateway with a $0.01 rule ($0 is not
representable — the API requires `limit` above zero, in cents) blocks paid
inference with a `429` once a penny of estimated spend accumulates, so a new
deployment cannot run up a bill until the operator raises the limit.
The 429 lands in the existing `model_error` settle path — task failed with
the reason, `task.failed` event, coordinator notified — so no new failure
taxonomy was needed. `AI_GATEWAY_ID` unset means the binding is called
directly, exactly as before.

Two things to verify live, because no test can prove them: that traffic
inside the free allocation still succeeds under the one-cent rule (no false
429),
and that the `agent_id` metadata is visible in the gateway's analytics
before relying on a per-agent split. See the runbook for the dashboard steps.

## Cloudflare REST, without a binding

```sh
npx wrangler secret put CF_API_TOKEN
```

```jsonc
"vars": { "MODEL_PROVIDER": "cloudflare-rest", "CF_ACCOUNT_ID": "…" }
```

The same models, reached over the Cloudflare REST API. No binding is
involved, so this works on a runtime that does not implement one — celld, for
instance.

## OpenCode Go

OpenCode Go is the subscription plan of the OpenCode Console: curated
open-weight coding models served through a gateway, with the key sent as a
bearer token.

```sh
npx wrangler secret put OPENCODE_API_KEY      # oc_sk_…
```

```jsonc
"vars": {
  "MODEL_PROVIDER": "opencode-go",
  "OPENCODE_GO_BASE_URL": "https://opencode.ai/inference/go/openai/v1",
  "OPENCODE_GO_MODELS": "[\"glm-5.3-flash\",\"kimi-k2.7-code\",\"deepseek-v4-pro\"]"
}
```

Three things a client gets wrong by assuming OpenAI's defaults:

1. **The path is `/inference/go/`.** The pay-as-you-go path is
   `/inference`; a Go key on that path is refused.
2. **`x-opencode-session` is required.** A request without it is refused
   with `MissingSessionID`. The provider sends a stable session per agent, so
   the service can route the conversation and cache its prompts. It also
   identifies the client honestly in the `user-agent`.
3. **Not every model is Chat Completions.** The service serves four API
   families from the same origin — Chat Completions, Responses, Anthropic
   Messages and Google — and each model is served by one of them. This
   provider speaks Chat Completions, so it can reach GLM, Kimi, DeepSeek,
   MiMo, MiniMax, LongCat, Step and Hy, but not Grok, GPT, Claude, Qwen or
   Gemini.

The model list is configuration, because a service's catalogue is not
something the harness should guess at: an id that is not listed cannot be
resolved, and that is a clearer failure than a wrong request.

## A ChatGPT subscription

A subscription is not an API key. It is an OAuth sign-in that yields a token
which expires and is refreshed. The sign-in has to happen where a browser
can reach the callback, so it happens on the operator's machine:

```sh
node scripts/chatgpt-login.mjs --out chatgpt-credential.json
node scripts/orgctl.mjs credential-set --provider openai --file chatgpt-credential.json
```

The credential is stored in the shared store, and pi-ai refreshes it **in
place** — a subscription's refresh token rotates, and the harness has to
write the new one back or the subscription breaks on the next call. The
refresh happens through the same serialized write path pi-ai uses for every
credential mutation, so two concurrent refreshes cannot race.

Set the provider and the model ids to the ones the subscription serves:

```jsonc
"vars": { "MODEL_PROVIDER": "chatgpt", "MODEL_ENGINEER": "gpt-5" }
```

## The credentials are secrets

A credential is written through the management API, which requires the
management token, and it is read only by the Durable Object that is about to
call the provider. The API reports **metadata only** — which providers are
configured, of what kind, and when they last changed. The credential itself
is never returned:

```sh
node scripts/orgctl.mjs credentials
```

```
Provider credentials

  PROVIDER     TYPE     UPDATED
  -----------  -------  --------------------------------
  openai       oauth    2026-10-20T23:21:43.885Z
```

Remove one with `orgctl credential-remove --provider openai`.
