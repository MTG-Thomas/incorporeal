-- Incorporeal shared operational state (D1).
--
-- D1 holds only what must be shared or queried across agents: identities,
-- goals, tasks, obligations, approvals, shared knowledge, external execution
-- records and the event log. Agent-private working state (transcript, inbox,
-- checkpoints) lives in each agent's Durable Object SQLite database, owned by
-- pi-durable.

CREATE TABLE IF NOT EXISTS agents (
	agent_id        TEXT PRIMARY KEY,
	role            TEXT NOT NULL,
	title           TEXT NOT NULL,
	status          TEXT NOT NULL DEFAULT 'active',   -- active | retired | blocked
	model           TEXT,
	thinking_level  TEXT,
	permissions     TEXT NOT NULL DEFAULT '[]',        -- JSON array of permission names
	max_tool_calls  INTEGER NOT NULL DEFAULT 20,       -- per task
	max_tokens      INTEGER NOT NULL DEFAULT 120000,   -- per task
	successor_of    TEXT,
	created_at      INTEGER NOT NULL,
	updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS goals (
	goal_id      TEXT PRIMARY KEY,
	title        TEXT NOT NULL,
	description  TEXT NOT NULL,
	owner_agent  TEXT NOT NULL,
	status       TEXT NOT NULL DEFAULT 'active',        -- active | achieved | blocked | paused
	created_at   INTEGER NOT NULL,
	updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
	task_id          TEXT PRIMARY KEY,
	goal_id          TEXT,
	kind             TEXT NOT NULL,                     -- investigate | review | apply | research
	title            TEXT NOT NULL,
	instruction      TEXT NOT NULL,
	assignee         TEXT NOT NULL,
	created_by       TEXT NOT NULL,
	status           TEXT NOT NULL,                     -- pending | assigned | running | blocked | completed | failed | cancelled
	attempt          INTEGER NOT NULL DEFAULT 0,
	max_attempts     INTEGER NOT NULL DEFAULT 2,
	depth            INTEGER NOT NULL DEFAULT 0,
	parent_task_id   TEXT,
	review_of_task_id TEXT,
	dedupe_key       TEXT,                              -- one task per key, e.g. apply:<review id>
	fingerprint      TEXT,                              -- dedupe key for findings
	deadline_at      INTEGER,
	requires_approval INTEGER NOT NULL DEFAULT 0,
	approval_id      TEXT,
	result           TEXT,                              -- JSON
	artifact         TEXT,                              -- JSON
	tool_calls       INTEGER NOT NULL DEFAULT 0,
	tokens           INTEGER NOT NULL DEFAULT 0,
	correlation_id   TEXT NOT NULL,
	created_at       INTEGER NOT NULL,
	updated_at       INTEGER NOT NULL,
	started_at       INTEGER,
	completed_at     INTEGER
);

-- One open review per source task: a replayed delegation cannot create a second reviewer.
CREATE UNIQUE INDEX IF NOT EXISTS tasks_review_of_unique
	ON tasks(review_of_task_id) WHERE review_of_task_id IS NOT NULL;
-- One open task per finding: a recurring obligation cannot stack duplicate work.
CREATE UNIQUE INDEX IF NOT EXISTS tasks_fingerprint_unique
	ON tasks(fingerprint) WHERE fingerprint IS NOT NULL;
-- One task per step of a chain: a replayed handoff cannot stack a second
-- apply step or a second round of rework.
CREATE UNIQUE INDEX IF NOT EXISTS tasks_dedupe_unique
	ON tasks(dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS tasks_assignee_status ON tasks(assignee, status);
CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS tasks_goal ON tasks(goal_id);
CREATE INDEX IF NOT EXISTS tasks_created ON tasks(created_at);

CREATE TABLE IF NOT EXISTS obligations (
	obligation_id    TEXT PRIMARY KEY,
	name             TEXT NOT NULL,
	owner_agent      TEXT NOT NULL,
	kind             TEXT NOT NULL,                    -- interval
	interval_seconds INTEGER NOT NULL,
	check_spec       TEXT NOT NULL,                    -- JSON check spec
	enabled          INTEGER NOT NULL DEFAULT 1,
	last_run_at      INTEGER,
	next_run_at      INTEGER,
	running_until    INTEGER,                          -- lock: prevents overlapping runs
	state            TEXT,                             -- JSON, e.g. last finding fingerprint
	created_at       INTEGER NOT NULL,
	updated_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
	approval_id  TEXT PRIMARY KEY,
	task_id      TEXT,
	requested_by TEXT NOT NULL,
	reason       TEXT NOT NULL,
	status       TEXT NOT NULL DEFAULT 'pending',      -- pending | approved | rejected | expired
	decided_by   TEXT,
	decided_at   INTEGER,
	created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge (
	knowledge_id TEXT PRIMARY KEY,
	kind         TEXT NOT NULL,                        -- decision | convention | finding
	title        TEXT NOT NULL,
	body         TEXT NOT NULL,
	author_agent TEXT NOT NULL,
	task_id      TEXT,
	created_at   INTEGER NOT NULL,
	updated_at   INTEGER NOT NULL
);

-- Every externally consequential action, keyed for idempotent replay.
CREATE TABLE IF NOT EXISTS executions (
	execution_id    TEXT PRIMARY KEY,
	task_id         TEXT NOT NULL,
	idempotency_key TEXT NOT NULL,
	backend         TEXT NOT NULL,
	spec            TEXT NOT NULL,                     -- JSON
	status          TEXT NOT NULL,                     -- submitted | succeeded | failed
	run_id          TEXT,
	result          TEXT,
	created_at      INTEGER NOT NULL,
	updated_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS executions_idempotency ON executions(idempotency_key);

-- Per-agent daily spend, so a Free-tier allocation can be exhausted gracefully.
CREATE TABLE IF NOT EXISTS agent_usage (
	usage_date TEXT NOT NULL,
	agent_id   TEXT NOT NULL,
	tool_calls INTEGER NOT NULL DEFAULT 0,
	tokens     INTEGER NOT NULL DEFAULT 0,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (usage_date, agent_id)
);

CREATE TABLE IF NOT EXISTS events (
	event_id      INTEGER PRIMARY KEY AUTOINCREMENT,
	ts            INTEGER NOT NULL,
	correlation_id TEXT NOT NULL,
	agent_id      TEXT,
	task_id       TEXT,
	type          TEXT NOT NULL,
	payload       TEXT
);
CREATE INDEX IF NOT EXISTS events_task ON events(task_id);
CREATE INDEX IF NOT EXISTS events_agent ON events(agent_id, ts);
CREATE INDEX IF NOT EXISTS events_type ON events(type, ts);
