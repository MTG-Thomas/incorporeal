/**
 * The Incorporeal worker.
 *
 * The worker is the ingress and the scheduler. It holds no agent state: every
 * agent is a Durable Object, and the organization's shared state is in D1.
 *
 * The split matters on the Workers Free plan. A worker invocation gets 10 ms
 * of CPU; a Durable Object invocation gets 30 s. So the worker authenticates,
 * routes and hands off, and every piece of real work happens inside a Durable
 * Object.
 */
import { handleApi } from "./api/routes.ts";
import { OrgAgent } from "./agents/org-agent.ts";
import { ensureBuiltInAgents } from "./agents/identity.ts";
import { findAgentByRole } from "./db/org.ts";
import type { Env } from "./env.ts";
import { describeError, logError, logInfo } from "./logging.ts";

export { OrgAgent };

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		try {
			if (url.pathname === "/" || url.pathname === "/api") {
				return new Response(
					JSON.stringify(
						{
							name: "incorporeal",
							description: "A durable organization of proactive agents on Cloudflare Workers.",
							api: "/api/agents, /api/goals, /api/tasks, /api/events, /api/obligations, /api/approvals"
						},
						null,
						2
					),
					{ headers: { "content-type": "application/json" } }
				);
			}
			await ensureBuiltInAgents(env.ORG_DB, env);
			const response = await handleApi(request, env, url, ctx);
			if (response) return response;
			return new Response(JSON.stringify({ error: "not found" }), {
				status: 404,
				headers: { "content-type": "application/json" }
			});
		} catch (error) {
			logError("request failed", {
				path: url.pathname,
				method: request.method,
				error: describeError(error)
			});
			return new Response(JSON.stringify({ error: "internal error" }), {
				status: 500,
				headers: { "content-type": "application/json" }
			});
		}
	},

	/**
	 * The organization's heartbeat.
	 *
	 * This is the only cron trigger in the system, and it does the least
	 * possible work here: it asks the coordinator to sweep its obligations
	 * and look for stalled assignments. The sweep itself runs inside the
	 * coordinator's Durable Object, which has 30 s of CPU and 15 minutes of
	 * wall time, instead of the 10 ms this worker has.
	 */
	async scheduled(_event: ScheduledController, env: Env): Promise<void> {
		try {
			await ensureBuiltInAgents(env.ORG_DB, env);
			const coordinator = await findAgentByRole(env.ORG_DB, "coordinator");
			const coordinatorId = coordinator?.agent_id ?? "coordinator";
			const started = Date.now();
			const result = await env.ORG_AGENTS.getByName(coordinatorId).runSweep();
			logInfo("sweep complete", {
				agentId: coordinatorId,
				durationMs: Date.now() - started,
				result: result as unknown as Record<string, unknown>
			});
		} catch (error) {
			logError("sweep failed", { error: describeError(error) });
		}
	}
};
