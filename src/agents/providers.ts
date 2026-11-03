/**
 * Where the agents' models come from.
 *
 * The organization does not care which provider answers: it asks for a model
 * by id, and the provider turns that id into a call. Five are supported:
 *
 * - `workers-ai` — the Workers AI binding. The default, and the one the Free
 *   plan's allocation pays for.
 * - `cloudflare-rest` — the same models over the Cloudflare REST API, with
 *   an account id and a token instead of a binding. Needed where a binding is
 *   not available.
 * - `opencode-go` — an OpenAI-compatible service reached with its own API
 *   key. The base URL and the model list are configuration.
 * - `chatgpt` — a ChatGPT *subscription*: the OpenAI provider, authenticated
 *   with an OAuth credential rather than a key. The credential is stored in
 *   the shared store so it can be refreshed in place.
 * - `faux` — a deterministic stand-in, for the tests and for a
 *   credential-free demonstration.
 *
 * Every provider **fails closed**: if its credential is missing, the run
 * fails with the reason. It never falls back to another provider, because a
 * silent fallback would send the work somewhere the operator did not choose.
 */
import { createModels, type Model, type MutableModels, type Provider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createAI } from "agents/models/pi-ai";
import { createProvider } from "@earendil-works/pi-ai";
import type { Env } from "../env.ts";
import { D1CredentialStore } from "./credentials.ts";
import { createFauxProvider, FAUX_MODEL_ID, FAUX_PROVIDER_ID } from "./faux.ts";

export const PROVIDERS = [
	"workers-ai",
	"cloudflare-rest",
	"opencode-go",
	"chatgpt",
	"faux"
] as const;

export type ProviderName = (typeof PROVIDERS)[number];

export type ResolvedProvider = {
	/** The provider the models are registered under. */
	provider: Provider;
	/** The id pi-ai resolves models by. */
	id: string;
	/** The model this provider should serve for the agent. */
	modelId: string;
	/** The models collection, with the credential store attached. */
	models: MutableModels;
	/** A human-readable note about how this provider is authenticated. */
	source: string;
};

/**
 * The AI Gateway id model traffic is routed through, if one is configured.
 *
 * Blank and whitespace-only values are unset: an empty `AI_GATEWAY_ID` in
 * configuration means the binding is called directly, not a gateway named
 * "".
 */
export function resolveGatewayId(env: Env): string | undefined {
	const id = env.AI_GATEWAY_ID?.trim();
	return id ? id : undefined;
}

/**
 * The stream options that tag an agent's model calls for the gateway.
 *
 * Every call carries the agent's id as scalar metadata, so a spend rule can
 * split the budget per agent. Scalar-only: the gateway rejects nested
 * metadata, and there is nothing nested to send.
 */
export function gatewayStreamOptions(agentId: string): { metadata: { agent_id: string } } {
	return { metadata: { agent_id: agentId } };
}

/** The provider the deployment is configured to use. */
export function providerName(env: Env): ProviderName {
	const configured = (env.MODEL_PROVIDER || "workers-ai") as ProviderName;
	return PROVIDERS.includes(configured) ? configured : "workers-ai";
}

/**
 * Build the provider the agents will use.
 *
 * `modelId` is the model the agent's row names. For the OpenAI-compatible
 * provider the model must exist in the configured list, or pi-ai cannot
 * resolve it — which is a configuration error worth naming.
 */
export async function resolveProvider(
	env: Env,
	db: D1Database,
	modelId: string,
	agentId?: string
): Promise<ResolvedProvider> {
	const name = providerName(env);
	const credentialStore = new D1CredentialStore(db);
	/** The collection, with the provider registered on it. */
	const models = createModels({ credentials: credentialStore });
	const withProvider = <T extends { provider: Provider; id: string; modelId: string; source: string }>(
		resolved: T
	): T & { models: MutableModels } => {
		models.setProvider(resolved.provider);
		return { ...resolved, models };
	};

	switch (name) {
		case "faux": {
			const faux = createFauxProvider(parseFauxScript(env));
			return withProvider({
				provider: faux.provider,
				id: FAUX_PROVIDER_ID,
				modelId: FAUX_MODEL_ID,
				source: "the deterministic stand-in"
			});
		}
		case "cloudflare-rest": {
			requireCredentials(env.CF_ACCOUNT_ID, env.CF_API_TOKEN, "CF_ACCOUNT_ID and CF_API_TOKEN");
			const ai = createAI({ accountId: env.CF_ACCOUNT_ID!, apiToken: env.CF_API_TOKEN! });
			return withProvider({
				provider: ai.provider,
				id: "cloudflare",
				modelId,
				source: "the Cloudflare REST API"
			});
		}
		case "opencode-go": {
			// The deployment's own name for the key, and the name the
			// service's documentation uses.
			const key = env.OPENCODE_GO_API_KEY || env.OPENCODE_API_KEY;
			requireCredentials(key, "OPENCODE_GO_API_KEY");
			const models = parseModelList(env.OPENCODE_GO_MODELS);
			if (!models.some((model) => model.id === modelId)) {
				// The model belongs to another provider, or to a plan this
				// key cannot reach. Say which, rather than sending a request
				// that will be refused.
				throw new Error(
					`the opencode-go provider does not serve "${modelId}". It serves: ${models
						.map((model) => model.id)
						.join(", ")}. The model id is per provider, so an agent's model has to be changed when the provider is.`
				);
			}
			const provider = opencodeGoProvider({
				baseUrl: env.OPENCODE_GO_BASE_URL || OPENCODE_GO_BASE_URL,
				apiKey: key!,
				models,
				// A stable session per agent, so the service can route the
				// conversation and cache its prompts.
				session: `incorporeal-${agentId ?? "agent"}`
			});
			return withProvider({
				provider,
				id: "opencode-go",
				modelId,
				source: "the OpenCode Go API key"
			});
		}
		case "chatgpt": {
			// A ChatGPT subscription: the OpenAI provider, authenticated with
			// an OAuth credential from the shared store.
			return withProvider({
				provider: openaiProvider(),
				id: "openai",
				modelId,
				source: "the ChatGPT subscription"
			});
		}
		case "workers-ai":
		default: {
			if (!env.AI) {
				throw new Error(
					"the Workers AI binding is not configured. Set MODEL_PROVIDER to a provider that does not need one, or bind AI."
				);
			}
			// A configured gateway owns the dollar boundary: every call runs
			// under its spend rules, and a $0 rule blocks paid inference with
			// a 429 the settle path already handles as a model_error. Unset
			// means the binding is called directly, exactly as before.
			const gatewayId = resolveGatewayId(env);
			const ai = gatewayId
				? createAI({ binding: env.AI, id: gatewayId })
				: createAI({ binding: env.AI });
			return withProvider({
				provider: ai.provider,
				id: "cloudflare",
				modelId,
				source: gatewayId
					? `the Workers AI binding via AI Gateway "${gatewayId}"`
					: "the Workers AI binding"
			});
		}
	}
}

function requireCredentials(...values: (string | undefined)[]): void {
	const missing = values.filter((value) => !value);
	if (missing.length > 0) {
		throw new Error(
			`the model provider is not configured: ${missing.length} of its settings are missing. The run is refused rather than falling back to another provider.`
		);
	}
}

/** OpenCode Go's OpenAI-compatible base. */
export const OPENCODE_GO_BASE_URL = "https://opencode.ai/inference/go/openai/v1";

/**
 * The models this provider can serve.
 *
 * OpenCode Go serves several API families from one origin, and a Chat
 * Completions client can only reach the models in that family. These were
 * checked against the service's live catalogue; the list can be replaced with
 * `OPENCODE_GO_MODELS`.
 */
const OPENCODE_GO_DEFAULT_MODELS = [
	{ id: "glm-5.3-flash", name: "GLM 5.3 Flash" },
	{ id: "kimi-k2.7-code", name: "Kimi K2.7 Code" },
	{ id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" }
];

/**
 * An OpenAI-compatible provider for a service with its own base URL and key.
 *
 * The model list is configuration, because a service's catalogue is not
 * something the harness should guess at: an id that is not listed cannot be
 * resolved, and that is a clearer failure than a wrong request.
 */
function opencodeGoProvider(options: {
	baseUrl: string;
	apiKey: string;
	models: { id: string; name?: string; contextWindow?: number; maxTokens?: number }[];
	session: string;
}): Provider {
	const models = options.models.map(
		(model): Model<"openai-completions"> => ({
			id: model.id,
			name: model.name ?? model.id,
			api: "openai-completions",
			provider: "opencode-go",
			baseUrl: options.baseUrl,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			reasoning: false,
			contextWindow: model.contextWindow ?? 128_000,
			maxTokens: model.maxTokens ?? 8192
		})
	);
	return createProvider({
		id: "opencode-go",
		name: "OpenCode Go",
		baseUrl: options.baseUrl,
		headers: {
			// The service refuses a request without a session id, and it
			// watches the traffic: identify the client honestly.
			"x-opencode-session": options.session,
			"user-agent": "incorporeal/0.1 (+https://github.com/incorporeal)"
		},
		auth: {
			apiKey: {
				name: "OpenCode Go key",
				resolve: async ({ credential }) => {
					const key = credential?.type === "api_key" ? credential.key : undefined;
					const resolved = key ?? options.apiKey;
					if (!resolved) return undefined;
					return { auth: { apiKey: resolved }, source: "the OpenCode Go API key" };
				}
			}
		},
		models,
		api: { "openai-completions": openAICompletionsApi() }
	});
}

/** The model list, from configuration. */
function parseModelList(
	raw: string | undefined
): { id: string; name?: string; contextWindow?: number; maxTokens?: number }[] {
	if (!raw) return OPENCODE_GO_DEFAULT_MODELS;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (Array.isArray(parsed)) {
			return parsed.filter(
				(entry): entry is { id: string; name?: string; contextWindow?: number; maxTokens?: number } =>
					typeof entry === "object" && entry !== null && typeof (entry as { id?: unknown }).id === "string"
			);
		}
	} catch {
		// Fall through to the comma-separated form.
	}
	return raw
		.split(",")
		.map((id) => id.trim())
		.filter((id) => id.length > 0)
		.map((id) => ({ id }));
}

function parseFauxScript(env: Env): ReturnType<typeof parseFauxScriptType> {
	return parseFauxScriptType(env.FAUX_SCRIPT);
}

// Kept separate so the import of the faux module stays in one place.
import { parseFauxSpec as parseFauxScriptType } from "./faux.ts";
