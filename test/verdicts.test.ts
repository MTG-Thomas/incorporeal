/**
 * The reviewer's verdict, the execution path and the approval gate.
 *
 * These exercise the paths that decide what happens next: what a reviewer
 * says, what an agent is allowed to run, and what happens when the same
 * action is requested twice.
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createApproval, createTask, getTask, listEvents, listTasks } from "../src/db/org.ts";
import { api, db, waitFor, waitForIdle } from "./helpers.ts";

describe("the reviewer's verdict", () => {
	it("sends findings back to the engineer, without a hand-written update", async () => {
		// The title is distinctive, so the scripted reviewer answers this one
		// with findings instead of accepting.
		const created = await api<{ goal: { goal_id: string } }>("/api/goals", {
			method: "POST",
			body: JSON.stringify({
				title: "Check the flaky login test",
				description: "The login test is flaky and the fix needs a second look."
			})
		});
		expect(created.status).toBe(201);

		// The reviewer produced the verdict, and the verdict is in the store.
		const review = await waitFor(
			async () => {
				const tasks = await listTasks(db(), { kind: "review" });
				const found = tasks[0];
				if (!found) return null;
				const current = await getTask(db(), found.task_id);
				return current?.status === "completed" ? current : null;
			},
			"the review to finish"
		);
		const verdict = JSON.parse(review.result ?? "{}") as {
			recommendation?: string;
			findings?: string[];
		};
		expect(verdict.recommendation).toBe("changes_requested");
		expect(verdict.findings?.length).toBeGreaterThan(0);

		// The coordinator turned the findings into rework for the engineer.
		const rework = await waitFor(
			async () => {
				const tasks = await listTasks(db(), { kind: "investigate" });
				return tasks.find((task) => task.parent_task_id === review.task_id) ?? null;
			},
			"the rework the reviewer asked for"
		);
		expect(rework.assignee).toBe("engineer");
		expect(rework.instruction).toContain("No test for the empty input.");
		// The attempt travelled with the task, so the retry limit can trip.
		expect(rework.attempt).toBe(1);
		await waitForIdle();
	});
});

describe("the execution path", () => {
	it("runs an approved action once, however often it is asked for", async () => {
		const approval = await createApproval(db(), {
			taskId: null,
			requestedBy: "operator",
			reason: "Run the build."
		});
		await db()
			.prepare("UPDATE approvals SET status = 'approved', decided_by = 'operator' WHERE approval_id = ?1")
			.bind(approval.approval_id)
			.run();

		const { task } = await createTask(db(), {
			kind: "apply",
			title: "Run the build",
			instruction: "Run the build with the key build-1 and report what happened.",
			assignee: "engineer",
			createdBy: "coordinator",
			requiresApproval: true,
			correlationId: "cor_exec"
		});
		await db()
			.prepare("UPDATE tasks SET approval_id = ?1 WHERE task_id = ?2")
			.bind(approval.approval_id, task.task_id)
			.run();

		await env.ORG_AGENTS.getByName("engineer").assign(task.task_id);
		await waitFor(
			async () => {
				const current = await getTask(db(), task.task_id);
				return current?.status === "completed" ? current : null;
			},
			"the execution task to finish"
		);

		// The action ran, and it ran once: the second request found the
		// first one's record.
		const executions = await db()
			.prepare("SELECT * FROM executions WHERE task_id = ?1")
			.bind(task.task_id)
			.all<{ execution_id: string; idempotency_key: string; status: string }>();
		expect(executions.results.length).toBe(1);
		expect(executions.results[0]?.idempotency_key).toBe("build-1");

		const submitted = await listEvents(db(), { taskId: task.task_id, type: "execution.submitted" });
		expect(submitted.length).toBe(1);
		await waitForIdle();
	});

	it("refuses an external action that no human approved", async () => {
		const { task } = await createTask(db(), {
			kind: "investigate",
			title: "Run the build without permission",
			instruction: "Run the build with the key build-2 and report what happened.",
			assignee: "engineer",
			createdBy: "coordinator",
			correlationId: "cor_exec2"
		});

		await env.ORG_AGENTS.getByName("engineer").assign(task.task_id);
		await waitFor(
			async () => {
				const current = await getTask(db(), task.task_id);
				return current?.status === "completed" ? current : null;
			},
			"the task to finish"
		);

		// Nothing ran: the gate held.
		const executions = await db()
			.prepare("SELECT * FROM executions WHERE task_id = ?1")
			.bind(task.task_id)
			.all<{ execution_id: string }>();
		expect(executions.results.length).toBe(0);

		// The agent was told why, and the refusal is in the record.
		const settled = await getTask(db(), task.task_id);
		const result = JSON.parse(settled?.result ?? "{}") as { summary?: string };
		expect(result.summary).toBeTruthy();
		await waitForIdle();
	});
});

describe("the coordinator's own delegation", () => {
	it("delegates a second piece of work and the assignee picks it up", async () => {
		const created = await api<{ goal: { goal_id: string } }>("/api/goals", {
			method: "POST",
			body: JSON.stringify({
				title: "Delegate the deep dive",
				description: "The coordinator should delegate part of this."
			})
		});
		expect(created.status).toBe(201);

		// The coordinator delegated, and the task it made carries the
		// delegation's own bounds.
		const delegated = await waitFor(
			async () => {
				const tasks = await listTasks(db(), { kind: "research", assignee: "engineer" });
				return tasks[0] ?? null;
			},
			"the coordinator to delegate"
		);
		expect(delegated.assignee).toBe("engineer");
		expect(delegated.created_by).toBe("coordinator");
		expect(delegated.depth).toBe(1);
		expect(delegated.deadline_at).toBeGreaterThan(0);

		// The assignee was woken: a task row alone would have sat on the
		// board until the next sweep.
		const settled = await waitFor(
			async () => {
				const current = await getTask(db(), delegated.task_id);
				return current?.status === "completed" ? current : null;
			},
			"the delegated task to be picked up"
		);
		expect(settled.status).toBe("completed");
		await waitForIdle();
	});
});
