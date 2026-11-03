/**
 * Provider credentials and the providers that use them.
 *
 * Two properties matter here: a credential is a secret that the API never
 * returns, and a provider that is not configured refuses the work rather
 * than quietly sending it somewhere else.
 */
import { describe, expect, it } from "vitest";
import { describeCredentials, D1CredentialStore, putCredential } from "../src/agents/credentials.ts";
import { gatewayStreamOptions, providerName, resolveGatewayId, resolveProvider } from "../src/agents/providers.ts";
import { api, db } from "./helpers.ts";
import type { Env } from "../src/env.ts";

/** The environment a test hands to the provider resolver. */
function testEnv(overrides: Partial<Env> = {}): Env {
	return {
		ORG_AGENTS: undefined as never,
		ORG_DB: db(),
		AI: undefined,
		ORG_API_TOKEN: "test-token",
		WEBHOOK_SECRET: "test-webhook",
		ORG_ENV: "test",
		MODEL_DEFAULT: "@cf/zai-org/glm-4.7-flash",
		MODEL_COORDINATOR: "@cf/zai-org/glm-4.7-flash",
		MODEL_ENGINEER: "@cf/openai/gpt-oss-120b",
		MODEL_REVIEWER: "@cf/zai-org/glm-4.7-flash",
		THINKING_LEVEL: "low",
		MODEL_PROVIDER: "faux",
		EXECUTION_BACKEND: "simulated",
		REPO_PROVIDER: "simulated",
		SIMULATED_REPO_STATE: "{}",
		...overrides
	};
}

describe("provider credentials", () => {
	it("stores a credential and reports only its metadata", async () => {
		await putCredential(db(), "openai", {
			type: "api_key",
			key: "sk-not-a-real-key"
		} as never);

		const listed = await describeCredentials(db());
		const row = listed.find((entry) => entry.providerId === "openai");
		expect(row).toBeTruthy();
		expect(row?.type).toBe("api_key");
		// The metadata never carries the secret.
		expect(JSON.stringify(listed)).not.toContain("sk-not-a-real-key");
	});

	it("never returns the credential through the API", async () => {
		await putCredential(db(), "openai", { type: "api_key", key: "sk-secret-value" } as never);

		const response = await api<{ credentials: unknown[] }>("/api/providers/credentials");
		expect(response.status).toBe(200);
		expect(JSON.stringify(response.body)).not.toContain("sk-secret-value");
	});

	it("stores a credential through the API, and refuses one without a type", async () => {
		const stored = await api<{ stored: boolean }>("/api/providers/credentials/openai", {
			method: "POST",
			body: JSON.stringify({ credential: { type: "oauth", refresh: "r", access: "a", expires: 1 } })
		});
		expect(stored.status).toBe(200);
		expect(stored.body.stored).toBe(true);

		const refused = await api("/api/providers/credentials/openai", {
			method: "POST",
			body: JSON.stringify({ credential: { key: "no-type" } })
		});
		expect(refused.status).toBe(400);
	});

	it("refuses an unauthenticated attempt to read or write credentials", async () => {
		const read = await api("/api/providers/credentials", { token: null });
		expect(read.status).toBe(401);
		const write = await api("/api/providers/credentials/openai", {
			method: "POST",
			token: null,
			body: JSON.stringify({ credential: { type: "api_key", key: "x" } })
		});
		expect(write.status).toBe(401);
	});

	it("refreshes a credential in place, the way a subscription needs", async () => {
		const store = new D1CredentialStore(db());
		await store.modify("openai", async () => ({
			type: "oauth",
			refresh: "first",
			access: "a",
			expires: 1
		}) as never);
		await store.modify("openai", async (current) => ({
			...(current as { access: string }),
			access: "rotated"
		}) as never);

		const read = await store.read("openai");
		expect((read as { access?: string })?.access).toBe("rotated");
	});
});

describe("the model providers", () => {
	it("names the provider the deployment is configured for", () => {
		expect(providerName(testEnv({ MODEL_PROVIDER: "faux" }))).toBe("faux");
		expect(providerName(testEnv({ MODEL_PROVIDER: "chatgpt" }))).toBe("chatgpt");
		// An unknown name falls back to the default rather than failing.
		expect(providerName(testEnv({ MODEL_PROVIDER: "nonsense" }))).toBe("workers-ai");
	});

	it("refuses a provider whose credentials are missing, rather than falling back", async () => {
		await expect(
			resolveProvider(
				testEnv({ MODEL_PROVIDER: "opencode-go", OPENCODE_API_KEY: undefined }),
				db(),
				"some-model"
			)
		).rejects.toThrow(/not configured/);
	});

	it("builds an OpenAI-compatible provider for a service with its own base URL", async () => {
		const resolved = await resolveProvider(
			testEnv({
				MODEL_PROVIDER: "opencode-go",
				OPENCODE_API_KEY: "oc-key",
				OPENCODE_GO_BASE_URL: "https://example.test/v1",
				OPENCODE_GO_MODELS: JSON.stringify([{ id: "a-model", name: "A model" }])
			}),
			db(),
			"a-model"
		);
		expect(resolved.id).toBe("opencode-go");
		expect(resolved.modelId).toBe("a-model");
		// The model is registered, so pi-ai can resolve it.
		expect(resolved.models.getModel("opencode-go", "a-model")).toBeTruthy();
	});

	it("builds the ChatGPT subscription provider", async () => {
		const resolved = await resolveProvider(
			testEnv({ MODEL_PROVIDER: "chatgpt" }),
			db(),
			"gpt-5"
		);
		expect(resolved.id).toBe("openai");
		expect(resolved.modelId).toBe("gpt-5");
	});
});

describe("the AI Gateway budget wiring", () => {
	it("treats a missing, empty or blank gateway id as no gateway", () => {
		expect(resolveGatewayId(testEnv({ AI_GATEWAY_ID: undefined }))).toBeUndefined();
		expect(resolveGatewayId(testEnv({ AI_GATEWAY_ID: "" }))).toBeUndefined();
		expect(resolveGatewayId(testEnv({ AI_GATEWAY_ID: "   " }))).toBeUndefined();
		expect(resolveGatewayId(testEnv({ AI_GATEWAY_ID: " prod-gw " }))).toBe("prod-gw");
	});

	it("tags an agent's calls with its id, as scalar metadata", () => {
		expect(gatewayStreamOptions("engineer")).toEqual({ metadata: { agent_id: "engineer" } });
	});

	it("routes Workers AI through the gateway when one is configured", async () => {
		const direct = await resolveProvider(
			testEnv({ MODEL_PROVIDER: "workers-ai", AI: {} as never }),
			db(),
			"@cf/zai-org/glm-4.7-flash"
		);
		expect(direct.id).toBe("cloudflare");
		expect(direct.source).toBe("the Workers AI binding");

		const gated = await resolveProvider(
			testEnv({ MODEL_PROVIDER: "workers-ai", AI: {} as never, AI_GATEWAY_ID: "prod-gw" }),
			db(),
			"@cf/zai-org/glm-4.7-flash"
		);
		expect(gated.id).toBe("cloudflare");
		expect(gated.source).toContain("prod-gw");
	});
});

describe("the OpenCode Go key", () => {
	it("is read under either name", async () => {
		const withGo = await resolveProvider(
			testEnv({
				MODEL_PROVIDER: "opencode-go",
				OPENCODE_GO_API_KEY: "oc-key",
				OPENCODE_GO_BASE_URL: "https://example.test/v1",
				OPENCODE_GO_MODELS: JSON.stringify([{ id: "a-model" }])
			}),
			db(),
			"a-model"
		);
		expect(withGo.id).toBe("opencode-go");

		// The name the service's own documentation uses works too.
		const withDocumented = await resolveProvider(
			testEnv({
				MODEL_PROVIDER: "opencode-go",
				OPENCODE_API_KEY: "oc-key",
				OPENCODE_GO_BASE_URL: "https://example.test/v1",
				OPENCODE_GO_MODELS: JSON.stringify([{ id: "a-model" }])
			}),
			db(),
			"a-model"
		);
		expect(withDocumented.id).toBe("opencode-go");
	});

	it("refuses a model the service does not serve, and says which it does", async () => {
		await expect(
			resolveProvider(
				testEnv({
					MODEL_PROVIDER: "opencode-go",
					OPENCODE_GO_API_KEY: "oc-key",
					OPENCODE_GO_BASE_URL: "https://example.test/v1",
					OPENCODE_GO_MODELS: JSON.stringify([{ id: "a-model" }, { id: "b-model" }])
				}),
				db(),
				"@cf/zai-org/glm-4.7-flash"
			)
		).rejects.toThrow(/a-model, b-model/);
	});
});
