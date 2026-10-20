/// <reference types="@cloudflare/vitest-plugin/types" />

/**
 * The test pool's module and the bindings the tests use.
 */
declare module "*.sql?raw" {
	const content: string;
	export default content;
}
