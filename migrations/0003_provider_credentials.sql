-- Provider credentials.
--
-- A provider credential is a secret: an API key, or an OAuth token that
-- stands for a subscription (a ChatGPT sign-in, for example). It is stored
-- here rather than in the configuration because a subscription's token
-- rotates, and the harness has to be able to write the new one back.
--
-- The row is never read by the management API: the API reports only which
-- providers are configured, never the credential itself. The Durable Object
-- that hosts an agent reads it when it opens pi, and nothing else can.

CREATE TABLE IF NOT EXISTS provider_credentials (
	provider_id TEXT PRIMARY KEY,
	credential  TEXT NOT NULL,          -- JSON, as pi-ai's Credential
	credential_type TEXT NOT NULL,      -- api_key | oauth
	updated_at  INTEGER NOT NULL
);
