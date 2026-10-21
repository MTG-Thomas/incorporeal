/**
 * Durability.
 *
 * These tests use the platform's own recovery behaviour: Durable Objects are
 * evicted, alarms fire, and the shared store is the only thing that survives
 * between them. They are the evidence that agents are durable members of an
 * organization while tasks, model calls and execution environments are
 * disposable.
 */
import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getTask, listEvents, listTasks, createTask, upsertAgent } from "../src/db/org.ts";
import { api, db, waitFor, waitForIdle } from "./helpers.ts";

const agent = (id: string) => env.ORG_AGENTS.getByName(id);

describe("durability", () => {
	it("keeps an agent's identity across a sleep", async () => {
		await api("/api/goals", {
			method: "POST",
			body: JSON.stringify({ title: "First goal", description: "Do the work." })
		});
		const before = await agent("engineer").status();
		expect((before as { agentId: string }).agentId).toBe("engineer");
		expect((before as { transcriptEntries: number }).transcriptEntries).toBeGreaterThan(0);

		// The agent is evicted: its memory is gone, its storage is not.
		await evictDurableObject(agent("engineer"));

		const after = (await agent("engineer").status()) as {
			agentId: string;
			role: string;
			permissions: string[];
			transcriptEntries: number;
		};
		expect(after.agentId).toBe("engineer");
		expect(after.role).toBe("engineer");
		expect(after.permissions).toContain("execution.run");
		// The working memory survived the sleep.
		expect(after.transcriptEntries).toBeGreaterThan(0);
	});

	it("resumes an assignment that was made while the agent was down", async () => {
		// The engineer is running, and then falls asleep.
		await agent("engineer").status();
		await evictDurableObject(agent("engineer"));

		// A task is assigned to it while it is asleep.
		const { task } = await createTask(db(), {
			kind: "investigate",
			title: "Investigate the sleeping agent",
			instruction: "Investigate the sleeping agent and report.",
			assignee: "engineer",
			createdBy: "coordinator",
			correlationId: "cor_test"
		});
		expect(task.status).toBe("assigned");

		// Waking the agent picks the assignment up: the agent reconciles the
		// shared store with its own state on every start.
		await agent("engineer").status();
		const settled = await waitFor(
			async () => {
				const current = await getTask(db(), task.task_id);
				return current?.status === "completed" ? current : null;
			},
			"the sleeping agent to pick the assignment up"
		);
		expect(settled.status).toBe("completed");
		await waitForIdle();
	});

	it("does not lose a message across an interruption", async () => {
		const message = "Please look at the flaky test.";
		const before = (await agent("engineer").status()) as { transcriptEntries: number };
		const receipt = await agent("engineer").note(message);
		expect(receipt.accepted).toBe(true);

		await waitFor(
			async () => {
				const status = (await agent("engineer").status()) as {
					transcriptEntries: number;
					transcriptPreview: string;
				};
				return status.transcriptPreview.includes(message) ? status : null;
			},
			"the note to be answered"
		);

		await evictDurableObject(agent("engineer"));

		const status = (await agent("engineer").status()) as {
			transcriptEntries: number;
			transcriptPreview: string;
			pendingOperations: { operationId: string }[];
		};
		// The message is still in the agent's transcript, and it is not
		// sitting in the inbox as an unplaced submission.
		expect(status.transcriptEntries).toBeGreaterThanOrEqual(before.transcriptEntries);
		expect(status.transcriptPreview).toContain(message);
		expect(status.pendingOperations.map((operation) => operation.operationId)).not.toContain(
			receipt.operationId
		);
	});

	it("does not run an external action twice after a replay", async () => {
		// The engineer is told to run the same execution with the same key,
		// twice, as a replay would.
		const { task } = await createTask(db(), {
			kind: "investigate",
			title: "Run the build twice",
			instruction: "Run the build with the key build-1, then report.",
			assignee: "engineer",
			createdBy: "coordinator",
			correlationId: "cor_exec"
		});
		await agent("engineer").assign(task.task_id);
		await waitFor(
			async () => {
				const current = await getTask(db(), task.task_id);
				return current?.status === "completed" ? current : null;
			},
			"the execution task to finish"
		);

		const executions = await db()
			.prepare("SELECT * FROM executions WHERE task_id = ?1")
			.bind(task.task_id)
			.all<{ execution_id: string; idempotency_key: string }>();
		// The same idempotency key never produces two executions.
		const keys = executions.results.map((row) => row.idempotency_key);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it("detects and recovers a stalled assignment", async () => {
		const { task } = await createTask(db(), {
			kind: "investigate",
			title: "A task nobody picked up",
			instruction: "Do the work.",
			assignee: "engineer",
			createdBy: "coordinator",
			deadlineAt: Date.now() - 60_000,
			maxAttempts: 2,
			correlationId: "cor_stalled"
		});

		const sweep = await agent("coordinator").runSweep();
		expect(sweep.stalled).toBeGreaterThan(0);

		const after = await getTask(db(), task.task_id);
		expect(after?.attempt).toBe(1);
		const events = await listEvents(db(), { taskId: task.task_id, type: "task.stalled_retried" });
		expect(events.length).toBe(1);
	});

	it("gives up on a task that keeps stalling, and says so", async () => {
		const { task } = await createTask(db(), {
			kind: "investigate",
			title: "A task that never finishes",
			instruction: "Do the work.",
			assignee: "engineer",
			createdBy: "coordinator",
			deadlineAt: Date.now() - 60_000,
			maxAttempts: 1,
			correlationId: "cor_stalled2"
		});

		await agent("coordinator").runSweep();
		const after = await getTask(db(), task.task_id);
		expect(after?.status).toBe("failed");
		const events = await listEvents(db(), { taskId: task.task_id, type: "task.stalled_failed" });
		expect(events.length).toBe(1);
	});

	it("does not let a recurring obligation stack duplicate work", async () => {
		await db()
			.prepare(
				`INSERT INTO obligations (obligation_id, name, owner_agent, kind, interval_seconds,
					check_spec, enabled, next_run_at, created_at, updated_at)
				 VALUES ('obl_test', 'Watch the repository', 'coordinator', 'interval', 60, '{}', 1, 0, 1, 1)`
			)
			.run();

		// Two sweeps at once: the obligation is claimed once.
		await Promise.all([agent("coordinator").runSweep(), agent("coordinator").runSweep()]);

		const tasks = await listTasks(db(), { kind: "investigate" });
		expect(tasks.length).toBe(1);

		// A later sweep finds the same finding and does not stack a second task.
		await agent("coordinator").runSweep();
		const later = await listTasks(db(), { kind: "investigate" });
		expect(later.length).toBe(1);
	});

	it("replaces an agent without losing its duties or its transcript", async () => {
		await api("/api/goals", {
			method: "POST",
			body: JSON.stringify({ title: "A goal for the engineer", description: "Do the work." })
		});
		const before = (await agent("engineer").status()) as { transcriptEntries: number };
		expect(before.transcriptEntries).toBeGreaterThan(0);

		// An open task, so the successor has something to inherit.
		const { task } = await createTask(db(), {
			kind: "investigate",
			title: "Work that outlives the agent",
			instruction: "Do the work.",
			assignee: "engineer",
			createdBy: "coordinator",
			correlationId: "cor_successor"
		});

		const response = await api<{ successor: { agent_id: string }; movedTasks: string[] }>(
			"/api/agents/engineer/successor",
			{ method: "POST", body: JSON.stringify({ successorId: "engineer-2" }) }
		);
		expect(response.status).toBe(200);
		expect(response.body.successor.agent_id).toBe("engineer-2");
		expect(response.body.movedTasks).toContain(task.task_id);

		// The open work moved to the successor.
		const moved = await getTask(db(), task.task_id);
		expect(moved?.assignee).toBe("engineer-2");

		// The predecessor is retired.
		const agents = await api<{ agents: { agent_id: string; status: string }[] }>("/api/agents");
		const predecessor = agents.body.agents.find((row) => row.agent_id === "engineer");
		expect(predecessor?.status).toBe("retired");

		// The successor starts with a new working memory, not the old
		// transcript: it inherits the commitments, not the context.
		const successor = (await agent("engineer-2").status()) as {
			agentId: string;
			role: string;
			transcriptEntries: number;
			transcriptPreview: string;
		};
		expect(successor.agentId).toBe("engineer-2");
		expect(successor.role).toBe("engineer");
		// Nothing of the predecessor's work is in the successor's transcript.
		expect(successor.transcriptPreview).not.toContain("A goal for the engineer");
		expect(successor.transcriptPreview).not.toContain("Investigate: A goal for the engineer");
	});
});

describe("an agent that stays alive", () => {
	it("picks up a model change without being restarted", async () => {
		// The agent is running, and its model is changed underneath it.
		await agent("engineer").status();
		await upsertAgent(db(), {
			agentId: "engineer",
			role: "engineer",
			title: "Engineer",
			model: "@cf/openai/gpt-oss-120b",
			permissions: ["task.read", "task.report", "knowledge.read", "knowledge.write", "execution.run"]
		});

		// The next run uses the new model. A Durable Object can stay alive for
		// a long time, so a cached identity would keep the agent on the old
		// model for hours.
		const { task } = await createTask(db(), {
			kind: "investigate",
			title: "A task after the model changed",
			instruction: "Report what you find.",
			assignee: "engineer",
			createdBy: "coordinator",
			correlationId: "cor_model"
		});
		await agent("engineer").assign(task.task_id);
		const settled = await waitFor(
			async () => {
				const current = await getTask(db(), task.task_id);
				return current?.status === "completed" ? current : null;
			},
			"the task to finish"
		);
		expect(settled.status).toBe("completed");

		const status = (await agent("engineer").status()) as { model: string };
		expect(status.model).toBe("@cf/openai/gpt-oss-120b");
	});
});
