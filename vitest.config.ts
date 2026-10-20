import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: fileURLToPath(new URL("./wrangler.jsonc", import.meta.url)) },
			miniflare: {
				bindings: {
					ORG_API_TOKEN: "test-token",
					WEBHOOK_SECRET: "test-webhook-secret",
					MODEL_PROVIDER: "faux",
					ORG_ENV: "test",
					REPO_PROVIDER: "simulated",
					SIMULATED_REPO_STATE:
						'{"ciStatus":"failing","workflow":"build-and-test","branch":"main","issue":"Simulated CI failure: the nightly workflow failed."}'
				}
			}
		})
	],
	resolve: {
		// One copy of pi's module state for the harness and the tests.
		dedupe: ["@earendil-works/pi-ai", "@earendil-works/pi-durable", "@earendil-works/chord"]
	},
	test: {
		name: "incorporeal",
		// The Durable Object tests evict objects, which reaches every object in
		// the runtime, so the files run one at a time.
		fileParallelism: false,
		include: ["test/**/*.test.ts"],
		setupFiles: [fileURLToPath(new URL("./test/setup.ts", import.meta.url))],
		testTimeout: 60_000,
		hookTimeout: 60_000
	}
});
