/**
 * Provider credentials, stored in the shared store.
 *
 * A credential is a secret. It is written through the management API (which
 * requires the management token) or by pi-ai's own refresh, and it is read
 * only by the Durable Object that is opening pi. The API reports *which*
 * providers are configured; it never reports the credential.
 *
 * The store is pi-ai's `CredentialStore`, so pi-ai's OAuth machinery can
 * refresh a subscription token in place — a ChatGPT sign-in rotates its
 * refresh token, and the harness has to write the new one back or the
 * subscription breaks on the next call.
 */
import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

type Row = {
	provider_id: string;
	credential: string;
	credential_type: string;
	updated_at: number;
};

/** The provider ids whose credentials this store knows about. */
export const KNOWN_PROVIDERS = ["openai", "opencode-go", "anthropic", "openrouter"] as const;

function parse(raw: string | null | undefined): Credential | undefined {
	if (!raw) return undefined;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object") return undefined;
		return parsed as Credential;
	} catch {
		return undefined;
	}
}

/** A credential store over the shared store. */
export class D1CredentialStore implements CredentialStore {
	readonly #db: D1Database;

	constructor(db: D1Database) {
		this.#db = db;
	}

	async read(providerId: string): Promise<Credential | undefined> {
		const row = await this.#db
			.prepare("SELECT credential FROM provider_credentials WHERE provider_id = ?1")
			.bind(providerId)
			.first<{ credential: string }>();
		return parse(row?.credential);
	}

	async list(): Promise<readonly CredentialInfo[]> {
		const { results } = await this.#db
			.prepare(
				"SELECT provider_id, credential_type FROM provider_credentials ORDER BY provider_id"
			)
			.all<{ provider_id: string; credential_type: string }>();
		return (results ?? []).map((row) => ({
			providerId: row.provider_id,
			type: row.credential_type as CredentialInfo["type"]
		}));
	}

	async modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>
	): Promise<Credential | undefined> {
		const current = await this.read(providerId);
		const next = await fn(current);
		if (next === undefined) return current;
		await this.#db
			.prepare(
				`INSERT INTO provider_credentials (provider_id, credential, credential_type, updated_at)
				 VALUES (?1, ?2, ?3, ?4)
				 ON CONFLICT(provider_id) DO UPDATE SET
					credential = excluded.credential,
					credential_type = excluded.credential_type,
					updated_at = excluded.updated_at`
			)
			.bind(providerId, JSON.stringify(next), next.type, Date.now())
			.run();
		return next;
	}

	async delete(providerId: string): Promise<void> {
		await this.#db
			.prepare("DELETE FROM provider_credentials WHERE provider_id = ?1")
			.bind(providerId)
			.run();
	}
}

/** Store a credential directly, for the operator who has one in hand. */
export async function putCredential(
	db: D1Database,
	providerId: string,
	credential: Credential
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO provider_credentials (provider_id, credential, credential_type, updated_at)
			 VALUES (?1, ?2, ?3, ?4)
			 ON CONFLICT(provider_id) DO UPDATE SET
				credential = excluded.credential,
				credential_type = excluded.credential_type,
				updated_at = excluded.updated_at`
		)
		.bind(providerId, JSON.stringify(credential), credential.type, Date.now())
		.run();
}

/** Remove a credential. */
export async function removeCredential(db: D1Database, providerId: string): Promise<void> {
	await db
		.prepare("DELETE FROM provider_credentials WHERE provider_id = ?1")
		.bind(providerId)
		.run();
}

/**
 * Which providers have a credential, and of what kind.
 *
 * Metadata only: this is what the management API is allowed to say.
 */
export async function describeCredentials(db: D1Database): Promise<
	{ providerId: string; type: string; updatedAt: number }[]
> {
	const { results } = await db
		.prepare(
			"SELECT provider_id, credential_type, updated_at FROM provider_credentials ORDER BY provider_id"
		)
		.all<Row>();
	return (results ?? []).map((row) => ({
		providerId: row.provider_id,
		type: row.credential_type,
		updatedAt: row.updated_at
	}));
}
