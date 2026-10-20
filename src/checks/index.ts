/** Repository check selection. */
import type { Env } from "../env.ts";
import { GitHubRepositoryCheck } from "./github.ts";
import { SimulatedRepositoryCheck } from "./simulated.ts";
import type { RepositoryCheck } from "./types.ts";

/**
 * The check named by `REPO_PROVIDER`.
 *
 * The GitHub check is only selected when a repository is configured, so a
 * deployment without a GitHub account keeps working with the simulated
 * provider instead of failing every sweep.
 */
export function selectRepositoryCheck(
	env: Env,
	spec?: { kind?: string } | null
): RepositoryCheck {
	const kind = spec?.kind ?? env.REPO_PROVIDER;
	if (kind === "github" && env.GITHUB_REPO) return new GitHubRepositoryCheck();
	return new SimulatedRepositoryCheck();
}
