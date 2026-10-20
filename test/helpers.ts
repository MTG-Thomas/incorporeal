/**
 * Helpers for the integration tests.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import worker from "../src/index.ts";
import { listTasks } from "../src/db/org.ts";
import type { Env } from "../src/env.ts";

export const API_TOKEN = "test-token";
export const WEBHOOK_SECRET = "test-webhook-secret";

/** Call the worker's fetch handler the way the runtime would. */
export async function call(
	path: string,
	init: RequestInit & { token?: string | null; webhookSecret?: string | null } = {}
): Promise<Response> {
	const headers = new Headers(init.headers);
	if (init.token !== null) headers.set("authorization", `Bearer ${init.token ?? API_TOKEN}`);
	if (init.webhookSecret) headers.set("x-webhook-secret", init.webhookSecret);
	if (init.body) headers.set("content-type", "application/json");
	const request = new Request(`https://organization.test${path}`, { ...init, headers });
	return worker.fetch(request, env as unknown as Env, createExecutionContext());
}

/** Call the API and parse the JSON body. */
export async function api<T = Record<string, unknown>>(
	path: string,
	init: RequestInit & { token?: string | null; webhookSecret?: string | null } = {}
): Promise<{ status: number; body: T }> {
	const response = await call(path, init);
	const text = await response.text();
	return {
		status: response.status,
		body: (text ? JSON.parse(text) : {}) as T
	};
}

/** Poll until a condition holds, or fail with a useful message. */
export async function waitFor<T>(
	read: () => Promise<T | null | undefined>,
	message = "condition",
	timeoutMs = 30_000
): Promise<T> {
	const start = Date.now();
	for (;;) {
		const value = await read();
		if (value !== null && value !== undefined && value !== false) return value;
		if (Date.now() - start > timeoutMs) {
			throw new Error(`timed out waiting for ${message} after ${timeoutMs}ms`);
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

/** The shared store, for assertions that read the organization's state directly. */
export function db(): D1Database {
	return env.ORG_DB;
}

/**
 * Wait until no task is pending, assigned or running.
 *
 * The organization works in the background: a call returns long before the
 * agents have finished. A test that wants the runtime to shut down quietly
 * waits for the work to settle first.
 */
export async function waitForIdle(timeoutMs = 30_000): Promise<void> {
	await waitFor(
		async () => {
			const open = await listTasks(env.ORG_DB, { status: ["pending", "assigned", "running"] });
			return open.length === 0 ? true : null;
		},
		"the organization to go idle",
		timeoutMs
	);
}
