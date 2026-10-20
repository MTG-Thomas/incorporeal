# ADR 0004: The model provider and the execution backend are pluggable

## Status

Accepted

## Context

Two things in this system are outside the organization and outside its
control.

- **The model.** Which model answers an agent, and whether a provider is
  reachable at all, depends on the deployment. Workers AI is available on the
  Free plan with a daily neuron allocation; other deployments may want a
  different provider, a gateway, or none. The model must also be replaceable
  per role and per agent.
- **The execution environment.** When the engineer asks for a command to be
  run, something has to run it: a GitHub Actions runner, a simulated
  environment, or nothing, because a read-only deployment must not execute
  code at all.

Both get hardcoded first and regretted later. The tests also need to run
without spending model calls or needing a network, and a demonstration
deployment should work without a GitHub account. The repository check has the
same property: it inspects external state on a schedule, so it too needs to
be replaceable and needs a deterministic substitute.

## Decision

Define a small interface for each and select the implementation from
configuration.

**The model.** pi-ai provides a model registry, and `src/agents/org-agent.ts`
installs one provider into it: `createAI({ binding: env.AI })` for Workers AI,
or `createFauxProvider(...)` when `MODEL_PROVIDER === "faux"`. The faux
provider answers from a script chosen by matching the prompt, so one script
serves every role. The model is selected per role and can be overridden on an
agent's row in D1.

**The execution backend.** `src/execution/types.ts` defines
`ExecutionBackend` with `submit` and `status`, returning a handle with a run
id, a status and an optional URL. `src/execution/index.ts` selects on
`EXECUTION_BACKEND`: `simulated` records the request and reports success;
`github-actions` dispatches a workflow in `GITHUB_REPO`; `none` refuses every
action, which is valid for a read-only organization.

**The repository check.** `src/checks/types.ts` defines `RepositoryCheck`
with a single `run`, returning findings that carry a stable `fingerprint`, a
title, a detail and a task kind. `src/checks/index.ts` selects on
`REPO_PROVIDER`: `github` reports the newest failing workflow run on `main`;
`simulated` reads a JSON blob from `SIMULATED_REPO_STATE`. A check is
deliberately *not* a model call: it is a bounded, repeatable inspection, so
the same input always produces the same finding, which is what makes the
fingerprint deduplication work.

The choice is made at construction time from configuration, not by a model at
runtime. A model cannot select a provider or a backend.

The `github-actions` backend has a working implementation here:
`.github/workflows/agent-task.yml` is a `workflow_dispatch` workflow whose
inputs are exactly `command`, `args` and `notes`. It matches `command`
against a fixed allowlist of the repository's own commands and refuses
anything else. The command is never run as a shell command: a runner holding
the repository's credentials and its network is not a place to execute text a
model produced.

## Consequences

The tests run against a deterministic model with no network and no
allocation, while the same suite exercises the real Durable Objects, the real
D1 database and the real platform recovery behaviour. Only the model is
substituted; nothing else is mocked. A deployment can be demonstrated end to
end with no external account: `MODEL_PROVIDER=faux`,
`EXECUTION_BACKEND=simulated` and `REPO_PROVIDER=simulated` still produce
the whole chain — finding, task, delegation, review, approval.

### What this makes harder

- Each pluggable point needs a meaningful no-op or refusal mode, not just a
  happy path. `none` throws on every submission; the faux provider has to
  imitate tool-call structure closely enough that pi's protocol works.
- The interfaces are narrow by necessity. `ExecutionBackend` covers "run this
  command somewhere" and nothing more.
- The faux provider is a behavioural approximation, not a model. A test that
  passes against it may still fail against a real provider.
- There is no separate configuration for an external model provider. The
  supported route is the Cloudflare AI Gateway: put a gateway id such as
  `openai/gpt-4o-mini` in a `MODEL_*` variable and the gateway holds the
  provider's credentials and takes the billing.

## Alternatives considered

- **Hardcode Workers AI.** Rejected: the tests would need a network and
  would spend the daily allocation on every run.
- **Build a model gateway abstraction of our own.** Deferred: pi-ai already
  provides a registry with provider interfaces, and a second layer would add
  configuration for no capability.
- **Let the model choose the execution backend at runtime.** Rejected: that
  would make the sandbox boundary model-controlled.
- **Make the repository check a model call.** Rejected: a non-deterministic
  check would make finding fingerprints unstable, so the deduplication that
  stops a recurring obligation from stacking work would stop working.
