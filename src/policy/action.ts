/**
 * What an approval authorises.
 *
 * An approval that says "this task may act" is a broad licence: the model
 * chooses the command afterwards, so a human who approved "run the tests"
 * can end up having approved, in effect, "let this agent run anything".
 *
 * A scoped approval names the action: the command, and optionally the
 * arguments, the backend, the repository and the branch. The execution must
 * match it, so the human's decision is about one specific effect.
 */
import type { JsonValue } from "@earendil-works/pi-ai";

export type ApprovedAction = {
	/** The command to run. Required: an approval without one authorises nothing. */
	command: string;
	/** The arguments, when the approval names them. */
	args?: string[];
	/** The backend, when the approval names one. */
	backend?: string;
	/** The repository, when the approval names one. */
	repo?: string;
	/** The branch, when the approval names one. */
	branch?: string;
};

/** Read an action out of a stored JSON blob. */
export function parseAction(raw: string | null | undefined): ApprovedAction | null {
	if (!raw) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object") return null;
		const action = parsed as Partial<ApprovedAction>;
		if (typeof action.command !== "string" || action.command.length === 0) return null;
		return {
			command: action.command,
			...(Array.isArray(action.args) ? { args: action.args.map(String) } : {}),
			...(typeof action.backend === "string" ? { backend: action.backend } : {}),
			...(typeof action.repo === "string" ? { repo: action.repo } : {}),
			...(typeof action.branch === "string" ? { branch: action.branch } : {})
		};
	} catch {
		return null;
	}
}

/** A short description of an action, for the approval list and the log. */
export function describeAction(action: ApprovedAction | null): string {
	if (!action) return "no action named";
	const parts = [action.command];
	if (action.args && action.args.length > 0) parts.push(action.args.join(" "));
	if (action.backend) parts.push(`via ${action.backend}`);
	if (action.repo) parts.push(`in ${action.repo}`);
	if (action.branch) parts.push(`on ${action.branch}`);
	return parts.join(" ");
}

/**
 * Does an approved action cover the action that was requested?
 *
 * A field the approval names must match exactly. A field it does not name is
 * not constrained by it.
 */
export function actionMatches(approved: ApprovedAction, requested: ApprovedAction): boolean {
	if (approved.command !== requested.command) return false;
	if (approved.args && !sameArgs(approved.args, requested.args ?? [])) return false;
	if (approved.backend && approved.backend !== requested.backend) return false;
	if (approved.repo && approved.repo !== requested.repo) return false;
	if (approved.branch && approved.branch !== requested.branch) return false;
	return true;
}

function sameArgs(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** The action as JSON, for storing. */
export function actionToJson(action: ApprovedAction | undefined): JsonValue | undefined {
	return action as unknown as JsonValue;
}
