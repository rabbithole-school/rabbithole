/**
 * Copy for the two shared school-lifecycle dialogs — DeleteSchoolDialog and
 * DisableSchoolDialog — as a pure function of the CALLER'S noun.
 *
 * Both dialogs are opened from two surfaces that speak different vocabularies:
 *   • /school/settings — a school leader acting on THEIR OWN school. Inside one
 *     school, the human word is "school".
 *   • /admin/institutions — a platform admin acting on any tenant. The
 *     admin-system word is "institution".
 *
 * T12 (.claude/rules/rabbithole-product-taste.md) — "Don't fork a shared
 * primitive with one caller's vocabulary … the caller owns the whole sentence."
 * So the noun-dependent strings live here, selected by the caller-supplied
 * `noun`, instead of being baked into the dialog. Keeping them in one pure,
 * imported module lets us unit-test them per caller, so the school copy can
 * never silently regress into admin vocabulary again (the exact risk the #1704
 * roster vocabulary pass introduced).
 *
 * Each string is a noun-aware template so both callers retain their own
 * vocabulary without duplicating the dialog.
 */
export type SchoolLifecycleNoun = "school" | "institution";

export function deleteSchoolCopy(noun: SchoolLifecycleNoun) {
  return {
    /** Footer confirm button. */
    confirmButton: `Delete this ${noun}`,
    /** Error toast title. */
    errorTitle: `Couldn't delete ${noun}`,
    /** Success toast body once the background delete is scheduled. */
    inProgressDescription: `The ${noun} and all of its data are being deleted in the background.`,
    /** Fallback shown when the server reports the tenant can't be deleted. */
    cannotDelete: `This ${noun} cannot be deleted.`,
    /** aria-label for the type-to-confirm input. */
    confirmInputAriaLabel: `Type the ${noun} name to confirm deletion`,
    /** Warning shown when the admin is deleting their own tenant. */
    deletingSelf: `This is your own ${noun} — deleting it will delete your account and sign you out.`,
    /**
     * Mid-sentence clause inside the surviving-accounts note. Only this clause
     * is noun-dependent; the surrounding sentence carries the name and count.
     */
    survivingAccountsClause:
      noun === "institution"
        ? "belong to another institution"
        : "belong to another school",
  };
}

export function disableSchoolCopy(noun: SchoolLifecycleNoun) {
  const accessPausedDescription = `Members who can only use Rabbithole through this ${noun} are blocked from the app and see an “access is paused” message.`;

  return {
    /** Footer confirm button. */
    confirmButton: `Pause this ${noun}`,
    /** Error toast title. */
    errorTitle: `Couldn't pause ${noun}`,
    /** aria-label for the optional-reason textarea. */
    reasonAriaLabel: `Optional reason for pausing this ${noun}`,
    /** Shared dialog/banner description of the actual access behavior. */
    accessPausedDescription,
    /** Success toast body after access has been paused. */
    successDescription: `${accessPausedDescription} Nothing was deleted — resume any time.`,
    /**
     * Mid-paragraph sentence about members who also belong elsewhere.
     */
    otherActiveSentence: `Anyone who also belongs to another active ${noun} keeps working there.`,
  };
}
