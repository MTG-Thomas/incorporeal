/**
 * Authentication.
 *
 * Two credentials, both secrets:
 *
 * - `ORG_API_TOKEN` authorizes the management API. Every agent-control
 *   endpoint requires it; there is no unauthenticated way to reach an agent.
 * - `WEBHOOK_SECRET` authorizes inbound webhooks, which are a different
 *   trust boundary: an external system pushing an event.
 *
 * Both comparisons are constant time, so a wrong token leaks nothing about
 * how wrong it was.
 */
import type { Env } from "./env.ts";

/** Constant-time comparison of two strings of equal expected length. */
function safeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let difference = 0;
	for (let i = 0; i < a.length; i++) {
		difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return difference === 0;
}

/** True when the request carries the management API token. */
export function isAuthorized(request: Request, env: Env): boolean {
	const header = request.headers.get("authorization") ?? "";
	const match = /^Bearer\s+(.+)$/i.exec(header.trim());
	if (!match) return false;
	if (!env.ORG_API_TOKEN) return false;
	return safeEqual(match[1]!.trim(), env.ORG_API_TOKEN);
}

/** True when the request carries the webhook secret. */
export function isWebhookAuthorized(request: Request, env: Env): boolean {
	const header = request.headers.get("x-webhook-secret") ?? "";
	if (!env.WEBHOOK_SECRET) return false;
	return safeEqual(header, env.WEBHOOK_SECRET);
}

/** A 401 response that does not say which part of the credential was wrong. */
export function unauthorized(): Response {
	return new Response(JSON.stringify({ error: "unauthorized" }), {
		status: 401,
		headers: { "content-type": "application/json" }
	});
}
