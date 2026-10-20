/**
 * Deterministic repository checks.
 *
 * A check is *not* a model call. It is a bounded, repeatable inspection of
 * some external state that produces findings, and a finding becomes a task.
 * Keeping this out of the model means the organization can notice trouble
 * without spending an allocation, and means the same input always produces
 * the same finding (which is what makes the fingerprint deduplication work).
 */
import type { Env } from "../env.ts";

export type CheckFinding = {
	/** Stable identity of this problem. Tasks are deduplicated on it. */
	fingerprint: string;
	/** Short title for the task. */
	title: string;
	/** What the agent should look at. */
	detail: string;
	/** The kind of task this finding should create. */
	kind: string;
};

export type CheckResult = {
	/** True when the check could not determine the state. */
	unknown: boolean;
	findings: CheckFinding[];
	/** Short description of what was inspected, for the event log. */
	detail: string;
};

export type CheckContext = {
	env: Env;
	correlationId: string;
};

export interface RepositoryCheck {
	readonly name: string;
	run(context: CheckContext): Promise<CheckResult>;
}
