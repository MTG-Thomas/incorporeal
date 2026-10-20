#!/usr/bin/env node
/**
 * Sign in to ChatGPT and save the credential for the organization.
 *
 * A ChatGPT *subscription* is not an API key: it is an OAuth sign-in that
 * yields a token which expires and is refreshed. The sign-in has to happen
 * where a browser can reach a callback — this machine — and the resulting
 * credential is then handed to the organization, which stores it and refreshes
 * it in place.
 *
 * Usage:
 *   node scripts/chatgpt-login.mjs            # sign in, write the credential
 *   node scripts/chatgpt-login.mjs --out c.json
 *
 * The credential is written with owner-only permissions. Push it with:
 *   node scripts/orgctl.mjs credential-set --provider openai --file c.json
 */
import { createModels } from "@earendil-works/pi-ai";
import { writeFile, chmod } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import process from "node:process";

const out = process.argv.includes("--out")
	? process.argv[process.argv.indexOf("--out") + 1]
	: "chatgpt-credential.json";

/**
 * The interaction the sign-in needs: a question, and things to say.
 *
 * The ChatGPT flow asks the operator to open a URL in a browser. It either
 * catches the callback on a local server or asks for the callback URL to be
 * pasted, so both are supported here.
 */
const interaction = {
	async prompt(prompt) {
		if (prompt.type === "select") {
			process.stdout.write(`${prompt.message}\n`);
			for (const option of prompt.options) {
				process.stdout.write(`  ${option.id} — ${option.label}\n`);
			}
		} else {
			process.stdout.write(`${prompt.message}\n`);
		}
		if (prompt.placeholder) process.stdout.write(`(${prompt.placeholder})\n`);
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		const answer = await rl.question("> ");
		rl.close();
		return answer.trim();
	},
	notify(event) {
		if (event.type === "auth_url") {
			process.stdout.write(`\nOpen this URL in a browser:\n  ${event.url}\n`);
			if (event.instructions) process.stdout.write(`${event.instructions}\n`);
			return;
		}
		if (event.type === "device_code") {
			process.stdout.write(`\nEnter the code ${event.userCode} at ${event.verificationUri}\n`);
			return;
		}
		if (event.type === "info") {
			process.stdout.write(`${event.message}\n`);
			for (const link of event.links ?? []) {
				process.stdout.write(`  ${link.label ?? link.url}: ${link.url}\n`);
			}
		}
	}
};

const models = createModels();
const credential = await models.login("openai", "oauth", interaction, {
	agentName: "Incorporeal"
});

if (!credential) {
	process.stderr.write("The sign-in did not produce a credential.\n");
	process.exit(1);
}

await writeFile(out, `${JSON.stringify(credential, null, 2)}\n`, { mode: 0o600 });
await chmod(out, 0o600).catch(() => {});
process.stdout.write(`\nSaved the credential to ${out}.\n`);
process.stdout.write(
	`Push it to the organization with:\n  node scripts/orgctl.mjs credential-set --provider openai --file ${out}\n`
);
