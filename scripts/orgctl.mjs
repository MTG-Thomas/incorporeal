#!/usr/bin/env node
/**
 * orgctl — the operator's console for a deployed Incorporeal worker.
 *
 * A dependency-free Node CLI (Node 22+, ESM). It talks to the management API
 * described in src/api/routes.ts over HTTP and prints either aligned plain
 * text or, with --json, the raw server payload.
 *
 * Configuration:
 *   ORG_URL         base URL of the deployed worker (required)
 *   ORG_API_TOKEN   bearer token for the management API (required)
 *
 * --url and --token override the environment. The token is never printed.
 */

import process from "node:process";

/* ── configuration ──────────────────────────────────────────────────────── */

const DEFAULT_TIMEOUT_MS = 30_000;

const BOOLEAN_FLAGS = new Set(["json", "help"]);
const VALUE_FLAGS = new Set([
	"url",
	"token",
	"timeout",
	"status",
	"assignee",
	"goal",
	"task",
	"agent",
	"type",
	"name",
	"interval",
	"by",
	"title",
	"description",
	"to",
	"limit"
]);

/* ── tiny helpers ──────────────────────────────────────────────────────── */

function parseArgs(argv) {
	const flags = {};
	const positional = [];
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if (!token.startsWith("--")) {
			positional.push(token);
			continue;
		}
		const body = token.slice(2);
		const eq = body.indexOf("=");
		let name = eq === -1 ? body : body.slice(0, eq);
		let value = eq === -1 ? undefined : body.slice(eq + 1);
		if (BOOLEAN_FLAGS.has(name)) {
			flags[name] = true;
			continue;
		}
		if (!VALUE_FLAGS.has(name)) {
			throw new UsageError(`unknown option --${name}`);
		}
		if (value === undefined) {
			value = argv[++i];
			if (value === undefined) throw new UsageError(`option --${name} needs a value`);
		}
		flags[name] = value;
	}
	return { flags, positional };
}

function requireFlag(flags, name, hint) {
	const value = flags[name];
	if (value === undefined || value === "") {
		throw new UsageError(`--${name} is required${hint ? ` (${hint})` : ""}`);
	}
	return value;
}

function requirePositional(positional, index, name) {
	const value = positional[index];
	if (!value) throw new UsageError(`${name} is required`);
	return value;
}

function parseJsonField(value) {
	if (value === null || value === undefined) return null;
	if (typeof value !== "string") return value;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

function formatTime(ms) {
	if (ms === null || ms === undefined) return "-";
	if (typeof ms !== "number" || !Number.isFinite(ms)) return String(ms);
	const date = new Date(ms);
	if (Number.isNaN(date.getTime())) return String(ms);
	return date.toISOString().replace("T", " ").slice(0, 19);
}

function truncate(text, limit) {
	const value = String(text ?? "");
	if (value.length <= limit) return value;
	return `${value.slice(0, limit - 1)}…`;
}

function asArray(value) {
	if (value === null || value === undefined) return [];
	if (Array.isArray(value)) return value;
	return [value];
}

/* ── output ────────────────────────────────────────────────────────────── */

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

function paint(code, text) {
	return useColor ? `[${code}m${text}[0m` : String(text);
}
const bold = (text) => paint("1", text);
const dim = (text) => paint("2", text);
const red = (text) => paint("31", text);
const green = (text) => paint("32", text);
const yellow = (text) => paint("33", text);
const cyan = (text) => paint("36", text);

const STATUS_COLORS = {
	completed: green,
	succeeded: green,
	active: green,
	approved: green,
	running: cyan,
	assigned: cyan,
	pending: yellow,
	blocked: yellow,
	waiting: yellow,
	failed: red,
	cancelled: red,
	rejected: red,
	expired: red,
	retired: dim,
	disabled: dim
};

function colorStatus(status) {
	const key = String(status ?? "").toLowerCase();
	const painter = STATUS_COLORS[key];
	return painter ? painter(String(status)) : String(status ?? "-");
}

function write(text = "") {
	process.stdout.write(`${text}\n`);
}

/** Print an aligned table. */
function printTable(headers, rows) {
	if (rows.length === 0) {
		write(dim("  (none)"));
		return;
	}
	const widths = headers.map((header, index) =>
		Math.max(header.length, ...rows.map((row) => stripAnsi(String(row[index] ?? "")).length))
	);
	const line = (cells) =>
		"  " +
		cells
			.map((cell, index) => {
				const text = String(cell ?? "");
				const padding = widths[index] - stripAnsi(text).length;
				return text + " ".repeat(Math.max(0, padding));
			})
			.join("  ")
			.replace(/\s+$/, "");
	write(line(headers));
	write(dim("  " + widths.map((width) => "-".repeat(width)).join("  ")));
	for (const row of rows) write(line(row));
}

/** Length of a string without ANSI escape sequences. */
function stripAnsi(text) {
	// eslint-disable-next-line no-control-regex
	return String(text).replace(/\[[0-9;]*m/g, "");
}

function printField(label, value) {
	write(`  ${dim(label.padEnd(14))} ${value}`);
}

/* ── http ───────────────────────────────────────────────────────────────── */

class UsageError extends Error {}
class CliError extends Error {}

/**
 * Load `.env` from the working directory, if there is one.
 *
 * Node's own loader reads the file without adding a dependency, and it does
 * not overwrite variables that are already set, so an explicit environment
 * still wins.
 */
function loadEnvFile() {
	if (process.env.ORG_URL && process.env.ORG_API_TOKEN) return;
	try {
		process.loadEnvFile(".env");
	} catch {
		// No file, or none this Node can read. The flags and the environment
		// are still there.
	}
}

function resolveConfig(flags) {
	// A `.env` file in the working directory is loaded first, so a
	// deployment's URL and token do not have to be typed every time. The
	// environment still wins over the file, and the flags win over both.
	loadEnvFile();
	const rawUrl = flags.url ?? process.env.ORG_URL ?? "";
	const url = rawUrl.trim().replace(/\/+$/, "");
	const token = (flags.token ?? process.env.ORG_API_TOKEN ?? "").trim();
	if (!url) {
		throw new CliError(
			"No worker URL. Set ORG_URL (for example https://incorporeal.example.workers.dev) or pass --url."
		);
	}
	if (!token) {
		throw new CliError(
			"No API token. Set ORG_API_TOKEN or pass --token. The token is the management bearer token."
		);
	}
	let timeout = DEFAULT_TIMEOUT_MS;
	if (flags.timeout !== undefined) {
		timeout = Number(flags.timeout);
		if (!Number.isFinite(timeout) || timeout <= 0) {
			throw new UsageError("--timeout must be a positive number of milliseconds");
		}
	}
	return { url, token, timeout };
}

/**
 * Call the management API.
 *
 * Returns the parsed JSON body. A non-2xx response becomes a CliError that
 * carries the server's own message.
 */
async function api(config, method, path, body) {
	const target = `${config.url}${path}`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), config.timeout);
	let response;
	try {
		response = await fetch(target, {
			method,
			headers: {
				authorization: `Bearer ${config.token}`,
				accept: "application/json",
				...(body === undefined ? {} : { "content-type": "application/json" })
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: controller.signal
		});
	} catch (error) {
		if (controller.signal.aborted) {
			throw new CliError(`Request to ${target} timed out after ${config.timeout} ms.`);
		}
		const reason = error instanceof Error ? error.message : String(error);
		throw new CliError(`Could not reach ${target}: ${reason}`);
	} finally {
		clearTimeout(timer);
	}

	const text = await response.text();
	let payload = null;
	if (text) {
		try {
			payload = JSON.parse(text);
		} catch {
			payload = { raw: text };
		}
	}
	if (!response.ok) {
		const message =
			(payload && typeof payload === "object" && typeof payload.error === "string")
				? payload.error
				: `HTTP ${response.status} ${response.statusText}`.trim();
		throw new CliError(`${method} ${target} failed: ${message}`);
	}
	return payload;
}

function query(params) {
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
	}
	const text = search.toString();
	return text ? `?${text}` : "";
}

/* ── formatting ────────────────────────────────────────────────────────── */

function agentRow(record) {
	return [
		record.agent_id,
		record.role,
		record.status ? colorStatus(record.status) : "-",
		record.model ?? "-",
		record.successor_of ? `→ ${record.successor_of}` : "-",
		record.title ?? ""
	];
}

function taskRow(task) {
	return [
		task.task_id,
		task.kind,
		task.status ? colorStatus(task.status) : "-",
		task.assignee,
		task.goal_id ?? "-",
		task.title ?? ""
	];
}

function goalRow(goal) {
	return [
		goal.goal_id,
		goal.status ? colorStatus(goal.status) : "-",
		goal.owner_agent,
		goal.title ?? ""
	];
}

function obligationRow(obligation) {
	return [
		obligation.obligation_id,
		obligation.name,
		obligation.owner_agent,
		`${obligation.interval_seconds}s`,
		obligation.enabled ? "yes" : "no",
		obligation.last_run_at ? formatTime(obligation.last_run_at) : "never",
		obligation.next_run_at ? formatTime(obligation.next_run_at) : "-"
	];
}

function approvalRow(approval) {
	return [
		approval.approval_id,
		approval.status ? colorStatus(approval.status) : "-",
		approval.task_id ?? "-",
		approval.requested_by,
		approval.reason ?? "",
		describeAction(approval.requested_action)
	];
}

/** What an approval authorises, in the operator's words. */
function describeAction(raw) {
	if (!raw) return "(no action named)";
	let action;
	try {
		action = typeof raw === "string" ? JSON.parse(raw) : raw;
	} catch {
		return String(raw);
	}
	if (!action || typeof action.command !== "string") return "(no action named)";
	const parts = [action.command];
	if (Array.isArray(action.args) && action.args.length > 0) parts.push(action.args.join(" "));
	if (action.backend) parts.push(`via ${action.backend}`);
	if (action.repo) parts.push(`in ${action.repo}`);
	if (action.branch) parts.push(`on ${action.branch}`);
	return parts.join(" ");
}

function eventRow(event) {
	const payload = parseJsonField(event.payload);
	return [
		event.event_id,
		formatTime(event.ts),
		event.type,
		event.agent_id ?? "-",
		event.task_id ?? "-",
		truncate(payload === null ? "" : JSON.stringify(payload), 80)
	];
}

/** Pull the human-readable text out of a transcript entry. */
function entryText(entry) {
	if (typeof entry === "string") return entry;
	if (!entry || typeof entry !== "object") return JSON.stringify(entry);
	if (typeof entry.text === "string") return entry.text;
	const content = entry.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const parts = [];
		for (const part of content) {
			if (typeof part === "string") parts.push(part);
			else if (part && typeof part.text === "string") parts.push(part.text);
		}
		if (parts.length > 0) return parts.join("\n");
	}
	if (entry.message) return entryText(entry.message);
	return JSON.stringify(entry);
}

function entryRole(entry) {
	if (entry && typeof entry === "object" && typeof entry.role === "string") return entry.role;
	return "entry";
}

/* ── commands ──────────────────────────────────────────────────────────── */

async function commandAgents(config, flags) {
	const payload = await api(config, "GET", "/api/agents");
	const agents = asArray(payload?.agents);
	if (flags.json) return payload;
	printTable(["AGENT", "ROLE", "STATUS", "MODEL", "SUCCESSOR", "TITLE"], agents.map(agentRow));
	return payload;
}

async function commandAgent(config, flags, positional) {
	const agentId = requirePositional(positional, 0, "an agent id");
	const payload = await api(config, "GET", `/api/agents/${encodeURIComponent(agentId)}`);
	const taskPayload = await api(
		config,
		"GET",
		`/api/tasks${query({ assignee: agentId, limit: 100 })}`
	);
	const tasks = asArray(taskPayload?.tasks);
	if (flags.json) return { ...payload, tasks };
	const record = payload?.agent ?? {};
	const status = payload?.status ?? {};

	write(bold(`${record.title ?? agentId}`) + dim(`  ${agentId}`));
	printField("role", record.role ?? "-");
	printField("status", record.status ? colorStatus(record.status) : "-");
	printField("model", record.model ?? "-");
	printField("thinking", record.thinking_level ?? "-");
	printField("limits", `max_tool_calls=${record.max_tool_calls ?? "-"} max_tokens=${record.max_tokens ?? "-"}`);
	if (record.successor_of) printField("successor of", record.successor_of);
	printField("created", formatTime(record.created_at));

	const permissions = asArray(status.permissions ?? parseJsonField(record.permissions));
	printField("permissions", permissions.length > 0 ? permissions.join(", ") : dim("(none)"));

	write("");
	write(bold("Tasks"));
	printTable(
		["TASK", "KIND", "STATUS", "ASSIGNEE", "GOAL", "TITLE"],
		tasks.map(taskRow)
	);

	const pending = asArray(status.pendingOperations);
	write("");
	write(bold(`Pending operations (${pending.length})`));
	if (pending.length === 0) write(dim("  (none)"));
	else for (const operation of pending) write(`  ${typeof operation === "string" ? operation : JSON.stringify(operation)}`);

	const usage = status.usage ?? null;
	write("");
	write(bold("Usage"));
	if (usage && typeof usage === "object") {
		printField("input", usage.input ?? 0);
		printField("output", usage.output ?? 0);
		printField("cache read", usage.cacheRead ?? 0);
		printField("cache write", usage.cacheWrite ?? 0);
		printField("total tokens", usage.totalTokens ?? 0);
		if (usage.cost && typeof usage.cost === "object") {
			printField("cost", `$${Number(usage.cost.total ?? 0).toFixed(6)}`);
		}
	} else {
		write(dim("  (not reported)"));
	}

	write("");
	write(bold(`Transcript (${status.transcriptEntries ?? 0} entries, newest shown)`));
	const preview = status.transcriptPreview;
	let entries = [];
	if (typeof preview === "string" && preview) {
		try {
			entries = asArray(JSON.parse(preview));
		} catch {
			entries = [preview];
		}
	} else {
		entries = asArray(preview);
	}
	if (entries.length === 0) write(dim("  (empty)"));
	for (const entry of entries) {
		write(`  ${dim(entryRole(entry))}: ${truncate(entryText(entry), 400).replace(/\n/g, "\n    ")}`);
	}
	return payload;
}

async function commandGoals(config, flags) {
	const payload = await api(config, "GET", "/api/goals");
	if (flags.json) return payload;
	printTable(["GOAL", "STATUS", "OWNER", "TITLE"], asArray(payload?.goals).map(goalRow));
	return payload;
}

async function commandGoal(config, flags, positional) {
	const goalId = requirePositional(positional, 0, "a goal id");
	const payload = await api(config, "GET", `/api/goals/${encodeURIComponent(goalId)}`);
	if (flags.json) return payload;
	const goal = payload?.goal ?? {};
	const tasks = asArray(payload?.tasks);
	write(bold(goal.title ?? goalId));
	printField("goal id", goal.goal_id ?? goalId);
	printField("status", goal.status ? colorStatus(goal.status) : "-");
	printField("owner", goal.owner_agent ?? "-");
	printField("created", formatTime(goal.created_at));
	write("");
	write(bold("Description"));
	write(`  ${goal.description || dim("(none)")}`);
	write("");
	write(bold(`Tasks (${tasks.length})`));
	printTable(["TASK", "KIND", "STATUS", "ASSIGNEE", "GOAL", "TITLE"], tasks.map(taskRow));
	return payload;
}

async function commandTasks(config, flags) {
	const payload = await api(
		config,
		"GET",
		`/api/tasks${query({
			status: flags.status,
			assignee: flags.assignee,
			goal: flags.goal,
			limit: flags.limit ?? 100
		})}`
	);
	if (flags.json) return payload;
	const tasks = asArray(payload?.tasks);
	printTable(["TASK", "KIND", "STATUS", "ASSIGNEE", "GOAL", "TITLE"], tasks.map(taskRow));
	return payload;
}

async function commandTask(config, flags, positional) {
	const taskId = requirePositional(positional, 0, "a task id");
	const payload = await api(config, "GET", `/api/tasks/${encodeURIComponent(taskId)}`);
	const eventsPayload = await api(config, "GET", `/api/tasks/${encodeURIComponent(taskId)}/events`);
	const events = asArray(eventsPayload?.events);
	if (flags.json) return { ...payload, events };
	const task = payload?.task ?? {};
	write(bold(task.title ?? taskId));
	printField("task id", task.task_id ?? taskId);
	printField("kind", task.kind ?? "-");
	printField("status", task.status ? colorStatus(task.status) : "-");
	printField("assignee", task.assignee ?? "-");
	printField("created by", task.created_by ?? "-");
	printField("goal", task.goal_id ?? "-");
	printField("attempt", `${task.attempt ?? 0}/${task.max_attempts ?? 0}`);
	printField("tool calls", task.tool_calls ?? 0);
	printField("tokens", task.tokens ?? 0);
	printField("deadline", task.deadline_at ? formatTime(task.deadline_at) : "-");
	printField("started", task.started_at ? formatTime(task.started_at) : "-");
	printField("completed", task.completed_at ? formatTime(task.completed_at) : "-");
	if (task.requires_approval) printField("approval", task.approval_id ?? "required");

	write("");
	write(bold("Instruction"));
	write(`  ${task.instruction || dim("(none)")}`);

	write("");
	write(bold("Result"));
	const result = parseJsonField(task.result);
	write(result === null ? dim("  (none)") : `  ${JSON.stringify(result, null, 2).split("\n").join("\n  ")}`);

	write("");
	write(bold("Artifact"));
	const artifact = parseJsonField(task.artifact);
	write(artifact === null ? dim("  (none)") : `  ${JSON.stringify(artifact, null, 2).split("\n").join("\n  ")}`);

	write("");
	write(bold(`Events (${events.length})`));
	printTable(["ID", "WHEN", "TYPE", "AGENT", "TASK", "PAYLOAD"], events.map(eventRow));
	return { task: payload, events: eventsPayload };
}

async function commandEvents(config, flags) {
	// The server filters, so the log is not truncated to the recent window
	// before the filters are applied.
	const query = new URLSearchParams();
	if (flags.task) query.set("task", flags.task);
	if (flags.agent) query.set("agent", flags.agent);
	if (flags.type) query.set("type", flags.type);
	const suffix = query.toString() ? `?${query}` : "";
	const payload = await api(config, "GET", `/api/events${suffix}`);
	if (flags.json) return payload;
	const events = asArray(payload?.events);
	printTable(["ID", "WHEN", "TYPE", "AGENT", "TASK", "PAYLOAD"], events.map(eventRow));
	return payload;
}

async function commandObligations(config, flags) {
	const payload = await api(config, "GET", "/api/obligations");
	if (flags.json) return payload;
	printTable(
		["OBLIGATION", "NAME", "OWNER", "EVERY", "ON", "LAST RUN", "NEXT RUN"],
		asArray(payload?.obligations).map(obligationRow)
	);
	return payload;
}

async function commandObligationAdd(config, flags) {
	const name = requireFlag(flags, "name", "the obligation name");
	let intervalSeconds = 900;
	if (flags.interval !== undefined) {
		intervalSeconds = Number(flags.interval);
		if (!Number.isFinite(intervalSeconds) || intervalSeconds < 60) {
			throw new UsageError("--interval must be at least 60 seconds");
		}
	}
	const payload = await api(config, "POST", "/api/obligations", { name, intervalSeconds });
	if (flags.json) return payload;
	const obligation = payload?.obligation ?? {};
	write(`${green("created")} obligation ${bold(obligation.obligation_id ?? "?")}: ${obligation.name ?? name}`);
	printField("every", `${obligation.interval_seconds ?? intervalSeconds}s`);
	printField("owner", obligation.owner_agent ?? "-");
	return payload;
}

async function commandApprovals(config, flags) {
	const payload = await api(config, "GET", "/api/approvals");
	if (flags.json) return payload;
	printTable(
		["APPROVAL", "STATUS", "TASK", "REQUESTED BY", "REASON", "AUTHORISES"],
		asArray(payload?.approvals).map(approvalRow)
	);
	return payload;
}

async function commandDecide(config, flags, positional, decision) {
	const approvalId = requirePositional(positional, 0, "an approval id");
	const decidedBy = flags.by ?? "operator";
	const payload = await api(config, "POST", `/api/approvals/${encodeURIComponent(approvalId)}`, {
		decision,
		decidedBy
	});
	if (flags.json) return payload;
	const approval = payload?.approval ?? {};
	write(`${green(decision === "approve" ? "approved" : "rejected")} ${bold(approval.approval_id ?? approvalId)}`);
	printField("status", approval.status ? colorStatus(approval.status) : "-");
	printField("decided by", approval.decided_by ?? decidedBy);
	printField("task", approval.task_id ?? "-");
	return payload;
}

async function commandNote(config, flags, positional) {
	const agentId = requirePositional(positional, 0, "an agent id");
	const text = requirePositional(positional, 1, "a message");
	const payload = await api(config, "POST", `/api/agents/${encodeURIComponent(agentId)}/note`, { text });
	if (flags.json) return payload;
	write(`${green("sent")} to ${bold(agentId)}`);
	printField("operation", payload?.operationId ?? "-");
	printField("accepted", payload?.accepted ? "yes" : "no");
	return payload;
}

async function commandGoalAdd(config, flags) {
	const title = requireFlag(flags, "title", "the goal title");
	const description = flags.description ?? "";
	const payload = await api(config, "POST", "/api/goals", { title, description });
	if (flags.json) return payload;
	const goal = payload?.goal ?? {};
	write(`${green("created")} goal ${bold(goal.goal_id ?? "?")}: ${goal.title ?? title}`);
	printField("owner", goal.owner_agent ?? "-");
	if (payload?.delegation) {
		write("");
		write(bold("Delegation"));
		write(`  ${JSON.stringify(payload.delegation, null, 2).split("\n").join("\n  ")}`);
	}
	return payload;
}

async function commandSweep(config, flags) {
	const payload = await api(config, "GET", "/api/sweep");
	if (flags.json) return payload;
	write(bold("Sweep result"));
	write(`  ${JSON.stringify(payload, null, 2).split("\n").join("\n  ")}`);
	return payload;
}

async function commandSuccessor(config, flags, positional) {
	const agentId = requirePositional(positional, 0, "an agent id");
	const successorId = requireFlag(flags, "to", "the successor agent id");
	const payload = await api(config, "POST", `/api/agents/${encodeURIComponent(agentId)}/successor`, {
		successorId
	});
	if (flags.json) return payload;
	const successor = payload?.successor ?? {};
	const moved = asArray(payload?.movedTasks);
	write(`${green("replaced")} ${bold(agentId)} with ${bold(successor.agent_id ?? successorId)}`);
	printField("role", successor.role ?? "-");
	printField("moved tasks", moved.length > 0 ? moved.join(", ") : "(none)");
	return payload;
}

/* ── dispatch ──────────────────────────────────────────────────────────── */

const COMMANDS = {
	agents: {
		summary: "list the agents",
		usage: "orgctl agents",
		run: (config, flags) => commandAgents(config, flags)
	},
	agent: {
		summary: "show one agent: record, permissions, tasks, operations, usage, transcript",
		usage: "orgctl agent <id>",
		run: (config, flags, positional) => commandAgent(config, flags, positional)
	},
	goals: {
		summary: "list the goals",
		usage: "orgctl goals",
		run: (config, flags) => commandGoals(config, flags)
	},
	goal: {
		summary: "show one goal and its tasks",
		usage: "orgctl goal <id>",
		run: (config, flags, positional) => commandGoal(config, flags, positional)
	},
	tasks: {
		summary: "list the tasks (--status, --assignee, --goal)",
		usage: "orgctl tasks [--status <s>] [--assignee <id>] [--goal <id>]",
		run: (config, flags) => commandTasks(config, flags)
	},
	task: {
		summary: "show one task, with its result and artifact",
		usage: "orgctl task <id>",
		run: (config, flags, positional) => commandTask(config, flags, positional)
	},
	events: {
		summary: "show the event log (--task, --agent, --type)",
		usage: "orgctl events [--task <id>] [--agent <id>] [--type <t>]",
		run: (config, flags) => commandEvents(config, flags)
	},
	obligations: {
		summary: "list the obligations",
		usage: "orgctl obligations",
		run: (config, flags) => commandObligations(config, flags)
	},
	"obligation-add": {
		summary: "create a recurring obligation",
		usage: "orgctl obligation-add --name <n> [--interval <seconds>]",
		run: (config, flags) => commandObligationAdd(config, flags)
	},
	approvals: {
		summary: "list the approval requests",
		usage: "orgctl approvals",
		run: (config, flags) => commandApprovals(config, flags)
	},
	approve: {
		summary: "approve a pending approval",
		usage: "orgctl approve <approval-id> [--by <name>]",
		run: (config, flags, positional) => commandDecide(config, flags, positional, "approve")
	},
	reject: {
		summary: "reject a pending approval",
		usage: "orgctl reject <approval-id> [--by <name>]",
		run: (config, flags, positional) => commandDecide(config, flags, positional, "reject")
	},
	note: {
		summary: "send a message to an agent",
		usage: "orgctl note <agent-id> <text>",
		run: (config, flags, positional) => commandNote(config, flags, positional)
	},
	"goal-add": {
		summary: "create a goal, which makes the coordinator delegate work",
		usage: "orgctl goal-add --title <t> --description <d>",
		run: (config, flags) => commandGoalAdd(config, flags)
	},
	sweep: {
		summary: "ask the coordinator to run its obligations and check for stalled work",
		usage: "orgctl sweep",
		run: (config, flags) => commandSweep(config, flags)
	},
	successor: {
		summary: "replace an agent with a successor that inherits its duties",
		usage: "orgctl successor <agent-id> --to <new-id>",
		run: (config, flags, positional) => commandSuccessor(config, flags, positional)
	}
};

function printHelp() {
	write(bold("orgctl") + dim(" — the operator's console for an Incorporeal worker"));
	write("");
	write(bold("Usage"));
	write("  node scripts/orgctl.mjs <command> [options]");
	write("");
	write(bold("Commands"));
	for (const [name, command] of Object.entries(COMMANDS)) {
		write(`  ${name.padEnd(16)} ${command.summary}`);
	}
	write("");
	write(bold("Options"));
	write("  --url <url>       base URL of the worker (default: $ORG_URL)");
	write("  --token <token>   management bearer token (default: $ORG_API_TOKEN)");
	write("  --timeout <ms>    request timeout in milliseconds (default: 30000)");
	write("  --json            print the raw server payload as JSON");
	write("  --help            show this help");
	write("");
	write(bold("Environment"));
	write("  ORG_URL           base URL of the deployed worker");
	write("  ORG_API_TOKEN     bearer token for the management API");
	write("");
	write(dim("The token is never printed."));
}

async function main(argv) {
	const { flags, positional } = parseArgs(argv);
	const commandName = positional.shift();

	if (!commandName || flags.help) {
		printHelp();
		return 0;
	}

	const command = COMMANDS[commandName];
	if (!command) {
		throw new UsageError(`unknown command "${commandName}". Run with --help for the command list.`);
	}

	const config = resolveConfig(flags);
	const result = await command.run(config, flags, positional);
	if (flags.json && result !== undefined) {
		write(JSON.stringify(result, null, 2));
	}
	return 0;
}

/* ── entry point ───────────────────────────────────────────────────────── */

process.on("unhandledRejection", (reason) => {
	process.stderr.write(`orgctl: unexpected failure: ${reason instanceof Error ? reason.message : String(reason)}\n`);
	process.exit(1);
});

try {
	const code = await main(process.argv.slice(2));
	process.exit(code);
} catch (error) {
	if (error instanceof UsageError) {
		process.stderr.write(`orgctl: ${error.message}\n`);
		process.exit(2);
	}
	if (error instanceof CliError) {
		process.stderr.write(`orgctl: ${error.message}\n`);
		process.exit(1);
	}
	process.stderr.write(`orgctl: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
	process.exit(1);
}
