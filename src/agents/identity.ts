/**
 * Agent identity.
 *
 * An agent's identity is a row in the shared store, not a class and not a
 * Durable Object name alone. The Durable Object name is the agent id, but
 * everything that makes the agent an agent — its role, its permissions, its
 * budgets, its model — lives in D1, so an agent can be replaced without
 * losing its obligations and a successor can inherit them.
 */
import { getAgent, listAgents, upsertAgent } from "../db/org.ts";
import type { AgentRow } from "../db/types.ts";
import type { Env } from "../env.ts";
import {
	defaultPermissionsForRole,
	parsePermissions,
	type Permission
} from "../policy/permissions.ts";
import { logInfo } from "../logging.ts";

export type AgentIdentity = {
	agentId: string;
	role: string;
	title: string;
	permissions: Permission[];
	/** Tool calls a single task may make. */
	maxToolCalls: number;
	/** Tokens a single task may spend. */
	maxTokens: number;
	/** Model id, as configured for the role or overridden per agent. */
	model: string;
	thinkingLevel: string;
};

/** The roles the organization ships with, and the environment variable each reads its model from. */
export const AGENT_ROLES = {
	coordinator: { title: "Coordinator", modelVar: "MODEL_COORDINATOR" },
	engineer: { title: "Engineer", modelVar: "MODEL_ENGINEER" },
	reviewer: { title: "Reviewer", modelVar: "MODEL_REVIEWER" }
} as const;

export type RoleName = keyof typeof AGENT_ROLES;

/** The role an agent id implies, when the id is one of the built-in ones. */
export function roleForAgentId(agentId: string): string {
	return agentId in AGENT_ROLES ? agentId : "observer";
}

/** The model id configured for a role. */
export function modelForRole(env: Env, role: string): string {
	const entry = AGENT_ROLES[role as RoleName];
	const fromEnv = entry ? env[entry.modelVar] : undefined;
	return fromEnv || env.MODEL_DEFAULT;
}

/**
 * Load an agent's identity, seeding the row on first use.
 *
 * Seeding only happens when the row is absent, so a permission change made by
 * an operator survives every later start.
 */
export async function loadIdentity(
	db: D1Database,
	env: Env,
	agentId: string
): Promise<AgentIdentity> {
	const existing = await getAgent(db, agentId);
	const role = existing?.role ?? roleForAgentId(agentId);
	let row: AgentRow;
	if (existing) {
		row = existing;
	} else {
		// An agent nobody has heard of joins with the read-only observer
		// role. It can read and report, and nothing else.
		row = await upsertAgent(db, {
			agentId,
			role,
			title: AGENT_ROLES[role as RoleName]?.title ?? agentId,
			permissions: defaultPermissionsForRole(role),
			model: modelForRole(env, role),
			thinkingLevel: env.THINKING_LEVEL || "low"
		});
	}
	return identityFromRow(row, env);
}

/**
 * Make sure the three built-in agents exist.
 *
 * This runs once, on the first request of a fresh deployment. It never
 * overwrites an existing row, so a retired agent stays retired and an
 * operator's permission change is never undone.
 */
export async function ensureBuiltInAgents(db: D1Database, env: Env): Promise<void> {
	const existing = await listAgents(db);
	const known = new Set(existing.map((agent) => agent.agent_id));
	for (const role of Object.keys(AGENT_ROLES) as RoleName[]) {
		const agentId = role;
		if (known.has(agentId)) continue;
		await upsertAgent(db, {
			agentId,
			role,
			title: AGENT_ROLES[role].title,
			permissions: defaultPermissionsForRole(role),
			model: modelForRole(env, role),
			thinkingLevel: env.THINKING_LEVEL || "low"
		});
		logInfo("seeded an agent", { agentId, role });
	}
}

/** The identity of an agent that already has a row. */
export function identityFromRow(row: AgentRow, env: Env): AgentIdentity {
	return {
		agentId: row.agent_id,
		role: row.role,
		title: row.title,
		permissions: parsePermissions(row.permissions),
		maxToolCalls: row.max_tool_calls,
		maxTokens: row.max_tokens,
		model: row.model || modelForRole(env, row.role),
		thinkingLevel: row.thinking_level || env.THINKING_LEVEL || "low"
	};
}
