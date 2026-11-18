#!/usr/bin/env node
/**
 * Audit production dependencies, tolerating only advisories that have no fix.
 *
 * `npm audit --omit=dev` fails the build on any finding. Occasionally an advisory
 * has no patched release at all, so the only ways to keep CI honest are to stop
 * auditing or to record a narrow, reviewed exception. This does the latter.
 *
 * An exception must name the GHSA ID and the package it applies to. Everything
 * else still fails the gate, and an exception that no longer matches a reported
 * advisory is called out so it can be deleted instead of quietly rotting.
 */
import { spawnSync } from "node:child_process";

/** Advisories with no patched release. Delete an entry once upstream ships one. */
const ALLOWED = [
	{
		ghsa: "GHSA-fc5q-39xc-vjpf",
		package: "picomatch",
		reason:
			"ReDoS in extglobs; no patched release exists (4.0.7 is the newest and is within the affected range).",
		// Reached through `agents` -> @rolldown/plugin-babel and its vite peer, which the Worker uses via agents/harness/pi.
		tracking: "https://github.com/advisories/GHSA-fc5q-39xc-vjpf"
	}
];

// `npm` is a .cmd shim on Windows, which needs a shell; on Linux (where CI runs)
// it is an ordinary executable and spawning directly avoids the shell entirely.
const isWindows = process.platform === "win32";
const audit = spawnSync(isWindows ? "npm.cmd" : "npm", ["audit", "--omit=dev", "--json"], {
	encoding: "utf8",
	shell: isWindows
});

let report;
try {
	report = JSON.parse(audit.stdout || "{}");
} catch {
	console.error("Could not parse `npm audit --json` output.");
	console.error(audit.stdout);
	console.error(audit.stderr);
	process.exit(1);
}

/** Collect every GHSA named by a reported vulnerability, with its package. */
const findings = new Map();
for (const [name, vuln] of Object.entries(report.vulnerabilities ?? {})) {
	for (const via of vuln.via ?? []) {
		if (typeof via !== "object" || !via.url) continue;
		const ghsa = /GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i.exec(via.url);
		if (!ghsa) continue;
		findings.set(`${ghsa[0]}::${name}`, { ghsa: ghsa[0], package: name, title: via.title });
	}
}

const allowedKeys = new Set(ALLOWED.map((entry) => `${entry.ghsa}::${entry.package}`));
const unexpected = [...findings.values()].filter((f) => !allowedKeys.has(`${f.ghsa}::${f.package}`));
const matched = [...findings.values()].filter((f) => allowedKeys.has(`${f.ghsa}::${f.package}`));

for (const entry of matched) {
	const policy = ALLOWED.find((a) => a.ghsa === entry.ghsa && a.package === entry.package);
	console.log(`tolerated: ${entry.ghsa} (${entry.package}) - ${policy.reason}`);
	console.log(`           ${policy.tracking}`);
}

const unused = ALLOWED.filter(
	(policy) => !matched.some((f) => f.ghsa === policy.ghsa && f.package === policy.package)
);
for (const policy of unused) {
	console.log(
		`notice: ${policy.ghsa} (${policy.package}) no longer appears in the audit - remove it from ALLOWED in scripts/audit-production.mjs`
	);
}

if (unexpected.length > 0) {
	console.error(`\nProduction audit failed: ${unexpected.length} unexpected advisory group(s).`);
	for (const entry of unexpected) {
		console.error(`  ${entry.ghsa}  ${entry.package}  ${entry.title ?? ""}`);
	}
	process.exit(1);
}

console.log("\nProduction audit passed: no unexpected advisories.");
