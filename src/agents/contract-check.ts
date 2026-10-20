/**
 * A compile-time proof that the shapes this organization reads from
 * pi-durable and the Agents SDK still exist.
 *
 * The organization depends on a few of pi's shapes: the usage totals, the
 * transcript entries, the pending operations, the session list. If an upgrade
 * changes one of them, `npm run typecheck` fails here, at the upgrade, rather
 * than at runtime in an agent's turn.
 */
import type {
	AgentEvent,
	EntryRecord,
	SnapshotEvent,
	TaskInspection,
	UsageState
} from "@earendil-works/pi-durable";

/** Fails to compile when the condition is not true. */
type Assert<T extends true> = T;

/** `harness.usage()` returns per-model totals, and each has tokens and a cost. */
export type UsageHasModels = Assert<"models" extends keyof UsageState ? true : false>;
export type ModelHasTokens = Assert<
	UsageState["models"][string] extends { totalTokens: number } ? true : false
>;
export type ModelHasCost = Assert<
	UsageState["models"][string] extends { cost: { total: number } } ? true : false
>;

/** A transcript entry carries its kind, and an agent event carries its type. */
export type EntryHasKind = Assert<"kind" extends keyof EntryRecord ? true : false>;
export type AgentEventHasType = Assert<"type" extends keyof AgentEvent ? true : false>;
export type SnapshotHasEntries = Assert<"entries" extends keyof SnapshotEvent ? true : false>;

/** An inspected task carries the record and the state the task graph reads. */
export type TaskHasState = Assert<"state" extends keyof TaskInspection ? true : false>;
export type TaskHasRecord = Assert<"record" extends keyof TaskInspection ? true : false>;
