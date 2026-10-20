/**
 * The controls: permissions, budgets, approval gates and idempotency.
 */
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { createApproval, createTask, getTask, recordExecution, upsertAgent } from "../src/db/org.ts";
import {
	checkTaskBudget,
	DAILY_TOOL_CALL_LIMIT
} from "../src/policy/budget.ts";
import {
	defaultPermissionsForRole,
	hasPermission,
	parsePermissions
} from "../src/policy/permissions.ts";
import { MAX_DELEGATION_DEPTH } from "../src/agents/tools.ts";
import { api, db, waitFor } from "./helpers.ts";

describe("permissions", () => {
	it("ignores permissions it does not know", () => {
		expect(parsePermissions('["task.read","rm -rf /","task.approve"]')).toEqual([
			"task.read",
			"task.approve"
		]);
		expect(parsePermissions("not json")).toEqual([]);
		expect(parsePermissions(null)).toEqual([]);
	});

	it("keeps the reviewer away from the levers that would let it accept its own work", () => {
		const reviewer = defaultPermissionsForRole("reviewer");
		// Every permission in the vocabulary is checked by a tool, and the
		// reviewer holds none of the levers that would let it accept its own
		// work.
		expect(hasPermission(reviewer, "task.read")).toBe(true);
		expect(hasPermission(reviewer, "task.report")).toBe(true);
		expect(hasPermission(reviewer, "task.delegate")).toBe(false);
		expect(hasPermission(reviewer, "task.approve")).toBe(false);
		expect(hasPermission(reviewer, "execution.run")).toBe(false);
	});

	it("keeps the engineer away from delegation and approval", () => {
		const engineer = defaultPermissionsForRole("engineer");
		expect(hasPermission(engineer, "execution.run")).toBe(true);
		expect(hasPermission(engineer, "task.delegate")).toBe(false);
		expect(hasPermission(engineer, "task.approve")).toBe(false);
	});

	it("bounds how deep delegation may go", () => {
		expect(MAX_DELEGATION_DEPTH).toBeGreaterThan(0);
		expect(MAX_DELEGATION_DEPTH).toBeLessThanOrEqual(3);
	});
});

describe("budgets", () => {
	it("refuses a call that would pass the limit, and says why", () => {
		expect(checkTaskBudget(0, 5).allowed).toBe(true);
		const atLimit = checkTaskBudget(5, 5);
		expect(atLimit.allowed).toBe(false);
		if (!atLimit.allowed) expect(atLimit.reason).toContain("budget exhausted");
		const noBudget = checkTaskBudget(0, 0);
		expect(noBudget.allowed).toBe(false);
	});

	it("has a daily ceiling for the shared allocation", () => {
		expect(DAILY_TOOL_CALL_LIMIT).toBeGreaterThan(0);
	});
});

describe("idempotency of external actions", () => {
	it("records an action once, however often it is replayed", async () => {
		const first = await recordExecution(db(), {
			taskId: "task_x",
			idempotencyKey: "build-1",
			backend: "simulated",
			spec: { command: "npm test" }
		});
		expect(first.created).toBe(true);

		const second = await recordExecution(db(), {
			taskId: "task_x",
			idempotencyKey: "build-1",
			backend: "simulated",
			spec: { command: "npm test" }
		});
		expect(second.created).toBe(false);
		expect(second.row.execution_id).toBe(first.row.execution_id);

		const rows = await db()
			.prepare("SELECT * FROM executions WHERE idempotency_key = 'build-1'")
			.all<{ execution_id: string }>();
		expect(rows.results.length).toBe(1);
	});
});

describe("the approval gate", () => {
	it("does not let an agent start work that a human has not approved", async () => {
		// The engineer gets no tool budget, so the first thing its agent tries
		// to do is refused: the point of this test is the approval gate, and
		// the budget keeps the run short.
		await upsertAgent(db(), {
			agentId: "engineer",
			role: "engineer",
			title: "Engineer",
			permissions: defaultPermissionsForRole("engineer")
		});

		const { task } = await createBlockedTask();
		const result = await engineer().assign(task.task_id);
		expect(result.status).toBe("blocked");

		const blocked = await getTask(db(), task.task_id);
		expect(blocked?.status).toBe("blocked");
	});

	it("lets the work start once a human approves it", async () => {
		const { task, approvalId } = await createBlockedTask();
		expect((await engineer().assign(task.task_id)).status).toBe("blocked");

		const decision = await api<{ approval: { status: string } }>(`/api/approvals/${approvalId}`, {
			method: "POST",
			body: JSON.stringify({ decision: "approve", decidedBy: "operator" })
		});
		expect(decision.status).toBe(200);
		expect(decision.body.approval.status).toBe("approved");

		const settled = await waitFor(
			async () => {
				const current = await getTask(db(), task.task_id);
				return current?.status === "completed" ? current : null;
			},
			"the approved task to run"
		);
		expect(settled.status).toBe("completed");
	});
});

/** A task that needs a human before it may act. */
async function createBlockedTask(): Promise<{
	task: { task_id: string };
	approvalId: string;
}> {
	const approval = await createApproval(db(), {
		taskId: null,
		requestedBy: "coordinator",
		reason: "Apply the fix to the repository."
	});
	const { task } = await createTask(db(), {
		kind: "apply",
		title: "Apply the fix",
		instruction: "Apply the accepted fix and report what you did.",
		assignee: "engineer",
		createdBy: "coordinator",
		requiresApproval: true,
		correlationId: "cor_approval"
	});
	await db()
		.prepare("UPDATE tasks SET status = 'blocked', approval_id = ?1 WHERE task_id = ?2")
		.bind(approval.approval_id, task.task_id)
		.run();
	return { task, approvalId: approval.approval_id };
}

/** The engineer's Durable Object. */
function engineer() {
	return env.ORG_AGENTS.getByName("engineer");
}
