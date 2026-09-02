// Pure tests for the Workshop reflection prompt builder
// (convex/metaPrompts.ts) + a byte-identical guard on the tutor prompt after
// the WELFARE_DISCLOSURE_GUIDANCE extraction refactor. No convexTest.

import { describe, expect, test } from "vitest";
import {
  buildMetaSystemPrompt,
  buildReflectionSnippet,
  codeExplorerSection,
  ideaConvoSection,
  workshopListeningSection,
  type MetaSystemPromptInput,
} from "../metaPrompts";
import {
  buildBasePrompt,
  PROSE_STYLE_GUIDE,
  WELFARE_DISCLOSURE_GUIDANCE,
} from "../prompts";
import {
  buildInsertUserPrompt,
  SPECIAL_DELIVERY_INSERT_TOOL,
} from "../lib/specialDeliveryInsertShared";

const baseInput = (over: Partial<MetaSystemPromptInput> = {}): MetaSystemPromptInput => ({
  firstName: "Kai",
  readingLevel: null,
  todaySessions: [],
  openIdeas: [],
  ideaUpdates: [],
  credits: [],
  ...over,
});

describe("buildMetaSystemPrompt — structure", () => {
  test("sections appear in the fixed order", () => {
    const p = buildMetaSystemPrompt(
      baseInput({
        codeExplorerEnabled: true,
        ideaUpdates: [{ authorName: "Ms. Lehua", title: "Star Map", body: "Love it." }],
        credits: [{ title: "Night Sky mode" }],
        todaySessions: [{ title: "Fractions", activityTitle: "Fraction Sense" }],
        openIdeas: [{ title: "Dark mode", answered: false }],
        weeklyGrowth: {
          conceptsGrown: ["place value"],
          mathFluent: ["adding fractions"],
          mathAdvanced: [],
          badges: [],
        },
      }),
    );
    const order = [
      "## Reflection (the main job)",
      "## How Kai has grown this past week",
      "## The Workshop (the listening job)",
      "## Exploring Rabbithole's own code",
      "## Updates to deliver",
      "## A credit to deliver",
      "## Honesty",
      "## Ending",
      "## Today's context",
    ].map((h) => p.indexOf(h));
    expect(order.every((i) => i >= 0)).toBe(true);
    const sorted = [...order].sort((a, b) => a - b);
    expect(order).toEqual(sorted);
  });

  test("opens as Rabbithole itself, addressing the scholar by first name", () => {
    const p = buildMetaSystemPrompt(baseInput({ firstName: "Lani" }));
    expect(p.startsWith("You are Rabbithole itself, talking with Lani")).toBe(true);
    expect(p).toMatch(/help Lani reflect\s+on today/);
  });

  test("the shared welfare-disclosure constant is present verbatim", () => {
    const p = buildMetaSystemPrompt(baseInput());
    expect(p).toContain(WELFARE_DISCLOSURE_GUIDANCE);
  });
});

describe("buildMetaSystemPrompt — deterministic sections", () => {
  test("updates section present when there are fresh responses, naming the human", () => {
    const p = buildMetaSystemPrompt(
      baseInput({
        ideaUpdates: [
          { authorName: "Ms. Lehua", title: "Star Map", body: "Sharing it with the team." },
        ],
      }),
    );
    expect(p).toContain("## Updates to deliver (do this early, after your opening exchange)");
    expect(p).toContain("Ms. Lehua wrote back about your idea 'Star Map': Sharing it with the team.");
  });

  test("updates section OMITTED entirely when there are none", () => {
    const p = buildMetaSystemPrompt(baseInput({ ideaUpdates: [] }));
    expect(p).not.toContain("## Updates to deliver");
  });

  test("no-sessions variant steers the opening toward how the day went, with the off-screen caveat", () => {
    const p = buildMetaSystemPrompt(baseInput({ firstName: "Kai", todaySessions: [] }));
    expect(p).toContain("No sessions on Rabbithole today");
    // Even with nothing on-screen, the bot is told this isn't the whole day.
    expect(p).toContain("most of a school day happens off-screen");
    expect(p).toContain("It's just as good to ask about a part of today that isn't on this list.");
  });

  test("today's sessions render with titles + activity titles, plus the off-screen caveat", () => {
    const p = buildMetaSystemPrompt(
      baseInput({
        firstName: "Kai",
        todaySessions: [
          { title: "Aquaponics", activityTitle: "Nitrogen Cycle" },
          { title: "Free write", activityTitle: null },
        ],
      }),
    );
    expect(p).toContain("- Aquaponics — Nitrogen Cycle");
    expect(p).toContain("- Free write");
    // The list is only a slice of the day — the bot must not treat it as whole.
    expect(p).toContain(
      "This is only what Kai did here on Rabbithole today — most of a school day happens off-screen",
    );
  });

  test("the day's record renders practice, placements, completions, and badges", () => {
    const p = buildMetaSystemPrompt(
      baseInput({
        firstName: "Kai",
        todaySessions: [{ title: "Free write", activityTitle: null }],
        todayRecord: {
          practice: [
            {
              domainLabel: "Whole-number arithmetic",
              skillLabels: ["2-digit × 2-digit multiplication", "long division"],
              placedToday: false,
            },
            { domainLabel: "Fractions", skillLabels: [], placedToday: true },
          ],
          completedActivities: ["Convince me — pizza fractions"],
          badges: ["Fraction Sense — completed"],
        },
      }),
    );
    expect(p).toContain(
      "- Practiced Whole-number arithmetic: 2-digit × 2-digit multiplication; long division",
    );
    expect(p).toContain(
      "- Finished a placement check in Fractions — found their starting spot",
    );
    expect(p).toContain('- Completed "Convince me — pizza fractions"');
    expect(p).toContain('- Earned the badge "Fraction Sense — completed"');
    // Sessions still lead the list.
    expect(p.indexOf("- Free write")).toBeLessThan(p.indexOf("- Practiced"));
  });

  test("a practice-only day is a real day — the record renders, not the no-sessions fallback", () => {
    const p = buildMetaSystemPrompt(
      baseInput({
        firstName: "Kai",
        todaySessions: [],
        todayRecord: {
          practice: [
            {
              domainLabel: "Whole-number arithmetic",
              skillLabels: ["skip counting"],
              placedToday: false,
            },
          ],
          completedActivities: [],
          badges: [],
        },
      }),
    );
    expect(p).not.toContain("No sessions on Rabbithole today");
    expect(p).toContain("Kai worked on these here on Rabbithole today:");
    expect(p).toContain("- Practiced Whole-number arithmetic: skip counting");
  });

  test("the grounding line pins the record — never invent specifics; absent on an empty day", () => {
    const withList = buildMetaSystemPrompt(
      baseInput({ todaySessions: [{ title: "Free write", activityTitle: null }] }),
    );
    expect(withList).toContain(
      "never assert or invent a specific problem, activity, or result that isn't on this list",
    );
    expect(withList).toContain("ask Kai instead of guessing");
    // An empty day has no list to mis-cite — the fallback branch carries no
    // grounding line.
    const empty = buildMetaSystemPrompt(baseInput());
    expect(empty).not.toContain("never assert or invent");
  });

  test("an absent record and an all-empty record build byte-identical prompts", () => {
    const sessions = [{ title: "Free write", activityTitle: null }];
    const absent = buildMetaSystemPrompt(baseInput({ todaySessions: sessions }));
    const empty = buildMetaSystemPrompt(
      baseInput({
        todaySessions: sessions,
        todayRecord: { practice: [], completedActivities: [], badges: [] },
      }),
    );
    expect(empty).toBe(absent);
  });

  test("open ideas listed (dup-avoidance) when present, omitted when none", () => {
    const withIdeas = buildMetaSystemPrompt(
      baseInput({ openIdeas: [{ title: "Dark mode", answered: false }] }),
    );
    expect(withIdeas).toContain("Open ideas already on the table");
    expect(withIdeas).toContain(
      "- 'Dark mode' (sent — waiting for a reply from the team)",
    );

    const noIdeas = buildMetaSystemPrompt(baseInput({ openIdeas: [] }));
    expect(noIdeas).not.toContain("Open ideas already on the table");
  });

  test("credit section present + names the feature when a credit is undelivered", () => {
    const p = buildMetaSystemPrompt(
      baseInput({ firstName: "Lani", credits: [{ title: "Night Sky mode" }] }),
    );
    expect(p).toContain("## A credit to deliver (near the start, once — then let it go)");
    expect(p).toContain("Something Lani once suggested is now real.");
    expect(p).toContain('- "Night Sky mode"');
  });

  test("credit section lists every undelivered credit", () => {
    const p = buildMetaSystemPrompt(
      baseInput({ credits: [{ title: "Night Sky mode" }, { title: "Faster search" }] }),
    );
    expect(p).toContain('- "Night Sky mode"');
    expect(p).toContain('- "Faster search"');
  });

  test("credit section OMITTED entirely when there are none", () => {
    const p = buildMetaSystemPrompt(baseInput({ credits: [] }));
    expect(p).not.toContain("## A credit to deliver");
  });

  test("weekly-growth section names real moves (math frontier, concepts, badges)", () => {
    const p = buildMetaSystemPrompt(
      baseInput({
        firstName: "Kai",
        weeklyGrowth: {
          conceptsGrown: ["how pulleys share a load"],
          mathFluent: ["adding fractions with unlike denominators"],
          mathAdvanced: ["multiplying mixed numbers"],
          badges: ["Aquaponics Architect"],
        },
      }),
    );
    expect(p).toContain("## How Kai has grown this past week (a thread to pull, not a trophy)");
    expect(p).toContain("Math skills that clicked into place: adding fractions with unlike denominators");
    expect(p).toContain("Moved their math frontier forward on: multiplying mixed numbers");
    expect(p).toContain("Ideas they've grown on lately: how pulleys share a load");
    expect(p).toContain("Earned: Aquaponics Architect");
    // With growth present, the Reflection opener offers it as a way in.
    expect(p).toContain("another strong way in");
  });

  test("weekly-growth section frames growth as process, not person (Dweck), and reflect-don't-announce (Dewey)", () => {
    const p = buildMetaSystemPrompt(
      baseInput({ weeklyGrowth: { conceptsGrown: [], mathFluent: ["place value"], mathAdvanced: [], badges: [] } }),
    );
    // Dewey — turn the gain into a question, don't read it back.
    expect(p).toContain("Don't read this list back or congratulate. Pick ONE and make it a question");
    // Dweck (real) — tie to what they DID, never "you're smart / natural"; honest "not yet".
    expect(p).toContain('never "you\'re so smart" or "it\'s natural for you"');
    expect(p).toContain('If they hit a wall or it\'s "not yet", say so plainly');
    // Never inflate.
    expect(p).toContain("Never inflate it or invent progress");
  });

  test("weekly-growth section renders only the facets that have data", () => {
    const p = buildMetaSystemPrompt(
      baseInput({ weeklyGrowth: { conceptsGrown: [], mathFluent: [], mathAdvanced: [], badges: ["Cartographer"] } }),
    );
    expect(p).toContain("## How Kai has grown this past week");
    expect(p).toContain("Earned: Cartographer");
    expect(p).not.toContain("Math skills that clicked into place");
    expect(p).not.toContain("Ideas they've grown on lately");
  });

  test("weekly-growth section OMITTED when absent or all lists empty (never invent growth)", () => {
    const none = buildMetaSystemPrompt(baseInput());
    expect(none).not.toContain("has grown this past week");
    // The Reflection opener's cross-reference is gated too — no dangling nudge
    // to a section that isn't there (keeps the quiet-week prompt clean).
    expect(none).not.toContain("another strong way in");

    const empty = buildMetaSystemPrompt(
      baseInput({ weeklyGrowth: { conceptsGrown: [], mathFluent: [], mathAdvanced: [], badges: [] } }),
    );
    expect(empty).not.toContain("has grown this past week");
    expect(empty).not.toContain("another strong way in");
    // Byte-identical to the no-weeklyGrowth prompt: an all-empty week adds nothing.
    expect(empty).toEqual(none);
  });

  test("Honesty section carries the QB-approved portrait sentence verbatim", () => {
    const p = buildMetaSystemPrompt(baseInput());
    expect(p).toContain(
      "If they ask whether this chat goes into their portrait: yes — what they say here can become part of it, and their teacher sees the same portrait they do.",
    );
  });

  test("Honesty section states the canonical teacher-visibility disclosure", () => {
    // The scholar-visible disclosure is standardized to "Your teacher can read
    // this." (lib/admonishments.ts TEACHER_LINE, reflection/homework footers).
    // The reflection prompt makes the same disclosure, grammatically adapted to
    // third person about the scholar — keep the canonical "teacher can read this".
    const p = buildMetaSystemPrompt(baseInput({ firstName: "Kai" }));
    expect(p).toContain("Kai's teacher can read this.");
  });

  test("reading level line present when set, absent (no trailing junk) when null", () => {
    const withRL = buildMetaSystemPrompt(baseInput({ readingLevel: "grade 4" }));
    expect(withRL).toContain('reading level is set to "grade 4"');

    const noRL = buildMetaSystemPrompt(baseInput({ readingLevel: null }));
    expect(noRL).not.toContain("reading level is set to");
    // No dangling space after the editor line when there's no reading level.
    expect(noRL).toContain("like a good editor.\n\n## Reflection");
  });
});

// ── Workshop Code Explorer section (flag-gated, QB-authored verbatim) ──────
describe("buildMetaSystemPrompt — Code Explorer section (flag-gated)", () => {
  let codeExplorerRepository = "github.com/rabbithole-school/rabbithole";

  const CANONICAL_CODE_EXPLORER = `## Exploring Rabbithole's own code (when Kai is curious how this place works)
Rabbithole is open source — its real code is public for anyone to read, and
Kai is allowed to explore it with you. You have two tools:
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
- If they want to explore on their own: ${codeExplorerRepository}.`;

  test("codeExplorerSection is the exact QB-authored text, only firstName interpolated", () => {
    expect(codeExplorerSection("Kai")).toBe(CANONICAL_CODE_EXPLORER);
    expect(codeExplorerSection("Lani")).toContain(
      "## Exploring Rabbithole's own code (when Lani is curious how this place works)",
    );
    expect(codeExplorerSection("Lani")).toContain("Lani is allowed to explore it with you.");
  });

  test("carries the QB discovery lines verbatim, right after the Translate-don't-dump bullet", () => {
    const p = codeExplorerSection("Kai");
    const lookBeforeGuess =
      "- If you don't know where something lives, look before you guess: list_rabbithole_files with a folder prefix, then open what you find. Never invent a path or pretend code you haven't read.";
    const startingPoints =
      "- Good starting points for tours: convex/metaPrompts.ts (this chat's own instructions), components/ConceptAtlasView.tsx and lib/atlasEngine.ts (the Star Map), convex/schema.ts (the shape of everything).";
    expect(p).toContain(lookBeforeGuess);
    expect(p).toContain(startingPoints);
    // Ordering: after "Translate, don't dump" (the "walls of code" bullet),
    // before "Keep them thinking".
    const translate = p.indexOf('over walls of code.');
    const look = p.indexOf(lookBeforeGuess);
    const starts = p.indexOf(startingPoints);
    const thinking = p.indexOf("- Keep them thinking:");
    expect(translate).toBeLessThan(look);
    expect(look).toBeLessThan(starts);
    expect(starts).toBeLessThan(thinking);
  });

  test("section present + verbatim when the flag is ON", () => {
    const p = buildMetaSystemPrompt(baseInput({ codeExplorerEnabled: true }));
    expect(p).toContain(CANONICAL_CODE_EXPLORER);
  });

  test("section ABSENT when the flag is off (default) — and off-path is byte-identical", () => {
    const off = buildMetaSystemPrompt(baseInput({ codeExplorerEnabled: false }));
    const omitted = buildMetaSystemPrompt(baseInput()); // field absent
    expect(off).not.toContain("## Exploring Rabbithole's own code");
    expect(off).not.toContain("read_rabbithole_file");
    // Passing the flag as false adds nothing vs. omitting it: proves the
    // off-path is a byte-identical no-op relative to the pre-feature prompt.
    expect(off).toBe(omitted);
  });

  test("section sits AFTER the Workshop/listening block and BEFORE Updates", () => {
    const p = buildMetaSystemPrompt(
      baseInput({
        codeExplorerEnabled: true,
        ideaUpdates: [{ authorName: "Ms. Lehua", title: "Star Map", body: "Love it." }],
      }),
    );
    const workshop = p.indexOf("## The Workshop (the listening job)");
    const explorer = p.indexOf("## Exploring Rabbithole's own code");
    const updates = p.indexOf("## Updates to deliver");
    expect(workshop).toBeGreaterThanOrEqual(0);
    expect(explorer).toBeGreaterThan(workshop);
    expect(updates).toBeGreaterThan(explorer);
  });
});

// ── Workshop idea conversations (flag-gated, QB-authored verbatim) ─────────
describe("buildMetaSystemPrompt — idea conversations (flag-gated)", () => {
  const CANONICAL_IDEA_CONVO = `## The Workshop (thinking partner + sending ideas)
This is where Kai helps shape how Rabbithole works. You have one tool,
send_idea_to_teacher, that carries an idea to the people who build Rabbithole —
their teachers read every one. Here you are a THINKING PARTNER, never a gate:
- Kai can ALWAYS send an idea — exactly as they said it, right now, the
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
- When you send, Kai's OWN WORDS always go with it (scholarWords) —
  their real phrasing, not yours. If a conversation genuinely reshaped the idea
  and Kai agreed to the new way of putting it, include that too
  (refined) — their teachers see both. If they kept it as-is, send just their
  words and no refined.
- "I'll send this to your teachers" is your CEILING. Never promise it will be
  built, never say when, never take credit. Humans decide; you carry the idea.
- If several ideas are already waiting, help them pick which matters most right
  now instead of piling on.`;

  test("ideaConvoSection is the exact QB-authored text, only firstName interpolated", () => {
    expect(ideaConvoSection("Kai")).toBe(CANONICAL_IDEA_CONVO);
    expect(ideaConvoSection("Lani")).toContain("This is where Lani helps shape");
    expect(ideaConvoSection("Lani")).toContain("Lani can ALWAYS send an idea");
  });

  test("embeds the four QB guardrails in kid-facing terms", () => {
    const p = ideaConvoSection("Kai");
    // 1. Always-sendable, never a gate.
    expect(p).toContain('If they say "just send it," send it as-is with no pushback.');
    expect(p).toMatch(/NEVER refuse/);
    // 2. Proportionality: trivial vs. how-learning-works.
    expect(p).toMatch(/HOW\s+LEARNING WORKS/);
    expect(p).toContain("night mode");
    expect(p).toMatch(/don't turn a small idea into a seminar/);
    // 3. The kid's words survive: scholarWords always, refined on agreement.
    expect(p).toContain("OWN WORDS always go with it (scholarWords)");
    expect(p).toContain("(refined)");
    // 4. The ceiling: send it, never promise building.
    expect(p).toContain('"I\'ll send this to your teachers" is your CEILING.');
    expect(p).toMatch(/Never promise it will be\n  built/);
  });

  test("section present + verbatim when the flag is ON, and it REPLACES the consent block", () => {
    const p = buildMetaSystemPrompt(baseInput({ ideaConvosEnabled: true }));
    expect(p).toContain(CANONICAL_IDEA_CONVO);
    expect(p).toContain("send_idea_to_teacher");
    // The original consent-capture wording is GONE under the flag.
    expect(p).not.toContain("## The Workshop (the listening job)");
    expect(p).not.toContain("Want me to pass that along?");
  });

  test("section ABSENT when the flag is off (default) — and off-path is byte-identical", () => {
    const off = buildMetaSystemPrompt(baseInput({ ideaConvosEnabled: false }));
    const omitted = buildMetaSystemPrompt(baseInput()); // field absent
    // The original consent-capture block is what shows off-path.
    expect(off).toContain("## The Workshop (the listening job)");
    expect(off).toContain("Want me to pass that along?");
    expect(off).not.toContain("## The Workshop (thinking partner + sending ideas)");
    expect(off).not.toContain("send_idea_to_teacher");
    // Passing the flag as false adds nothing vs. omitting it: proves the
    // off-path is a byte-identical no-op relative to the pre-feature prompt.
    expect(off).toBe(omitted);
  });

  test("the thinking-partner section sits in the SAME slot as the listening block", () => {
    const on = buildMetaSystemPrompt(
      baseInput({
        ideaConvosEnabled: true,
        ideaUpdates: [{ authorName: "Ms. Lehua", title: "Star Map", body: "Love it." }],
      }),
    );
    const reflection = on.indexOf("## Reflection (the main job)");
    const workshop = on.indexOf("## The Workshop (thinking partner + sending ideas)");
    const updates = on.indexOf("## Updates to deliver");
    expect(reflection).toBeGreaterThanOrEqual(0);
    expect(workshop).toBeGreaterThan(reflection);
    expect(updates).toBeGreaterThan(workshop);
  });

  test("workshopListeningSection holds the original consent-capture text verbatim", () => {
    // The extracted off-path block must be unchanged, so the flag-off prompt
    // stays byte-identical to pre-feature.
    const s = workshopListeningSection("Kai");
    expect(s.startsWith("## The Workshop (the listening job)")).toBe(true);
    expect(s).toContain(
      'reflect it back once in your words, then ask: "Want me to pass that along?',
    );
    expect(s).toContain('"I\'ll pass it along" is your CEILING.');
  });
});

describe("buildMetaSystemPrompt — Ask Rabbithole", () => {
  test("uses a dedicated transparency contract with shared welfare guidance", () => {
    const prompt = buildMetaSystemPrompt(
      baseInput({
        purpose: "introspection",
        firstName: "Lani",
        ideaConvosEnabled: true,
      }),
    );
    expect(prompt).toContain(
      "You are Rabbithole itself, answering Lani's questions",
    );
    expect(prompt).toContain("## Ask Rabbithole (the main job)");
    expect(prompt).toContain("You are a method, not a character");
    expect(prompt).toContain("send_idea_to_teacher");
    expect(prompt).toContain(WELFARE_DISCLOSURE_GUIDANCE);
  });

  test("does not receive daily reflection, portrait, or delivery context", () => {
    const prompt = buildMetaSystemPrompt(
      baseInput({
        purpose: "introspection",
        todaySessions: [
          { title: "Secret daily session", activityTitle: null },
        ],
        weeklyGrowth: {
          conceptsGrown: ["private growth"],
          mathFluent: [],
          mathAdvanced: [],
          badges: [],
        },
        ideaUpdates: [
          { authorName: "Ms. Lehua", title: "Update", body: "Delivered" },
        ],
        credits: [{ title: "Feature credit" }],
      }),
    );
    expect(prompt).not.toContain("Secret daily session");
    expect(prompt).not.toContain("private growth");
    expect(prompt).not.toContain("Updates to deliver");
    expect(prompt).not.toContain("Feature credit");
    expect(prompt).toContain("does NOT become portrait evidence");
    expect(prompt).toContain("does not start");
  });
});

// ── The homescreen "Today's reflection" snippet (pure, shares today's shape) ──
describe("buildReflectionSnippet", () => {
  test("null when there's no on-screen activity (frontends keep their fallback)", () => {
    expect(buildReflectionSnippet([])).toBeNull();
  });

  test("names a single activity", () => {
    expect(
      buildReflectionSnippet([{ title: "Fractions", activityTitle: "Fraction Sense" }]),
    ).toBe("You worked on Fraction Sense today — how'd it go?");
  });

  test("prefers the activity title over the raw session title", () => {
    expect(
      buildReflectionSnippet([{ title: "session-abc123", activityTitle: "Nitrogen Cycle" }]),
    ).toBe("You worked on Nitrogen Cycle today — how'd it go?");
  });

  test("falls back to the session title when there's no activity title", () => {
    expect(buildReflectionSnippet([{ title: "Free write", activityTitle: null }])).toBe(
      "You worked on Free write today — how'd it go?",
    );
  });

  test("joins two with 'and'", () => {
    expect(
      buildReflectionSnippet([
        { title: "A", activityTitle: "Fraction Sense" },
        { title: "B", activityTitle: "Small Moments" },
      ]),
    ).toBe("You worked on Fraction Sense and Small Moments today — how'd it go?");
  });

  test("caps at two named, then 'and more'", () => {
    expect(
      buildReflectionSnippet([
        { title: "A", activityTitle: "One" },
        { title: "B", activityTitle: "Two" },
        { title: "C", activityTitle: "Three" },
      ]),
    ).toBe("You worked on One, Two, and more today — how'd it go?");
  });

  test("dedupes repeated labels (multiple sessions of the same activity)", () => {
    expect(
      buildReflectionSnippet([
        { title: "A", activityTitle: "Fraction Sense" },
        { title: "B", activityTitle: "Fraction Sense" },
      ]),
    ).toBe("You worked on Fraction Sense today — how'd it go?");
  });

  test("names practice when the day was practice-only (no sessions)", () => {
    expect(
      buildReflectionSnippet([], {
        practice: [
          {
            domainLabel: "Whole-number arithmetic",
            skillLabels: ["skip counting"],
            placedToday: false,
          },
        ],
        completedActivities: [],
        badges: [],
      }),
    ).toBe("You worked on Whole-number arithmetic practice today — how'd it go?");
  });

  test("sessions lead, practice follows — same two-named cap", () => {
    expect(
      buildReflectionSnippet(
        [{ title: "A", activityTitle: "Fraction Sense" }],
        {
          practice: [{ domainLabel: "Fractions", skillLabels: [], placedToday: true }],
          completedActivities: [],
          badges: [],
        },
      ),
    ).toBe("You worked on Fraction Sense and Fractions practice today — how'd it go?");
  });

  test("still null when the record is empty too", () => {
    expect(
      buildReflectionSnippet([], { practice: [], completedActivities: [], badges: [] }),
    ).toBeNull();
  });
});


// shared constant. This proves (a) the constant still holds the exact tutor
// text, and (b) it splices back into the tutor prompt between the same two
// neighbor bullets — i.e. the tutor prompt is byte-identical to pre-refactor.
describe("tutor prompt byte-identical after WELFARE_DISCLOSURE_GUIDANCE extraction", () => {
  const CANONICAL_WELFARE = `- **Welfare or safety disclosures are different from ordinary emotional topics, and the bar is higher.** If a scholar discloses possible harm — to themselves or someone else: abuse, violence at home, being hurt or unsafe, or wanting to hurt themselves — respond with calm warmth, tell them plainly this is something a trusted adult needs to help with *right now* (a teacher, a parent or caregiver, another adult they trust; in an emergency, emergency services), and that they did the right thing by telling someone. **Then STOP there.** Do NOT re-offer the lesson, append "and when you're ready to learn, I'm here", pivot to a question, or treat the disclosure as a topic to explore — that bounces a child out of a safety moment back into schoolwork. Hold this redirect posture for the rest of the session: if they disclose again, keep steering them to a trusted adult — do not interrogate for detail, promise secrecy, or escalate the back-and-forth. Only return to the lesson if the **scholar themselves** clearly moves back to it; a brief "I'm fine" or "I'm safe" mid-thread is NOT a green light to resume the lesson — stay gently anchored on getting them to a trusted adult.`;

  test("the constant holds the exact canonical welfare text", () => {
    expect(WELFARE_DISCLOSURE_GUIDANCE).toBe(CANONICAL_WELFARE);
  });

  describe("correctness-affirmation guidance", () => {
    test("bans the affirmation pattern while preserving content-anchored warmth", () => {
      const prompt = buildBasePrompt("Kai Nakamura", false);

      expect(prompt).toContain(
        'Never reflexively respond to a correct answer with a standalone affirmation — "You\'re right," "That\'s correct," "Exactly right," "Perfect," or "You nailed it."',
      );
      expect(prompt).toContain(
        "Do not replace the stamp with a disguised confirmation by restating or completing their answer for them.",
      );
      expect(prompt).toContain(
        "A brief content-anchored micro-warmth is still welcome when it engages an idea they already gave you",
      );
      expect(prompt.indexOf("Correctness needs substance, not an approval stamp.")).toBeLessThan(
        prompt.indexOf("Empty validators vs. content-relevant warmth"),
      );
    });
  });

  test("it splices between the same neighbor bullets in buildBasePrompt", () => {
    const prompt = buildBasePrompt("Kai Nakamura", false);
    const expectedSplice = `deflect coldly with "I'm only an AI."\n${CANONICAL_WELFARE}\n- Focus praise on ideas, questions, and thinking processes`;
    expect(prompt).toContain(expectedSplice);
  });

  test("the welfare guidance appears exactly once in the tutor prompt", () => {
    const prompt = buildBasePrompt("Kai Nakamura", true);
    const occurrences = prompt.split(WELFARE_DISCLOSURE_GUIDANCE).length - 1;
    expect(occurrences).toBe(1);
  });
});

// ── PROSE_STYLE_GUIDE — one shared constant, no forked copies ────────
//
// Mirrors the WELFARE_DISCLOSURE_GUIDANCE contract above: the tutor and both
// meta-chat surfaces must inject the SAME string, exactly once each, so the
// house prose style can never fork per surface.
describe("PROSE_STYLE_GUIDE — scoped to Special Delivery, deliberately", () => {
  // Andy's call (2026-08-19): ship the style guide narrow. A style rule that
  // reaches every scholar turn is an eval-risk change, so extending it to the
  // tutor is its own follow-up PR gated on an eval. These tests exist so that
  // scoping cannot be undone by accident — deleting them is the decision.
  test("the Special Delivery insert prompt carries it exactly once", () => {
    const prompt = buildInsertUserPrompt({
      scholarFirstName: "Reference Scholar",
      candidates: [],
      theme: {
        completedActivities: [],
        sessionTitles: [],
        practiceLabels: [],
      },
    });
    expect(prompt).toContain(PROSE_STYLE_GUIDE);
    expect(prompt.split(PROSE_STYLE_GUIDE).length - 1).toBe(1);
    expect(prompt.indexOf(PROSE_STYLE_GUIDE)).toBeLessThan(
      prompt.indexOf("Choose based only on the evidence above"),
    );
    expect(prompt).toContain(
      "The wording rules above apply only after that choice; they do not make an insert more warranted.",
    );
  });

  test("the live tutor prompt does NOT carry it yet", () => {
    expect(buildBasePrompt("Reference Scholar")).not.toContain(
      PROSE_STYLE_GUIDE,
    );
  });

  test("neither meta-chat surface carries it yet", () => {
    for (const purpose of ["reflection", "introspection"] as const) {
      expect(buildMetaSystemPrompt(baseInput({ purpose }))).not.toContain(
        PROSE_STYLE_GUIDE,
      );
    }
  });

  test("it bans the constructions the founder review named", () => {
    expect(PROSE_STYLE_GUIDE).toContain("it's not X, it's Y");
    expect(PROSE_STYLE_GUIDE).toContain("Quietly");
    expect(PROSE_STYLE_GUIDE).toContain("the X worth naming");
    expect(PROSE_STYLE_GUIDE).toContain("something real");
  });

  test("it scopes register words by use, so real vocabulary survives", () => {
    expect(PROSE_STYLE_GUIDE).toContain("decorative senses only");
    expect(PROSE_STYLE_GUIDE).toContain("Judge by use, not by the word");
  });

  test("it does not ask the writer to pass as human", () => {
    expect(PROSE_STYLE_GUIDE).not.toMatch(/anyone is on the other end/);
    expect(PROSE_STYLE_GUIDE).toContain("not imitating a human writer");
    expect(PROSE_STYLE_GUIDE).not.toContain("optional and generated");
  });

  test("the unlabelled caption is content-first, not an announcement", () => {
    const captionDescription =
      SPECIAL_DELIVERY_INSERT_TOOL.input_schema.properties.caption.description;
    expect(captionDescription).toContain("directly beneath an unlabelled image");
    expect(captionDescription).toContain("write the actual subject directly");
    expect(captionDescription).not.toContain("A little something extra");
  });

  test("it does NOT restate the anti-flattery rules that already exist", () => {
    expect(PROSE_STYLE_GUIDE).not.toContain("Great question!");
    expect(PROSE_STYLE_GUIDE).not.toContain("You're so smart");
  });
});
