import type { ToolOutcome } from './types.js';

/**
 * Wrap a value as a successful tool result.
 *
 * Handlers in this server never throw: a thrown error inside an MCP handler
 * becomes an opaque protocol error, which loses the message the caller needs.
 * Every failure is converted to `isError: true` with readable text.
 */
export function asText(text: string, data?: unknown): ToolOutcome {
  return { text, data };
}

/**
 * Wrap a failure as a tool result the caller can read.
 *
 * `hint` is appended after the message so the caller knows what to try next,
 * which is more useful than repeating the message in a field.
 */
export function asError(message: string, hint?: string): ToolOutcome {
  const text = hint ? `${message}\n${hint}` : message;
  return { text, isError: true };
}

/**
 * Run a function that may throw and convert the throw into an error result.
 *
 * Used at the handler boundary so an unexpected exception in the registry
 * becomes a message rather than a dropped connection.
 */
export async function guard(
  label: string,
  fn: () => Promise<ToolOutcome> | ToolOutcome,
): Promise<ToolOutcome> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return asError(`${label} failed: ${message}`);
  }
}

/** Format an error for display, including the cause chain when present. */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message && cause.message !== err.message) {
      return `${err.message}: ${cause.message}`;
    }
    return err.message;
  }
  return String(err);
}
