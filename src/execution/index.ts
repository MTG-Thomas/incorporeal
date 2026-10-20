/** Execution backend selection. */
import type { Env } from "../env.ts";
import { GitHubActionsBackend } from "./github-actions.ts";
import { SimulatedExecutionBackend } from "./simulated.ts";
import type { ExecutionBackend } from "./types.ts";

/**
 * The backend named by `EXECUTION_BACKEND`.
 *
 * `github-actions` needs `GITHUB_TOKEN`, `GITHUB_REPO` and
 * `GITHUB_WORKFLOW`. Without them the dispatch fails at GitHub with an
 * authentication error, which is reported as a normal failure rather than
 * silently falling back to another backend: a deployment that thinks it is
 * dispatching real work must not be quietly doing nothing.
 * `none` disables coding execution entirely, which is a valid configuration
 * for a read-only organization.
 */
export function selectExecutionBackend(env: Env): ExecutionBackend {
	switch (env.EXECUTION_BACKEND) {
		case "github-actions":
			return new GitHubActionsBackend();
		case "none":
			return new NoExecutionBackend();
		case "simulated":
		default:
			return new SimulatedExecutionBackend();
	}
}

/** A backend that refuses every action, for deployments that must not execute code. */
export class NoExecutionBackend implements ExecutionBackend {
	readonly name = "none";

	async submit(): Promise<never> {
		throw new Error("execution is disabled for this deployment (EXECUTION_BACKEND=none)");
	}

	async status(runId: string): Promise<never> {
		throw new Error(`execution is disabled for this deployment (EXECUTION_BACKEND=none): ${runId}`);
	}
}
