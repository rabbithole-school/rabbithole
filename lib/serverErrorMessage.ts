/** Convex surfaces a thrown Error's message wrapped with framing
 * ("… Uncaught Error: <message> at …", sometimes across multiple lines).
 * Pull the human sentence back out so a server refusal reads as guidance
 * rather than a stack trace. Previously copy-pasted per component — this is
 * the one shared home.
 */
export function serverErrorMessage(error: unknown, fallback = ""): string {
  const raw = error instanceof Error ? error.message : String(error);
  const match = raw.match(
    /Uncaught (?:Convex)?Error:\s*([\s\S]*?)(?:\n\s*at\s|\n\s*$|$)/,
  );
  return (match?.[1] ?? raw).trim() || fallback;
}
