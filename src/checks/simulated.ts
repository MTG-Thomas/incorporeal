/**
 * The simulated repository check.
 *
 * It reads a JSON state blob from the environment, so a deployment can
 * demonstrate the whole proactive loop — check, finding, task, delegation,
 * review — without a GitHub account. The state is part of the configuration,
 * not a secret, and it is clearly labelled as simulated wherever it appears.
 */
import type { CheckContext, CheckResult, RepositoryCheck } from "./types.ts";

type SimulatedState = {
	ciStatus?: "passing" | "failing";
	workflow?: string;
	branch?: string;
	issue?: string;
};

export class SimulatedRepositoryCheck implements RepositoryCheck {
	readonly name = "simulated";

	async run(context: CheckContext): Promise<CheckResult> {
		let state: SimulatedState = {};
		try {
			state = JSON.parse(context.env.SIMULATED_REPO_STATE || "{}") as SimulatedState;
		} catch {
			return { unknown: true, findings: [], detail: "SIMULATED_REPO_STATE is not valid JSON" };
		}
		if (state.ciStatus !== "failing") {
			return { unknown: false, findings: [], detail: "simulated repository is healthy" };
		}
		const workflow = state.workflow ?? "build";
		const branch = state.branch ?? "main";
		return {
			unknown: false,
			findings: [
				{
					fingerprint: `simulated-ci-failure:${workflow}:${branch}`,
					title: `CI workflow "${workflow}" is failing on ${branch}`,
					detail:
						state.issue ??
						`The ${workflow} workflow on ${branch} is failing. Investigate the failure, propose a fix and provide evidence.`,
					kind: "investigate"
				}
			],
			detail: `simulated check: ${workflow} failing`
		};
	}
}
