// Inserts the hand-authored "Geography Quests" unit — three map-driven social
// studies quests that let a scholar DISCOVER geography on a real, governed map
// (the GeoMap surface, lib/geomap/*) instead of reading it off a labeled
// diagram. The design anchor is review/geography-quest-mapbox-plan.html §7 (the
// three quest cards) and §9 (the pedagogy guardrails: predict-before-reveal,
// never open with the annotated answer-map, the map is evidence not the
// argument).
//
// The three quests, each one online activity:
//   1. "The Wet Side and the Dry Side" (Oʻahu) — satellite → 3D terrain →
//      trade winds + PREDICT-before-reveal rainfall → transfer to Maui/Hawaiʻi.
//      Exercises every Phase-1 primitive (bases, terrain3d, overlays, markers,
//      tapToPin, camera patches) in one conversation.
//   2. "Where in the World Is Washington, DC?" — globe → zoom ladder on the
//      politicalUnlabeled base while the kid hunts (tapToPin), labels/political
//      reveal after each commitment → the DC-isn't-in-a-state beat → satellite
//      finale. Runs on show_map + pins + tutor judgment (NOT graded practice
//      items — that geoLocate wiring is a separate, later phase).
//   3. "How a Map Started a War" (WWI, older scholars) — 1914 empires → alliance
//      bloc tints → the July–August 1914 declaration chain as a spec-level
//      stepper → then-vs-now. The map is EVIDENCE; the kid articulates the
//      causal chain, predicting each next domino before it's stepped.
//
// Each systemPrompt scripts the beats and tells the tutor how to drive the
// show_map tool: call `create` ONCE to open the one session map, then `read` +
// `patch` per beat — one variable per patch (a camera move, or one layer toggle, or a
// base change) — questions between, never a one-shot everything-labeled map.
// Scholar pins arrive in session context; the prompts tell the tutor to read
// them and respond.
//
// Registry keys the prompts reference (governed overlay/region data — authored
// alongside this quest in lib/geomap/registry/): the Oʻahu wind overlay,
// `oahu-rainfall`, `europe-1914`, `ww1-blocs-entente`, `ww1-blocs-alliance`,
// `europe-today`. This file only NAMES those keys inside prompt copy; it never
// imports registry data.
//
// Structure mirrors the AI-literacy strand (convex/seedAiLiteracyUnits.ts):
// typed defs, an idempotent-by-slug inserter called from seedData.seedAll, and
// a standalone internalMutation runner for promoting/refreshing the unit
// without re-running the whole base seed. Dev-safe and idempotent.
import type { MutationCtx } from "../_generated/server";
import { internalMutation } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { normalizeGranules } from "../lib/granules";
import { PRIMARY_INSTITUTION_PROMPT_PROFILE } from "../lib/primaryInstitutionPromptProfile";
import {
  OAHU_WIND_OVERLAY_ID,
  OAHU_WIND_OVERLAY_LABEL,
  PREVAILING_WIND_TERM,
} from "../../lib/geomap/registry/keys";

type LessonStrand = NonNullable<Doc<"lessons">["strand"]>;
type BloomLevel = NonNullable<Doc<"units">["targetBloomLevel"]>;

type ActivityDef = {
  title: string;
  // Every quest activity is "online" — the scholar opens it in Rabbithole and
  // the tutor drives the map via show_map. No offline/planning activities here.
  kind: "online";
  description: string;
  scholarDescription?: string;
  systemPrompt: string;
  durationMinutes?: number;
};

type LessonDef = {
  title: string;
  strand: LessonStrand;
  durationMinutes?: number;
  activities: ActivityDef[];
};

type UnitDef = {
  title: string;
  slug: string;
  emoji: string;
  subject: string;
  gradeLevel: string;
  targetBloomLevel: BloomLevel;
  bigIdea: string;
  description: string; // teacher-facing (3rd person)
  scholarDescription: string; // scholar-facing (2nd person)
  essentialQuestions: string[];
  enduringUnderstandings: string[];
  badge: { title: string; description: string; icon: string };
  lessons: LessonDef[];
};

const SUBJECT = "Social Studies";

// The shared show_map operating rules every quest prompt leans on. Kept in one
// constant so all three quests describe the tool identically (the QB may still
// rewrite pedagogy-critical copy; this is the structural spine).
const SHOW_MAP_RULES = `HOW TO DRIVE THE MAP (show_map tool):
- Call show_map with op "create" EXACTLY ONCE, at the start, to open the single session map. Before every later change, call op "read", then op "patch" against the revision it returns — never a second create (one map per session).
- Each patch changes ONE thing: a camera move, OR one layer toggled on/off, OR a base change, OR a marker added. Never resend the whole map or build the whole answer-map in one call. Ask a question between every patch.
- Never open with an everything-labeled map ("here is the island with the winds and the rain and why"). That is answer-dumping with pixels. Reveal one variable at a time, and let the child do the noticing first.
- The child can drop pins on the map (tapToPin). Their pins arrive in your context each turn as scholarPins. READ them and respond to what they actually pinned — a pin is a commitment you can react to, praise, or gently complicate. Your patches never erase the child's pins.`;

// ═══════════════════════════════════════════════════════════════════════════
// QUEST 1 — Oʻahu: the wet side and the dry side (Phase-1 flagship)
// ═══════════════════════════════════════════════════════════════════════════
const QUEST_OAHU: ActivityDef = {
  title: "The Wet Side and the Dry Side",
  kind: "online",
  description:
    "Oʻahu from space: the scholar discovers why one side of the island is lush green and the other is dry brown — reading the satellite colors, feeling the Koʻolau ridge in 3D, predicting where the rain falls, then transferring the pattern to the other islands.",
  scholarDescription:
    "Explore Oʻahu from above and see what the island's colors and mountains can tell you. You'll use the map to follow the winds and rain.",
  durationMinutes: 25,
  systemPrompt: `Guide the scholar to DISCOVER why Oʻahu has a green wet side and a brown dry side — never explain it to them. The map is how they find out; you ask the questions. By the end they should be able to say, in their own words, why wet air climbing a mountain drops its rain on the windward side (orographic lift) — WITHOUT you ever having stated it first.

${SHOW_MAP_RULES}

Work through four beats. Move to the next only when the child has really looked and answered.

BEAT 1 — NOTICE (open with THEIR observation, never your explanation).
Open the map with show_map "create": base "satellite", camera center [-157.98, 21.48], zoom 9 (all of Oʻahu in frame). Then ask, before you tell them anything: "What do you notice about the COLORS of the island?" The green/brown split is unmissable from space. If the child lives on Oʻahu, they may name places (Kailua and windward towns are green; ʻEwa Beach / Kapolei / the leeward side is dry). Let them wonder aloud. Do not name "windward" or "rain" yet — just get them to see two different sides.

BEAT 2 — FEEL THE MOUNTAINS.
Read, then patch the map: set base "terrain" with terrain3d on, and camera center [-157.82, 21.4], zoom 10.5, pitch 60, bearing 320 — a low, tilted view along the Koʻolau range. Say: "Tilt it. Spin it. What is STANDING between the green side and the brown side?" Let them discover the ridge line with their hands. Ask what a tall wall of mountains might DO to air or clouds trying to cross it — don't answer, just plant the question.

BEAT 3 — PREDICT BEFORE REVEAL (the house move — do not skip the prediction).
Read, then patch the map to add TWO layers with upsertLayer: the ${PREVAILING_WIND_TERM} layer (registry key "${OAHU_WIND_OVERLAY_ID}", label "${OAHU_WIND_OVERLAY_LABEL}", visible) AND the rainfall layer (registry key "oahu-rainfall", label "Yearly rainfall", initiallyVisible false — added now, still hidden). The child sees the wind blowing from the northeast across the island. Explain only this much: "Wet ocean air rides this wind toward the island." Then ask them to COMMIT before anything is revealed: "Drop a pin where you think the MOST rain falls." Wait for their pin — read it from scholarPins. ONLY AFTER they have pinned, read again and use setLayerVisibility to reveal the rainfall layer. Now the map itself checks their intuition. Ask: "The wind hits the mountains and has to climb. What happens to the water in the air when it's forced UP and cools off?" Guide them to build the idea of rain-on-the-way-up themselves. Whether their pin was right or not, make them explain WHY the windward side wins.

BEAT 4 — TRANSFER (does the idea travel?).
Read, then patchCamera to fly to Maui (center around [-156.3, 20.8], zoom ~9), still satellite. Say: "Same wind, new island. Where's the wet side here? Pin it BEFORE you change anything." Let them pin, then let them check by looking at the colors / toggling terrain. Optionally repeat for Hawaiʻi Island (center around [-155.5, 19.6], zoom ~8). If the pattern transfers, the concept is theirs. Close with the exit ramp: "Your school is named ${PRIMARY_INSTITUTION_PROMPT_PROFILE.shortName}. Now you know what those winds actually DO — and why that name fits a school here." Invite free exploration — flying the camera to another island they care about is the product working, not a detour.

TONE: warm, curious, detective-ish. Short turns. You are a guide who withholds the answer so the child gets the joy of finding it. Praise good noticing and good guesses equally — a wrong prediction they can explain is worth more than a right one they can't.`,
};

// ═══════════════════════════════════════════════════════════════════════════
// QUEST 2 — Washington, DC: where in the world? (globe → zoom ladder)
// ═══════════════════════════════════════════════════════════════════════════
const QUEST_DC: ActivityDef = {
  title: "Where in the World Is Washington, DC?",
  kind: "online",
  description:
    "A zoom ladder from the whole spinning globe down to the National Mall: the scholar hunts for the United States, the East Coast, and finally Washington, DC on an unlabeled map — labels revealing only after each commitment — and discovers the good weirdness that DC belongs to no state.",
  scholarDescription:
    "Start with the whole globe and hunt for Washington, DC. Zoom closer as you find your way across the map.",
  durationMinutes: 20,
  systemPrompt: `Guide the scholar to FIND Washington, DC by hunting for it on a map — from the whole planet down to the city — instead of being shown where it is. They commit first (a tap, a pin), and the map reveals the answer AFTER. This is a "where" quest that hides a real "why" inside it (why would a capital belong to no state?).

This activity runs on show_map + the child's pins + YOUR judgment of their taps. Do NOT use graded practice items or quiz scoring — you look at where they pinned and respond like a guide. Be generous early (the globe is huge) and expect more precision as you zoom in.

${SHOW_MAP_RULES}

Keep labels OFF while they hunt, and turn them ON as the reward for a commitment — the unlabeled map exists exactly so they can't just read the answer.

BEAT 1 — THE GLOBE.
Open with show_map "create": globe on, base "politicalUnlabeled", camera center [0, 20], zoom 1.2 (the whole Earth). Say: "Spin the Earth. Tap where you think the United States is." Read their pin from scholarPins. For a roughly-right tap, celebrate and reward it with a camera swoop: read, then patchCamera toward North America (center around [-98, 39], zoom ~3.2). The camera move IS the reward.

BEAT 2 — THE ZOOM LADDER (tighten as you go; reveal labels after each answer).
Work down a ladder of commitments, each on the politicalUnlabeled base so they can't read it off:
  - "Now tap the EAST COAST of the U.S." → after they pin, read and patchCamera toward the eastern seaboard (center around [-77, 39], zoom ~5.5).
  - "Washington, DC sits right between two states, on a river. Tap the spot." → read the pin, then zoom in (center around [-77.04, 38.9], zoom ~9).
After each commitment, reveal the answer by reading and patching the base to "political" (labels bloom on) so they can SEE how close they got — then flip back to politicalUnlabeled for the next hunt if you like. Labels-on is always the reveal, never the starting state.

BEAT 3 — THE GOOD WEIRDNESS (the why hiding in the where).
Zoomed to DC on the "political" base, say: "Look carefully at the border around DC. Is Washington, DC INSIDE a state — like a city is usually inside a state? Look at the shape." Let them notice it's its own little diamond that belongs to no state. Then ask the real question OPEN-ENDED: "Why do you think the people who built this country might have wanted their capital to belong to NO state?" Let them theorize (fairness between states, no single state controlling the government). Don't hand them the answer — draw out their reasoning.

BEAT 4 — FROM SPACE.
Read, then patch the base to "satellite", camera still on DC. Say: "Find the long green rectangle — that's the National Mall — and the river beside it." Anchor relative location: "Which big ocean is nearest? Tap it." Read the pin. Close by zooming back out one notch so they can see DC sitting on the East Coast they found earlier — the whole ladder in one view. Invite them to keep exploring: fly to a place they've been or want to go.

TONE: playful, hide-and-seek energy. Short turns. Reward the hunt, not just the right answer. The zoom-in swoops are the fun — use them.`,
};

// ═══════════════════════════════════════════════════════════════════════════
// QUEST 3 — WWI: how a map started a war (older scholars; the stepper)
// ═══════════════════════════════════════════════════════════════════════════
//
// The July–August 1914 declaration chain, authored as spec-level `steps` the
// tutor passes to show_map. The 1914 borders/names are NOT a layer — they're
// the era basemap itself (historicalBasemap "europe-1914"), so the steps only
// orchestrate the two bloc tint layers:
//   entente      → registry "ww1-blocs-entente"    (blue: Russia, France, UK, Serbia…)
//   alliance     → registry "ww1-blocs-alliance"   (red: Germany, Austria-Hungary…)
// The stepper reveals the dominoes in order; when `steps` is present the
// renderer follows each step's visibleLayerIds (initiallyVisible is ignored).
// This is the ready-made JSON the prompt tells the tutor to pass through — the
// dated sequence mirrors lib/geomap/registry/data/ww1-declarations.ts.
const WW1_STEPS_JSON = `[
  { "id": "assassination", "label": "28 Jun 1914", "description": "Archduke Franz Ferdinand of Austria-Hungary is assassinated in Sarajevo.", "visibleLayerIds": [], "camera": { "center": [18.4, 43.85], "zoom": 5 } },
  { "id": "ah-serbia", "label": "28 Jul 1914", "description": "Austria-Hungary declares war on Serbia.", "visibleLayerIds": ["alliance"], "camera": { "center": [19, 44.5], "zoom": 4.5 } },
  { "id": "germany-russia", "label": "1 Aug 1914", "description": "Russia mobilizes for its ally Serbia; Germany declares war on Russia.", "visibleLayerIds": ["alliance", "entente"], "camera": { "center": [25, 52], "zoom": 3.8 } },
  { "id": "germany-france", "label": "3 Aug 1914", "description": "Germany declares war on France, Russia's ally.", "visibleLayerIds": ["alliance", "entente"], "camera": { "center": [8, 48], "zoom": 4 } },
  { "id": "britain-germany", "label": "4 Aug 1914", "description": "Germany invades neutral Belgium to reach France; Britain declares war on Germany.", "visibleLayerIds": ["alliance", "entente"], "camera": { "center": [4.5, 50.5], "zoom": 4.5 } },
  { "id": "ah-russia", "label": "6 Aug 1914", "description": "Austria-Hungary declares war on Russia. The two blocs are fully at war.", "visibleLayerIds": ["alliance", "entente"], "camera": { "center": [13, 50], "zoom": 3.6 } }
]`;

const QUEST_WWI: ActivityDef = {
  title: "How a Map Started a War",
  kind: "online",
  description:
    "A scholar reads the causes of World War I straight off the map: a Europe of vanished empires in 1914, the two alliance blocs tinted so encirclement is visible, the July–August declaration chain as a step-by-step domino run, and then-vs-now to see the war's consequences. The map is evidence; the scholar builds the causal argument.",
  scholarDescription:
    "Travel back to Europe in 1914 and trace how one event pulled countries into a war. Compare the old map with today’s world.",
  durationMinutes: 30,
  systemPrompt: `Guide an older scholar to reason out WHY World War I happened by reading a real historical map as EVIDENCE. Crucial rule: the map shows the situation; the CHILD must articulate the causal chain. You are not walking them to a known answer with a funnel of leading questions — you ask genuinely open questions, make them PREDICT each next step, and let them build the argument. If you catch yourself about to state the cause, stop and ask instead.

${SHOW_MAP_RULES}

BEAT 1 — A DIFFERENT EUROPE.
Open with show_map "create": historicalBasemap "europe-1914", base "political", camera center [13, 50], zoom 3.6. NO layers yet — the era basemap IS the 1914 map (real cartography with the empires' borders and names baked in; keep historicalBasemap set for the whole session until the final beat). Say: "This is Europe in 1914, before the war. Find Germany. Now find Poland." (They can't find Poland — it didn't exist; it was partitioned among empires.) Then: "Count the separate countries on the Balkan peninsula in 1914 — we'll count them again at the end." The scholar can flip Satellite/Terrain and the map STAYS in 1914 — invite it ("look at the real land these empires sat on"). Let the idea that BORDERS ARE NOT PERMANENT land here, from what they see.

BEAT 2 — THE ALLIANCE WEB (encirclement, read off the map).
Read, then patch the map to tint the two blocs: use upsertLayer for the Entente layer (registry key "ww1-blocs-entente", label "Entente", tint blue — Russia, France, Britain, Serbia) and the Alliance layer (registry key "ww1-blocs-alliance", label "Central Powers", tint red — Germany, Austria-Hungary). Add them as separate toggleable layers. Ask, open-ended: "Look at where Germany sits. Which blue bloc countries touch or surround its borders? If you were leading Germany, looking at this map, what might you be AFRAID of?" Let them read encirclement off the geography themselves — that is geography's actual causal contribution to the war. Don't say "encirclement"; let them describe being surrounded.

BEAT 3 — THE CHAIN (predict every domino before you step it).
Now run the July–August 1914 declaration chain as a STEPPER. Read, then patch with replaceSteps using this ready-made array (the layer ids match the two bloc layers you already created — alliance = red bloc, entente = blue bloc; the 1914 borders are the basemap and always visible):

${WW1_STEPS_JSON}

Advance the stepper ONE step at a time. Before each step, make the child PREDICT: "Austria-Hungary just declared war on Serbia. Serbia is friends with Russia — what do you think Russia does now?" Let them guess, THEN step to reveal it. "Russia is backing Serbia — now who is Germany obligated to help, and against whom?" Keep making them see how an alliance turns a small local war into a continental one — a promise to a friend pulls each country in. The stepper is the evidence; their prediction-then-check is the thinking.

BEAT 4 — THEN VS NOW.
Snap the map back to the present: read, then patch historicalBasemap:null and replaceSteps with an empty array (keep base "political"; keep or remove the bloc layers as you see fit) — the modern world returns, labels and all. Say: "Count the countries on the Balkans now versus 1914. Find the ones that exist today that didn't exist then — like Poland. Where did all these new countries come from?" Let them connect the new nations to the empires that broke apart because of the war. The map hands them the war's CONSEQUENCES as a discovery. (If they want to compare again, you can patch historicalBasemap back on after another read.)

TONE: treat the scholar as a serious young historian. Questions over statements, always. Never a leading-question funnel — if there's only one answer you'll accept, you're funneling; widen the question. The payoff is that THEY explain how a promise between countries and a map full of empires turned an assassination into a world war.`,
};

// ═══════════════════════════════════════════════════════════════════════════
// THE UNIT
// ═══════════════════════════════════════════════════════════════════════════
const GEOGRAPHY_QUESTS: UnitDef[] = [
  {
    title: "Geography Quests",
    slug: "geography-quests",
    emoji: "🗺️",
    subject: SUBJECT,
    gradeLevel: "3-8",
    targetBloomLevel: "analyze",
    bigIdea:
      "A real map is evidence you can question: the shape of the land, where the rain falls, and where the borders sit all have reasons you can discover by looking.",
    description:
      "Three map-driven quests on the live GeoMap surface. Each scholar reads a real, governed map — satellite, 3D terrain, political, and historical — to DISCOVER a geographic idea rather than be told it: why Oʻahu has a wet and a dry side, where Washington, DC hides on the globe, and how a map full of empires and alliances turned into World War I. Predict-before-reveal throughout; the map is evidence, never the answer key.",
    scholarDescription:
      "Fly a real map to figure things out for yourself — why one side of your island is green and the other brown, where Washington, DC is hiding on the whole spinning Earth, and how a map of old empires helped start a world war. You'll guess first, then let the map show you.",
    essentialQuestions: [
      "Why does the same island have a wet side and a dry side?",
      "How do you find one small place on the whole Earth?",
      "Why do borders change, and what can a map from the past tell us about why things happened?",
    ],
    enduringUnderstandings: [
      "When wet air is pushed up over mountains it cools and drops its rain, so the windward side is lush and the leeward side is dry (orographic lift).",
      "Location is relative and nested — a place lives inside larger places, and you can zoom from the whole globe down to one city to pin it.",
      "Borders are contingent, not permanent; a historical map is evidence, and geography (who borders whom, who is allied to whom) helps explain why events unfolded.",
    ],
    badge: {
      title: "Cartographer",
      description:
        "Read real satellite, terrain, political, and historical maps to discover how the land, the weather, and the borders got the way they are.",
      icon: "🧭",
    },
    lessons: [
      {
        title: "The Wet Side and the Dry Side",
        strand: "core",
        durationMinutes: 25,
        activities: [QUEST_OAHU],
      },
      {
        title: "Where in the World Is Washington, DC?",
        strand: "core",
        durationMinutes: 20,
        activities: [QUEST_DC],
      },
      {
        title: "How a Map Started a War",
        strand: "core",
        durationMinutes: 30,
        activities: [QUEST_WWI],
      },
    ],
  },
];

/**
 * Insert the "Geography Quests" unit (→ 3 lessons → 3 online activities) owned
 * by `teacherId`. Idempotent by slug: if the unit already exists, inserts
 * nothing and returns 0. Returns the number of units inserted (0 or 1).
 */
export async function insertGeographyQuests(
  ctx: MutationCtx,
  teacherId: Id<"users">,
): Promise<number> {
  const firstSlug = GEOGRAPHY_QUESTS[0].slug;
  const already = await ctx.db
    .query("units")
    .withIndex("by_slug", (q) => q.eq("slug", firstSlug))
    .first();
  if (already) return 0;

  for (const u of GEOGRAPHY_QUESTS) {
    const unitId = await ctx.db.insert("units", {
      teacherId,
      title: u.title,
      slug: u.slug,
      emoji: u.emoji,
      subject: u.subject,
      gradeLevel: u.gradeLevel,
      targetBloomLevel: u.targetBloomLevel,
      bigIdea: u.bigIdea,
      description: u.description,
      scholarDescription: u.scholarDescription,
      essentialQuestions: normalizeGranules(u.essentialQuestions, "eq"),
      enduringUnderstandings: normalizeGranules(u.enduringUnderstandings, "eu"),
      badgeOnCompletion: u.badge,
      isActive: true,
    });
    for (let li = 0; li < u.lessons.length; li++) {
      const l = u.lessons[li];
      const lessonId = await ctx.db.insert("lessons", {
        unitId,
        title: l.title,
        order: li,
        strand: l.strand,
        durationMinutes: l.durationMinutes,
      });
      for (let ai = 0; ai < l.activities.length; ai++) {
        const a = l.activities[ai];
        await ctx.db.insert("activities", {
          lessonId,
          title: a.title,
          order: ai,
          kind: a.kind,
          description: a.description,
          scholarDescription: a.scholarDescription,
          systemPrompt: a.systemPrompt,
          durationMinutes: a.durationMinutes,
        });
      }
    }
  }

  return GEOGRAPHY_QUESTS.length;
}

/**
 * Standalone runner for the Geography Quests unit — resolves the system teacher
 * (falling back to any teacher) and inserts the unit. Idempotent (skips if
 * already present). Run with:
 *   npx convex run seed/geographyQuests:seedGeographyQuests
 * Safe to run on dev now and to promote to prod later without re-running the
 * whole base seed.
 */
export const seedGeographyQuests = internalMutation({
  args: {},
  handler: async (ctx) => {
    const systemTeacher = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", "system@rabbithole.app"))
      .first();
    const teacher =
      systemTeacher ??
      (await ctx.db
        .query("users")
        .filter((q) => q.eq(q.field("role"), "teacher"))
        .first()) ??
      (await ctx.db
        .query("users")
        .filter((q) => q.eq(q.field("role"), "platform_admin"))
        .first());
    if (!teacher) {
      return { inserted: 0, note: "No teacher/admin found; cannot seed." };
    }
    const inserted = await insertGeographyQuests(ctx, teacher._id);
    return { inserted };
  },
});
