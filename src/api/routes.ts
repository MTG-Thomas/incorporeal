/**
 * The management API.
 *
 * Every route here is authenticated with the management token. The API is the
 * only way a human drives the organization; the agents drive each other
 * through the shared store and the Durable Object RPC surface, which is not
 * reachable from outside.
 */
import { findAgentByRole, getAgent, getApproval, getGoal, listAgents, listApprovals, listEvents, listGoals, listKnowledge, listObligations, listTasks, createGoal, createObligation, decideApproval, getTask, recordEvent, upsertAgent } from "../db/org.ts";
import { defaultPermissionsForRole } from "../policy/permissions.ts";
import { describeCredentials, putCredential, removeCredential } from "../agents/credentials.ts";
import {
	accessIdentity,
	callerName,
	type Caller,
	isAllowed,
	isWebhookAuthorized,
	unauthorized,
	forbidden
} from "../auth.ts";
import type { Env } from "../env.ts";
import { describeError, logError, logInfo } from "../logging.ts";
import type { TaskRow } from "../db/types.ts";

type Json = Record<string, unknown>;

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value, null, 2), {
		status,
		headers: { "content-type": "application/json" }
	});
}

function badRequest(message: string): Response {
	return json({ error: message }, 400);
}

function notFound(message: string): Response {
	return json({ error: message }, 404);
}

/** The largest request body the API reads. */
const MAX_BODY_BYTES = 64 * 1024;

async function readJson(request: Request): Promise<Json> {
	try {
		const text = await request.text();
		if (text.length > MAX_BODY_BYTES) {
			throw new Error(`the request body is larger than ${MAX_BODY_BYTES} bytes`);
		}
		const body: unknown = JSON.parse(text);
		if (body && typeof body === "object") return body as Json;
		return {};
	} catch {
		return {};
	}
}

/** The stub of one agent's Durable Object. */
function agentStub(env: Env, agentId: string) {
	return env.ORG_AGENTS.getByName(agentId);
}

/** The id of the agent that currently holds a role. */
async function agentIdForRole(env: Env, role: string): Promise<string | null> {
	const row = await findAgentByRole(env.ORG_DB, role);
	return row?.agent_id ?? null;
}

/**
 * Handle one request.
 *
 * Returns `undefined` when the path is not part of the API, so the worker can
 * fall through to other handling.
 */
export async function handleApi(
	request: Request,
	env: Env,
	url: URL,
	ctx?: ExecutionContext
): Promise<Response | undefined> {
	const path = url.pathname;
	if (!path.startsWith("/api/") && path !== "/api") return undefined;

	// Who is calling? When Cloudflare Access is in front of the Worker, it
	// has already decided the request is authenticated, and it knows who.
	const caller = ctx ? await accessIdentity(ctx) : null;

	if (path === "/api/health") {
		return json({ status: "ok", env: env.ORG_ENV });
	}

	// Webhooks have their own credential and are checked before the
	// management token, because an external system does not hold that one.
	if (path.startsWith("/api/webhooks/")) {
		if (!isWebhookAuthorized(request, env)) return unauthorized();
		return handleWebhook(request, env, path);
	}

	if (!isAllowed(caller, request, env)) {
		return caller && !caller.isService ? forbidden("this identity is not allowed") : unauthorized();
	}

	const segments = path.split("/").filter(Boolean); // ["api", ...]
	const [, resource, id, action] = segments;
	// The caller, for the routes that record who did something.
	const operator = callerName(caller, undefined);

	switch (resource) {
		case "agents":
			return handleAgents(request, env, id, action);
		case "goals":
			return handleGoals(request, env, id);
		case "tasks":
			return handleTasks(request, env, id, action);
		case "events": {
			const events = await listEvents(env.ORG_DB, {
				taskId: url.searchParams.get("task") ?? undefined,
				agentId: url.searchParams.get("agent") ?? undefined,
				type: url.searchParams.get("type") ?? undefined,
				limit: Number(url.searchParams.get("limit") ?? 200)
			});
			return json({ events });
		}
		case "obligations":
			return handleObligations(request, env, id, action);
		case "approvals":
			return handleApprovals(request, env, id, caller);
		case "knowledge":
			return json({ knowledge: await listKnowledge(env.ORG_DB, 100) });
		case "providers":
			return handleProviders(request, env, segments);
		case "sweep": {
			// Both verbs work: the sweep is idempotent, and a GET is easier to
			// paste into a browser.
			if (request.method !== "GET" && request.method !== "POST") {
				return badRequest("use GET or POST to run a sweep");
			}
			const coordinatorId = await agentIdForRole(env, "coordinator");
			if (!coordinatorId) return badRequest("no coordinator is registered");
			return json(await agentStub(env, coordinatorId).runSweep());
		}
		default:
			return notFound(`no such resource: ${resource ?? ""}`);
	}
}

/* ── agents ─────────────────────────────────────────────────────────────── */

async function handleAgents(
	request: Request,
	env: Env,
	agentId: string | undefined,
	action: string | undefined
): Promise<Response> {
	if (!agentId) {
		const agents = await listAgents(env.ORG_DB);
		return json({ agents });
	}

	if (action === "note" && request.method === "POST") {
		if (!(await getAgent(env.ORG_DB, agentId))) return notFound(`no such agent: ${agentId}`);
		const body = await readJson(request);
		const text = typeof body.text === "string" ? body.text.slice(0, 20_000) : "";
		if (!text) return badRequest("text is required");
		const operationId = typeof body.operationId === "string" ? body.operationId : undefined;
		const receipt = await agentStub(env, agentId).note(text, operationId);
		return json(receipt);
	}

	if (action === "successor" && request.method === "POST") {
		return handleSuccessor(request, env, agentId);
	}

	const row = await getAgent(env.ORG_DB, agentId);
	if (!row) return notFound(`no such agent: ${agentId}`);
	const status = await agentStub(env, agentId).status();
	return json({ agent: row, status });
}

/**
 * Replace an agent with a successor.
 *
 * The successor inherits the role, the permissions, the budgets and the open
 * obligations of the agent it replaces, and starts with an empty working
 * memory: the organizational commitments move, the transcript does not.
 */
async function handleSuccessor(request: Request, env: Env, agentId: string): Promise<Response> {
	const body = await readJson(request);
	const successorId = typeof body.successorId === "string" ? body.successorId.trim() : "";
	if (!successorId) return badRequest("successorId is required");
	if (successorId === agentId) return badRequest("an agent cannot succeed itself");

	const previous = await getAgent(env.ORG_DB, agentId);
	if (!previous) return notFound(`no such agent: ${agentId}`);
	if (await getAgent(env.ORG_DB, successorId)) {
		return badRequest(`agent ${successorId} already exists`);
	}

	const successor = await upsertAgent(env.ORG_DB, {
		agentId: successorId,
		role: previous.role,
		title: body.title ? String(body.title) : previous.title,
		permissions: previous.permissions ? (JSON.parse(previous.permissions) as string[]) : defaultPermissionsForRole(previous.role),
		model: previous.model,
		thinkingLevel: previous.thinking_level,
		maxToolCalls: previous.max_tool_calls,
		maxTokens: previous.max_tokens,
		successorOf: agentId
	});
	await upsertAgent(env.ORG_DB, {
		agentId: previous.agent_id,
		role: previous.role,
		title: previous.title,
		status: "retired",
		model: previous.model,
		thinkingLevel: previous.thinking_level,
		permissions: previous.permissions ? (JSON.parse(previous.permissions) as string[]) : [],
		maxToolCalls: previous.max_tool_calls,
		maxTokens: previous.max_tokens,
		successorOf: previous.successor_of
	});

	// Move the organizational commitments, not the working memory.
	await env.ORG_DB.prepare("UPDATE obligations SET owner_agent = ?1, updated_at = ?2 WHERE owner_agent = ?3")
		.bind(successorId, Date.now(), agentId)
		.run();
	await env.ORG_DB.prepare("UPDATE goals SET owner_agent = ?1, updated_at = ?2 WHERE owner_agent = ?3")
		.bind(successorId, Date.now(), agentId)
		.run();
	const open = await listTasks(env.ORG_DB, { assignee: agentId, status: ["pending", "assigned", "running"] });
	for (const task of open) {
		await env.ORG_DB.prepare("UPDATE tasks SET assignee = ?1, updated_at = ?2 WHERE task_id = ?3")
			.bind(successorId, Date.now(), task.task_id)
			.run();
	}

	await recordEvent(env.ORG_DB, {
		correlationId: `cor_${successorId}`,
		agentId: successorId,
		type: "agent.replaced",
		payload: { previous_agent: agentId, successor: successorId, moved_tasks: open.map((t) => t.task_id) }
	});
	logInfo("agent replaced", { agentId: successorId, previousAgent: agentId });

	// The successor starts with a handoff note, not the predecessor's transcript.
	try {
		await agentStub(env, successorId).note(
			[
				`You have taken over from ${agentId} (${previous.role}).`,
				`You inherit ${open.length} open task(s) and the obligations of ${agentId}.`,
				"You start with an empty working memory: read the shared store for the state of the organization."
			].join(" "),
			`handoff:${successorId}`
		);
	} catch (error) {
		logError("could not deliver the handoff note", {
			agentId: successorId,
			error: describeError(error)
		});
	}

	return json({ successor, movedTasks: open.map((task) => task.task_id) });
}

/* ── goals ──────────────────────────────────────────────────────────────── */

async function handleGoals(request: Request, env: Env, goalId: string | undefined): Promise<Response> {
	if (request.method === "POST" && !goalId) {
		const body = await readJson(request);
		const title = typeof body.title === "string" ? body.title.trim() : "";
		const description = typeof body.description === "string" ? body.description : "";
		if (!title) return badRequest("title is required");
		const coordinatorId = await agentIdForRole(env, "coordinator");
		if (!coordinatorId) return badRequest("no coordinator is registered");
		const goal = await createGoal(env.ORG_DB, {
			title,
			description,
			ownerAgent: coordinatorId
		});
		await recordEvent(env.ORG_DB, {
			correlationId: `cor_${goal.goal_id}`,
			agentId: coordinatorId,
			type: "goal.created",
			payload: { goal_id: goal.goal_id, title }
		});
		const result = await agentStub(env, coordinatorId).onGoalCreated(goal.goal_id);
		return json({ goal, delegation: result }, 201);
	}
	if (goalId) {
		const goal = await getGoal(env.ORG_DB, goalId);
		if (!goal) return notFound(`no such goal: ${goalId}`);
		const tasks = await listTasks(env.ORG_DB, { goalId });
		return json({ goal, tasks });
	}
	return json({ goals: await listGoals(env.ORG_DB) });
}

/* ── tasks ──────────────────────────────────────────────────────────────── */

async function handleTasks(
	request: Request,
	env: Env,
	taskId: string | undefined,
	action: string | undefined
): Promise<Response> {
	if (!taskId) {
		const url = new URL(request.url);
		const tasks = await listTasks(env.ORG_DB, {
			assignee: url.searchParams.get("assignee") ?? undefined,
			status: (url.searchParams.get("status") ?? undefined) as never,
			goalId: url.searchParams.get("goal") ?? undefined,
			limit: Number(url.searchParams.get("limit") ?? 50)
		});
		return json({ tasks });
	}
	const task = await getTask(env.ORG_DB, taskId);
	if (!task) return notFound(`no such task: ${taskId}`);
	if (action === "events") {
		return json({ task, events: await listEvents(env.ORG_DB, { taskId }) });
	}
	return json({ task });
}

/* ── provider credentials ───────────────────────────────────────────────── */

/**
 * The credentials the organization holds for its model providers.
 *
 * Reading returns **metadata only**: which providers are configured, of what
 * kind, and when they last changed. The credential itself is never returned
 * by the API — it is a secret, and the only thing that needs it is the agent
 * that is about to call the provider.
 *
 * The routes are `/api/providers/credentials` and
 * `/api/providers/credentials/{provider}`.
 */
async function handleProviders(
	request: Request,
	env: Env,
	segments: readonly string[]
): Promise<Response> {
	if (segments[2] !== "credentials") return notFound("no such provider resource");
	const providerId = segments[3];
	if (request.method === "GET" && !providerId) {
		return json({ credentials: await describeCredentials(env.ORG_DB) });
	}
	if (request.method === "POST" && providerId) {
		const body = await readJson(request);
		const credential = body.credential as { type?: string; key?: string } | undefined;
		if (!credential || (credential.type !== "api_key" && credential.type !== "oauth")) {
			return badRequest(
				'credential must be an object with a type of "api_key" or "oauth"'
			);
		}
		await putCredential(env.ORG_DB, providerId, credential as never);
		await recordEvent(env.ORG_DB, {
			correlationId: `cor_${providerId}`,
			type: "provider.credential.set",
			payload: { provider: providerId, credential_type: credential.type }
		});
		return json({ provider: providerId, stored: true });
	}
	if (request.method === "DELETE" && providerId) {
		await removeCredential(env.ORG_DB, providerId);
		await recordEvent(env.ORG_DB, {
			correlationId: `cor_${providerId}`,
			type: "provider.credential.removed",
			payload: { provider: providerId }
		});
		return json({ provider: providerId, removed: true });
	}
	return badRequest("use GET to list, POST to store, or DELETE to remove");
}

/* ── obligations ────────────────────────────────────────────────────────── */

async function handleObligations(
	request: Request,
	env: Env,
	obligationId: string | undefined,
	action: string | undefined
): Promise<Response> {
	if (request.method === "POST" && !obligationId) {
		const body = await readJson(request);
		const name = typeof body.name === "string" ? body.name.trim() : "";
		if (!name) return badRequest("name is required");
		const intervalSeconds = Number(body.intervalSeconds ?? 900);
		if (!Number.isFinite(intervalSeconds) || intervalSeconds < 60) {
			return badRequest("intervalSeconds must be at least 60");
		}
		const owner = (await agentIdForRole(env, "coordinator")) ?? "coordinator";
		const obligation = await createObligation(env.ORG_DB, {
			name,
			ownerAgent: owner,
			intervalSeconds,
			checkSpec: body.check ?? { kind: "repository-health" }
		});
		await recordEvent(env.ORG_DB, {
			correlationId: `cor_${obligation.obligation_id}`,
			agentId: owner,
			type: "obligation.created",
			payload: { obligation_id: obligation.obligation_id, name }
		});
		return json({ obligation }, 201);
	}
	if (obligationId && action === "run" && request.method === "POST") {
		const coordinatorId = await agentIdForRole(env, "coordinator");
		if (!coordinatorId) return badRequest("no coordinator is registered");
		const result = await agentStub(env, coordinatorId).runSweep();
		return json({ result });
	}
	return json({ obligations: await listObligations(env.ORG_DB) });
}

/* ── approvals ──────────────────────────────────────────────────────────── */

async function handleApprovals(
	request: Request,
	env: Env,
	approvalId: string | undefined,
	caller: Caller | null
): Promise<Response> {
	if (request.method === "POST" && approvalId) {
		const body = await readJson(request);
		const decision = body.decision === "approve" ? "approved" : body.decision === "reject" ? "rejected" : null;
		if (!decision) return badRequest("decision must be \"approve\" or \"reject\"");
		const claimed = typeof body.decidedBy === "string" ? body.decidedBy : undefined;
		// A verified Access identity wins over a name in the body.
		const decidedBy = callerName(caller, claimed);
		const before = await getApproval(env.ORG_DB, approvalId);
		if (!before) return notFound(`no such approval: ${approvalId}`);
		if (before.status !== "pending") {
			// The decision was already taken. Repeating it would repeat the
			// side effects, so the answer stands and nothing else happens.
			return json({ approval: before, already_decided: true });
		}
		const approval = await decideApproval(env.ORG_DB, approvalId, decision, decidedBy);
		if (!approval) return notFound(`no such approval: ${approvalId}`);
		await recordEvent(env.ORG_DB, {
			correlationId: `cor_${approvalId}`,
			agentId: approval.requested_by,
			taskId: approval.task_id,
			type: `approval.${decision}`,
			payload: { approval_id: approvalId, decided_by: decidedBy }
		});
		// The task that waits for this approval may point at the approval, or
		// the approval may point at the task: the apply step is created after
		// the request, so both directions have to work.
		const task = approval.task_id
			? await getTask(env.ORG_DB, approval.task_id)
			: await env.ORG_DB.prepare("SELECT * FROM tasks WHERE approval_id = ?1")
					.bind(approvalId)
					.first<TaskRow>();
		if (task) {
			// Only a task that is waiting for this approval may start. A
			// finished task is never reopened by a decision.
			const unblocked = await env.ORG_DB.prepare(
				"UPDATE tasks SET status = ?1, updated_at = ?2 WHERE task_id = ?3 AND status = 'blocked'"
			)
				.bind(decision === "approved" ? "assigned" : "cancelled", Date.now(), task.task_id)
				.run();
			if (decision === "approved" && (unblocked.meta.changes ?? 0) > 0) {
				await agentStub(env, task.assignee).assign(task.task_id);
			}
		}
		// Approvals created for a task that does not exist yet (the apply step
		// is created after the approval) are handled by the coordinator sweep.
		if (!approval.task_id) {
			const coordinatorId = await agentIdForRole(env, "coordinator");
			if (coordinatorId) await agentStub(env, coordinatorId).runSweep();
		}
		return json({ approval });
	}
	return json({ approvals: await listApprovals(env.ORG_DB) });
}

/* ── webhooks ───────────────────────────────────────────────────────────── */

/**
 * Inbound events.
 *
 * A webhook is an external system telling the organization something. It
 * becomes a goal, which the coordinator turns into bounded work. The webhook
 * credential is separate from the management token.
 */
async function handleWebhook(request: Request, env: Env, path: string): Promise<Response> {
	const source = path.split("/").pop() ?? "unknown";
	const body = await readJson(request);
	const title =
		(typeof body.title === "string" && body.title) ||
		`Webhook from ${source}`;
	const description =
		(typeof body.description === "string" && body.description) ||
		JSON.stringify(body).slice(0, 2000);
	const coordinatorId = await agentIdForRole(env, "coordinator");
	if (!coordinatorId) return badRequest("no coordinator is registered");
	const goal = await createGoal(env.ORG_DB, {
		title: `[${source}] ${title}`,
		description,
		ownerAgent: coordinatorId
	});
	await recordEvent(env.ORG_DB, {
		correlationId: `cor_${goal.goal_id}`,
		agentId: coordinatorId,
		type: "webhook.received",
		payload: { source, goal_id: goal.goal_id }
	});
	const result = await agentStub(env, coordinatorId).onGoalCreated(goal.goal_id);
	return json({ goal, delegation: result }, 201);
}
