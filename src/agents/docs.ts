/**
 * Documents the organization keeps inside each agent's own Durable Object.
 *
 * These are agent-private: they live in the agent's SQLite database, not in
 * the shared store. The shared store holds what the organization owes each
 * other; these hold what one agent is currently doing.
 */
import { defineDoc } from "@earendil-works/pi-durable";

/**
 * The assignment the agent is currently working on.
 *
 * It is durable, so a tool call that arrives after an eviction still knows
 * which organizational task it belongs to.
 */
export const AssignmentDoc = defineDoc<{
	taskId: string | null;
	kind: string | null;
	goalId: string | null;
}>({
	kind: "org.assignment",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ taskId: null, kind: null, goalId: null }),
	checkpointWhen: () => true
});
