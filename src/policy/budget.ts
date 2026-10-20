/**
 * Per-agent and per-task execution budgets.
 *
 * A budget is a ceiling, not a suggestion. When it is reached the tool
 * refuses the call with a normal error result, so the model can adapt, and the
 * refusal is visible in the event log. A Free-tier allocation that runs out
 * therefore degrades into "the agent stops doing side effects" instead of
 * "the worker starts throwing".
 */
import { getAgentUsage } from "../db/org.ts";

export type BudgetVerdict = { allowed: true } | { allowed: false; reason: string };

/** The per-agent daily ceiling on tool calls. */
export const DAILY_TOOL_CALL_LIMIT = 200;

/**
 * Check a task's tool-call budget before a side effect.
 *
 * `used` is the task's current counter, `limit` the agent's per-task ceiling.
 */
export function checkTaskBudget(used: number, limit: number): BudgetVerdict {
	if (limit <= 0) return { allowed: false, reason: "no tool-call budget is configured for this agent" };
	if (used >= limit) {
		return {
			allowed: false,
			reason: `task tool-call budget exhausted (${used}/${limit}); report what you have and stop`
		};
	}
	return { allowed: true };
}

/** Check the per-agent daily ceiling, which protects the shared Free allocation. */
export async function checkAgentDailyBudget(
	db: D1Database,
	agentId: string,
	limit = DAILY_TOOL_CALL_LIMIT
): Promise<BudgetVerdict> {
	const usage = await getAgentUsage(db, agentId);
	const used = usage?.tool_calls ?? 0;
	if (used >= limit) {
		return {
			allowed: false,
			reason: `agent daily tool-call budget exhausted (${used}/${limit})`
		};
	}
	return { allowed: true };
}

