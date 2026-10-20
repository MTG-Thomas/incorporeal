/**
 * A deterministic stand-in for a model.
 *
 * `MODEL_PROVIDER=faux` makes every agent answer from a script instead of
 * calling a provider. It exists for two reasons: the integration tests must
 * not spend model calls or need a network, and a deployment can be
 * demonstrated on a Free allocation without depending on a model provider.
 *
 * The script is chosen by looking at the prompt, so one script can serve
 * every role: the reviewer sees a prompt that mentions a review and answers
 * differently from the engineer. Within a turn, the script walks its actions
 * in order, skipping the ones the transcript already shows, so an agent can
 * run a tool and then report its result.
 */
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type FauxResponseStep
} from "@earendil-works/pi-ai/providers/faux";
import type { JsonValue, Message } from "@earendil-works/pi-ai";

/** The model id the faux provider serves. */
export const FAUX_MODEL_ID = "faux-1";
/** The provider id the faux provider registers under. */
export const FAUX_PROVIDER_ID = "faux";

export type FauxAction = {
	/** Text to answer with. */
	text?: string;
	/** A tool to call, and its arguments. */
	tool?: string;
	args?: Record<string, JsonValue>;
};

export type FauxRule = {
	/**
	 * What selects this rule: one substring, or several that must all be
	 * present. Several is how a rule says "only the agent whose prompt says
	 * both of these", which is how one script can serve three roles.
	 */
	match: string | string[];
	/** What the agent does, in order. */
	actions: FauxAction[];
};

export type FauxSpec = {
	/** What to do when no rule matches. */
	default?: FauxAction[];
	/** Rules, applied in order; the first whose `match` appears in the prompt wins. */
	rules?: FauxRule[];
};

const DEFAULT_SPEC: FauxSpec = {
	default: [
		{
			tool: "org_report_result",
			args: {
				summary: "The deterministic model reported the result of the assignment.",
				findings: [],
				evidence: []
			}
		}
	],
	rules: [
		{
			// The coordinator delegating a second, deeper piece of work.
			match: ["Delegate the deep dive", "(coordinator)"],
			actions: [
				{
					tool: "org_delegate",
					args: {
						title: "Dig deeper into the failure",
						instruction: "Investigate the deeper cause and report what you find.",
						assignee: "engineer",
						kind: "research",
						deadline_minutes: 30
					}
				}
			]
		},
		{
			// A review that asks for changes. The rule is matched before the
			// general review rule, so a distinctive title wins.
			match: ["flaky login", "(reviewer)"],
			actions: [
				{
					tool: "org_report_result",
					args: {
						summary: "The fix does not handle the empty case, and no test covers it.",
						findings: ["No test for the empty input.", "The error path is not exercised."],
						recommendation: "changes_requested",
						evidence: ["Read the proposed change and its test."]
					}
				}
			]
		},
		{
			// An execution, run twice with the same idempotency key: the
			// second attempt must find the first one and do nothing.
			match: ["Run the build", "(engineer)"],
			actions: [
				{
					tool: "org_run_execution",
					args: { command: "npm test", idempotency_key: "build-1", notes: "the build" }
				},
				{
					tool: "org_run_execution",
					args: { command: "npm test", idempotency_key: "build-1", notes: "the build, again" }
				},
				{
					tool: "org_report_result",
					args: {
						summary: "Ran the build and reported the result.",
						findings: [],
						evidence: ["the execution record"],
						action: { command: "npm test" }
					}
				}
			]
		},
		{
			match: "Review:",
			actions: [
				{
					tool: "org_report_result",
					args: {
						summary: "Reviewed the engineering output. The approach is sound and the evidence supports it.",
						findings: ["No blocking issue found."],
						recommendation: "accept",
						evidence: ["Reviewed the reported plan and its stated evidence."]
					}
				}
			]
		}
	]
};

/** Parse the script from configuration, falling back to a sensible default. */
export function parseFauxSpec(raw: string | undefined): FauxSpec {
	if (!raw) return DEFAULT_SPEC;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object") return DEFAULT_SPEC;
		const spec = parsed as FauxSpec;
		return {
			default: spec.default ? (spec.default as FauxAction[]) : DEFAULT_SPEC.default,
			rules: spec.rules ?? DEFAULT_SPEC.rules
		};
	} catch {
		return DEFAULT_SPEC;
	}
}

/** The text of a message, for matching a rule against it. */
function messageText(message: Message): string {
	// A system message carries the prompt sections in `sections`, and that is
	// where an agent's role is written, so the sections are part of the text a
	// rule is matched against.
	const sections = (message as { sections?: Record<string, unknown> }).sections;
	const sectionText =
		sections && typeof sections === "object"
			? Object.values(sections)
					.map((section) => (typeof section === "string" ? section : ""))
					.join("\n")
			: "";
	const content = (message as { content?: unknown }).content;
	// A user message's content is either plain text or a list of blocks.
	if (typeof content === "string") return `${sectionText}\n${content}`;
	if (!Array.isArray(content)) return sectionText;
	return [
		sectionText,
		content
			.map((block) => {
				const text = (block as { text?: unknown }).text;
				return typeof text === "string" ? text : "";
			})
			.join("\n")
	].join("\n");
}

/**
 * True when this run already called the tool.
 *
 * Only the messages after the newest user message count: a previous
 * assignment in the same conversation is history, not something to repeat.
 */
function alreadyCalled(messages: readonly Message[], toolName: string): boolean {
	let start = 0;
	for (let index = messages.length - 1; index >= 0; index--) {
		if ((messages[index] as { role?: string }).role === "user") {
			start = index;
			break;
		}
	}
	return messages
		.slice(start)
		.some(
			(message) =>
				(message as { role?: string }).role === "toolResult" &&
				(message as { toolName?: string }).toolName === toolName
		);
}

/** True when the prompt contains the rule's marker, or all of its markers. */
function matches(marker: string | string[], prompt: string): boolean {
	return Array.isArray(marker)
		? marker.every((part) => prompt.includes(part))
		: prompt.includes(marker);
}

/**
 * Fill the placeholders in a scripted call.
 *
 * `$TASK_ID` becomes the task the assignment names, so a scripted tool call
 * can address the task it is working on without the script knowing it.
 */
function resolveArgs(args: Record<string, JsonValue>, prompt: string): Record<string, JsonValue> {
	const taskId = /task_id="([^"]+)"/.exec(prompt)?.[1];
	const resolved: Record<string, JsonValue> = {};
	for (const [key, value] of Object.entries(args)) {
		resolved[key] = value === "$TASK_ID" ? (taskId ?? "") : value;
	}
	return resolved;
}

/** The script, as a list of steps the faux provider cycles through. */
export function createFauxSteps(spec: FauxSpec, steps = 64): FauxResponseStep[] {
	const step: FauxResponseStep = (context) => {
		const prompt = context.messages.map(messageText).join("\n");
		const rule = spec.rules?.find((candidate) => matches(candidate.match, prompt));
		const actions = rule?.actions ?? spec.default ?? [];
		for (const action of actions) {
			if (!action.tool) return fauxAssistantMessage(action.text ?? "Done.");
			// A tool that already ran in this transcript must not run again, or
			// the agent would loop forever.
			if (alreadyCalled(context.messages, action.tool)) continue;
			// A message that asks for a tool must say so: pi only starts a tool
			// round when the model stops with "toolUse".
			return fauxAssistantMessage(
				[fauxToolCall(action.tool, resolveArgs(action.args ?? {}, prompt))],
				{ stopReason: "toolUse" }
			);
		}
		return fauxAssistantMessage("The work has been reported.");
	};
	return Array.from({ length: steps }, () => step);
}

/** A faux provider with the script already set. */
export function createFauxProvider(spec: FauxSpec) {
	const faux = fauxProvider({
		provider: FAUX_PROVIDER_ID,
		models: [{ id: FAUX_MODEL_ID, name: "Deterministic model" }]
	});
	faux.setResponses(createFauxSteps(spec));
	return faux;
}
