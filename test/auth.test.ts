/**
 * The two layers of authentication.
 *
 * The edge (Cloudflare Access) answers "is this an authenticated human?";
 * the application (the bearer token) answers "is this an authorized
 * management client?". Both have to agree before anything happens, and the
 * identity Access asserts is the one that gets recorded.
 */
import { describe, expect, it } from "vitest";
import { accessIdentity, callerName, isAllowed, isAuthorized, type Caller } from "../src/auth.ts";
import type { Env } from "../src/env.ts";

function testEnv(overrides: Partial<Env> = {}): Env {
	return {
		ORG_AGENTS: undefined as never,
		ORG_DB: undefined as never,
		AI: undefined,
		ORG_API_TOKEN: "the-token",
		WEBHOOK_SECRET: "the-webhook-secret",
		ORG_ENV: "test",
		MODEL_DEFAULT: "m",
		MODEL_COORDINATOR: "m",
		MODEL_ENGINEER: "m",
		MODEL_REVIEWER: "m",
		THINKING_LEVEL: "low",
		MODEL_PROVIDER: "faux",
		EXECUTION_BACKEND: "simulated",
		REPO_PROVIDER: "simulated",
		SIMULATED_REPO_STATE: "{}",
		...overrides
	};
}

function request(token?: string): Request {
	return new Request("https://organization.test/api/agents", {
		headers: token ? { authorization: `Bearer ${token}` } : {}
	});
}

describe("the management token", () => {
	it("is required, and compared in constant time", () => {
		const env = testEnv();
		expect(isAuthorized(request("the-token"), env)).toBe(true);
		expect(isAuthorized(request("wrong"), env)).toBe(false);
		expect(isAuthorized(request(), env)).toBe(false);
		expect(isAuthorized(request("the-token"), testEnv({ ORG_API_TOKEN: "" }))).toBe(false);
	});
});

describe("the caller", () => {
	it("is nobody when Access did not authenticate the request", () => {
		expect(isAllowed(null, request("the-token"), testEnv())).toBe(true);
	});

	it("is a machine when there is no Access identity", () => {
		const machine: Caller = { email: null, audience: null, isService: true };
		expect(isAllowed(machine, request("the-token"), testEnv())).toBe(true);
		// A machine still needs the token.
		expect(isAllowed(machine, request(), testEnv())).toBe(false);
	});

	it("is a person when Access asserts an identity", () => {
		const person: Caller = {
			email: "operator@example.com",
			audience: "app-aud",
			isService: false
		};
		expect(isAllowed(person, request("the-token"), testEnv())).toBe(true);
		// And still needs the token: Access is not a substitute for it.
		expect(isAllowed(person, request(), testEnv())).toBe(false);
	});

	it("is refused when the identity is not on the allow list", () => {
		const person: Caller = {
			email: "someone@example.com",
			audience: "app-aud",
			isService: false
		};
		const env = testEnv({ CF_ACCESS_ALLOWED_EMAILS: "operator@example.com" });
		expect(isAllowed(person, request("the-token"), env)).toBe(false);

		const allowed: Caller = { ...person, email: "operator@example.com" };
		expect(isAllowed(allowed, request("the-token"), env)).toBe(true);
	});

	it("reads the identity off the execution context, and denies on failure", async () => {
		const ctx = {
			access: {
				aud: "app-aud",
				async getIdentity() {
					return { email: "operator@example.com" };
				}
			}
		} as unknown as ExecutionContext;
		const identity = await accessIdentity(ctx);
		expect(identity?.email).toBe("operator@example.com");
		expect(identity?.isService).toBe(false);

		// No Access at all.
		expect(await accessIdentity({} as ExecutionContext)).toBeNull();
		// Access present but the identity could not be read: a denial.
		const broken = {
			access: {
				aud: "app-aud",
				async getIdentity() {
					throw new Error("nope");
				}
			}
		} as unknown as ExecutionContext;
		expect(await accessIdentity(broken)).toBeNull();
	});
});

describe("the recorded name", () => {
	it("prefers the verified identity over a claimed one", () => {
		const person: Caller = {
			email: "operator@example.com",
			audience: "app-aud",
			isService: false
		};
		expect(callerName(person, "someone-else")).toBe("operator@example.com");
		expect(callerName(null, "someone-else")).toBe("someone-else");
		expect(callerName(null, undefined)).toBe("operator");
	});
});
