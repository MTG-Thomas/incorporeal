/**
 * The shared operational store.
 *
 * Everything in this module is authoritative organization state: who the
 * agents are, what they owe each other, what is running, what was decided and
 * what happened. Agent-private working state (transcript, inbox, checkpoints)
 * is not here; it lives in each agent's Durable Object, owned by pi-durable.
 *
 * D1 is used because this state is genuinely relational and shared: tasks
 * reference goals, agents, reviews and approvals, and every agent needs to
 * read the same rows. It is not used for agent transcripts.
 */
import { shortId } from "../ids.ts";
import type {
	AgentRow,
	AgentStatus,
	ApprovalRow,
	ApprovalStatus,
	ExecutionRow,
	ExecutionStatus,
	EventRow,
	GoalRow,
	GoalStatus,
	KnowledgeKind,
	KnowledgeRow,
	ObligationRow,
	TaskRow,
	TaskStatus
} from "./types.ts";
export type { AgentRow } from "./types.ts";

/* ── agents ─────────────────────────────────────────────────────────────── */

export async function getAgent(db: D1Database, agentId: string): Promise<AgentRow | null> {
	return db.prepare("SELECT * FROM agents WHERE agent_id = ?1").bind(agentId).first<AgentRow>();
}

/** The agent holding a role, for example the coordinator. */
export async function findAgentByRole(db: D1Database, role: string): Promise<AgentRow | null> {
	return db
		.prepare("SELECT * FROM agents WHERE role = ?1 AND status = 'active' ORDER BY created_at ASC LIMIT 1")
		.bind(role)
		.first<AgentRow>();
}

export async function listAgents(db: D1Database): Promise<AgentRow[]> {
	const { results } = await db
		.prepare("SELECT * FROM agents ORDER BY created_at ASC")
		.all<AgentRow>();
	return results ?? [];
}

export type AgentInput = {
	agentId: string;
	role: string;
	title: string;
	status?: AgentStatus;
	model?: string | null;
	thinkingLevel?: string | null;
	permissions?: readonly string[];
	maxToolCalls?: number;
	maxTokens?: number;
	successorOf?: string | null;
};

export async function upsertAgent(db: D1Database, input: AgentInput): Promise<AgentRow> {
	const now = Date.now();
	await db
		.prepare(
			`INSERT INTO agents (agent_id, role, title, status, model, thinking_level, permissions,
				max_tool_calls, max_tokens, successor_of, created_at, updated_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)
			 ON CONFLICT(agent_id) DO UPDATE SET
				role = excluded.role, title = excluded.title, status = excluded.status,
				model = excluded.model, thinking_level = excluded.thinking_level,
				permissions = excluded.permissions, max_tool_calls = excluded.max_tool_calls,
				max_tokens = excluded.max_tokens, successor_of = excluded.successor_of,
				updated_at = excluded.updated_at`
		)
		.bind(
			input.agentId,
			input.role,
			input.title,
			input.status ?? "active",
			input.model ?? null,
			input.thinkingLevel ?? null,
			JSON.stringify(input.permissions ?? []),
			input.maxToolCalls ?? 20,
			input.maxTokens ?? 120_000,
			input.successorOf ?? null,
			now
		)
		.run();
	const row = await getAgent(db, input.agentId);
	if (!row) throw new Error(`agent ${input.agentId} disappeared after upsert`);
	return row;
}

/* ── goals ──────────────────────────────────────────────────────────────── */

export async function createGoal(
	db: D1Database,
	input: { title: string; description: string; ownerAgent: string }
): Promise<GoalRow> {
	const goalId = shortId("goal");
	const now = Date.now();
	await db
		.prepare(
			`INSERT INTO goals (goal_id, title, description, owner_agent, status, created_at, updated_at)
			 VALUES (?1, ?2, ?3, ?4, 'active', ?5, ?5)`
		)
		.bind(goalId, input.title, input.description, input.ownerAgent, now)
		.run();
	const row = await getGoal(db, goalId);
	if (!row) throw new Error("goal disappeared after insert");
	return row;
}

export async function getGoal(db: D1Database, goalId: string): Promise<GoalRow | null> {
	return db.prepare("SELECT * FROM goals WHERE goal_id = ?1").bind(goalId).first<GoalRow>();
}

export async function listGoals(db: D1Database): Promise<GoalRow[]> {
	const { results } = await db.prepare("SELECT * FROM goals ORDER BY created_at DESC").all<GoalRow>();
	return results ?? [];
}

export async function updateGoal(
	db: D1Database,
	goalId: string,
	patch: { status?: GoalStatus; title?: string; description?: string }
): Promise<void> {
	const sets: string[] = [];
	const values: unknown[] = [];
	if (patch.status !== undefined) {
		sets.push("status = ?");
		values.push(patch.status);
	}
	if (patch.title !== undefined) {
		sets.push("title = ?");
		values.push(patch.title);
	}
	if (patch.description !== undefined) {
		sets.push("description = ?");
		values.push(patch.description);
	}
	if (sets.length === 0) return;
	sets.push("updated_at = ?");
	values.push(Date.now(), goalId);
	await db
		.prepare(`UPDATE goals SET ${sets.join(", ")} WHERE goal_id = ?`)
		.bind(...values)
		.run();
}

/* ── tasks ──────────────────────────────────────────────────────────────── */

export type CreateTaskInput = {
	goalId?: string | null;
	kind: string;
	title: string;
	instruction: string;
	assignee: string;
	createdBy: string;
	maxAttempts?: number;
	/** The attempt this task starts at; a rework task inherits its source's. */
	attempt?: number;
	depth?: number;
	parentTaskId?: string | null;
	reviewOfTaskId?: string | null;
	/** One task per key: a replayed handoff cannot create a second one. */
	dedupeKey?: string | null;
	/** The tool call that made this row, so a replay finds it again. */
	toolTaskId?: string | null;
	fingerprint?: string | null;
	deadlineAt?: number | null;
	requiresApproval?: boolean;
	correlationId: string;
};

export type CreateTaskResult = { task: TaskRow; created: boolean };

/**
 * Create a task.
 *
 * Two uniqueness rules make delegation safe to replay: one open review per
 * source task, and one open task per finding fingerprint. A duplicate insert
 * returns the existing row with `created: false` instead of throwing, so a
 * replayed delegation cannot start the same work twice.
 */
export async function createTask(
	db: D1Database,
	input: CreateTaskInput
): Promise<CreateTaskResult> {
	const taskId = shortId("task");
	const now = Date.now();
	try {
		await db
			.prepare(
				`INSERT INTO tasks (task_id, goal_id, kind, title, instruction, assignee, created_by,
					status, attempt, max_attempts, depth, parent_task_id, review_of_task_id, dedupe_key,
					fingerprint, deadline_at, requires_approval, correlation_id, tool_task_id, created_at, updated_at)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'assigned', ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?19)`
			)
			.bind(
				taskId,
				input.goalId ?? null,
				input.kind,
				input.title,
				input.instruction,
				input.assignee,
				input.createdBy,
				input.attempt ?? 0,
				input.maxAttempts ?? 2,
				input.depth ?? 0,
				input.parentTaskId ?? null,
				input.reviewOfTaskId ?? null,
				input.dedupeKey ?? null,
				input.fingerprint ?? null,
				input.deadlineAt ?? null,
				input.requiresApproval ? 1 : 0,
				input.correlationId,
				input.toolTaskId ?? null,
				now
			)
			.run();
	} catch (error) {
		const existing = await findDuplicateTask(db, input);
		if (existing) return { task: existing, created: false };
		throw error;
	}
	const task = await getTask(db, taskId);
	if (!task) throw new Error("task disappeared after insert");
	return { task, created: true };
}

async function findDuplicateTask(
	db: D1Database,
	input: CreateTaskInput
): Promise<TaskRow | null> {
	if (input.reviewOfTaskId) {
		const row = await db
			.prepare("SELECT * FROM tasks WHERE review_of_task_id = ?1 LIMIT 1")
			.bind(input.reviewOfTaskId)
			.first<TaskRow>();
		if (row) return row;
	}
	if (input.toolTaskId) {
		const row = await db
			.prepare("SELECT * FROM tasks WHERE tool_task_id = ?1 LIMIT 1")
			.bind(input.toolTaskId)
			.first<TaskRow>();
		if (row) return row;
	}
	if (input.dedupeKey) {
		const row = await db
			.prepare("SELECT * FROM tasks WHERE dedupe_key = ?1 LIMIT 1")
			.bind(input.dedupeKey)
			.first<TaskRow>();
		if (row) return row;
	}
	if (input.fingerprint) {
		const row = await db
			.prepare("SELECT * FROM tasks WHERE fingerprint = ?1 LIMIT 1")
			.bind(input.fingerprint)
			.first<TaskRow>();
		if (row) return row;
	}
	return null;
}

export async function getTask(db: D1Database, taskId: string): Promise<TaskRow | null> {
	return db.prepare("SELECT * FROM tasks WHERE task_id = ?1").bind(taskId).first<TaskRow>();
}

export type TaskFilter = {
	assignee?: string;
	status?: TaskStatus | TaskStatus[];
	goalId?: string;
	kind?: string;
	limit?: number;
};

export async function listTasks(db: D1Database, filter: TaskFilter = {}): Promise<TaskRow[]> {
	const clauses: string[] = [];
	const values: unknown[] = [];
	if (filter.assignee) {
		values.push(filter.assignee);
		clauses.push(`assignee = ?${values.length}`);
	}
	if (filter.status) {
		const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
		const placeholders = statuses.map((status) => {
			values.push(status);
			return `?${values.length}`;
		});
		clauses.push(`status IN (${placeholders.join(", ")})`);
	}
	if (filter.goalId) {
		values.push(filter.goalId);
		clauses.push(`goal_id = ?${values.length}`);
	}
	if (filter.kind) {
		values.push(filter.kind);
		clauses.push(`kind = ?${values.length}`);
	}
	const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
	values.push(Math.min(filter.limit ?? 100, 500));
	const sql = `SELECT * FROM tasks ${where} ORDER BY created_at DESC LIMIT ?${values.length}`;
	const { results } = await db
		.prepare(sql)
		.bind(...values)
		.all<TaskRow>();
	return results ?? [];
}

/** Tasks that are still owed work, for stall detection. */
export async function listOpenTasks(db: D1Database): Promise<TaskRow[]> {
	return listTasks(db, { status: ["pending", "assigned", "running", "blocked"] });
}

export type TaskPatch = {
	status?: TaskStatus;
	attempt?: number;
	result?: unknown;
	artifact?: unknown;
	toolCalls?: number;
	tokens?: number;
	startedAt?: number | null;
	completedAt?: number | null;
	deadlineAt?: number | null;
	approvalId?: string | null;
	requiresApproval?: boolean;
	fingerprint?: string | null;
};

export async function updateTask(
	db: D1Database,
	taskId: string,
	patch: TaskPatch
): Promise<TaskRow | null> {
	const sets: string[] = [];
	const values: unknown[] = [];
	const add = (column: string, value: unknown) => {
		values.push(value);
		sets.push(`${column} = ?${values.length}`);
	};
	if (patch.status !== undefined) add("status", patch.status);
	if (patch.attempt !== undefined) add("attempt", patch.attempt);
	if (patch.result !== undefined) add("result", JSON.stringify(patch.result));
	if (patch.artifact !== undefined) add("artifact", JSON.stringify(patch.artifact));
	if (patch.toolCalls !== undefined) add("tool_calls", patch.toolCalls);
	if (patch.tokens !== undefined) add("tokens", patch.tokens);
	if (patch.startedAt !== undefined) add("started_at", patch.startedAt);
	if (patch.completedAt !== undefined) add("completed_at", patch.completedAt);
	if (patch.deadlineAt !== undefined) add("deadline_at", patch.deadlineAt);
	if (patch.approvalId !== undefined) add("approval_id", patch.approvalId);
	if (patch.requiresApproval !== undefined) add("requires_approval", patch.requiresApproval ? 1 : 0);
	if (patch.fingerprint !== undefined) add("fingerprint", patch.fingerprint);
	if (sets.length === 0) return getTask(db, taskId);
	sets.push("updated_at = ?");
	values.push(Date.now(), taskId);
	await db
		.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE task_id = ?`)
		.bind(...values)
		.run();
	return getTask(db, taskId);
}

/**
 * Move a task into the running state.
 *
 * The update is conditional on the task not already being finished: a late
 * assignment must never pull a completed task back to "running", which would
 * lose the result it recorded.
 */
export async function markTaskRunning(db: D1Database, taskId: string): Promise<boolean> {
	const result = await db
		.prepare(
			`UPDATE tasks SET status = 'running', started_at = COALESCE(started_at, ?1), updated_at = ?1
			 WHERE task_id = ?2 AND status NOT IN ('completed', 'failed', 'cancelled')`
		)
		.bind(Date.now(), taskId)
		.run();
	return (result.meta.changes ?? 0) > 0;
}

/**
 * Complete a task, unless it already has a result.
 *
 * The agent's own report is better than the harness's fallback, so a result
 * that is already recorded is never overwritten.
 */
export async function completeTask(
	db: D1Database,
	taskId: string,
	result: unknown,
	now: number
): Promise<boolean> {
	const changed = await db
		.prepare(
			`UPDATE tasks SET status = 'completed', result = ?1, completed_at = ?2, updated_at = ?2,
				fingerprint = NULL
			 WHERE task_id = ?3 AND status NOT IN ('completed', 'failed', 'cancelled') AND result IS NULL`
		)
		.bind(JSON.stringify(result), now, taskId)
		.run();
	if ((changed.meta.changes ?? 0) > 0) return true;
	// The task carries a result already; make sure the status says so.
	await db
		.prepare(
			`UPDATE tasks SET status = 'completed', completed_at = COALESCE(completed_at, ?1), updated_at = ?1
			 WHERE task_id = ?2 AND status NOT IN ('failed', 'cancelled')`
		)
		.bind(now, taskId)
		.run();
	return false;
}

/** Increment a task's tool-call counter and report the new value. */
export async function bumpTaskToolCalls(db: D1Database, taskId: string): Promise<number> {
	await db
		.prepare("UPDATE tasks SET tool_calls = tool_calls + 1, updated_at = ?1 WHERE task_id = ?2")
		.bind(Date.now(), taskId)
		.run();
	const row = await db
		.prepare("SELECT tool_calls FROM tasks WHERE task_id = ?1")
		.bind(taskId)
		.first<{ tool_calls: number }>();
	return row?.tool_calls ?? 0;
}

/* ── obligations ────────────────────────────────────────────────────────── */

export async function listObligations(db: D1Database): Promise<ObligationRow[]> {
	const { results } = await db
		.prepare("SELECT * FROM obligations ORDER BY created_at ASC")
		.all<ObligationRow>();
	return results ?? [];
}

export async function getObligation(
	db: D1Database,
	obligationId: string
): Promise<ObligationRow | null> {
	return db
		.prepare("SELECT * FROM obligations WHERE obligation_id = ?1")
		.bind(obligationId)
		.first<ObligationRow>();
}

export async function createObligation(
	db: D1Database,
	input: {
		name: string;
		ownerAgent: string;
		intervalSeconds: number;
		checkSpec: unknown;
		nextRunAt?: number | null;
	}
): Promise<ObligationRow> {
	const obligationId = shortId("obl");
	const now = Date.now();
	await db
		.prepare(
			`INSERT INTO obligations (obligation_id, name, owner_agent, kind, interval_seconds, check_spec,
				enabled, next_run_at, created_at, updated_at)
			 VALUES (?1, ?2, ?3, 'interval', ?4, ?5, 1, ?6, ?7, ?7)`
		)
		.bind(
			obligationId,
			input.name,
			input.ownerAgent,
			input.intervalSeconds,
			JSON.stringify(input.checkSpec),
			input.nextRunAt ?? now + input.intervalSeconds * 1000,
			now
		)
		.run();
	const row = await getObligation(db, obligationId);
	if (!row) throw new Error("obligation disappeared after insert");
	return row;
}

/**
 * Claim an obligation for a run.
 *
 * The claim is a single conditional update, so two overlapping sweeps cannot
 * both run the same obligation: the second update matches no row and the
 * claim is refused. The lock expires after `leaseMs`, so a crashed run does
 * not block the obligation forever.
 */
export async function claimObligation(
	db: D1Database,
	obligationId: string,
	now: number,
	leaseMs: number
): Promise<boolean> {
	const result = await db
		.prepare(
			`UPDATE obligations SET running_until = ?1, updated_at = ?2
			 WHERE obligation_id = ?3 AND enabled = 1
			   AND (running_until IS NULL OR running_until < ?2)
			   AND (next_run_at IS NULL OR next_run_at <= ?2)`
		)
		.bind(now + leaseMs, now, obligationId)
		.run();
	return (result.meta.changes ?? 0) > 0;
}

export async function completeObligationRun(
	db: D1Database,
	obligationId: string,
	now: number,
	intervalSeconds: number,
	state: unknown
): Promise<void> {
	await db
		.prepare(
			`UPDATE obligations SET last_run_at = ?1, next_run_at = ?2, running_until = NULL,
				state = ?3, updated_at = ?1 WHERE obligation_id = ?4`
		)
		.bind(now, now + intervalSeconds * 1000, JSON.stringify(state ?? {}), obligationId)
		.run();
}

export async function releaseObligation(db: D1Database, obligationId: string): Promise<void> {
	await db
		.prepare("UPDATE obligations SET running_until = NULL, updated_at = ?1 WHERE obligation_id = ?2")
		.bind(Date.now(), obligationId)
		.run();
}

/* ── approvals ──────────────────────────────────────────────────────────── */

export async function createApproval(
	db: D1Database,
	input: { taskId: string | null; requestedBy: string; reason: string; toolTaskId?: string | null }
): Promise<ApprovalRow> {
	if (input.toolTaskId) {
		const existing = await db
			.prepare("SELECT * FROM approvals WHERE tool_task_id = ?1 LIMIT 1")
			.bind(input.toolTaskId)
			.first<ApprovalRow>();
		if (existing) return existing;
	}
	const approvalId = shortId("apv");
	const now = Date.now();
	await db
		.prepare(
			`INSERT INTO approvals (approval_id, task_id, requested_by, reason, status, created_at, tool_task_id)
			 VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?6)`
		)
		.bind(
			approvalId,
			input.taskId,
			input.requestedBy,
			input.reason,
			now,
			input.toolTaskId ?? null
		)
		.run();
	const row = await db
		.prepare("SELECT * FROM approvals WHERE approval_id = ?1")
		.bind(approvalId)
		.first<ApprovalRow>();
	if (!row) throw new Error("approval disappeared after insert");
	return row;
}

export async function getApproval(db: D1Database, approvalId: string): Promise<ApprovalRow | null> {
	return db
		.prepare("SELECT * FROM approvals WHERE approval_id = ?1")
		.bind(approvalId)
		.first<ApprovalRow>();
}

export async function listApprovals(
	db: D1Database,
	status?: ApprovalStatus
): Promise<ApprovalRow[]> {
	const { results } = status
		? await db
				.prepare("SELECT * FROM approvals WHERE status = ?1 ORDER BY created_at DESC")
				.bind(status)
				.all<ApprovalRow>()
		: await db.prepare("SELECT * FROM approvals ORDER BY created_at DESC").all<ApprovalRow>();
	return results ?? [];
}

/**
 * Decide an approval. The update is conditional on the approval still being
 * pending, so a replayed decision cannot overwrite a human's earlier choice.
 */
export async function decideApproval(
	db: D1Database,
	approvalId: string,
	status: "approved" | "rejected",
	decidedBy: string
): Promise<ApprovalRow | null> {
	const now = Date.now();
	await db
		.prepare(
			`UPDATE approvals SET status = ?1, decided_by = ?2, decided_at = ?3
			 WHERE approval_id = ?4 AND status = 'pending'`
		)
		.bind(status, decidedBy, now, approvalId)
		.run();
	return getApproval(db, approvalId);
}

/* ── knowledge ──────────────────────────────────────────────────────────── */

export async function addKnowledge(
	db: D1Database,
	input: {
		kind: KnowledgeKind;
		title: string;
		body: string;
		authorAgent: string;
		taskId?: string | null;
		toolTaskId?: string | null;
	}
): Promise<KnowledgeRow> {
	if (input.toolTaskId) {
		const existing = await db
			.prepare("SELECT * FROM knowledge WHERE tool_task_id = ?1 LIMIT 1")
			.bind(input.toolTaskId)
			.first<KnowledgeRow>();
		if (existing) return existing;
	}
	const knowledgeId = shortId("kn");
	const now = Date.now();
	await db
		.prepare(
			`INSERT INTO knowledge (knowledge_id, kind, title, body, author_agent, task_id, created_at, updated_at, tool_task_id)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8)`
		)
		.bind(
			knowledgeId,
			input.kind,
			input.title,
			input.body,
			input.authorAgent,
			input.taskId ?? null,
			now,
			input.toolTaskId ?? null
		)
		.run();
	const row = await db
		.prepare("SELECT * FROM knowledge WHERE knowledge_id = ?1")
		.bind(knowledgeId)
		.first<KnowledgeRow>();
	if (!row) throw new Error("knowledge disappeared after insert");
	return row;
}

export async function listKnowledge(
	db: D1Database,
	limit = 50
): Promise<KnowledgeRow[]> {
	const { results } = await db
		.prepare("SELECT * FROM knowledge ORDER BY created_at DESC LIMIT ?1")
		.bind(Math.min(limit, 200))
		.all<KnowledgeRow>();
	return results ?? [];
}

/* ── executions ─────────────────────────────────────────────────────────── */

export type ExecutionInput = {
	taskId: string;
	idempotencyKey: string;
	backend: string;
	spec: unknown;
};

/**
 * Record an external action under an idempotency key.
 *
 * The key is unique, so a replayed tool call after a crash finds the first
 * record instead of creating a second one. The caller uses `created` to decide
 * whether it may perform the action or must return the recorded outcome.
 */
export async function recordExecution(
	db: D1Database,
	input: ExecutionInput
): Promise<{ row: ExecutionRow; created: boolean }> {
	const now = Date.now();
	try {
		await db
			.prepare(
				`INSERT INTO executions (execution_id, task_id, idempotency_key, backend, spec, status,
					created_at, updated_at)
				 VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?6)`
			)
			.bind(
				shortId("exe"),
				input.taskId,
				input.idempotencyKey,
				input.backend,
				JSON.stringify(input.spec),
				now
			)
			.run();
	} catch {
		const existing = await db
			.prepare("SELECT * FROM executions WHERE idempotency_key = ?1")
			.bind(input.idempotencyKey)
			.first<ExecutionRow>();
		if (!existing) throw new Error("execution insert failed and no existing row was found");
		return { row: existing, created: false };
	}
	const row = await db
		.prepare("SELECT * FROM executions WHERE idempotency_key = ?1")
		.bind(input.idempotencyKey)
		.first<ExecutionRow>();
	if (!row) throw new Error("execution disappeared after insert");
	return { row, created: true };
}

/** The statuses that mean a task still owes work. */
const OPEN_STATUSES: TaskStatus[] = ["pending", "assigned", "running", "blocked"];

/**
 * The task that started a chain, or the one still waiting in it.
 *
 * A finding opens a chain: the investigation, the review of it, and the
 * apply step that waits for a human. While any of them is open, the problem
 * is unresolved, and a recurrence of the same finding is the same problem.
 */
export async function findOpenChainTask(
	db: D1Database,
	taskId: string
): Promise<TaskRow | null> {
	const task = await getTask(db, taskId);
	if (!task) return null;
	if (OPEN_STATUSES.includes(task.status)) return task;
	const review = await db
		.prepare("SELECT * FROM tasks WHERE review_of_task_id = ?1 LIMIT 1")
		.bind(taskId)
		.first<TaskRow>();
	if (!review) return null;
	if (OPEN_STATUSES.includes(review.status)) return review;
	const apply = await db
		.prepare("SELECT * FROM tasks WHERE parent_task_id = ?1 AND kind = 'apply' LIMIT 1")
		.bind(review.task_id)
		.first<TaskRow>();
	if (apply && OPEN_STATUSES.includes(apply.status)) return apply;
	return null;
}

/** The executions that are still in flight. */
export async function listExecutions(
	db: D1Database,
	status?: ExecutionStatus
): Promise<ExecutionRow[]> {
	const { results } = status
		? await db
				.prepare("SELECT * FROM executions WHERE status = ?1 ORDER BY created_at ASC LIMIT 50")
				.bind(status)
				.all<ExecutionRow>()
		: await db.prepare("SELECT * FROM executions ORDER BY created_at ASC LIMIT 50").all<ExecutionRow>();
	return results ?? [];
}

export async function updateExecution(
	db: D1Database,
	executionId: string,
	patch: { status?: string; runId?: string | null; result?: unknown }
): Promise<void> {
	const sets: string[] = [];
	const values: unknown[] = [];
	if (patch.status !== undefined) {
		values.push(patch.status);
		sets.push(`status = ?${values.length}`);
	}
	if (patch.runId !== undefined) {
		values.push(patch.runId);
		sets.push(`run_id = ?${values.length}`);
	}
	if (patch.result !== undefined) {
		values.push(JSON.stringify(patch.result));
		sets.push(`result = ?${values.length}`);
	}
	if (sets.length === 0) return;
	sets.push("updated_at = ?");
	values.push(Date.now(), executionId);
	await db
		.prepare(`UPDATE executions SET ${sets.join(", ")} WHERE execution_id = ?`)
		.bind(...values)
		.run();
}

/* ── usage ──────────────────────────────────────────────────────────────── */

export async function bumpAgentUsage(
	db: D1Database,
	agentId: string,
	toolCalls: number,
	tokens: number
): Promise<void> {
	const date = new Date().toISOString().slice(0, 10);
	await db
		.prepare(
			`INSERT INTO agent_usage (usage_date, agent_id, tool_calls, tokens, updated_at)
			 VALUES (?1, ?2, ?3, ?4, ?5)
			 ON CONFLICT(usage_date, agent_id) DO UPDATE SET
				tool_calls = tool_calls + excluded.tool_calls,
				tokens = tokens + excluded.tokens,
				updated_at = excluded.updated_at`
		)
		.bind(date, agentId, toolCalls, tokens, Date.now())
		.run();
}

export async function getAgentUsage(
	db: D1Database,
	agentId: string,
	date?: string
): Promise<{ usage_date: string; agent_id: string; tool_calls: number; tokens: number } | null> {
	const day = date ?? new Date().toISOString().slice(0, 10);
	return db
		.prepare("SELECT * FROM agent_usage WHERE usage_date = ?1 AND agent_id = ?2")
		.bind(day, agentId)
		.first();
}

/* ── events ─────────────────────────────────────────────────────────────── */

export async function recordEvent(
	db: D1Database,
	event: {
		correlationId: string;
		type: string;
		agentId?: string | null;
		taskId?: string | null;
		payload?: unknown;
	}
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO events (ts, correlation_id, agent_id, task_id, type, payload)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
		)
		.bind(
			Date.now(),
			event.correlationId,
			event.agentId ?? null,
			event.taskId ?? null,
			event.type,
			event.payload === undefined ? null : JSON.stringify(event.payload)
		)
		.run();
}

export async function listEvents(
	db: D1Database,
	filter: { taskId?: string; agentId?: string; type?: string; limit?: number } = {}
): Promise<EventRow[]> {
	const clauses: string[] = [];
	const values: unknown[] = [];
	if (filter.taskId) {
		values.push(filter.taskId);
		clauses.push(`task_id = ?${values.length}`);
	}
	if (filter.agentId) {
		values.push(filter.agentId);
		clauses.push(`agent_id = ?${values.length}`);
	}
	if (filter.type) {
		values.push(filter.type);
		clauses.push(`type = ?${values.length}`);
	}
	const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
	values.push(Math.min(filter.limit ?? 100, 500));
	const { results } = await db
		.prepare(`SELECT * FROM events ${where} ORDER BY event_id DESC LIMIT ?${values.length}`)
		.bind(...values)
		.all<EventRow>();
	return results ?? [];
}
