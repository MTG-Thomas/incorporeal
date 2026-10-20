/**
 * A simulated execution backend.
 *
 * It performs no external work: it records that the action was requested and
 * reports success. It exists so the organization can be deployed, demonstrated
 * and tested without a GitHub account, a runner, or any paid service.
 */
import type { ExecutionBackend, ExecutionContext, ExecutionHandle, ExecutionSpec } from "./types.ts";

export class SimulatedExecutionBackend implements ExecutionBackend {
	readonly name = "simulated";

	async submit(spec: ExecutionSpec, _context: ExecutionContext): Promise<ExecutionHandle> {
		const runId = `sim-${spec.requestedAt ?? Date.now()}-${hash(spec.command)}`;
		return {
			runId,
			status: "succeeded",
			detail: `simulated execution of "${spec.command}"`,
			url: undefined
		};
	}

	async status(runId: string, _context: ExecutionContext): Promise<ExecutionHandle> {
		return { runId, status: "succeeded", detail: "simulated execution" };
	}
}

/** A stable, short hash of a string; used for simulated run ids only. */
function hash(value: string): string {
	let h = 2166136261;
	for (let i = 0; i < value.length; i++) {
		h ^= value.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return (h >>> 0).toString(36);
}
