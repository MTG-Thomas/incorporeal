/**
 * Tool permissions.
 *
 * Two rules make this safe:
 *
 * 1. The permission set is *data* (in D1), not something the model can
 *    influence. A model instruction to "grant yourself execution rights" is
 *    just text; it changes no row.
 * 2. Every tool re-checks its permission inside `execute()`, against the
 *    row, on every call. The model only being offered a subset of tools is a
 *    convenience, not the control.
 */
export const PERMISSIONS = [
	"task.read",
	"task.report",
	"task.delegate",
	"task.approve",
	"knowledge.read",
	"knowledge.write",
	"execution.run"
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** Parse the JSON permission list stored on an agent row. */
export function parsePermissions(raw: string | null | undefined): Permission[] {
	if (!raw) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		const allowed = new Set<string>(PERMISSIONS);
		return parsed.filter((value): value is Permission => typeof value === "string" && allowed.has(value));
	} catch {
		return [];
	}
}

export function hasPermission(permissions: readonly Permission[], permission: Permission): boolean {
	return permissions.includes(permission);
}

/**
 * The default permission set for a role.
 *
 * The reviewer can read tasks, report the result of its own work and write
 * shared knowledge. It cannot write tasks, delegate, approve or execute, so
 * it cannot accept its own work or act on it. The engineer can run code but
 * cannot delegate or approve. Only the coordinator can delegate or ask a
 * human.
 */
export const ROLE_PERMISSIONS: Record<string, readonly Permission[]> = {
	coordinator: [
		"task.read",
		"task.report",
		"task.delegate",
		"task.approve",
		"knowledge.read",
		"knowledge.write"
	],
	engineer: [
		"task.read",
		"task.report",
		"knowledge.read",
		"knowledge.write",
		"execution.run"
	],
	reviewer: ["task.read", "task.report", "knowledge.read", "knowledge.write"]
};

/** The default permission set for an unknown role: read-only. */
export function defaultPermissionsForRole(role: string): Permission[] {
	return [...(ROLE_PERMISSIONS[role] ?? ["task.read", "knowledge.read"])];
}
