/**
 * The GitHub repository check.
 *
 * It looks at the most recent workflow runs and reports the newest failure on
 * the default branch. It is a read-only call to the GitHub REST API: no
 * Cloudflare infrastructure, no paid plan, and no cost beyond a request.
 */
import type { CheckContext, CheckResult, RepositoryCheck } from "./types.ts";

type WorkflowRunsResponse = {
	workflow_runs?: {
		id: number;
		name: string | null;
		workflow_id: number;
		status: string;
		conclusion: string | null;
		head_branch: string | null;
		html_url: string;
		created_at: string;
	}[];
};

export class GitHubRepositoryCheck implements RepositoryCheck {
	readonly name = "github";

	async run(context: CheckContext): Promise<CheckResult> {
		const repo = context.env.GITHUB_REPO;
		if (!repo) {
			return { unknown: true, findings: [], detail: "GITHUB_REPO is not configured" };
		}
		const base = context.env.GITHUB_API_BASE ?? "https://api.github.com";
		const headers: Record<string, string> = {
			accept: "application/vnd.github+json",
			"x-github-api-version": "2022-11-28",
			"user-agent": "incorporeal-org"
		};
		if (context.env.GITHUB_TOKEN) headers.authorization = `Bearer ${context.env.GITHUB_TOKEN}`;

		const response = await fetch(
			`${base}/repos/${repo}/actions/runs?branch=${encodeURIComponent(
				"main"
			)}&per_page=20`,
			{ headers }
		);
		if (!response.ok) {
			return {
				unknown: true,
				findings: [],
				detail: `GitHub workflow run lookup failed with status ${response.status}`
			};
		}
		const body = (await response.json()) as WorkflowRunsResponse;
		const runs = (body.workflow_runs ?? []).filter((run) => run.status === "completed");
		const failure = runs.find((run) => run.conclusion === "failure");
		if (!failure) {
			return { unknown: false, findings: [], detail: "no failing workflow run on main" };
		}
		const workflow = failure.name ?? `workflow-${failure.workflow_id}`;
		return {
			unknown: false,
			findings: [
				{
					fingerprint: `github-ci-failure:${repo}:${workflow}:${failure.head_branch ?? "main"}`,
					title: `CI workflow "${workflow}" is failing in ${repo}`,
					detail: `The ${workflow} workflow failed on ${
						failure.head_branch ?? "main"
					}. Run: ${failure.html_url}. Investigate the failure, propose a fix and provide evidence.`,
					kind: "investigate"
				}
			],
			detail: `github check: ${workflow} failed`
		};
	}
}
