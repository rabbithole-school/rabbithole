/**
 * What an "about" conversation says it is about, worded once for web and the
 * BunnyPad (review/quests-rebuilt-proposal.html, "Conversations live in
 * Messages": one thread per Quest and one per wonder a teacher replies to,
 * and "the thread says what it is about at the top").
 *
 * The subject in words (`aboutTitle`) comes from `scholarMessages.listThreads`
 * and `getThread`; a thread whose subject can't be read says only the label.
 *
 * Pure. Shared by web and native (native reads it via native/vendor: re-run
 * `npm run sync:vendor` in native/ after editing).
 */

export const MESSAGE_ABOUT_COPY = {
  /** The list group that holds these threads, under People and Workshop. */
  listHeading: "About your wonders and Quests",
  wonder: "About your wonder",
  quest: "About your Quest",
  /** The same, as a teacher reads it. */
  wonderForStaff: "About a wonder",
  questForStaff: "About a Quest",
} as const;

type AboutKind = { type: "wonder" } | { type: "quest" };

/** "About your wonder" / "About your Quest" (a teacher's: "About a wonder"). */
export function aboutLabel(
  about: AboutKind | undefined,
  viewer: "scholar" | "staff" = "scholar",
): string | null {
  if (!about) return null;
  if (about.type === "wonder") {
    return viewer === "scholar"
      ? MESSAGE_ABOUT_COPY.wonder
      : MESSAGE_ABOUT_COPY.wonderForStaff;
  }
  return viewer === "scholar"
    ? MESSAGE_ABOUT_COPY.quest
    : MESSAGE_ABOUT_COPY.questForStaff;
}

/** The label, then the subject in words when there is one:
 *  "About your wonder · Why do owls turn their heads so far?". */
export function aboutLine(
  about: AboutKind | undefined,
  aboutTitle: string | undefined,
  viewer: "scholar" | "staff" = "scholar",
): string | null {
  const label = aboutLabel(about, viewer);
  if (!label) return null;
  const title = aboutTitle?.trim();
  return title ? `${label} · ${title}` : label;
}
