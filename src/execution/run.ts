/**
 * Sending a recorded execution.
 *
 * The row is written before the action is sent, so a process that dies in
 * between leaves a `pending` row with no run id. That row is re-sent rather
 * than lost, and the backend is given the idempotency key so it can
 * recognise the re-send as the same action.
 *
 * The helper lives here so that the tool and the sweep agree on what
 * sending means.
 */
import { recordEvent, updateExecution } from "../db/org.ts";
import type { D1Database } from "@cloudflare/workers-types";
import type { Env } from "../env.ts";
import { logWarn } from "../logging.ts";
import type { ExecutionBackend, ExecutionHandle, ExecutionSpec } from "./types.ts";

export type ExecutionRecord = {
	execution_id: string;
	task_id: string;
	idempotency_key: string;
	backend: string;
	spec: string;
	status: string;
	run_id: string | null;
};

export type SendOptions = {
	env: Env;
	db: D1Database;
	backend: ExecutionBackend;
	row: ExecutionRecord;
	spec: ExecutionSpec;
	correlationId: string;
	agentId?: string | null;
};

/** Send an execution and write down what became of it. */
export async function sendExecution(options: SendOptions): Promise<ExecutionHandle> {
	const { env, db, backend, row, spec, correlationId, agentId } = options;
	try {
		const handle = await backend.submit(
			{ ...spec, idempotencyKey: row.idempotency_key },
			{ env, correlationId }
		);
		await updateExecution(db, row.execution_id, {
			status: handle.status === "failed" ? "failed" : "submitted",
			runId: handle.runId,
			result: { detail: handle.detail ?? null, url: handle.url ?? null }
		});
		await recordEvent(db, {
			correlationId,
			agentId: agentId ?? null,
			taskId: row.task_id,
			type: "execution.submitted",
			payload: { backend: backend.name, run_id: handle.runId, command: spec.command }
		});
		return handle;
	} catch (error) {
		await updateExecution(db, row.execution_id, {
			status: "failed",
			result: { error: error instanceof Error ? error.message : String(error) }
		});
		logWarn("execution failed", {
			agentId: agentId ?? undefined,
			taskId: row.task_id,
			error: error instanceof Error ? error.message : String(error)
		});
		throw error;
	}
}
