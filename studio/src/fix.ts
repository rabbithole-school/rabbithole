/**
 * The deterministic pass, plus the parse check the sandbox uses to decide
 * whether a failure is worth escalating to the model.
 *
 * The repairs themselves live in `shared/studioFix.ts` so the Convex-side
 * stage-2 fixer and the sandbox agree, to the character, on what a "fix" is.
 */
export { fixRuntimeSource, studioFix } from "../../shared/studioFix";

/** Does this text parse as a program at all? Cheap, and the escalation trigger. */
export function parses(src: string): { ok: true } | { ok: false; error: string } {
  try {
    new Function('"use strict";\n' + src);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}
