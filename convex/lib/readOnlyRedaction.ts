// What a READ-ONLY identity (users.readOnly: a read-only MCP service token,
// or the claude-readonly account) must not be handed even though it may read
// the row that holds it: a credential that would let it WRITE somewhere else.
//
// Today that is one thing. A static custom app's launch URL is
// `/custom-apps?token=<token>` (shared/appKind.ts → customAppPath), and that
// token is the bearer secret appStates.updateCustomAppState accepts with no
// session at all, so "can read the app catalog" would otherwise mean "can
// write that app's state". The token travels inside webUrl through a dozen
// queries (catalog, scholar apps, activities, assignments, take-home plans,
// audiences), so it is withheld centrally: every custom query wrapper in
// convex/lib/customFunctions.ts runs its result through this for a read-only
// session owner, and the MCP curriculum proxy does the same to its text.
// The URL keeps its shape, so a reader still sees that the app exists and is
// a custom app; it just cannot launch or write it.

import { CUSTOM_APP_URL_PREFIX } from "../../shared/appKind";

export const WITHHELD_CUSTOM_APP_TOKEN = "withheld-read-only";

const escaped = CUSTOM_APP_URL_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Plain and percent-encoded forms (a launch URL nested in another URL's query).
const CUSTOM_APP_TOKEN_PATTERNS: RegExp[] = [
  new RegExp(`(${escaped})[^&#\\s"'<>]+`, "g"),
  new RegExp(
    `(${encodeURIComponent(CUSTOM_APP_URL_PREFIX).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})[^&#\\s"'<>%]+`,
    "gi",
  ),
];

function redactString(s: string): string {
  let out = s;
  for (const pattern of CUSTOM_APP_TOKEN_PATTERNS) {
    out = out.replace(pattern, `$1${WITHHELD_CUSTOM_APP_TOKEN}`);
  }
  return out;
}

/**
 * Deep copy of a Convex value with every custom-app launch token replaced.
 * Strings, arrays and plain objects are walked; everything else (numbers,
 * booleans, null, ArrayBuffers) passes through. Pure.
 */
export function redactCustomAppTokens<T>(value: T): T {
  if (typeof value === "string") return redactString(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactCustomAppTokens(v)) as T;
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactCustomAppTokens(v);
    }
    return out as T;
  }
  return value;
}
