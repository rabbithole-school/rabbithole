/**
 * Pure view helpers for the SEL Rounds surface — the small branchy logic the
 * board row and pane share, kept out of the "use client" component files so it
 * can be unit-tested without a DOM.
 */

export type SelSynthesisCite = {
  kind: "sessionSignal" | "analysis" | "alert" | "observation";
  id: string;
  label: string;
  at: number;
};

export type SelSynthesisClaim = {
  text: string;
  cites: SelSynthesisCite[];
};

/** The structural subset both the batched roster read and the single-scholar
 *  read hand back — every SEL view needs no more than this. */
export type SelSynthesisRow = {
  strengths: SelSynthesisClaim[];
  watch: SelSynthesisClaim[];
  quiet: boolean;
  generatedAt: number;
};

export type SelRecordObservation = {
  _id: string;
  type: "praise" | "concern" | "suggestion" | "intervention" | "note";
  note: string;
  category:
    | "execFunction"
    | "socialEmotional"
    | "collaboration"
    | "passions"
    | "other"
    | null;
  at: number;
  teacherName: string | null;
};

/**
 * The SEL compact-row headline: the synthesis's first strength, or its first
 * watch item when there are no strengths, or a muted "quiet week" — never a
 * practice/mastery figure. A missing synthesis reads as "not written yet".
 */
export function selRowHeadline(
  synthesis: SelSynthesisRow | null,
  loading: boolean,
): { text: string; quiet: boolean } {
  if (!synthesis) {
    return { text: loading ? "…" : "not written yet", quiet: true };
  }
  if (synthesis.quiet) return { text: "quiet week", quiet: true };
  const first = synthesis.strengths[0]?.text ?? synthesis.watch[0]?.text;
  return first
    ? { text: first, quiet: false }
    : { text: "quiet week", quiet: true };
}

/** The slice the synthesis reads: anything the staff aide category-tagged, plus
 *  the concern/intervention rows already surfaced in the academic projection. */
export function selTeacherRecord(
  observations: SelRecordObservation[],
): SelRecordObservation[] {
  return observations.filter(
    (o) =>
      o.category !== null || o.type === "concern" || o.type === "intervention",
  );
}
