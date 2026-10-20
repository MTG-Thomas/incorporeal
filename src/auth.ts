/**
 * Authentication, in two layers.
 *
 * **The edge.** Cloudflare Access can sit in front of the Worker
 * ("Worker-level Access"), so an unauthenticated visitor never reaches the
 * application at all. When it does, the Worker can ask who the caller is:
 * `ctx.access.getIdentity()` returns the identity the identity provider
 * asserted — an email address, verified by the provider and signed by
 * Cloudflare.
 *
 * **The application.** The management API requires a bearer token. That stays
 * even when Access is in front, because Access answers "is this an
 * authenticated human?" and the token answers "is this an authorized
 * management client?". A mistake in one policy should not grant the rights of
 * the other.
 *
 * A machine caller (the CLI, the webhook sender) authenticates with the
 * token and arrives with no Access identity. That is a different kind of
 * principal, and the code keeps them apart.
 */
import type { Env } from "./env.ts";

/** Who the caller is, as far as the application can tell. */
export type Caller = {
	/** The verified email, when Access authenticated the request. */
	email: string | null;
	/** The Access audience tag, when Access authenticated the request. */
	audience: string | null;
	/** True when the caller is a machine rather than a person. */
	isService: boolean;
};

/** The identity behind an Access-authenticated request, if there is one. */
export async function accessIdentity(ctx: ExecutionContext): Promise<Caller | null> {
	const access = ctx.access;
	if (!access) return null;
	let identity: { email?: string; type?: string } | undefined;
	try {
		identity = await access.getIdentity();
	} catch {
		// An Access failure is a denial, not an allow.
		return null;
	}
	if (!identity) return null;
	return {
		email: identity.email ?? null,
		audience: access.aud,
		// A service token authenticates as a machine: no human email.
		isService: !identity.email
	};
}

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

/**
 * Is this caller allowed to drive the organization?
 *
 * The token is always required. When Access authenticated the request, the
 * identity is also checked against `CF_ACCESS_ALLOWED_EMAILS`, if that is
 * configured: a token alone is not enough for a human whose email is not on
 * the list. A machine caller has no Access identity, so the token is the
 * whole of its authority.
 */
export function isAllowed(caller: Caller | null, request: Request, env: Env): boolean {
	if (!isAuthorized(request, env)) return false;
	if (!caller || caller.isService) return true;
	const allowlist = (env.CF_ACCESS_ALLOWED_EMAILS ?? "")
		.split(",")
		.map((email) => email.trim().toLowerCase())
		.filter((email) => email.length > 0);
	if (allowlist.length === 0) return true;
	if (!caller.email) return false;
	return allowlist.includes(caller.email.toLowerCase());
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

/** A 403 response, for a caller who is known but not allowed. */
export function forbidden(reason = "forbidden"): Response {
	return new Response(JSON.stringify({ error: reason }), {
		status: 403,
		headers: { "content-type": "application/json" }
	});
}

/**
 * The name to record for whoever made a request.
 *
 * A verified Access identity wins over a name in the request body: the
 * identity provider asserted the email, and anyone with the token can claim
 * any name they like.
 */
export function callerName(caller: Caller | null, claimed?: string): string {
	if (caller?.email) return caller.email;
	if (claimed && claimed.trim().length > 0) return claimed.trim();
	return "operator";
}
