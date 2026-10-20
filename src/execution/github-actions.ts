/**
 * GitHub Actions execution backend.
 *
 * It dispatches a workflow in a repository and reports the run. The cost is
 * GitHub's: Actions minutes are free for public repositories and billed for
 * private ones, which is an independent cost of using this backend and is
 * documented in docs/free-tier.md. Nothing here requires a Cloudflare paid
 * plan.
 */
import { ExecutionError, type ExecutionBackend, type ExecutionContext, type ExecutionHandle, type ExecutionSpec } from "./types.ts";

type WorkflowRunsResponse = {
	workflow_runs?: {
		id: number;
		status: string;
		conclusion: string | null;
		html_url: string;
		created_at: string;
		event?: string;
	}[];
};

export class GitHubActionsBackend implements ExecutionBackend {
	readonly name = "github-actions";

	async submit(spec: ExecutionSpec, context: ExecutionContext): Promise<ExecutionHandle> {
		const { repo, workflow } = this.target(context.env);
		const base = apiBase(context.env);
		const response = await fetch(`${base}/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
			method: "POST",
			headers: headers(context.env),
			body: JSON.stringify({
				ref: spec.branch ?? "main",
				inputs: {
					command: spec.command,
					...(spec.args && spec.args.length > 0 ? { args: spec.args.join(" ") } : {}),
					...(spec.notes ? { notes: spec.notes } : {})
				}
			})
		});
		if (response.status === 422) {
			throw new ExecutionError(`GitHub rejected the workflow dispatch for ${repo}/${workflow}`);
		}
		if (!response.ok && response.status !== 204) {
			throw new ExecutionError(
				`GitHub workflow dispatch failed with status ${response.status}`,
				response.status >= 500
			);
		}
		// The dispatch endpoint returns no run id, so the run is found by its
		// creation time. The caller polls `status` with the returned marker.
		return {
			runId: `dispatch:${repo}:${workflow}:${spec.requestedAt ?? Date.now()}`,
			status: "submitted",
			detail: `dispatched ${workflow} in ${repo}`
		};
	}

	async status(runId: string, context: ExecutionContext): Promise<ExecutionHandle> {
		const { repo } = this.target(context.env);
		const base = apiBase(context.env);
		const response = await fetch(
			`${base}/repos/${repo}/actions/runs?event=workflow_dispatch&per_page=10`,
			{ headers: headers(context.env) }
		);
		if (!response.ok) {
			throw new ExecutionError(`GitHub workflow run lookup failed with status ${response.status}`, true);
		}
		const body = (await response.json()) as WorkflowRunsResponse;
		const runs = body.workflow_runs ?? [];
		const requestedAt = Number.parseInt(runId.split(":").pop() ?? "0", 10);
		const match =
			runs.find((run) => run.created_at && Date.parse(run.created_at) >= requestedAt - 60_000) ??
			runs[0];
		if (!match) return { runId, status: "unknown", detail: "no workflow run found yet" };
		const status: ExecutionHandle["status"] =
			match.status === "completed"
				? match.conclusion === "success"
					? "succeeded"
					: "failed"
				: "submitted";
		return {
			runId: String(match.id),
			status,
			url: match.html_url,
			detail: `${match.status}${match.conclusion ? ` (${match.conclusion})` : ""}`
		};
	}

	private target(env: ContextEnv): { repo: string; workflow: string } {
		const repo = env.GITHUB_REPO;
		const workflow = env.GITHUB_WORKFLOW;
		if (!repo) throw new ExecutionError("GITHUB_REPO is not configured");
		if (!workflow) throw new ExecutionError("GITHUB_WORKFLOW is not configured");
		return { repo, workflow };
	}
}

type ContextEnv = ExecutionContext["env"];

function apiBase(env: ContextEnv): string {
	return env.GITHUB_API_BASE ?? "https://api.github.com";
}

function headers(env: ContextEnv): Record<string, string> {
	const headers: Record<string, string> = {
		accept: "application/vnd.github+json",
		"x-github-api-version": "2022-11-28",
		"user-agent": "incorporeal-org"
	};
	if (env.GITHUB_TOKEN) headers.authorization = `Bearer ${env.GITHUB_TOKEN}`;
	return headers;
}
