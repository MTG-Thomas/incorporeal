/**
 * Replay, repetition and the edges of the sweep.
 *
 * These are the cases where the same thing happens twice: a tool call
 * replayed after an interruption, a finding that comes back, an action that
 * was recorded but never sent.
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
	createApproval,
	createTask,
	getTask,
	listEvents,
	listTasks,
	recordExecution
} from "../src/db/org.ts";
import { api, db, waitFor } from "./helpers.ts";

describe("a replayed tool call", () => {
	it("finds the task it made instead of making a second one", async () => {
		const first = await createTask(db(), {
			kind: "research",
			title: "A delegated task",
			instruction: "Do it.",
			assignee: "engineer",
			createdBy: "coordinator",
			toolTaskId: "tool_call_1",
			correlationId: "cor_replay"
		});
		const second = await createTask(db(), {
			kind: "research",
			title: "A delegated task",
			instruction: "Do it.",
			assignee: "engineer",
			createdBy: "coordinator",
			toolTaskId: "tool_call_1",
			correlationId: "cor_replay"
		});
		expect(second.created).toBe(false);
		expect(second.task.task_id).toBe(first.task.task_id);

		const rows = await listTasks(db(), { kind: "research" });
		expect(rows.length).toBe(1);
	});

	it("finds the approval it raised instead of raising a second one", async () => {
		const first = await createApproval(db(), {
			taskId: null,
			requestedBy: "coordinator",
			reason: "Apply it.",
			toolTaskId: "tool_call_2"
		});
		const second = await createApproval(db(), {
			taskId: null,
			requestedBy: "coordinator",
			reason: "Apply it.",
			toolTaskId: "tool_call_2"
		});
		expect(second.approval_id).toBe(first.approval_id);

		const rows = await db()
			.prepare("SELECT * FROM approvals WHERE tool_task_id = 'tool_call_2'")
			.all<{ approval_id: string }>();
		expect(rows.results.length).toBe(1);
	});
});

describe("a finding that comes back", () => {
	it("does not open a second chain while the first one is unresolved", async () => {
		// An obligation that always reports the same failing workflow.
		await db()
			.prepare(
				`INSERT INTO obligations (obligation_id, name, owner_agent, kind, interval_seconds,
					check_spec, enabled, next_run_at, created_at, updated_at)
				 VALUES ('obl_repeat', 'Watch', 'coordinator', 'interval', 60, '{}', 1, 0, 1, 1)`
			)
			.run();

		await env.ORG_AGENTS.getByName("coordinator").runSweep();
		const first = await listTasks(db(), { kind: "investigate" });
		expect(first.length).toBe(1);

		// The chain is still open: the investigation is running or waiting.
		// The next interval comes round.
		await db()
			.prepare("UPDATE obligations SET next_run_at = 0 WHERE obligation_id = 'obl_repeat'")
			.run();
		await env.ORG_AGENTS.getByName("coordinator").runSweep();
		const second = await listTasks(db(), { kind: "investigate" });
		expect(second.length).toBe(1);

		// The recurrence is recorded, not acted on.
		const suppressed = await listEvents(db(), { type: "finding.suppressed" });
		expect(suppressed.length).toBeGreaterThan(0);
	});

	it("treats two different findings as two different problems", async () => {
		await db()
			.prepare(
				`INSERT INTO obligations (obligation_id, name, owner_agent, kind, interval_seconds,
					check_spec, enabled, next_run_at, created_at, updated_at)
				 VALUES ('obl_repeat', 'Watch', 'coordinator', 'interval', 60, '{}', 1, 0, 1, 1)`
			)
			.run();
		await env.ORG_AGENTS.getByName("coordinator").runSweep();

		// A second, different failure: it gets its own task.
		await db()
			.prepare(
				`INSERT INTO obligations (obligation_id, name, owner_agent, kind, interval_seconds,
					check_spec, enabled, next_run_at, created_at, updated_at)
				 VALUES ('obl_repeat2', 'Watch again', 'coordinator', 'interval', 60, '{}', 1, 0, 1, 1)`
			)
			.run();
		await env.ORG_AGENTS.getByName("coordinator").runSweep();
		const tasks = await listTasks(db(), { kind: "investigate" });
		expect(tasks.length).toBe(2);
	});
});

describe("an action that was recorded but never sent", () => {
	it("is sent by the sweep rather than lost", async () => {
		const { task } = await createTask(db(), {
			kind: "apply",
			title: "Run the build",
			instruction: "Run the build with the key build-3 and report.",
			assignee: "engineer",
			createdBy: "coordinator",
			requiresApproval: true,
			correlationId: "cor_pending"
		});
		const approval = await createApproval(db(), {
			taskId: null,
			requestedBy: "operator",
			reason: "Run the build."
		});
		await db()
			.prepare("UPDATE approvals SET status = 'approved' WHERE approval_id = ?1")
			.bind(approval.approval_id)
			.run();
		await db()
			.prepare("UPDATE tasks SET approval_id = ?1 WHERE task_id = ?2")
			.bind(approval.approval_id, task.task_id)
			.run();

		// An action recorded, and a process that died before it was sent.
		const { row } = await recordExecution(db(), {
			taskId: task.task_id,
			idempotencyKey: "build-3",
			backend: "simulated",
			spec: { command: "npm test" }
		});
		expect(row.status).toBe("pending");
		expect(row.run_id).toBeNull();

		// The sweep sends it.
		await env.ORG_AGENTS.getByName("coordinator").runSweep();
		const settled = await waitFor(
			async () => {
				const current = await db()
					.prepare("SELECT * FROM executions WHERE idempotency_key = 'build-3'")
					.first<{ status: string; run_id: string | null }>();
				return current?.status === "submitted" ? current : null;
			},
			"the unsent action to be sent"
		);
		expect(settled.run_id).toBeTruthy();
	});
});

describe("a task that waits for a human", () => {
	it("is not reopened by a decision that was already taken", async () => {
		const { task } = await createTask(db(), {
			kind: "apply",
			title: "Apply",
			instruction: "Apply it.",
			assignee: "engineer",
			createdBy: "coordinator",
			requiresApproval: true,
			correlationId: "cor_replay_approval"
		});
		const approval = await createApproval(db(), {
			taskId: null,
			requestedBy: "coordinator",
			reason: "Apply it."
		});
		await db()
			.prepare("UPDATE tasks SET status = 'blocked', approval_id = ?1 WHERE task_id = ?2")
			.bind(approval.approval_id, task.task_id)
			.run();

		const first = await api<{ approval: { status: string } }>(
			`/api/approvals/${approval.approval_id}`,
			{ method: "POST", body: JSON.stringify({ decision: "approve", decidedBy: "operator" }) }
		);
		expect(first.body.approval.status).toBe("approved");

		// The same decision again changes nothing.
		const second = await api<{
			approval: { status: string; decided_by?: string | null };
			already_decided?: boolean;
		}>(
			`/api/approvals/${approval.approval_id}`,
			{ method: "POST", body: JSON.stringify({ decision: "approve", decidedBy: "someone-else" }) }
		);
		expect(second.body.approval.status).toBe("approved");
		expect(second.body.already_decided).toBe(true);
		expect(second.body.approval.decided_by).toBe("operator");

		// The task is finished, and it stays finished.
		const after = await getTask(db(), task.task_id);
		expect(["assigned", "running", "completed"]).toContain(after?.status);
	});
});
