/**
 * Correlation ids and short, sortable identifiers.
 *
 * Every externally visible action carries a correlation id so the event log,
 * the structured logs and the Durable Object traces can be joined.
 */

/** RFC 4122 v4 identifier, from the runtime's CSPRNG. */
export function uuid(): string {
	return crypto.randomUUID();
}

/**
 * A short, sortable, human-readable id: `<prefix>_<base32 time><random>`.
 *
 * The time prefix keeps ids roughly ordered by creation, which matters when
 * reading the event log; the random suffix keeps them unguessable, which
 * matters because task ids appear in tool arguments.
 */
export function shortId(prefix: string): string {
	const time = Date.now().toString(32).padStart(9, "0");
	const bytes = new Uint8Array(5);
	crypto.getRandomValues(bytes);
	let random = "";
	for (const byte of bytes) random += byte.toString(32).padStart(2, "0");
	return `${prefix}_${time}${random}`;
}

/** A correlation id for one logical action. */
export function correlationId(): string {
	return shortId("cor");
}
