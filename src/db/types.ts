/** Row shapes for the shared operational store (D1). */

export type AgentStatus = "active" | "retired" | "blocked";
export type TaskStatus =
	| "pending"
	| "assigned"
	| "running"
	| "blocked"
	| "completed"
	| "failed"
	| "cancelled";
export type GoalStatus = "active" | "achieved" | "blocked" | "paused";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";
export type KnowledgeKind = "decision" | "convention" | "finding";
export type ExecutionStatus = "pending" | "submitted" | "succeeded" | "failed";

export type AgentRow = {
	agent_id: string;
	role: string;
	title: string;
	status: AgentStatus;
	model: string | null;
	thinking_level: string | null;
	permissions: string;
	max_tool_calls: number;
	max_tokens: number;
	successor_of: string | null;
	created_at: number;
	updated_at: number;
};

export type GoalRow = {
	goal_id: string;
	title: string;
	description: string;
	owner_agent: string;
	status: GoalStatus;
	created_at: number;
	updated_at: number;
};

export type TaskRow = {
	task_id: string;
	goal_id: string | null;
	kind: string;
	title: string;
	instruction: string;
	assignee: string;
	created_by: string;
	status: TaskStatus;
	attempt: number;
	max_attempts: number;
	depth: number;
	parent_task_id: string | null;
	review_of_task_id: string | null;
	dedupe_key: string | null;
	fingerprint: string | null;
	deadline_at: number | null;
	requires_approval: number;
	approval_id: string | null;
	result: string | null;
	artifact: string | null;
	tool_calls: number;
	tokens: number;
	correlation_id: string;
	created_at: number;
	updated_at: number;
	started_at: number | null;
	completed_at: number | null;
};

export type ObligationRow = {
	obligation_id: string;
	name: string;
	owner_agent: string;
	kind: string;
	interval_seconds: number;
	check_spec: string;
	enabled: number;
	last_run_at: number | null;
	next_run_at: number | null;
	running_until: number | null;
	state: string | null;
	created_at: number;
	updated_at: number;
};

export type ApprovalRow = {
	approval_id: string;
	task_id: string | null;
	requested_by: string;
	reason: string;
	/** The action this approval authorises, as JSON. */
	requested_action: string | null;
	status: ApprovalStatus;
	decided_by: string | null;
	decided_at: number | null;
	created_at: number;
};

export type KnowledgeRow = {
	knowledge_id: string;
	kind: KnowledgeKind;
	title: string;
	body: string;
	author_agent: string;
	task_id: string | null;
	created_at: number;
	updated_at: number;
};

export type ExecutionRow = {
	execution_id: string;
	task_id: string;
	idempotency_key: string;
	backend: string;
	spec: string;
	status: ExecutionStatus;
	run_id: string | null;
	result: string | null;
	created_at: number;
	updated_at: number;
};

export type EventRow = {
	event_id: number;
	ts: number;
	correlation_id: string;
	agent_id: string | null;
	task_id: string | null;
	type: string;
	payload: string | null;
};
