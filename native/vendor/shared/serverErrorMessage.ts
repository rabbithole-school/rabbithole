import { ConvexError } from "convex/values";

/** Convex surfaces a thrown Error's message wrapped with framing
 * ("… Uncaught Error: <message> at …", sometimes across multiple lines).
 * Pull the human sentence back out so a server refusal reads as guidance
 * rather than a stack trace. Previously copy-pasted per component — this is
 * the one shared home.
 *
 * A ConvexError whose data is a sentence wins outright: production redacts a
 * plain Error's message to "Server Error", so a ConvexError is how a server
 * refusal reaches the person who hit it. A redacted message carries no
 * sentence at all, so a caller's fallback replaces its framing — but only a
 * caller that gave one: without it the framing is kept, because callers that
 * render `{error && …}` would otherwise show nothing for a real failure.
 */
export function serverErrorMessage(error: unknown, fallback = ""): string {
  if (error instanceof ConvexError && typeof error.data === "string") {
    return error.data.trim() || fallback;
  }
  const raw = error instanceof Error ? error.message : String(error);
  const match = raw.match(
    /Uncaught (?:Convex)?Error:\s*([\s\S]*?)(?:\n\s*at\s|\n\s*$|$)/,
  );
  if (!match && fallback && /\bServer Error\s*$/.test(raw)) return fallback;
  return (match?.[1] ?? raw).trim() || fallback;
}
