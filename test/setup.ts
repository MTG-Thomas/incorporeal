/**
 * Test setup.
 *
 * Every test starts from an empty organization: the shared store is reset and
 * the schema is applied again, and every Durable Object is reset, so no test
 * can see another's state.
 */
import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import { afterEach, beforeEach } from "vitest";
const migrationFiles = import.meta.glob("../migrations/*.sql", {
	query: "?raw",
	import: "default",
	eager: true
}) as Record<string, string>;

/** Every migration, in the order they must be applied. */
const migrations = Object.entries(migrationFiles)
	.sort(([a], [b]) => a.localeCompare(b))
	.map(([name, sql]) => ({ name: name.split("/").pop() ?? name, sql }));

/**
 * The migration file, split into statements.
 *
 * D1's `exec` splits on semicolons and rejects a chunk that holds nothing but
 * a comment, so the comments come out first.
 */
function statements(sql: string): string[] {
	return sql
		.split("\n")
		.filter((line) => !line.trim().startsWith("--"))
		.join("\n")
		.split(";")
		.map((statement) => statement.trim())
		.filter((statement) => statement.length > 0);
}

beforeEach(async () => {
	await reset();
	await applyD1Migrations(
		env.ORG_DB,
		migrations.map((migration) => ({
			name: migration.name,
			queries: statements(migration.sql)
		}))
	);
});

afterEach(async () => {
	// The agents keep working in the background after a call returns: a
	// Durable Object that is waiting on a model run holds an open promise when
	// the runtime shuts down, and the test pool reports that as an
	// "EnvironmentTeardownError" on the way out. It is noise, not a failure:
	// the assertions have already run and the suite's result is unaffected.
	await new Promise((resolve) => setTimeout(resolve, 150));
});
