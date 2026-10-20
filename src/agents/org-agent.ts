/**
 * The organization's agent.
 *
 * One Durable Object class hosts every agent; the object's name is the agent
 * id. That keeps the class count low (Workers Free allows 100 classes, and
 * one class is better than three), and it means an agent can be replaced by
 * retiring its row and starting a new object under a new id.
 *
 * The split of state is deliberate:
 *
 * - The Durable Object's own SQLite database holds agent-private state: the
 *   pi-durable transcript, the inbox, the running generation, the task
 *   checkpoints, and the record of what this agent is working on.
 * - D1 holds organizational state: who the agents are, what they owe each
 *   other, what is running, what was decided, what happened.
 *
 * The agent is durable; the model call, the tool call and the execution
 * environment are not. An eviction loses neither the identity nor the work.
 */
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import { PiHarness } from "agents/harness/pi";
import { createAI } from "agents/models/pi-ai";
import {
	claimObligation,
	completeObligationRun,
	completeTask,
	createApproval,
	createTask,
	findAgentByRole,
	findOpenChainTask,
	getTask,
	listExecutions,
	listObligations,
	listOpenTasks,
	markTaskRunning,
	bumpAgentUsage,
	recordEvent,
	releaseObligation,
	updateExecution,
	updateTask
} from "../db/org.ts";
import type { ObligationRow, TaskRow } from "../db/types.ts";
import { selectRepositoryCheck } from "../checks/index.ts";
import { selectExecutionBackend } from "../execution/index.ts";
import { sendExecution } from "../execution/run.ts";
import type { Env } from "../env.ts";
import { describeError, logError, logInfo, logWarn } from "../logging.ts";
import { AssignmentDoc } from "./docs.ts";
import { createFauxProvider, FAUX_MODEL_ID, FAUX_PROVIDER_ID, parseFauxSpec } from "./faux.ts";
import { loadIdentity, type AgentIdentity, ensureBuiltInAgents } from "./identity.ts";
import { createOrgExtension } from "./tools.ts";
import { describeAction, type ApprovedAction } from "../policy/action.ts";

/** How long an obligation sweep may hold its lock. */
const OBLIGATION_LEASE_MS = 5 * 60_000;

/**
 * What an obligation remembers between sweeps.
 *
 * One record per finding, not one record for the last finding: a single
 * "last seen" would be defeated by two findings alternating, and each would
 * open its own chain.
 */
type ObligationState = {
	fingerprints?: Record<
		string,
		{
			/** When the finding was first seen. */
			firstSeen: number;
			/** When it was last seen. */
			lastSeen: number;
			/** When a task was made for it. */
			lastCreatedAt: number;
			/** That task. */
			taskId: string;
		}
	>;
};

export class OrgAgent extends DurableObject<Env> {
	readonly #agentId: string;
	readonly harness: PiHarness;
	readonly lifecycle: Lifecycle<Env>;
	#identity: Promise<AgentIdentity> | null = null;
	#modelId = "";
	#modelProvider = "cloudflare";
	#thinkingLevel = "low";
	#modelRef: { provider: string; id: string } | null = null;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		const name = ctx.id.name;
		if (!name) {
			throw new Error("the organization requires named Durable Objects: the name is the agent id");
		}
		this.#agentId = name;
		const self = this;
		this.harness = new PiHarness({
			harness: async ({ storage, context }) => {
				const identity = await self.#resolveIdentity();
				self.#modelId = identity.model;
				self.#thinkingLevel = identity.thinkingLevel;
				const registry = createRegistry();
				registry.install(
					createOrgExtension({
						env: self.env,
						agentId: self.#agentId,
						identity,
						notifyTaskCompleted: (taskId) => self.#notifyCoordinator(taskId)
					})
				);
				const models = createModels();
				if (self.env.MODEL_PROVIDER === "faux") {
					const faux = createFauxProvider(parseFauxSpec(self.env.FAUX_SCRIPT));
					models.setProvider(faux.provider);
					self.#modelRef = { provider: FAUX_PROVIDER_ID, id: FAUX_MODEL_ID };
					self.#modelProvider = FAUX_PROVIDER_ID;
				} else if (
					self.env.MODEL_PROVIDER === "cloudflare-rest" &&
					self.env.CF_ACCOUNT_ID &&
					self.env.CF_API_TOKEN
				) {
					// The same models, reached over the Cloudflare REST API.
					// No binding is involved, so this works on a runtime that
					// does not implement one.
					const ai = createAI({
						accountId: self.env.CF_ACCOUNT_ID,
						apiToken: self.env.CF_API_TOKEN
					});
					models.setProvider(ai.provider);
					self.#modelRef = { provider: "cloudflare", id: self.#modelId };
				} else if (self.env.AI) {
					const ai = createAI({ binding: self.env.AI });
					models.setProvider(ai.provider);
					self.#modelRef = { provider: "cloudflare", id: self.#modelId };
				} else {
					// No binding and no account credentials: there is no model
					// to call, and the run will say so rather than fail
					// obscurely.
					logWarn("no model provider is configured", {
						agentId: self.#agentId,
						modelProvider: self.env.MODEL_PROVIDER
					});
					const ai = createAI({
						accountId: self.env.CF_ACCOUNT_ID ?? "",
						apiToken: self.env.CF_API_TOKEN ?? ""
					});
					models.setProvider(ai.provider);
					self.#modelRef = { provider: "cloudflare", id: self.#modelId };
				}
				return Harness.open(
					storage,
					{
						models,
						registry,
						// Pi keeps idle caches behind timers, and a pending timer
						// stops a Durable Object from hibernating. The object's
						// SQLite is local, so the caches save nothing.
						settings: { contextRetentionMs: 0, documentRetentionMs: 0 },
						onReport: (error: unknown, info?: { readonly type?: string }) => {
							logWarn("pi reported a failure", {
								agentId: self.#agentId,
								type: info?.type,
								error: describeError(error)
							});
						}
					},
					context
				);
			},
			get defaults() {
				return {
					model: self.#modelRef ?? {
						provider: "cloudflare",
						id: self.#modelId || self.env.MODEL_DEFAULT
					},
					thinkingLevel: self.#thinkingLevel as never
				};
			}
		});
		this.lifecycle = Lifecycle.install(this).use(this.harness);
	}

	/** The agent id is the Durable Object's name. */
	get agentId(): string {
		return this.#agentId;
	}

	async onStart(): Promise<void> {
		const identity = await this.#resolveIdentity();
		logInfo("agent started", { agentId: this.#agentId, role: identity.role });
		// The organization is a set of agents: make sure its members exist
		// before this one starts acting for it.
		await ensureBuiltInAgents(this.env.ORG_DB, this.env);
		await this.#applyModel(identity);
		await this.#reconcile();
	}

	/**
	 * Make the conversation use the agent's model.
	 *
	 * pi stores the model in the conversation's own agent record, so a model
	 * that was stored when the conversation was created outlives a change to
	 * the agent's row. The agent's model is a property of the agent, so it is
	 * applied here — but only when it differs, because configuring writes.
	 */
	async #applyModel(identity: AgentIdentity): Promise<void> {
		try {
			// The faux provider serves one model of its own, so the agent's row
			// does not choose it.
			const modelId =
				this.#modelProvider === FAUX_PROVIDER_ID ? FAUX_MODEL_ID : identity.model;
			const pi = await this.harness.pi();
			const root = await pi.root(BACKGROUND_CONTEXT);
			const current = await root.agent(BACKGROUND_CONTEXT);
			if (current.model?.provider === this.#modelProvider && current.model?.modelId === modelId) {
				return;
			}
			await root.configure(
				{ model: { provider: this.#modelProvider, modelId } },
				BACKGROUND_CONTEXT
			);
			logInfo("the agent's model changed", {
				agentId: this.#agentId,
				from: current.model?.modelId,
				to: modelId
			});
		} catch (error) {
			logWarn("could not apply the agent's model", {
				agentId: this.#agentId,
				error: describeError(error)
			});
		}
	}

	/* ── public operations ───────────────────────────────────────────────── */

	/**
	 * Start, or resume, work on a task assigned to this agent.
	 *
	 * The submission is idempotent: the same task always uses the same
	 * operation id, so a replay after an interruption rejoins the existing
	 * run instead of starting a second one.
	 */
	async assign(taskId: string): Promise<{ status: string; detail?: string }> {
		await this.lifecycle.start();
		const task = await getTask(this.env.ORG_DB, taskId);
		if (!task) return { status: "unknown_task" };
		if (task.assignee !== this.#agentId) return { status: "not_assignee" };
		if (task.status === "completed" || task.status === "cancelled") {
			return { status: "already_done" };
		}
		if (task.requires_approval) {
			const approval = task.approval_id
				? await this.env.ORG_DB.prepare("SELECT status FROM approvals WHERE approval_id = ?1")
						.bind(task.approval_id)
						.first<{ status: string }>()
				: null;
			if (approval?.status !== "approved") {
				await updateTask(this.env.ORG_DB, taskId, { status: "blocked" });
				await recordEvent(this.env.ORG_DB, {
					correlationId: task.correlation_id,
					agentId: this.#agentId,
					taskId,
					type: "task.blocked",
					payload: { reason: "approval_pending", approval_id: task.approval_id }
				});
				return { status: "blocked", detail: "waiting for human approval" };
			}
		}

		await this.#markRunning(task);
		await this.#setAssignment(task);
		this.ctx.waitUntil(this.#runTask(task));
		return { status: "assigned", detail: `operation ${operationIdFor(task.task_id)}` };
	}

	/**
	 * Run the organization's periodic work: due obligations and stalled
	 * assignments. The coordinator does this; other agents accept the call and
	 * do nothing, so the cron trigger can address a single agent.
	 */
	async runSweep(): Promise<{
		obligations: number;
		findings: number;
		stalled: number;
		executions: number;
	}> {
		await this.lifecycle.start();
		const identity = await this.#resolveIdentity();
		if (identity.role !== "coordinator") {
			return { obligations: 0, findings: 0, stalled: 0, executions: 0 };
		}
		const findings = await this.#runObligations();
		const stalled = await this.#recoverStalledTasks();
		const executions = await this.#reconcileExecutions();
		return {
			obligations: findings.obligations,
			findings: findings.findings,
			stalled,
			executions
		};
	}

	/**
	 * The coordinator's decision point: a task finished. It reviews what
	 * happened and either delegates the next step, escalates to a human, or
	 * closes the goal.
	 */
	async onTaskCompleted(taskId: string): Promise<{ action: string; detail?: string }> {
		await this.lifecycle.start();
		const identity = await this.#resolveIdentity();
		if (identity.role !== "coordinator") return { action: "ignored" };
		const task = await getTask(this.env.ORG_DB, taskId);
		if (!task) return { action: "unknown_task" };
		if (task.status !== "completed") return { action: "not_completed" };

		if (task.kind === "investigate" || task.kind === "research") {
			return this.#startReview(task);
		}
		if (task.kind === "review") {
			return this.#actOnReview(task);
		}
		if (task.kind === "apply") {
			return this.#closeGoal(task, "achieved");
		}
		return { action: "no_action" };
	}

	/** A goal was created. The coordinator turns it into bounded work. */
	async onGoalCreated(goalId: string): Promise<{ taskId?: string; action: string }> {
		await this.lifecycle.start();
		const identity = await this.#resolveIdentity();
		if (identity.role !== "coordinator") return { action: "ignored" };
		const goal = await this.env.ORG_DB.prepare("SELECT * FROM goals WHERE goal_id = ?1")
			.bind(goalId)
			.first<{
				goal_id: string;
				title: string;
				description: string;
				owner_agent: string;
				status: string;
			}>();
		if (!goal) return { action: "unknown_goal" };
		if (goal.status !== "active") return { action: "goal_not_active" };

		const engineer = await findAgentByRole(this.env.ORG_DB, "engineer");
		if (!engineer) return { action: "no_engineer" };
		const { task, created } = await createTask(this.env.ORG_DB, {
			goalId: goal.goal_id,
			kind: "investigate",
			title: `Investigate: ${goal.title}`,
			instruction: [
				`Goal: ${goal.title}`,
				`Details: ${goal.description}`,
				"",
				"Investigate the goal, produce a concrete plan or change, and report your result with org_report_result.",
				"Record anything the organization should remember with org_write_knowledge.",
				"Do not apply anything externally; a human approves that step."
			].join("\n"),
			assignee: engineer.agent_id,
			createdBy: this.#agentId,
			depth: 1,
			deadlineAt: Date.now() + 60 * 60_000,
			correlationId: `cor_${goal.goal_id}`
		});
		if (!created) return { action: "already_delegated", taskId: task.task_id };
		await recordEvent(this.env.ORG_DB, {
			correlationId: task.correlation_id,
			agentId: this.#agentId,
			taskId: task.task_id,
			type: "task.created",
			payload: { goal_id: goal.goal_id, assignee: engineer.agent_id, kind: task.kind }
		});
		await this.#assignTo(engineer.agent_id, task.task_id);

		// The coordinator also gets a task of its own: a bounded piece of
		// planning, which its model can use to delegate something narrower or
		// deeper than the default investigation. The guaranteed path above
		// does not wait for it.
		const { task: planning, created: planningCreated } = await createTask(this.env.ORG_DB, {
			goalId: goal.goal_id,
			// Its own kind: the coordinator's own decision is not engineering
			// work, so it is not sent to the reviewer.
			kind: "plan",
			title: `Plan: ${goal.title}`,
			instruction: [
				`Goal: ${goal.title}`,
				`Details: ${goal.description}`,
				"",
				"The investigation has been delegated to the engineer. If the goal needs",
				"another, narrower piece of work, delegate it with org_delegate; if it",
				"does not, say so. Delegation is bounded: it must name an agent, and it",
				"must not go deeper than the limit.",
				"Then report what you decided."
			].join("\n"),
			assignee: this.#agentId,
			createdBy: this.#agentId,
			depth: 0,
			deadlineAt: Date.now() + 30 * 60_000,
			correlationId: `cor_${goal.goal_id}`
		});
		if (planningCreated) {
			await recordEvent(this.env.ORG_DB, {
				correlationId: planning.correlation_id,
				agentId: this.#agentId,
				taskId: planning.task_id,
				type: "task.created",
				payload: { goal_id: goal.goal_id, assignee: this.#agentId, kind: planning.kind }
			});
			await this.#assignTo(this.#agentId, planning.task_id);
		}
		return { action: "delegated", taskId: task.task_id };
	}

	/** Send a message to this agent, from a human. */
	async note(text: string, operationId?: string): Promise<{ operationId: string; accepted: boolean }> {
		await this.lifecycle.start();
		const receipt = await this.harness.submit(text, {
			operationId: operationId ?? `note:${crypto.randomUUID()}`,
			entry: { kind: "app.note", data: { source: "human" } }
		});
		this.ctx.waitUntil(
			this.harness
				.wait(receipt.operationId)
				.then((result) => this.#recordNoteResult(receipt.operationId, result))
				.catch((error: unknown) => {
					logError("note failed", {
						agentId: this.#agentId,
						error: describeError(error)
					});
				})
		);
		return receipt;
	}

	/** Everything an operator needs to see about this agent. */
	async status(): Promise<Record<string, unknown>> {
		await this.lifecycle.start();
		const identity = await this.#resolveIdentity();
		const tasks = await listOpenTasks(this.env.ORG_DB);
		const mine = tasks.filter((task) => task.assignee === this.#agentId);
		const pi = await this.harness.pi();
		const usage = await pi.usage(BACKGROUND_CONTEXT);
		const pending = await this.harness.pending();
		const messages = await this.harness.messages();
		return {
			agentId: this.#agentId,
			role: identity.role,
			title: identity.title,
			permissions: identity.permissions,
			model: identity.model,
			openTasks: mine.map((task) => ({
				taskId: task.task_id,
				kind: task.kind,
				title: task.title,
				status: task.status,
				deadlineAt: task.deadline_at,
				attempt: task.attempt,
				toolCalls: task.tool_calls
			})),
			pendingOperations: pending,
			transcriptEntries: messages.length,
			// A bounded preview of the newest transcript entries, for inspection
			// and for showing that a successor did not inherit its
			// predecessor's working memory.
			transcriptPreview: JSON.stringify(messages.slice(-6)).slice(0, 20_000),
			usage,
			sessions: await this.harness.sessions.list()
		};
	}

	/* ── internals ──────────────────────────────────────────────────────── */

	#resolveIdentity(): Promise<AgentIdentity> {
		this.#identity ??= loadIdentity(this.env.ORG_DB, this.env, this.#agentId).catch((error: unknown) => {
			this.#identity = null;
			throw error;
		});
		return this.#identity;
	}

	async #markRunning(task: TaskRow): Promise<void> {
		const moved = await markTaskRunning(this.env.ORG_DB, task.task_id);
		if (!moved) {
			// The task finished while this assignment was in flight; its result
			// stands.
			return;
		}
		await recordEvent(this.env.ORG_DB, {
			correlationId: task.correlation_id,
			agentId: this.#agentId,
			taskId: task.task_id,
			type: "task.started",
			payload: { attempt: task.attempt }
		});
	}

	/** Record which organizational task this agent is working on, durably. */
	async #setAssignment(task: TaskRow): Promise<void> {
		const pi = await this.harness.pi();
		const root = await pi.root(BACKGROUND_CONTEXT);
		await root.commit(async (tx) => {
			const doc = await tx.doc(AssignmentDoc, root.id);
			doc.taskId = task.task_id;
			doc.kind = task.kind;
			doc.goalId = task.goal_id;
		}, BACKGROUND_CONTEXT);
	}

	/**
	 * Run the task and settle it.
	 *
	 * The submission is durable and idempotent, so this method can be called
	 * again after an eviction: it rejoins the run that is already under way.
	 */
	async #runTask(task: TaskRow): Promise<void> {
		const operationId = operationIdFor(task.task_id);
		const identity = await this.#resolveIdentity();
		await this.#applyModel(identity);
		const tokensBefore = await this.#usageTokens();
		try {
			const receipt = await this.harness.submit(await this.#buildPrompt(task), {
				operationId,
				entry: {
					kind: "app.assignment",
					data: { task_id: task.task_id, kind: task.kind, assignee: this.#agentId }
				}
			});
			if (!receipt.accepted) {
				logInfo("rejoined an existing run", {
					agentId: this.#agentId,
					taskId: task.task_id
				});
			}
			const result = await this.harness.wait(operationId);
			const tokens = Math.max(0, (await this.#usageTokens()) - tokensBefore);
			await this.#settle(task.task_id, result, tokens);
		} catch (error) {
			logError("task run failed", {
				agentId: this.#agentId,
				taskId: task.task_id,
				error: describeError(error)
			});
			await this.#failTask(task, describeError(error));
		}
	}

	/**
	 * The tokens this agent's session has spent.
	 *
	 * It is the session total, so a task's own cost is the difference between
	 * the total before it and the total after it.
	 */
	async #usageTokens(): Promise<number> {
		try {
			const pi = await this.harness.pi();
			const usage = await pi.usage(BACKGROUND_CONTEXT);
			return Object.values(usage.models).reduce(
				(total, entry) => total + (entry.totalTokens ?? 0),
				0
			);
		} catch {
			return 0;
		}
	}

	async #buildPrompt(task: TaskRow): Promise<string> {
		const goal = task.goal_id
			? await this.env.ORG_DB.prepare("SELECT title FROM goals WHERE goal_id = ?1")
					.bind(task.goal_id)
					.first<{ title: string }>()
			: null;
		const lines = [
			`<assignment task_id="${task.task_id}" kind="${task.kind}">`,
			`Task: ${task.title}`,
			goal ? `Goal: ${goal.title}` : undefined,
			task.deadline_at ? `Deadline: ${new Date(task.deadline_at).toISOString()}` : undefined,
			"",
			task.instruction,
			"",
			"When you are done, call org_report_result with a summary and the evidence you gathered."
		];
		return lines.filter((line) => line !== undefined).join("\n");
	}

	/** Record the outcome of a run and hand the task to the coordinator. */
	async #settle(
		taskId: string,
		result: { status: string; reason?: string; text?: string },
		tokens = 0
	): Promise<void> {
		const task = await getTask(this.env.ORG_DB, taskId);
		if (!task) return;
		if (tokens > 0) {
			await updateTask(this.env.ORG_DB, taskId, { tokens });
			await bumpAgentUsage(this.env.ORG_DB, this.#agentId, 0, tokens);
		}
		const identity = await this.#resolveIdentity();
		if (tokens > identity.maxTokens) {
			// The task spent more than it was allowed. It is closed as failed
			// with the reason, rather than quietly costing more than planned.
			await this.#failTask(
				task,
				`the task spent ${tokens} tokens, over its budget of ${identity.maxTokens}`
			);
			await this.#notifyCoordinator(taskId);
			return;
		}
		if (result.status !== "done") {
			// A run that did not answer says why in pi's own record. Carry that
			// detail into the task, or the operator sees only "model_error" and
			// has to guess.
			const detail = await this.#failureDetail();
			await this.#failTask(task, detail ? `${result.reason ?? "failed"}: ${detail}` : (result.reason ?? "failed"));
			await this.#notifyCoordinator(taskId);
			return;
		}
		if (task.status !== "completed") {
			// The model did not call org_report_result. Close the task with the
			// final text so the organization does not wait forever, and say so.
			const wrote = await completeTask(
				this.env.ORG_DB,
				taskId,
				{
					summary: result.text ?? "",
					findings: [],
					recommendation: null,
					evidence: [],
					reportedBy: "harness"
				},
				Date.now()
			);
			if (wrote) {
				await recordEvent(this.env.ORG_DB, {
					correlationId: task.correlation_id,
					agentId: this.#agentId,
					taskId,
					type: "task.settled_without_report",
					payload: {}
				});
				logWarn("task settled without a structured report", {
					agentId: this.#agentId,
					taskId
				});
			}
		}
		await this.#notifyCoordinator(taskId);
	}

	/**
	 * The error behind a run that did not answer.
	 *
	 * pi keeps the detail in the failed task's own outcome. This reads it
	 * back, so the reason an agent could not finish is in the organization's
	 * own record rather than only in a log line.
	 */
	async #failureDetail(): Promise<string | null> {
		try {
			const pi = await this.harness.pi();
			const inspection = await pi.inspect(BACKGROUND_CONTEXT);
			for (const task of inspection.tasks) {
				const state = task.state as { status?: string; outcome?: { error?: { message?: string } } };
				const message = state.outcome?.error?.message;
				if (message) return message;
			}
		} catch {
			// Fall through to the transcript.
		}
		try {
			// The failed generation leaves its error in the transcript, as the
			// assistant entry that carries it.
			const entries = await this.harness.messages();
			for (const entry of entries) {
				const model = (entry as { model?: { errorMessage?: string }[] }).model ?? [];
				for (const message of model) {
					const error = (message as { errorMessage?: string }).errorMessage;
					if (error) return error;
				}
			}
		} catch {
			// Nothing to add.
		}
		return null;
	}

	async #failTask(task: TaskRow, reason: string): Promise<void> {
		if (task.status === "completed" || task.status === "failed") return;
		await updateTask(this.env.ORG_DB, task.task_id, {
			status: "failed",
			result: { summary: reason, findings: [], recommendation: null, evidence: [] },
			completedAt: Date.now(),
			fingerprint: null
		});
		await recordEvent(this.env.ORG_DB, {
			correlationId: task.correlation_id,
			agentId: this.#agentId,
			taskId: task.task_id,
			type: "task.failed",
			payload: { reason }
		});
	}

	async #recordNoteResult(operationId: string, result: { status: string; reason?: string }): Promise<void> {
		await recordEvent(this.env.ORG_DB, {
			correlationId: operationId,
			agentId: this.#agentId,
			type: "agent.note.settled",
			payload: { status: result.status, reason: result.reason ?? null }
		});
	}

	/** Tell the coordinator that a task finished. */
	async #notifyCoordinator(taskId: string): Promise<void> {
		try {
			const coordinator = await findAgentByRole(this.env.ORG_DB, "coordinator");
			if (!coordinator) return;
			await this.env.ORG_AGENTS.getByName(coordinator.agent_id).onTaskCompleted(taskId);
		} catch (error) {
			// The coordinator's own sweep repairs a missed handoff, so a failure
			// here is logged and not fatal.
			logWarn("could not notify the coordinator", {
				agentId: this.#agentId,
				taskId,
				error: describeError(error)
			});
		}
	}

	/** Give a task to another agent. */
	async #assignTo(agentId: string, taskId: string): Promise<void> {
		try {
			await this.env.ORG_AGENTS.getByName(agentId).assign(taskId);
		} catch (error) {
			logWarn("could not assign a task", {
				agentId: this.#agentId,
				taskId,
				error: describeError(error)
			});
		}
	}

	/* ── coordinator decisions ──────────────────────────────────────────── */

	async #startReview(task: TaskRow): Promise<{ action: string; detail?: string }> {
		const reviewer = await findAgentByRole(this.env.ORG_DB, "reviewer");
		if (!reviewer) return { action: "no_reviewer" };
		const { task: review, created } = await createTask(this.env.ORG_DB, {
			goalId: task.goal_id,
			kind: "review",
			title: `Review: ${task.title}`,
			instruction: [
				`Review the work of task ${task.task_id} (${task.kind}).`,
				"",
				"Result under review:",
				JSON.stringify(parseJson(task.result), null, 2),
				"",
				"Assess it independently. Look for bugs, regressions and unsupported claims.",
				"Then call org_report_result with a summary, your findings, and a recommendation of",
				"\"accept\", \"changes_requested\" or \"escalate\".",
				"Do not review your own work: this task belongs to a different agent."
			].join("\n"),
			assignee: reviewer.agent_id,
			createdBy: this.#agentId,
			depth: task.depth,
			parentTaskId: task.task_id,
			reviewOfTaskId: task.task_id,
			deadlineAt: Date.now() + 60 * 60_000,
			correlationId: task.correlation_id
		});
		if (!created) return { action: "review_exists", detail: review.task_id };
		await recordEvent(this.env.ORG_DB, {
			correlationId: task.correlation_id,
			agentId: this.#agentId,
			taskId: review.task_id,
			type: "task.review_requested",
			payload: { source_task_id: task.task_id, reviewer: reviewer.agent_id }
		});
		await this.#assignTo(reviewer.agent_id, review.task_id);
		return { action: "review_started", detail: review.task_id };
	}

	async #actOnReview(task: TaskRow): Promise<{ action: string; detail?: string }> {
		const result = parseJson(task.result) as { recommendation?: string | null; findings?: string[] };
		const recommendation = result.recommendation ?? "escalate";
		const source = task.review_of_task_id
			? await getTask(this.env.ORG_DB, task.review_of_task_id)
			: null;

		if (recommendation === "accept") {
			return this.#startApply(task, source);
		}
		if (recommendation === "changes_requested") {
			if (!source) return { action: "no_source_task" };
			if (source.attempt + 1 >= source.max_attempts) {
				return this.#escalate(task, source, "the reviewer asked for changes and the attempt limit is reached");
			}
			const engineer = await findAgentByRole(this.env.ORG_DB, "engineer");
			if (!engineer) return { action: "no_engineer" };
			const { task: retry, created } = await createTask(this.env.ORG_DB, {
				goalId: source.goal_id,
				kind: source.kind,
				title: source.title,
				// The attempt travels with the task, so the limit is measured
				// against the work as a whole and not against each round.
				attempt: source.attempt + 1,
				maxAttempts: source.max_attempts,
				instruction: [
					source.instruction,
					"",
					"The reviewer asked for changes:",
					...(result.findings ?? []).map((finding) => `- ${finding}`),
					"",
					"Address every finding and report again."
				].join("\n"),
				assignee: engineer.agent_id,
				createdBy: this.#agentId,
				depth: source.depth,
				parentTaskId: task.task_id,
				dedupeKey: `rework:${task.task_id}`,
				deadlineAt: Date.now() + 60 * 60_000,
				correlationId: source.correlation_id
			});
			if (!created) return { action: "retry_exists", detail: retry.task_id };
			await recordEvent(this.env.ORG_DB, {
				correlationId: source.correlation_id,
				agentId: this.#agentId,
				taskId: retry.task_id,
				type: "task.rework_requested",
				payload: { source_task_id: source.task_id, attempt: source.attempt + 1 }
			});
			await this.#assignTo(engineer.agent_id, retry.task_id);
			return { action: "rework_started", detail: retry.task_id };
		}
		return this.#escalate(task, source, "the reviewer asked for a human decision");
	}

	/**
	 * The next step after an accepted review is the externally consequential
	 * one, so it needs a human. The task is created blocked, with an approval
	 * request, and starts only once a human approves it.
	 */
	async #startApply(
		review: TaskRow,
		source: TaskRow | null
	): Promise<{ action: string; detail?: string }> {
		const engineer = await findAgentByRole(this.env.ORG_DB, "engineer");
		if (!engineer) return { action: "no_engineer" };
		// What the agent proposed to run, which is what the human is asked
		// to approve. The reviewer's word wins over the engineer's, because
		// the reviewer is the last one to look at it.
		const proposed =
			proposedAction(review.result) ?? (source ? proposedAction(source.result) : undefined);
		// The task is created first: its key makes the step unique, so a
		// replayed handoff finds it instead of creating a second one, and no
		// second approval is raised for the same review.
		const { task, created } = await createTask(this.env.ORG_DB, {
			goalId: review.goal_id,
			kind: "apply",
			title: `Apply: ${source?.title ?? review.title}`,
			instruction: [
				`The reviewer accepted the work of task ${source?.task_id ?? review.task_id}.`,
				"",
				proposed
					? `The approved action is: ${describeAction(proposed)}. Run exactly that with org_run_execution.`
					: "No action was proposed, so nothing is authorised to run: ask for approval of a specific action with org_request_approval first.",
				"it will not run until a human has approved that action.",
				"Then call org_report_result with what was applied and the evidence."
			].join("\n"),
			assignee: engineer.agent_id,
			createdBy: this.#agentId,
			depth: review.depth,
			parentTaskId: review.task_id,
			dedupeKey: `apply:${review.task_id}`,
			requiresApproval: true,
			deadlineAt: Date.now() + 60 * 60_000,
			correlationId: review.correlation_id
		});
		if (!created) return { action: "apply_exists", detail: task.task_id };
		const approval = await createApproval(this.env.ORG_DB, {
			taskId: null,
			requestedBy: this.#agentId,
			reason: `Apply the result of ${source?.task_id ?? review.task_id} to the repository.`,
			...(proposed ? { action: proposed } : {})
		});
		await updateTask(this.env.ORG_DB, task.task_id, {
			status: "blocked",
			approvalId: approval.approval_id
		});
		await recordEvent(this.env.ORG_DB, {
			correlationId: task.correlation_id,
			agentId: this.#agentId,
			taskId: task.task_id,
			type: "approval.requested",
			payload: { approval_id: approval.approval_id, reason: approval.reason }
		});
		return { action: "awaiting_approval", detail: approval.approval_id };
	}

	/**
	 * Ask a human to decide, and stop the automatic chain.
	 *
	 * The work that led here is finished, and it stays finished: reopening a
	 * completed task would make the reviewer answer again, which would raise
	 * another approval, which would reopen the task again. The escalation is
	 * recorded on the approval and on the goal, and the chain stops there.
	 */
	async #escalate(
		review: TaskRow,
		source: TaskRow | null,
		reason: string
	): Promise<{ action: string; detail?: string }> {
		const approval = await createApproval(this.env.ORG_DB, {
			taskId: review.task_id,
			requestedBy: this.#agentId,
			reason
		});
		await recordEvent(this.env.ORG_DB, {
			correlationId: review.correlation_id,
			agentId: this.#agentId,
			taskId: review.task_id,
			type: "approval.requested",
			payload: { approval_id: approval.approval_id, reason }
		});
		const goalId = source?.goal_id ?? review.goal_id;
		if (goalId) {
			await this.env.ORG_DB.prepare("UPDATE goals SET status = 'blocked', updated_at = ?1 WHERE goal_id = ?2")
				.bind(Date.now(), goalId)
				.run();
		}
		return { action: "escalated", detail: approval.approval_id };
	}

	async #closeGoal(task: TaskRow, status: "achieved" | "blocked"): Promise<{ action: string }> {
		if (!task.goal_id) return { action: "no_goal" };
		await this.env.ORG_DB.prepare("UPDATE goals SET status = ?1, updated_at = ?2 WHERE goal_id = ?3")
			.bind(status, Date.now(), task.goal_id)
			.run();
		await recordEvent(this.env.ORG_DB, {
			correlationId: task.correlation_id,
			agentId: this.#agentId,
			taskId: task.task_id,
			type: `goal.${status}`,
			payload: { goal_id: task.goal_id }
		});
		return { action: `goal_${status}` };
	}

	/* ── periodic work ──────────────────────────────────────────────────── */

	async #runObligations(): Promise<{ obligations: number; findings: number }> {
		const obligations = await listObligations(this.env.ORG_DB);
		let ran = 0;
		let findings = 0;
		const now = Date.now();
		for (const obligation of obligations) {
			if (!obligation.enabled) continue;
			const claimed = await claimObligation(
				this.env.ORG_DB,
				obligation.obligation_id,
				now,
				OBLIGATION_LEASE_MS
			);
			if (!claimed) continue;
			ran += 1;
			try {
				// Each obligation names the check it runs.
				const spec = parseJson(obligation.check_spec) as { kind?: string };
				const check = selectRepositoryCheck(this.env, spec);
				const result = await check.run({
					env: this.env,
					correlationId: `cor_${obligation.obligation_id}`
				});
				const state = parseJson(obligation.state) as ObligationState;
				const applied = await this.#applyFindings(obligation, state, result.findings);
				findings += applied.created;
				await completeObligationRun(
					this.env.ORG_DB,
					obligation.obligation_id,
					Date.now(),
					obligation.interval_seconds,
					{ ...applied.state, detail: result.detail, unknown: result.unknown, at: Date.now() }
				);
			} catch (error) {
				logError("obligation failed", {
					obligationId: obligation.obligation_id,
					error: describeError(error)
				});
				await releaseObligation(this.env.ORG_DB, obligation.obligation_id);
			}
		}
		return { obligations: ran, findings };
	}

	/**
	 * Turn findings into tasks, one per finding.
	 *
	 * A finding is deduplicated twice: the open task for it blocks a second
	 * one, and the obligation remembers the last finding it acted on, so a
	 * failure that is still there does not produce a new task on every
	 * sweep. A cooldown stands between them: the same failure is worth
	 * another look, but not another full chain every fifteen minutes.
	 */
	async #applyFindings(
		obligation: ObligationRow,
		state: ObligationState,
		findings: readonly { fingerprint: string; title: string; detail: string; kind: string }[]
	): Promise<{ created: number; state: ObligationState }> {
		const next: ObligationState = { ...state };
		if (findings.length === 0) return { created: 0, state: next };
		const engineer = await findAgentByRole(this.env.ORG_DB, "engineer");
		if (!engineer) return { created: 0, state: next };
		const cooldownMs = Math.max(obligation.interval_seconds * 4, 3600) * 1000;
		const now = Date.now();
		let created = 0;
		for (const finding of findings) {
			const known = state.fingerprints?.[finding.fingerprint];
			const unresolved = known ? await findOpenChainTask(this.env.ORG_DB, known.taskId) : null;
			if (
				known &&
				(unresolved !== null || now - (known.lastCreatedAt ?? 0) < cooldownMs)
			) {
				await recordEvent(this.env.ORG_DB, {
					correlationId: `cor_${obligation.obligation_id}`,
					agentId: this.#agentId,
					taskId: unresolved?.task_id ?? known.taskId,
					type: "finding.suppressed",
					payload: {
						obligation_id: obligation.obligation_id,
						fingerprint: finding.fingerprint,
						reason: unresolved
							? "the work this finding started has not finished"
							: "the same finding was turned into a task recently"
					}
				});
				continue;
			}
			const { task, created: wasCreated } = await createTask(this.env.ORG_DB, {
				kind: finding.kind,
				title: finding.title,
				instruction: [
					finding.detail,
					"",
					"Investigate, propose a fix, and report your result with org_report_result."
				].join("\n"),
				assignee: engineer.agent_id,
				createdBy: this.#agentId,
				depth: 1,
				fingerprint: finding.fingerprint,
				deadlineAt: Date.now() + 60 * 60_000,
				correlationId: `cor_${obligation.obligation_id}`
			});
			if (!wasCreated) {
				logInfo("finding already has an open task", {
					obligationId: obligation.obligation_id,
					taskId: task.task_id
				});
				continue;
			}
			created += 1;
			next.fingerprints = {
				...next.fingerprints,
				[finding.fingerprint]: {
					firstSeen: known?.firstSeen ?? now,
					lastSeen: now,
					lastCreatedAt: now,
					taskId: task.task_id
				}
			};
			await recordEvent(this.env.ORG_DB, {
				correlationId: task.correlation_id,
				agentId: this.#agentId,
				taskId: task.task_id,
				type: "task.created_from_finding",
				payload: { obligation_id: obligation.obligation_id, fingerprint: finding.fingerprint }
			});
			await this.#assignTo(engineer.agent_id, task.task_id);
		}
		return { created, state: next };
	}

	/**
	 * Record how the external actions ended.
	 *
	 * An execution is submitted and then forgotten; nothing would ever say
	 * whether it worked. The sweep asks the backend and writes the answer
	 * down.
	 */
	async #reconcileExecutions(): Promise<number> {
		const pending = await listExecutions(this.env.ORG_DB, "submitted");
		const unsent = await listExecutions(this.env.ORG_DB, "pending");
		const rows = [...unsent, ...pending];
		if (rows.length === 0) return 0;
		const backend = selectExecutionBackend(this.env);
		let settled = 0;
		for (const row of rows) {
			try {
				if (!row.run_id) {
					// Recorded but never sent: the process died in the window
					// between the two. It may still be sent.
					await sendExecution({
						env: this.env,
						db: this.env.ORG_DB,
						backend,
						row,
						spec: parseJson(row.spec) as { command: string },
						correlationId: `cor_${row.execution_id}`,
						agentId: this.#agentId
					});
					settled += 1;
					continue;
				}
				const handle = await backend.status(row.run_id, {
					env: this.env,
					correlationId: `cor_${row.execution_id}`
				});
				if (handle.status === "submitted" || handle.status === "unknown") continue;
				await updateExecution(this.env.ORG_DB, row.execution_id, {
					status: handle.status === "succeeded" ? "succeeded" : "failed",
					result: { detail: handle.detail ?? null, url: handle.url ?? null }
				});
				await recordEvent(this.env.ORG_DB, {
					correlationId: `cor_${row.execution_id}`,
					agentId: this.#agentId,
					taskId: row.task_id,
					type: `execution.${handle.status}`,
					payload: { run_id: row.run_id, detail: handle.detail ?? null }
				});
				settled += 1;
			} catch (error) {
				logWarn("could not reconcile an execution", {
					agentId: this.#agentId,
					taskId: row.task_id,
					error: describeError(error)
				});
			}
		}
		return settled;
	}

	/**
	 * Find assignments that are not moving and either re-issue them or give
	 * up on them.
	 */
	async #recoverStalledTasks(): Promise<number> {
		const open = await listOpenTasks(this.env.ORG_DB);
		const now = Date.now();
		let recovered = 0;
		for (const task of open) {
			if (task.status === "blocked") continue;
			if (task.deadline_at === null || task.deadline_at > now) continue;
			if (task.attempt + 1 >= task.max_attempts) {
				await updateTask(this.env.ORG_DB, task.task_id, {
					status: "failed",
					result: {
						summary: "the assignment did not finish before its deadline",
						findings: [],
						recommendation: "escalate",
						evidence: []
					},
					completedAt: now
				});
				await recordEvent(this.env.ORG_DB, {
					correlationId: task.correlation_id,
					agentId: this.#agentId,
					taskId: task.task_id,
					type: "task.stalled_failed",
					payload: { attempt: task.attempt }
				});
				await this.#notifyCoordinator(task.task_id);
				recovered += 1;
				continue;
			}
			await updateTask(this.env.ORG_DB, task.task_id, {
				attempt: task.attempt + 1,
				status: "assigned",
				deadlineAt: now + 30 * 60_000
			});
			await recordEvent(this.env.ORG_DB, {
				correlationId: task.correlation_id,
				agentId: this.#agentId,
				taskId: task.task_id,
				type: "task.stalled_retried",
				payload: { attempt: task.attempt + 1 }
			});
			logWarn("re-issued a stalled assignment", {
				agentId: this.#agentId,
				taskId: task.task_id,
				attempt: task.attempt + 1
			});
			await this.#assignTo(task.assignee, task.task_id);
			recovered += 1;
		}
		return recovered;
	}

	/**
	 * Rejoin work that an earlier instance of this object left behind.
	 *
	 * This is the recovery path: an eviction between the admission of a task
	 * and its completion leaves the task open in the shared store, and the
	 * next start of this object picks it up again. Because submissions are
	 * idempotent, rejoining does not start a second run.
	 */
	async #reconcile(): Promise<void> {
		const open = await listOpenTasks(this.env.ORG_DB);
		const mine = open.filter((task) => task.assignee === this.#agentId);
		for (const task of mine) {
			if (task.requires_approval) continue;
			try {
				await this.#markRunning(task);
				await this.#setAssignment(task);
				this.ctx.waitUntil(this.#runTask(task));
				logInfo("rejoined an open assignment", {
					agentId: this.#agentId,
					taskId: task.task_id
				});
			} catch (error) {
				logError("could not rejoin an assignment", {
					agentId: this.#agentId,
					taskId: task.task_id,
					error: describeError(error)
				});
			}
		}
	}
}

/** The action a task's report proposed, if it proposed one. */
function proposedAction(result: string | null): ApprovedAction | undefined {
	const parsed = parseJson(result) as { action?: ApprovedAction };
	const action = parsed.action;
	if (!action || typeof action.command !== "string" || action.command.length === 0) {
		return undefined;
	}
	return action;
}

/** The operation id of a task's run. Stable, so a replay rejoins the run. */
export function operationIdFor(taskId: string): string {
	return `task:${taskId}`;
}

function parseJson(value: string | null): unknown {
	if (!value) return {};
	try {
		return JSON.parse(value);
	} catch {
		return {};
	}
}
