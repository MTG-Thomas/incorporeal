/**
 * Structured logging.
 *
 * One JSON object per line, so the Workers log view and any Logpush pipeline
 * can filter on the same fields. Secrets never reach a log line: the helpers
 * here only accept ids, counts and short labels.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = {
	correlationId?: string;
	agentId?: string;
	taskId?: string;
	goalId?: string;
	obligationId?: string;
	kind?: string;
	durationMs?: number;
	[key: string]: unknown;
};

/** Emit one structured log line. */
export function log(level: LogLevel, message: string, fields: LogFields = {}): void {
	const line = JSON.stringify({
		ts: new Date().toISOString(),
		level,
		msg: message,
		...fields
	});
	if (level === "error") console.error(line);
	else if (level === "warn") console.warn(line);
	else console.log(line);
}

export const logInfo = (message: string, fields?: LogFields) => log("info", message, fields);
export const logWarn = (message: string, fields?: LogFields) => log("warn", message, fields);
export const logError = (message: string, fields?: LogFields) => log("error", message, fields);
export const logDebug = (message: string, fields?: LogFields) => log("debug", message, fields);

/**
 * Describe an unknown error without leaking a stack trace into user-facing
 * output. The message is safe for logs; the stack is not.
 */
export function describeError(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	try {
		return JSON.stringify(error);
	} catch {
		return "unknown error";
	}
}
