/**
 * Execution backends.
 *
 * Coding execution is deliberately pluggable and deliberately outside the
 * agent's identity: an agent asks for "this command, in this repository" and
 * a backend decides where it runs. The MVP ships a simulated backend (so the
 * organization works with no external account) and a GitHub Actions backend
 * (a real, free-for-public-repositories runner). Cloudflare Containers are
 * intentionally not used: they are a Workers Paid feature and would make the
 * MVP require a paid subscription.
 */
import type { Env } from "../env.ts";

export type ExecutionSpec = {
	/** What to run, in the backend's own terms. */
	command: string;
	/** Optional arguments. */
	args?: string[];
	/** Repository to act on, `owner/name`. */
	repo?: string;
	/** Branch to act on. */
	branch?: string;
	/** Free-form note recorded with the execution. */
	notes?: string;
	/** When the action was requested; backends that cannot return a run id use it to find one. */
	requestedAt?: number;
};

export type ExecutionHandle = {
	runId: string;
	status: "submitted" | "succeeded" | "failed" | "unknown";
	/** Where a human can watch the action. */
	url?: string;
	/** Human-readable detail, kept short. */
	detail?: string;
};

export type ExecutionContext = {
	env: Env;
	/** Correlation id of the request that caused the action. */
	correlationId: string;
};

export interface ExecutionBackend {
	readonly name: string;
	/** Start an execution. */
	submit(spec: ExecutionSpec, context: ExecutionContext): Promise<ExecutionHandle>;
	/** Report the current state of a previous execution. */
	status(runId: string, context: ExecutionContext): Promise<ExecutionHandle>;
}

/** Thrown when a backend cannot run an action, so the tool can report it cleanly. */
export class ExecutionError extends Error {
	constructor(
		message: string,
		readonly retryable = false
	) {
		super(message);
		this.name = "ExecutionError";
	}
}
