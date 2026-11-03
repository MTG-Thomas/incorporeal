# Security policy

Incorporeal is a pre-alpha experiment. There are no supported releases yet;
everything on `main` should be treated as under active development.

## Reporting a vulnerability

Please do **not** open a public issue for a suspected vulnerability. Use GitHub's
[private vulnerability reporting](../../security/advisories/new) on this repository
instead, so the report stays private until a fix exists.

Include, where known:

- the affected commit or file and how the issue was found;
- what an attacker could achieve (read/write/execution scope, agent boundary);
- whether agent isolation or execution-backend credentials are involved.

## Scope notes

- Production dependencies are intentionally tiny (the Worker, one Durable
  Object class, D1, Workers AI); CI gates `npm run check` (typecheck + tests)
  on every push and PR.
- Local Cloudflare emulation (`wrangler`, `@cloudflare/vitest-plugin`) pulls
  in dev-only native dependencies that never ship in the Worker bundle.
  Findings confined to that tree are tracked but do not trigger production
  advisories.
- `ORG_API_TOKEN` and `WEBHOOK_SECRET` live in `wrangler secret put`, never in
  the repo. `.dev.vars` is local-only and git-ignored; CI must fail if a
  secret file is ever tracked.

## Scanning stack

Distinct coverage with low noise; no two scanners report the same dependency CVEs:

- Dependabot: dependency update workflow (npm, daily).
- `npm audit`: advisory production vulnerability signal (blocking gate lives in CI).
- Gitleaks (`.github/workflows/secret-scan.yml`, `.gitleaks.toml`): leaked
  credentials under arbitrary filenames, including fixtures/docs/examples;
  scans tree plus git history, fails closed, uploads SARIF to code scanning.
- CodeQL (actions + javascript-typescript, security-extended): semantic
  source/dataflow vulnerabilities.
- Scorecard: supply-chain posture (advisory SARIF).

If a real secret leaks: revoke/rotate it FIRST (removing it from Git alone is
insufficient since history retains it), then remove the string, consider
history rewrite, and report via private vulnerability reporting above.
