#!/usr/bin/env node
/**
 * Put the organization behind Cloudflare Access.
 *
 * Worker-level Access protects a Worker by its script id, which covers its
 * `workers.dev` hostname, its routes, its custom domains and its preview URLs
 * — no custom domain and no change to `wrangler.jsonc`.
 *
 * It creates three things:
 *   1. an Access application for the Worker, with an Allow policy for the
 *      operator's email;
 *   2. a service token, for machine callers such as the CLI;
 *   3. a second policy that lets that service token through.
 *
 * Usage:
 *   CLOUDFLARE_API_TOKEN=… node scripts/access-setup.mjs --email you@example.com
 *   CLOUDFLARE_API_TOKEN=… node scripts/access-setup.mjs --email you@example.com --dry-run
 *
 * The token needs the `Access: Apps and Policies Write` and
 * `Workers Scripts: Read` permissions.
 *
 * The dashboard does the same thing in two clicks: Workers & Pages →
 * incorporeal → Access.
 */
import process from "node:process";

const args = process.argv.slice(2);
const flag = (name) => {
	const index = args.indexOf(`--${name}`);
	return index === -1 ? undefined : args[index + 1];
};

const token = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "b5fc61a1bec847ecc83b3b880b563aaf";
const workerName = flag("worker") ?? "incorporeal";
const emails = (flag("email") ?? "")
	.split(",")
	.map((email) => email.trim())
	.filter((email) => email.length > 0);
const serviceTokenName = flag("service-token-name") ?? `${workerName}-cli`;
const dryRun = args.includes("--dry-run");

if (!token) {
	process.stderr.write(
		"Set CLOUDFLARE_API_TOKEN to a token with `Access: Apps and Policies Write` and `Workers Scripts: Read`.\n"
	);
	process.exit(1);
}
if (emails.length === 0) {
	process.stderr.write("Give --email <address> (comma separated for several).\n");
	process.exit(1);
}

const api = "https://api.cloudflare.com/client/v4";

async function call(path, init = {}) {
	const response = await fetch(`${api}${path}`, {
		...init,
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
			...init.headers
		}
	});
	const body = await response.json().catch(() => ({}));
	if (!response.ok) {
		const detail = body?.errors?.map((error) => error.message).join("; ") ?? response.statusText;
		throw new Error(`${init.method ?? "GET"} ${path} failed: ${detail}`);
	}
	return body.result;
}

const script = await call(`/accounts/${accountId}/workers/scripts/${workerName}`);
if (!script?.id) throw new Error(`could not find the worker ${workerName}`);

if (dryRun) {
	process.stdout.write(
		`Would create an Access application for the worker ${script.id}, an allow policy for ${emails.join(", ")}, and a service token named ${serviceTokenName}.\n`
	);
	process.exit(0);
}

// 1. The service token, for the machine callers.
const serviceToken = await call(`/accounts/${accountId}/access/service_tokens`, {
	method: "POST",
	body: JSON.stringify({ name: serviceTokenName, duration: "8760h" })
});

// 2. The application, with both policies.
const application = {
	type: "self_hosted",
	name: `Access for ${workerName}`,
	destinations: [{ type: "worker", worker_id: script.id }],
	policies: [
		{
			decision: "allow",
			name: `${workerName} operators`,
			precedence: 1,
			include: emails.map((email) => ({ email: { email } }))
		},
		{
			decision: "allow",
			name: `${workerName} machine callers`,
			precedence: 2,
			include: [{ service_token: { token_id: serviceToken.id } }]
		}
	],
	session_duration: "24h"
};

const created = await call(`/accounts/${accountId}/access/apps`, {
	method: "POST",
	body: JSON.stringify(application)
});

process.stdout.write(`Created the Access application "${created.name}".\n`);
process.stdout.write(`  id:  ${created.id}\n`);
process.stdout.write(`  aud: ${created.aud}\n`);
process.stdout.write(`\nThe Worker is now behind Access:\n  https://${workerName}.<your-subdomain>.workers.dev\n`);
process.stdout.write("\nSet these for the CLI and for any machine caller:\n");
process.stdout.write(`  CF_ACCESS_CLIENT_ID=${serviceToken.client_id}\n`);
process.stdout.write(`  CF_ACCESS_CLIENT_SECRET=${serviceToken.client_secret}\n`);
process.stdout.write(`  CF_ACCESS_ALLOWED_EMAILS=${emails.join(",")}\n`);
process.stdout.write(
	"\nThe client secret is shown only once. Store it in the deployment's .env, and set\n" +
		"CF_ACCESS_ALLOWED_EMAILS on the Worker to restrict who may drive the organization.\n"
);
