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
	/** Workers AI binding. The Free plan grants 10,000 neurons per day. */
	AI: Ai;
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
	 * Model provider: "workers-ai" (the default) or "faux" for a
	 * deterministic stand-in used by the tests and by credential-free
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
