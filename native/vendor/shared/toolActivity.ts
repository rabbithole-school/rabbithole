/**
 * Which tool rows a scholar is allowed to see, and which are machinery.
 *
 * A `role: "tool"` message's `toolAction` carries two different kinds of value:
 *
 *   - **Machine discriminators** that select a dedicated renderer, or — for
 *     `whisper` — private teacher guidance the scholar must never be shown.
 *   - **Human-readable receipts** written for the scholar's eyes: "Wrote down
 *     your words", "Edited document", "Generated image". These render as a
 *     plain centered activity line naming what the tutor just did.
 *
 * This lives in `shared/` because web and native disagreeing about which tool
 * rows are visible is precisely how the bug this fixes happened: native's
 * transcript filter admitted only tool rows carrying a rich payload, so every
 * plain receipt web had been showing for months was silently dropped on iPad.
 * One list, one answer, both frontends.
 */

/**
 * `toolAction` values that are NOT scholar-facing prose. Each is either
 * rendered by a dedicated component keyed off this exact string, or — in the
 * case of `whisper` — must not reach the scholar at all.
 */
export const TOOL_ACTION_DISCRIMINATORS: readonly string[] = [
  // Private teacher guidance. Never scholar-visible.
  "whisper",
  // Rich cards that key off the discriminator and read their own payload.
  "physical_task",
  "resource_share",
  "generate_image",
];

const DISCRIMINATORS = new Set(TOOL_ACTION_DISCRIMINATORS);

/**
 * True when `toolAction` is a human-readable receipt that should render as an
 * activity line.
 *
 * Deliberately a denylist rather than an allowlist of known receipts. The bug
 * this guards against was a receipt being *silently dropped*, and an allowlist
 * reproduces that the next time someone adds one. A newly added machine
 * discriminator that forgets this list instead surfaces as a visible raw
 * string — wrong in the loud direction rather than the invisible one.
 *
 * The comparison is trimmed and case-folded because the schema types
 * `toolAction` as a free string, so nothing structurally guarantees the
 * canonical spelling. Exact matching would let `"Whisper"` or `" whisper "`
 * slip past and render a teacher's private guidance to the scholar. That is
 * the one place this denylist's failure mode is genuinely unsafe rather than
 * merely loud, so it is worth closing even though every writer today emits the
 * literal. Receipts are prose and never collide with a folded discriminator;
 * the row still displays the original string verbatim.
 */
export function isToolActivityLabel(
  toolAction: string | undefined | null,
): boolean {
  if (!toolAction) return false;
  const normalized = toolAction.trim().toLowerCase();
  if (!normalized) return false;
  return !DISCRIMINATORS.has(normalized);
}

/**
 * What a scholar-visible tool row renders: the illustration it carries, the
 * receipt line naming what the tutor did, and — for a FOUND image — where it
 * came from.
 *
 * These are NOT alternatives. The `generate_image` tool writes ONE tool row
 * carrying both an `imageId` and the "Generated image" receipt, so a renderer
 * that treats the receipt branch as terminal drops the picture and leaves the
 * caption behind — which is exactly what an iPad scholar saw when they asked
 * the tutor for a diagram of a sucrose molecule and got the words "Generated
 * image" alone. Returning both fields together is what keeps a renderer from
 * having to remember.
 *
 * `sourceHost` is set only by `search_image`, and only ever travels WITH an
 * image — attribution without a picture is meaningless, and a picture whose
 * provenance silently drops is the same class of bug as the caption-only row
 * above. A generated illustration has no source and returns null, which is how
 * a reader tells the two apart.
 */
export function toolRowDisplay<TImageId>(row: {
  toolAction?: string | null;
  imageId?: TImageId | null;
  imageSourceHost?: string | null;
}): { imageId: TImageId | null; label: string | null; sourceHost: string | null } {
  const imageId = row.imageId ?? null;
  const host = row.imageSourceHost?.trim();
  const sourceHost = imageId !== null && host ? host : null;
  const receipt = isToolActivityLabel(row.toolAction)
    ? (row.toolAction as string)
    : null;
  // Composed HERE, not in each frontend, for the same reason the visibility
  // rule is shared: two renderers separately deciding how to join a receipt to
  // its source is two chances to drift, and the drift is invisible until a
  // scholar on one device sees attribution the other device dropped.
  const label =
    receipt && sourceHost
      ? `${receipt} · ${sourceHost}`
      : (receipt ?? (sourceHost ? `Found image · ${sourceHost}` : null));
  return { imageId, label, sourceHost };
}

/** True when a tool row has anything at all to show a scholar. */
export function hasToolRowDisplay(row: {
  toolAction?: string | null;
  imageId?: unknown;
}): boolean {
  const display = toolRowDisplay(row);
  return display.imageId !== null || display.label !== null;
}
