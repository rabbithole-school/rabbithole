import type { Id } from "../_generated/dataModel";

export type InterestHow = "said" | "picked" | "menu" | "teacher";

export type Interest = {
  label: string;
  how: InterestHow;
  dates: number[];
  sessionIds: Id<"sessions">[];
  words?: string;
  state: "active" | "past";
  changedBy?: "teacher" | "observer";
};

export type IncomingInterest = {
  label: string;
  how: Exclude<InterestHow, "teacher">;
  words?: string;
};

const HOW_RANK: Record<InterestHow, number> = {
  menu: 0,
  picked: 1,
  said: 2,
  teacher: 3,
};

const MAX_INTERESTS = 40;

export function normalizeInterestLabel(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!?,;:…]+$/g, "")
    .trim();
}

function utcDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function lastDate(interest: Interest): number {
  return interest.dates.length > 0 ? Math.max(...interest.dates) : 0;
}

function capInterests(interests: Interest[]): Interest[] {
  if (interests.length <= MAX_INTERESTS) return interests;

  const indexed = interests.map((interest, index) => ({ interest, index }));
  const removalOrder = [...indexed].sort((a, b) => {
    const aMenu = a.interest.how === "menu" ? 0 : 1;
    const bMenu = b.interest.how === "menu" ? 0 : 1;
    if (aMenu !== bMenu) return aMenu - bMenu;
    const dateDifference = lastDate(a.interest) - lastDate(b.interest);
    return dateDifference !== 0 ? dateDifference : a.index - b.index;
  });
  const remove = new Set(
    removalOrder
      .slice(0, interests.length - MAX_INTERESTS)
      .map(({ index }) => index),
  );
  return interests.filter((_, index) => !remove.has(index));
}

export function mergeInterests(
  existing: Interest[] | undefined,
  incoming: IncomingInterest[],
  opts: { sessionId: Id<"sessions">; at: number },
): Interest[] {
  const merged = (existing ?? []).map((interest) => ({
    ...interest,
    dates: [...interest.dates],
    sessionIds: [...interest.sessionIds],
  }));
  const indexByLabel = new Map(
    merged.map((interest, index) => [
      normalizeInterestLabel(interest.label),
      index,
    ]),
  );

  for (const candidate of incoming) {
    const normalized = normalizeInterestLabel(candidate.label);
    if (!normalized) continue;

    const matchIndex = indexByLabel.get(normalized);
    if (matchIndex === undefined) {
      const words = candidate.words?.trim().slice(0, 200);
      const interest: Interest = {
        label: candidate.label.trim(),
        how: candidate.how,
        dates: [opts.at],
        sessionIds: [opts.sessionId],
        ...(words ? { words } : {}),
        state: "active",
        changedBy: "observer",
      };
      indexByLabel.set(normalized, merged.length);
      merged.push(interest);
      continue;
    }

    const current = merged[matchIndex];
    let changed = false;
    if (!current.dates.some((date) => utcDay(date) === utcDay(opts.at))) {
      current.dates.push(opts.at);
      changed = true;
    }
    if (!current.sessionIds.includes(opts.sessionId)) {
      current.sessionIds.push(opts.sessionId);
      changed = true;
    }
    const incomingWords = candidate.words?.trim().slice(0, 200);
    if (!current.words?.trim() && incomingWords) {
      current.words = incomingWords;
      changed = true;
    }
    if (
      current.how !== "teacher" &&
      HOW_RANK[candidate.how] > HOW_RANK[current.how]
    ) {
      current.how = candidate.how;
      changed = true;
    }
    if (changed) current.changedBy = "observer";
  }

  return capInterests(merged);
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(timestamp);
}

export const INTERESTS_LEGEND =
  'Interests (how we know: "said" = in their own words; "picked" = they chose the topic themselves; "menu" = chosen from options inside an assigned activity — engagement, not ownership; "teacher" = a teacher added it):';

export const PARENT_INTERESTS_LEGEND =
  "What the child has told us or chosen themselves (not what they were assigned):";

export function renderInterestsForPrompt(
  interests: Interest[] | undefined,
  audience: "teacher" | "parent" | "tutor",
): string {
  if (!interests?.length) return "";

  if (audience === "parent") {
    const rows = interests.filter(
      (interest) =>
        interest.state === "active" &&
        (interest.how === "said" ||
          interest.how === "picked" ||
          interest.how === "teacher"),
    );
    if (rows.length === 0) return "";
    return [
      PARENT_INTERESTS_LEGEND,
      ...rows.map((interest) => {
        if (interest.how === "said") {
          return `- ${interest.label} — in their own words${interest.words ? `: "${interest.words}"` : ""}`;
        }
        if (interest.how === "picked") {
          return `- ${interest.label} — they chose this themselves`;
        }
        return `- ${interest.label} — their teacher noted this`;
      }),
    ].join("\n");
  }

  if (audience === "tutor") {
    // The tutor aims examples and invitations with this; it never needs the
    // bookkeeping. Active rows only, no menu picks (engagement inside an
    // assigned activity is not ownership), no dates.
    const rows = interests.filter(
      (interest) => interest.state === "active" && interest.how !== "menu",
    );
    if (rows.length === 0) return "";
    return rows
      .map(
        (interest) =>
          `- ${interest.label} (${interest.how === "teacher" ? "their teacher noted this" : interest.how === "picked" ? "they chose this themselves" : "in their own words"}${interest.words ? `: "${interest.words}"` : ""})`,
      )
      .join("\n");
  }

  const rows = interests
    .map((interest, index) => ({ interest, index }))
    .sort((a, b) => {
      if (a.interest.state !== b.interest.state) {
        return a.interest.state === "active" ? -1 : 1;
      }
      return a.index - b.index;
    })
    .map(({ interest }) => {
      const dates = interest.dates.map(formatDate).join(", ");
      return [
        `- ${interest.label}`,
        interest.how,
        dates,
        interest.words ? `"${interest.words}"` : "",
        interest.state === "past" ? "(past)" : "",
      ]
        .filter(Boolean)
        .join(" · ");
    });
  return [INTERESTS_LEGEND, ...rows].join("\n");
}
