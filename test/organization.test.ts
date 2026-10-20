/**
 * The organization, end to end.
 *
 * These tests use the real Durable Objects, the real D1 database and a
 * deterministic model. Nothing is mocked except the model itself, which is
 * the point: the durability claims have to hold against the platform's
 * behaviour, not against a test double.
 */
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { listTasks, getTask, listApprovals } from "../src/db/org.ts";
import { api, db, waitFor, waitForIdle } from "./helpers.ts";

describe("the organization", () => {
	it("has three stable, independent agent identities", async () => {
		const response = await api<{ agents: { agent_id: string; role: string; status: string }[] }>(
			"/api/agents"
		);
		expect(response.status).toBe(200);
		const byRole = new Map(response.body.agents.map((agent) => [agent.role, agent]));
		expect(byRole.get("coordinator")?.agent_id).toBe("coordinator");
		expect(byRole.get("engineer")?.agent_id).toBe("engineer");
		expect(byRole.get("reviewer")?.agent_id).toBe("reviewer");
		for (const agent of response.body.agents) {
			expect(agent.status).toBe("active");
		}
	});

	it("refuses an unauthenticated agent-control request", async () => {
		const response = await api("/api/agents", { token: "wrong-token" });
		expect(response.status).toBe(401);
	});

	it("turns a goal into delegated work, a review, and a human approval", async () => {
		const created = await api<{ goal: { goal_id: string }; delegation: { action: string } }>(
			"/api/goals",
			{
				method: "POST",
				body: JSON.stringify({
					title: "Keep the test repository healthy",
					description: "Investigate the failing workflow and propose a fix."
				})
			}
		);
		expect(created.status).toBe(201);
		expect(created.body.delegation.action).toBe("delegated");

		// The coordinator delegated to the engineer.
		const investigate = await waitFor(
			async () => {
				const tasks = await listTasks(db(), { kind: "investigate" });
				return tasks[0] ?? null;
			},
			"the coordinator to delegate the investigation"
		);
		expect(investigate.assignee).toBe("engineer");
		expect(["assigned", "running", "completed"]).toContain(investigate.status);
		expect(investigate.task_id).toMatch(/^task_/);

		// The engineer finished, and the coordinator asked the reviewer.
		const review = await waitFor(
			async () => {
				const tasks = await listTasks(db(), { kind: "review" });
				return tasks[0] ?? null;
			},
			"the reviewer to be given the work"
		);
		expect(review.assignee).toBe("reviewer");
		expect(review.review_of_task_id).toBe(investigate.task_id);

		// The reviewer recommended acceptance, so the apply step waits for a human.
		const approval = await waitFor(
			async () => {
				const approvals = await listApprovals(db(), "pending");
				return approvals[0] ?? null;
			},
			"the reviewer to escalate to a human"
		);
		expect(approval.status).toBe("pending");

		// One review, one apply step, one approval: a replayed handoff does not
		// stack a second copy of the work.
		await waitForIdle();
		const reviews = await listTasks(db(), { kind: "review" });
		const applies = await listTasks(db(), { kind: "apply" });
		const approvals = await listApprovals(db(), "pending");
		expect(reviews.length).toBe(1);
		expect(applies.length).toBe(1);
		expect(approvals.length).toBe(1);
		expect(applies[0]?.status).toBe("blocked");

		// The engineer's task carries the evidence it reported.
		const settled = await getTask(db(), investigate.task_id);
		expect(settled?.status).toBe("completed");
		expect(JSON.parse(settled?.result ?? "{}").summary).toBeTruthy();

		await waitForIdle();
	});

	it("lets a reviewer send findings back to the engineer", async () => {
		// A review that asks for changes creates a new investigation.
		const created = await api<{ goal: { goal_id: string } }>("/api/goals", {
			method: "POST",
			body: JSON.stringify({ title: "Check the failing test", description: "Look at it." })
		});
		expect(created.status).toBe(201);

		const review = await waitFor(
			async () => {
				const tasks = await listTasks(db(), { kind: "review" });
				return tasks[0] ?? null;
			},
			"a review task"
		);
		// Simulate a reviewer that asks for changes.
		await db()
			.prepare(
				`UPDATE tasks SET status = 'completed', result = ?1, completed_at = ?2 WHERE task_id = ?3`
			)
			.bind(
				JSON.stringify({
					summary: "The fix does not handle the empty case.",
					findings: ["No test for the empty input."],
					recommendation: "changes_requested",
					evidence: []
				}),
				Date.now(),
				review.task_id
			)
			.run();

		// The coordinator turns that into rework.
		await env.ORG_AGENTS.getByName("coordinator").onTaskCompleted(review.task_id);
		const rework = await waitFor(
			async () => {
				const tasks = await listTasks(db(), { kind: "investigate" });
				return tasks.find((task) => task.parent_task_id === review.task_id) ?? null;
			},
			"the coordinator to ask for rework"
		);
		expect(rework.assignee).toBe("engineer");
		expect(rework.instruction).toContain("No test for the empty input.");

		await waitForIdle();
	});

	it("turns an inbound webhook into delegated work", async () => {
		const response = await api<{ goal: { goal_id: string; title: string }; delegation: { action: string } }>(
			"/api/webhooks/ci",
			{
				method: "POST",
				body: JSON.stringify({
					title: "The nightly workflow failed",
					description: "The build-and-test workflow failed on main."
				}),
				webhookSecret: "test-webhook-secret"
			}
		);
		expect(response.status).toBe(201);
		expect(response.body.goal.title).toContain("[ci]");
		expect(response.body.delegation.action).toBe("delegated");

		// The coordinator delegated it, exactly as it would for a goal.
		const task = await waitFor(
			async () => {
				const tasks = await listTasks(db(), { kind: "investigate" });
				return tasks[0] ?? null;
			},
			"the webhook to produce delegated work"
		);
		expect(task.assignee).toBe("engineer");
		await waitForIdle();
	});

	it("closes the goal when the applied work is done", async () => {
		const created = await api<{ goal: { goal_id: string } }>("/api/goals", {
			method: "POST",
			body: JSON.stringify({ title: "A goal that gets finished", description: "Do the work." })
		});
		const goalId = created.body.goal.goal_id;

		// The chain runs: investigate, review, apply.
		const apply = await waitFor(
			async () => {
				const tasks = await listTasks(db(), { kind: "apply" });
				return tasks[0] ?? null;
			},
			"the apply step"
		);
		expect(apply.status).toBe("blocked");

		// A human approves it.
		const approvals = await listApprovals(db(), "pending");
		expect(approvals.length).toBe(1);
		await api(`/api/approvals/${approvals[0]!.approval_id}`, {
			method: "POST",
			body: JSON.stringify({ decision: "approve", decidedBy: "operator" })
		});

		await waitFor(
			async () => {
				const current = await getTask(db(), apply.task_id);
				return current?.status === "completed" ? current : null;
			},
			"the apply step to finish"
		);

		// The goal is achieved. The coordinator closes it when it hears about
		// the apply step, which is a moment after the step itself completes.
		const goal = await waitFor(
			async () => {
				const row = await db()
					.prepare("SELECT * FROM goals WHERE goal_id = ?1")
					.bind(goalId)
					.first<{ status: string }>();
				return row?.status === "achieved" ? row : null;
			},
			"the goal to be closed"
		);
		expect(goal.status).toBe("achieved");
		await waitForIdle();
	});

	it("does not let an agent approve its own work", async () => {
		const response = await api<{ status: { role: string; permissions: string[] } }>(
			"/api/agents/reviewer"
		);
		expect(response.status).toBe(200);
		expect(response.body.status.role).toBe("reviewer");
		expect(response.body.status.permissions).not.toContain("task.delegate");
		expect(response.body.status.permissions).not.toContain("task.approve");
		expect(response.body.status.permissions).not.toContain("execution.run");
	});
});

describe("the worker's own surface", () => {
	it("answers a health check without a token", async () => {
		const response = await api("/api/health", { token: null });
		expect(response.status).toBe(200);
	});

	it("rejects a webhook with the wrong secret", async () => {
		const response = await api("/api/webhooks/github", {
			method: "POST",
			body: JSON.stringify({ title: "something" }),
			webhookSecret: "nope"
		});
		expect(response.status).toBe(401);
	});
});
