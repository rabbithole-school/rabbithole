/**
 * The grid's minute clock applied to its gives (TRA-582, T11). The grid query
 * can't read the clock, so it returns each give's end; a live give whose end
 * has passed and that fades reads as ended here. A give can stay open past its
 * end until its clear job runs, and a same-day give (no explicit window) is
 * never cleared at all, so the stored state alone would read "Live" forever.
 *
 * Also collapses one give drawn for several groups to a single card in the
 * teacher lens, where the group doesn't separate them (T1).
 */
import { openUntilPhrase } from "@/shared/openUntil";

type ClockedGive = {
  key: string;
  pushId: string;
  state: "planned" | "live" | "finished";
  linkState: "planned" | "live";
  closedLabel: string | null;
  endsAt: number | null;
  afterEnd: "late" | "fade";
  openUntilLabel?: string | null;
};

/** `timeZone` words an open-until give's "Open until Thu" line with the same
 *  clock: from seven days out the date is added (openUntilPhrase). */
export function withGiveClock<G extends ClockedGive>(
  gives: readonly G[],
  nowMs: number,
  timeZone?: string,
): G[] {
  return gives.map((give) => {
    if (
      give.state === "live" &&
      give.afterEnd === "fade" &&
      give.endsAt != null &&
      give.endsAt <= nowMs
    ) {
      return { ...give, state: "finished", closedLabel: "Ended" };
    }
    if (give.openUntilLabel != null && give.endsAt != null && timeZone) {
      const label = openUntilPhrase(give.endsAt, timeZone, nowMs);
      if (label !== give.openUntilLabel) return { ...give, openUntilLabel: label };
    }
    return give;
  });
}

/** One card per give: keeps the first copy of each `pushId`, with how many
 *  groups the give reaches (the card can't show one group's mark for an
 *  all-school give). */
export function onePerGive<G extends { pushId: string }>(
  gives: readonly G[],
): (G & { groupCount: number })[] {
  const count = new Map<string, number>();
  for (const give of gives) count.set(give.pushId, (count.get(give.pushId) ?? 0) + 1);
  const seen = new Set<string>();
  const out: (G & { groupCount: number })[] = [];
  for (const give of gives) {
    if (seen.has(give.pushId)) continue;
    seen.add(give.pushId);
    out.push({ ...give, groupCount: count.get(give.pushId)! });
  }
  return out;
}

/**
 * The class meetings something was given in (`classId|dayKey`), which hide
 * that meeting's Up next. A carried open-until card (TRA-724) sits in a
 * later week's cell but wasn't given that day, so it doesn't count. A give
 * drawn in another class's slot (TRA-725) marks that slot, not its own
 * class's meeting.
 */
export function givenMeetingKeys(
  gives: readonly {
    place: string;
    carried?: boolean;
    classId: string | null;
    slotClassId?: string | null;
    dayKey: string;
  }[],
): Set<string> {
  return new Set(
    gives
      .filter((g) => g.place === "class" && !g.carried)
      .map((g) => `${g.slotClassId ?? g.classId}|${g.dayKey}`),
  );
}
