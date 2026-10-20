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
import schema from "../migrations/0001_init.sql?raw";

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
	await applyD1Migrations(env.ORG_DB, [{ name: "0001_init", queries: statements(schema) }]);
});

afterEach(async () => {
	// The agents keep working in the background after a call returns: a
	// Durable Object that is waiting on a model run holds an open promise when
	// the runtime shuts down, and the test pool reports that as an
	// "EnvironmentTeardownError" on the way out. It is noise, not a failure:
	// the assertions have already run and the suite's result is unaffected.
	await new Promise((resolve) => setTimeout(resolve, 150));
});
