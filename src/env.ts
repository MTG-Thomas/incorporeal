/**
 * Bindings and configuration for the Incorporeal worker.
 *
 * Every value here is available on the Workers Free plan. Secrets (tokens) are
 * absent from `wrangler.jsonc` and are set with `wrangler secret put`.
 */
export interface Env {
	/** Durable Object namespace holding every agent. The object name is the agent id. */
	ORG_AGENTS: DurableObjectNamespace<import("./agents/org-agent.ts").OrgAgent>;
	/** Shared operational state: agents, goals, tasks, obligations, approvals, knowledge, events. */
	ORG_DB: D1Database;
	/**
	 * Workers AI binding. The Free plan grants 10,000 neurons per day.
	 *
	 * A deployment that does not have a Workers AI binding can use the
	 * account credentials below instead: the same models, reached over the
	 * Cloudflare REST API rather than through a binding. That is also what
	 * makes the organization portable to a runtime that does not implement
	 * the binding.
	 */
	AI?: Ai;
	/** A Cloudflare account id, for the binding-free model path. */
	CF_ACCOUNT_ID?: string;
	/**
	 * The emails allowed to drive the organization, comma separated.
	 *
	 * Only meaningful when Cloudflare Access is in front of the Worker: the
	 * identity Access asserts is checked against this list. Empty means any
	 * authenticated identity, plus any caller with the management token.
	 */
	CF_ACCESS_ALLOWED_EMAILS?: string;
	/** An API token with Workers AI Read and AI Gateway Run. */
	CF_API_TOKEN?: string;
	/** Bearer token for the management API. Never logged. */
	ORG_API_TOKEN: string;
	/** Shared secret for inbound webhooks. Never logged. */
	WEBHOOK_SECRET: string;

	/** "local" or "production"; only used for labels in logs and events. */
	ORG_ENV: string;
	/** Default Workers AI model id for agents without a role-specific one. */
	MODEL_DEFAULT: string;
	MODEL_COORDINATOR: string;
	MODEL_ENGINEER: string;
	MODEL_REVIEWER: string;
	/** Model thinking level: off | minimal | low | medium | high. */
	THINKING_LEVEL: string;
	/**
	 * Model provider: "workers-ai" (the default), "cloudflare-rest" (the
	 * same models over the Cloudflare REST API, with no binding), or "faux"
	 * for a deterministic stand-in used by the tests and by credential-free
	 * demonstrations.
	 *
	 * The model ids below are plain strings. A Workers AI id such as
	 * "@cf/zai-org/glm-4.7-flash" runs on Cloudflare's allocation; a Cloudflare
	 * AI Gateway id such as "openai/gpt-4o-mini" or
	 * "anthropic/claude-haiku-4-5" runs on an external provider whose
	 * credentials the gateway holds, and whose billing is the provider's.
	 */
	MODEL_PROVIDER: string;
	/** The script the faux provider answers from, as JSON. */
	FAUX_SCRIPT?: string;
	/**
	 * The API key for an OpenAI-compatible service such as OpenCode Go.
	 *
	 * `OPENCODE_GO_API_KEY` is the name this deployment uses;
	 * `OPENCODE_API_KEY` is the name the service's own documentation uses.
	 * Either is accepted, and neither is stored in the configuration: both
	 * are Worker secrets.
	 */
	OPENCODE_GO_API_KEY?: string;
	OPENCODE_API_KEY?: string;
	/**
	 * The base URL of that service, including any path prefix.
	 *
	 * OpenCode Go's OpenAI-compatible base is
	 * `https://opencode.ai/inference/go/openai/v1`. The service serves several
	 * API families from the same origin, and this provider speaks the Chat
	 * Completions one: the models served over the Responses, Anthropic and
	 * Google families need a different client.
	 */
	OPENCODE_GO_BASE_URL?: string;
	/**
	 * The models that service serves, as JSON: a list of
	 * `{"id": "...", "name": "...", "contextWindow": 128000, "maxTokens": 8192}`.
	 * A comma-separated list of ids also works.
	 */
	OPENCODE_GO_MODELS?: string;

	/** Execution backend: simulated | github-actions | none. */
	EXECUTION_BACKEND: string;
	/** Repository state provider for the deterministic repository check: simulated | github. */
	REPO_PROVIDER: string;
	/** JSON state used by the simulated repository provider. */
	SIMULATED_REPO_STATE: string;

	/** Optional GitHub integration. Costs nothing on the GitHub side beyond Actions minutes. */
	GITHUB_TOKEN?: string;
	GITHUB_REPO?: string;
	GITHUB_WORKFLOW?: string;
	GITHUB_API_BASE?: string;
}
