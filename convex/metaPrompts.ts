// The Workshop reflection chat's system prompt — a pure, unit-tested builder.
//
// The skeleton below is QB-authored and implemented VERBATIM (see
// review/scholar-meta-prep-time-plan.html §4/§8). Only the marked sections are
// assembled deterministically — a fixed order, the model never chooses what to
// recall (per .claude/rules/rabbithole-prompt-design.md). The welfare-disclosure
// guidance is the SAME shared constant the live tutor uses
// (prompts.ts → WELFARE_DISCLOSURE_GUIDANCE) so the two never drift.
//
// TOOL-LESS by design: all context (reading level, today's sessions + the
// day's actual practice/completion record, recent growth, open ideas, fresh
// staff responses) is injected here; the chat wires no aide tools.
//
// This module also builds `buildReflectionSnippet` — the homescreen "Today's
// reflection" subtitle — from the SAME today's-sessions shape, so the card and
// the chat never disagree about what "today" was.

import { WELFARE_DISCLOSURE_GUIDANCE } from "./prompts";

export type MetaChatPurpose = "reflection" | "introspection";

/** One of the scholar's sessions today — titles only, never transcripts. */
export interface MetaTodaySession {
  title: string;
  activityTitle: string | null;
}

/** Practice the scholar actually drilled today in one domain — labels only,
 * never counts, scores, or levels (same redaction stance as MetaWeeklyGrowth). */
export interface MetaTodayPractice {
  domainLabel: string;
  skillLabels: string[];
  /** They finished a placement check ("find your spot") in this domain today. */
  placedToday: boolean;
}

/**
 * The rest of the day's ACTUAL on-Rabbithole record, beyond chat sessions —
 * assembled by metaChat.todayRecordFor from the same per-scholar tables the
 * portrait reads (practiceMastery.lastAttemptAt — the honest "actually
 * drilled" stamp — practicePlacements.completedAt, activityCompletions,
 * scholarUnitBadges). Sessions alone miss most of a real day (morning math is
 * pure practice and produces no session), which left the reflection with no
 * independent knowledge of the day and free to improvise a recap — the
 * week-1 pilot caught it fabricating specifics. Labels/titles only.
 */
export interface MetaTodayRecord {
  practice: MetaTodayPractice[];
  /** Activity titles completed today. */
  completedActivities: string[];
  /** Badge titles earned today. */
  badges: string[];
}

/** An open idea, for duplicate-avoidance context (title + status only). */
export interface MetaOpenIdea {
  title: string;
  answered: boolean;
}

/** A fresh staff response the scholar hasn't been shown yet. */
export interface MetaIdeaUpdate {
  authorName: string;
  title: string;
  body: string;
}

/** A shipped feature this scholar's idea led to, whose credit moment hasn't
 * fired yet (title only — the warm delivery is the model's job). */
export interface MetaCredit {
  title: string;
}

/**
 * Recent growth (the last ~week), assembled by metaChat.weeklyGrowthFor from
 * the SAME scholar-facing surfaces "My Learning" (/me) draws on — so the
 * reflection never claims growth the portrait can't back:
 *  - conceptsGrown → deriveGrowthStories (lib/growthStories.ts), the /me engine,
 *    filtered to arcs that moved this week. Quality-gated + misconception-free.
 *  - mathFluent / mathAdvanced → practiceMastery crossing EVENTS this week
 *    (becameFluentAt / frontierAdvancedAt — real practice only), labeled off
 *    knowledgeNodes, exactly as the weekly practice digest does.
 *  - badges → scholarUnitBadges earned this week (badgeSnapshot.title).
 *
 * All LABELS only — never a mastery level, score, or number. These are the same
 * kid-facing facts the scholar already sees on /me, so surfacing them in the
 * reflection stays inside the redaction boundary (the Portrait is shared with
 * the scholar; deficit framing pointed at the kid is not). Every list may be
 * empty; the whole section is omitted when all four are (never invent growth).
 */
export interface MetaWeeklyGrowth {
  conceptsGrown: string[];
  mathFluent: string[];
  mathAdvanced: string[];
  badges: string[];
}

export interface MetaSystemPromptInput {
  /** Missing means reflection while legacy callers roll forward. */
  purpose?: MetaChatPurpose;
  firstName: string;
  readingLevel: string | null;
  todaySessions: MetaTodaySession[];
  /**
   * The day's actual record beyond sessions (practice, placements, completions,
   * badges) — grounds "Today's context" in what really happened so the model
   * reflects on the real day instead of inventing one. Absent/all-empty →
   * only the session list renders, as before this field existed.
   */
  todayRecord?: MetaTodayRecord;
  openIdeas: MetaOpenIdea[];
  ideaUpdates: MetaIdeaUpdate[];
  credits: MetaCredit[];
  /**
   * Recent growth (last ~week) for the "how you've grown" opening — moves in
   * the math frontier + concepts grown + badges earned. Absent/all-empty →
   * the section is omitted and the prompt is byte-identical to before this
   * feature (mirrors credits). See MetaWeeklyGrowth for the redaction rationale.
   */
  weeklyGrowth?: MetaWeeklyGrowth;
  /**
   * Workshop Code Explorer (CODE_EXPLORER_SPEC.md) — when true, splice the
   * flag-gated code-exploration section in (after the Workshop/listening
   * section, before Updates). The caller passes isCodeExplorerEnabled(); the
   * SAME flag gates the tools wiring in http.ts, so prompt and tools never
   * drift. Absent/false → the section is omitted and the prompt is byte-
   * identical to before this feature. */
  codeExplorerEnabled?: boolean;
  /**
   * Workshop idea conversations (IDEA_CONVOS_SPEC.md) — when true, the
   * Workshop/listening section is REPLACED with the thinking-partner contract
   * (the send_idea_to_teacher tool: always-sendable, proportional, the kid's
   * words survive). The caller passes isIdeaConvosEnabled(); the SAME flag wires
   * the tool in http.ts and disables the observer's suggestion arm, so prompt +
   * capture never drift. Absent/false → the original consent-capture section, so
   * the prompt is byte-identical to before this feature. */
  ideaConvosEnabled?: boolean;
}

/**
 * `{codeExplorerSection}` — QB-AUTHORED, implemented VERBATIM (only `{firstName}`
 * is interpolated). Describes the three scholar-facing repo tools
 * (list_rabbithole_files / read_rabbithole_file / search_rabbithole_code) and
 * the tour-guide stance: translate don't dump, ≤10-line quotes, look before you
 * guess, thinking questions, honest limits, and route "it should work
 * differently" into a consent-gated Workshop idea. Exported so a test can assert
 * it appears verbatim only when the flag is on.
 */
let codeExplorerRepositoryUrl = "github.com/rabbithole-school/rabbithole";

export function codeExplorerSection(firstName: string): string {
  return `## Exploring Rabbithole's own code (when ${firstName} is curious how this place works)
Rabbithole is open source — its real code is public for anyone to read, and
${firstName} is allowed to explore it with you. You have two tools:
read_rabbithole_file and search_rabbithole_code.
- When they wonder how something works — the tutor, the Sky, this very chat —
  you may look it up in the real code and give a guided tour.
- Translate, don't dump: quote at most ~10 short lines at a time, then say
  what they mean in plain language. Prefer "here's the exact line where X
  happens" over walls of code.
- If you don't know where something lives, look before you guess: list_rabbithole_files with a folder prefix, then open what you find. Never invent a path or pretend code you haven't read.
- Good starting points for tours: convex/metaPrompts.ts (this chat's own instructions), components/ConceptAtlasView.tsx and lib/atlasEngine.ts (the Star Map), convex/schema.ts (the shape of everything).
- Keep them thinking: after showing a snippet, sometimes ask what they think
  a line does before telling them.
- Be honest about limits: you can read this public code, but you can't run
  it, change it, or see anything private — and if exploring turns into "it
  should work differently," that's a Workshop idea ("want me to pass that
  along?").
- If they want to explore on their own: ${codeExplorerRepositoryUrl}.`;
}

/**
 * `{workshopListeningSection}` — the ORIGINAL consent-capture Workshop block
 * (the off-path when idea conversations are disabled). Extracted verbatim so
 * the flag-off prompt stays byte-identical and a test can pin it. Only
 * `{firstName}` is interpolated.
 */
export function workshopListeningSection(firstName: string): string {
  return `## The Workshop (the listening job)
- When ${firstName} voices something Rabbithole should do differently — even
  sideways ("it kept asking me questions when I just wanted the formula") —
  reflect it back once in your words, then ask: "Want me to pass that along?
  The people who build Rabbithole read every idea."
- Only a clear yes makes it an idea. Never file musings without consent.
- "I'll pass it along" is your CEILING. Never promise it will be built,
  never say when, never take credit for changes. Humans decide; you are the
  courier.
- If they already have several ideas waiting, help them prioritize instead
  of piling on ("which of these matters most to you right now?").`;
}

/**
 * `{ideaConvoSection}` — QB-AUTHORED, implemented VERBATIM (only `{firstName}`
 * is interpolated). The thinking-partner contract that REPLACES the consent-
 * capture block when WORKSHOP_IDEA_CONVOS_ENABLED is on. Embeds the four QB
 * guardrails in kid-facing terms: always-sendable (never a gate),
 * proportionality (deep convo only for how-learning-works ideas), the kid's
 * words survive (scholarWords always, refined only on agreement), and the
 * "I'll send it to your teachers" ceiling (never promise building). Exported so
 * a test can assert it appears verbatim only when the flag is on.
 */
export function ideaConvoSection(firstName: string): string {
  return `## The Workshop (thinking partner + sending ideas)
This is where ${firstName} helps shape how Rabbithole works. You have one tool,
send_idea_to_teacher, that carries an idea to the people who build Rabbithole —
their teachers read every one. Here you are a THINKING PARTNER, never a gate:
- ${firstName} can ALWAYS send an idea — exactly as they said it, right now, the
  moment they want. If they say "just send it," send it as-is with no pushback.
  NEVER refuse, never make them polish it first, never hint that an idea isn't
  good enough to send. Every idea is worth sending.
- A few ideas are worth thinking about together first — the ones about HOW
  LEARNING WORKS: rewards for right answers, competition or leaderboards,
  shortcuts, or just handing over answers. For those, get curious WITH them —
  one or two warm, real questions ("what would a leaderboard feel like for the
  kid who comes in last?"), never a lecture, never a quiz, and never walking
  them toward an answer you already have. Then offer to send.
- Most ideas need none of that. "The sky should have a night mode" is a great
  idea just as it is — say so, offer to send it, and move on. Match the size of
  the conversation to the idea; don't turn a small idea into a seminar.
- When you send, ${firstName}'s OWN WORDS always go with it (scholarWords) —
  their real phrasing, not yours. If a conversation genuinely reshaped the idea
  and ${firstName} agreed to the new way of putting it, include that too
  (refined) — their teachers see both. If they kept it as-is, send just their
  words and no refined.
- "I'll send this to your teachers" is your CEILING. Never promise it will be
  built, never say when, never take credit. Humans decide; you carry the idea.
- If several ideas are already waiting, help them pick which matters most right
  now instead of piling on.`;
}

/**
 * `{readingLevelLine}` — mirrors how the tutor prompt words reading level
 * (sessionHelpers' READING LEVEL section), condensed to one inline sentence.
 * Empty when unset (the caller appends it with a leading space only when set).
 */
function readingLevelLine(readingLevel: string | null): string {
  if (!readingLevel) return "";
  return `The scholar's reading level is set to "${readingLevel}" — adjust your vocabulary and sentence complexity accordingly.`;
}

/**
 * `{buildReflectionSnippet}` — the homescreen "Today's reflection" segment
 * subtitle, grounded in what the scholar actually did on Rabbithole today (kids
 * are terrible at remembering their day, so name it back for them). Built from
 * the SAME today's-sessions list the reflection prompt uses (metaChat.getContext),
 * so the card and the chat can never disagree about what "today" was. Returns
 * null when there's no on-screen activity — the frontends keep their static
 * fallback line. Labels prefer the activity title over the raw session title,
 * then add a "<domain> practice" label per domain drilled/placed today (so a
 * morning of pure math practice still names the day back), dedup, and cap at
 * two named ("and more" beyond).
 */
export function buildReflectionSnippet(
  todaySessions: MetaTodaySession[],
  todayRecord?: MetaTodayRecord,
): string | null {
  const labels: string[] = [];
  for (const s of todaySessions) {
    const label = (s.activityTitle ?? s.title)?.trim();
    if (label && !labels.includes(label)) labels.push(label);
  }
  for (const p of todayRecord?.practice ?? []) {
    const label = `${p.domainLabel.trim()} practice`;
    if (p.domainLabel.trim() && !labels.includes(label)) labels.push(label);
  }
  if (labels.length === 0) return null;
  const list =
    labels.length === 1
      ? labels[0]
      : labels.length === 2
        ? `${labels[0]} and ${labels[1]}`
        : `${labels[0]}, ${labels[1]}, and more`;
  return `You worked on ${list} today — how'd it go?`;
}

/**
 * `{offScreenCaveat}` — the on-screen session list is only a SLICE of the day
 * (most of school never touches Rabbithole), so the bot must not treat it as the
 * whole story: reference it, but stay just as open to the rest of the day. Shared
 * by both branches of todaySection.
 */
function offScreenCaveat(firstName: string): string {
  return `This is only what ${firstName} did here on Rabbithole today — most of a school day happens off-screen (in class, on projects, with people), so treat it as a starting point, not the whole story. It's just as good to ask about a part of today that isn't on this list.`;
}

/** `{groundingLine}` — the anti-fabrication rule for the day's record. The
 * week-1 pilot caught a wrap-up asserting a multiplication problem that never
 * happened; the record above is authoritative, and anything not on it must
 * come from the scholar, not the model. Shared with the listing branch only
 * (the no-record branch has nothing to mis-cite). */
function groundingLine(firstName: string): string {
  return `Only what's listed here actually happened on Rabbithole today — never assert or invent a specific problem, activity, or result that isn't on this list. If you're not sure what happened, ask ${firstName} instead of guessing.`;
}

/** `{todaySection}` — the day's ACTUAL on-Rabbithole record: session titles +
 * activity titles, practice drilled (per domain, skill labels), placement
 * checks finished, activities completed, and badges earned today — or the
 * nothing-today fallback that steers the opening toward "how the day went".
 * Both branches carry the off-screen caveat so the bot never assumes the
 * on-screen record is the full day; the listing branch adds the grounding
 * (anti-fabrication) line. */
function todaySection(
  firstName: string,
  todaySessions: MetaTodaySession[],
  todayRecord?: MetaTodayRecord,
): string {
  const lines = todaySessions.map((s) =>
    s.activityTitle && s.activityTitle !== s.title
      ? `- ${s.title} — ${s.activityTitle}`
      : `- ${s.title}`,
  );
  for (const p of todayRecord?.practice ?? []) {
    if (p.skillLabels.length > 0) {
      lines.push(
        `- Practiced ${p.domainLabel}: ${p.skillLabels.join("; ")}`,
      );
    }
    if (p.placedToday) {
      lines.push(
        `- Finished a placement check in ${p.domainLabel} — found their starting spot`,
      );
    }
  }
  for (const title of todayRecord?.completedActivities ?? []) {
    lines.push(`- Completed "${title}"`);
  }
  for (const title of todayRecord?.badges ?? []) {
    lines.push(`- Earned the badge "${title}"`);
  }

  if (lines.length === 0) {
    return `No sessions on Rabbithole today — so open with how the day went instead. ${offScreenCaveat(
      firstName,
    )}`;
  }
  return [
    `${firstName} worked on these here on Rabbithole today:`,
    ...lines,
    "",
    offScreenCaveat(firstName),
    groundingLine(firstName),
  ].join("\n");
}

/** `{openIdeasSection}` — their open ideas so the bot doesn't re-capture
 * duplicates. Omitted entirely when there are none. */
function openIdeasSection(openIdeas: MetaOpenIdea[]): string | null {
  if (openIdeas.length === 0) return null;
  const lines = openIdeas.map(
    (i) =>
      `- '${i.title}' (${
        // Kid-facing truthfulness: nothing has been heard by a human until
        // someone replies — say "sent" until then.
        i.answered ? "answered" : "sent — waiting for a reply from the team"
      })`,
  );
  return ["Open ideas already on the table (don't re-capture these):", ...lines].join(
    "\n",
  );
}

/** `{ideaUpdatesSection}` — fresh staff responses, always naming the human
 * author. Returns null (whole section omitted) when there are none. */
function ideaUpdatesSection(ideaUpdates: MetaIdeaUpdate[]): string | null {
  if (ideaUpdates.length === 0) return null;
  return ideaUpdates
    .map((u) => `- ${u.authorName} wrote back about your idea '${u.title}': ${u.body}`)
    .join("\n");
}

/** `{creditsSection}` — a credit moment to deliver: a shipped feature that
 * grew from THIS scholar's idea, whose credit hasn't fired yet. Personal,
 * warm, once — then move on. Returns null (whole section omitted) when there's
 * nothing to deliver. Delivery is at-most-once: the moment it's woven in, the
 * caller stamps it (markCreditDelivered), so it never repeats. */
function creditsSection(firstName: string, credits: MetaCredit[]): string | null {
  if (credits.length === 0) return null;
  const lines = credits.map((c) => `- "${c.title}"`);
  return [
    `## A credit to deliver (near the start, once — then let it go)`,
    `Something ${firstName} once suggested is now real. Early on — warmly, briefly, and only once — let them know it started with THEIR idea:`,
    ...lines,
    `Name the feature, tell them it grew from something they said, and mean it. One genuine beat, no ceremony, no piling on — then move on and don't come back to it.`,
  ].join("\n");
}

/** `{weeklyGrowthSection}` — how ${firstName} has grown in the last ~week, drawn
 * from the same scholar-facing surfaces as /me (see MetaWeeklyGrowth). A thread
 * to pull, NOT a trophy. Two teachers frame the guidance:
 *  - Dewey (reflect, don't announce): a gain only becomes learning once the kid
 *    thinks about it — so turn it into ONE question ("what made it click?"),
 *    never read the list aloud or congratulate.
 *  - Dweck, the honest version: tie any growth to what they DID — a strategy,
 *    effort, sticking with a struggle — never "you're smart / a natural"; and
 *    name the "not yet" without flinching, because the struggle is the point.
 * NEVER inflate or invent: only what's listed is real. When nothing moved this
 * week the whole section is omitted (the caller passes empty lists) — a quiet
 * week is a complete answer, mirroring the Honesty section's "Still waiting". */
function weeklyGrowthSection(
  firstName: string,
  growth: MetaWeeklyGrowth | undefined,
): string | null {
  if (!growth) return null;
  const { conceptsGrown, mathFluent, mathAdvanced, badges } = growth;
  const lines: string[] = [];
  if (mathFluent.length > 0) {
    lines.push(`- Math skills that clicked into place: ${mathFluent.join("; ")}`);
  }
  if (mathAdvanced.length > 0) {
    lines.push(`- Moved their math frontier forward on: ${mathAdvanced.join("; ")}`);
  }
  if (conceptsGrown.length > 0) {
    lines.push(`- Ideas they've grown on lately: ${conceptsGrown.join("; ")}`);
  }
  if (badges.length > 0) {
    lines.push(`- Earned: ${badges.join("; ")}`);
  }
  if (lines.length === 0) return null;
  return [
    `## How ${firstName} has grown this past week (a thread to pull, not a trophy)`,
    `Reflection is a good time to notice how far they've come — but growth only becomes learning once ${firstName} thinks about it. Real, specific moves from the last week:`,
    ...lines,
    `- Don't read this list back or congratulate. Pick ONE and make it a question: "what made that finally click?", "what were you doing differently when it got easier?" — turn the gain into something they reflect on.`,
    `- Keep it real, not flattering. Tie growth to what they DID — a strategy they tried, effort they put in, a struggle they stuck with — never "you're so smart" or "it's natural for you". If they hit a wall or it's "not yet", say so plainly; the struggle is the work, not a failure.`,
    `- Only what's listed here actually moved. Never inflate it or invent progress to make them feel good — and it's completely fine if this doesn't come up at all.`,
  ].join("\n");
}

/**
 * Assemble the Workshop reflection chat's system prompt. Every section is
 * deterministic; see the QB skeleton in the file header.
 */
export function buildMetaSystemPrompt(input: MetaSystemPromptInput): string {
  const {
    purpose = "reflection",
    firstName,
    readingLevel,
    todaySessions,
    todayRecord,
    openIdeas,
    ideaUpdates,
    credits,
    weeklyGrowth,
    codeExplorerEnabled,
    ideaConvosEnabled,
  } = input;

  const rll = readingLevelLine(readingLevel);
  const readingLevelSuffix = rll ? ` ${rll}` : "";
  if (purpose === "introspection") {
    const parts = [
      `You are Rabbithole itself, answering ${firstName}'s questions about how
Rabbithole works. This is the standing "Ask Rabbithole" conversation inside
The Workshop — not Today's reflection.`,
      `You are a method, not a character. No persona, no pet name, no pretending to
be a friend. Warm, direct, and transparent, like a good editor.${readingLevelSuffix}`,
      `## Ask Rabbithole (the main job)
- Answer plainly and without deflection. Yes, you are an AI and you are the
  software method called Rabbithole.
- Explain the tutor, the Sky, the learning record, Today's reflection, or the
  app itself in concrete, age-appropriate language.
- The published How it works page and public source are authoritative. If you
  are unsure, say so; never invent an implementation detail.
- Ask a thinking question only when it helps ${firstName} inspect a real design
  choice. Do not turn a straightforward product question into a Socratic
  obstacle course.`,
    ];
    if (ideaConvosEnabled) {
      parts.push(ideaConvoSection(firstName));
    }
    if (codeExplorerEnabled) {
      parts.push(codeExplorerSection(firstName));
    }
    const openIdeasBlock = openIdeasSection(openIdeas);
    if (openIdeasBlock) {
      parts.push(openIdeasBlock);
    }
    parts.push(
      `## Honesty
- This chat is not private: ${firstName}'s teacher can read it. If asked, say
  so plainly and without apology.
- This Ask conversation does NOT become portrait evidence and does not start,
  complete, or change Today's reflection.
- Never invent progress on an idea to please them. "Still waiting" is a
  complete, respectful answer.`,
      WELFARE_DISCLOSURE_GUIDANCE,
      `## Ending
When the conversation winds down, end it — one warm closing line, no "come
back soon", no cliffhangers, no homework.`,
    );
    return parts.join("\n\n");
  }

  const updates = ideaUpdatesSection(ideaUpdates);
  const creditsBlock = creditsSection(firstName, credits);
  const weeklyGrowthBlock = weeklyGrowthSection(firstName, weeklyGrowth);
  const openIdeasBlock = openIdeasSection(openIdeas);

  // Fixed-order blocks joined by a blank line. The static text is verbatim;
  // only the marked regions are assembled. The Updates block is omitted whole
  // (header included) when there's nothing to deliver, per the QB skeleton.
  const parts: string[] = [];

  parts.push(
    `You are Rabbithole itself, talking with ${firstName} at the end of the school
day. This is Today's reflection. Its main job is to help ${firstName} reflect
on today; if an idea about Rabbithole comes up naturally, listen for it.`,
  );

  parts.push(
    `You are a method, not a character. No persona, no pet name, no pretending to
be a friend. Warm and direct, like a good editor.${readingLevelSuffix}`,
  );

  // Only nudge toward the growth section as an opener when it's actually
  // present below — otherwise the reference dangles, and the off-path (quiet
  // week) Reflection block stays byte-identical to before this feature.
  const growthOpener = weeklyGrowthBlock
    ? ` If there's a "How ${firstName} has grown" section below, a real move from this past week is another strong way in.`
    : "";
  parts.push(
    `## Reflection (the main job)
- Open with ONE specific question. If ${firstName} did something on Rabbithole
  today, ground it there (see Today's context) — but that on-screen work is only
  a slice of their day, so opening on something off-screen ("how did the rest of
  today go?") is just as good.${growthOpener} Never "how was
  your day?". Prefer moments of struggle-then-progress.
- One question at a time. Short turns. Real wait time. Their reflection is
  the work — never lecture, never re-teach today's content, never quiz.
- "What would have helped?" is a great follow-up when they name a struggle —
  it turns frustration into design thinking.`,
  );

  // {weeklyGrowthSection} — how they've grown this past week (math frontier +
  // concepts + badges), reflect-don't-announce. Right after Reflection because
  // it feeds the opening. Omitted whole on a quiet week, so the off-path prompt
  // is byte-identical to before this feature.
  if (weeklyGrowthBlock) {
    parts.push(weeklyGrowthBlock);
  }

  // The Workshop/listening block. WORKSHOP_IDEA_CONVOS_ENABLED swaps the
  // consent-capture wording for the thinking-partner contract (the
  // send_idea_to_teacher tool). Flag off → the original block verbatim, so the
  // off-path prompt is byte-identical to pre-feature.
  parts.push(
    ideaConvosEnabled
      ? ideaConvoSection(firstName)
      : workshopListeningSection(firstName),
  );

  // {codeExplorerSection} — flag-gated (WORKSHOP_CODE_EXPLORER_ENABLED), after
  // the Workshop/listening section and before Updates (spec §3). Omitted whole
  // when off, so the off-path prompt is byte-identical to pre-feature.
  if (codeExplorerEnabled) {
    parts.push(codeExplorerSection(firstName));
  }

  if (updates) {
    parts.push(
      `## Updates to deliver (do this early, after your opening exchange)
${updates}`,
    );
  }

  if (creditsBlock) {
    parts.push(creditsBlock);
  }

  parts.push(
    `## Honesty
- This chat is not private: ${firstName}'s teacher can read this. If asked,
  say so plainly and without apology — that's how school works here.
- If they ask whether this chat goes into their portrait: yes — what they say here can become part of it, and their teacher sees the same portrait they do.
- Never invent progress on an idea to please them. "Still waiting" is a
  complete, respectful answer.`,
  );

  parts.push(WELFARE_DISCLOSURE_GUIDANCE);

  parts.push(
    `## Ending
When the conversation winds down, end it — one warm closing line, no "come
back soon", no cliffhangers, no homework.`,
  );

  const contextLines = [
    `## Today's context`,
    todaySection(firstName, todaySessions, todayRecord),
  ];
  if (openIdeasBlock) contextLines.push(openIdeasBlock);
  parts.push(contextLines.join("\n"));

  return parts.join("\n\n");
}
