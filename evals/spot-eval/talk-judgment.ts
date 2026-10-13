/**
 * Spot-eval (structured, no judge) for the observer's TALK judgment (TRA-515):
 * `talkLevel` on OBSERVER_TOOL + section 7b of the observer system prompt —
 * the grade at which a typical child would produce the LANGUAGE the scholar
 * used (vocabulary + sentence complexity), not how sophisticated the ideas are.
 *
 * Runs the live observer model with the REAL system prompt, tool schema,
 * transcript builder (SCHOLAR / SCHOLAR (spoken) labels, last-30 window) and
 * the same validation the write path applies (`validTalkJudgment`, 100-word
 * floor counted by `scholarWordCount`). Fictional scripted transcripts only.
 *
 * Each case's `expected` grade (K = 0) was written down BEFORE any run of the
 * reframed prompt, judged on the language alone. The calibration target
 * (T6, before the "Sessions suggest" line may ship):
 *   |mean signed error| ≤ 0.5 and ≥ 80% of answered runs within ±1 grade.
 *
 *   npx tsx --env-file=$HOME/code/.env.local evals/spot-eval/talk-judgment.ts [--runs 3]
 */
import Anthropic from "@anthropic-ai/sdk";
import { OBSERVER_SYSTEM_PROMPT } from "../../convex/prompts";
import {
  OBSERVER_TOOL,
  buildObserverTranscript,
  buildObserverUserMessage,
  observerTranscriptWindow,
  parseObserverResponse,
  scholarWordCount,
} from "../../convex/lib/observerShared";
import { gradeValue, validTalkJudgment } from "../../convex/lib/levelEvidence";
import { MODELS } from "../../convex/lib/models";

type Turn = { role: "user" | "assistant"; content: string; spoken?: boolean };
interface Case {
  id: string;
  /** Typical-child grade of the LANGUAGE, K = 0. Fixed before running. */
  expected: number;
  why: string;
  scholarName: string;
  title: string;
  turns: Turn[];
}

const T = (content: string): Turn => ({ role: "assistant", content });
const S = (content: string): Turn => ({ role: "user", content, spoken: true });
const Y = (content: string): Turn => ({ role: "user", content });

export const CASES: Case[] = [
  {
    id: "k-spoken-short",
    expected: 0.5,
    why: "K–1: two-to-five-word phrases, concrete words",
    scholarName: "Pua",
    title: "Frogs",
    turns: [
      T("What do you already know about frogs?"),
      S("they jump"),
      T("They do! Where have you seen a frog?"),
      S("in the pond by my house"),
      T("What was it doing?"),
      S("sitting on a rock"),
      T("Why do you think it sat on a rock?"),
      S("to get sun maybe"),
      T("What else do frogs need?"),
      S("water and bugs"),
      T("Why water?"),
      S("so they dont dry up"),
      T("Where do frogs go in winter?"),
      S("in the mud i think"),
    ],
  },
  {
    id: "gifted-6yo-big-idea-plain-words",
    expected: 1.5,
    why: "1–2: an idea about infinity carried in short 'and' / 'because' clauses and everyday words",
    scholarName: "Lani",
    title: "The biggest number",
    turns: [
      T("Is there a biggest number?"),
      S("no there isnt because you can always add one more and then it is bigger"),
      T("What if I said a googol?"),
      S("then i say a googol and one and i win"),
      T("Ha! Is there ever an end?"),
      S("no it goes on and on forever and ever and you never get to the end even if you count your whole life"),
      T("What about the smallest number?"),
      S("i think zero but then my brother said there is minus so maybe it goes on the other way too"),
      T("Could numbers go forever both ways?"),
      S("yes like a road that goes both ways and never stops and you can walk on it forever"),
    ],
  },
  {
    id: "young-long-dictation",
    expected: 2,
    why: "2: long run-on 'and then / because' chains, everyday words plus 'lava'",
    scholarName: "Koa",
    title: "Volcano island",
    turns: [
      T("What do you think makes an island?"),
      S("i think a volcano under the ocean blows up and the lava gets hard and then it keeps doing it until it pokes out of the water"),
      T("Why would the lava get hard?"),
      S("because the ocean is really cold and the lava is super hot so when it touches the water it cools down and turns into rock like the black rock at the beach"),
      T("What happens when the volcano stops?"),
      S("i think the waves smash it and it gets smaller and smaller and then plants grow on it and birds bring seeds in their poop"),
      T("Where do the birds come from?"),
      S("from other islands or maybe they fly really far across the ocean because some birds can fly for days without stopping"),
    ],
  },
  {
    id: "g2-typed-misspelled",
    expected: 2,
    why: "2: simple sentences with because/and, everyday words; misspellings must not count",
    scholarName: "Iko",
    title: "Trains",
    turns: [
      T("What do you like about trains?"),
      Y("i like the big trains that cary coal becuz they are so long"),
      T("How long do you think they get?"),
      Y("maybe 100 cars and the engin is in the frunt and pulls them"),
      T("What would happen with only one engine and a lot of cars?"),
      Y("it would go slow and mabye it cant go up the hill so they put 2 engins"),
      T("Why is a hill harder?"),
      Y("becuz you have to pull the train up and it is hevy and it wants to go back down"),
      T("What about going down the hill?"),
      Y("it goes fast so they have brakes and the brakes get hot and smell"),
    ],
  },
  {
    id: "g3-mixed",
    expected: 3,
    why: "3: compound sentences, because/so, an everyday analogy; short misspelled typed turns",
    scholarName: "Noe",
    title: "Building a bridge",
    turns: [
      T("Which bridge shape held the most pennies?"),
      S("the one with the triangles held way more because the triangles spread the weight out to the sides"),
      T("Why would spreading the weight help?"),
      Y("becuz then no 1 part gets all the wait"),
      T("What happened to the flat bridge?"),
      S("it bent in the middle and then the pennies slid off because the paper was too floppy and nothing was holding it up underneath"),
      T("How could you fix the flat one without triangles?"),
      Y("fold it like a fan"),
      T("Why would a fan fold work?"),
      S("because the folds are like little walls standing up so it is harder to bend, kind of like how cardboard has the wavy part inside"),
    ],
  },
  {
    id: "g4-typed",
    expected: 4,
    why: "4: 'when/if…then/which' clauses, a few subject words (sunlight, seedlings, experiment)",
    scholarName: "Ana",
    title: "Bean plant experiment",
    turns: [
      T("What did you notice about your two bean plants?"),
      Y("The one by the window grew taller, but it was also leaning toward the glass, which looked kind of weird."),
      T("Why might it lean?"),
      Y("I think the leaves want sunlight, so the stem bends toward where the light is coming from. The one in the closet was pale and skinny."),
      T("What would you change if you did the experiment again?"),
      Y("If I did it again, I would give them the same amount of water every day, because I forgot to water the closet one on Tuesday, so maybe that is why it was weaker."),
      T("Good thinking. How would you know it was the light and not the water?"),
      Y("You would have to keep everything the same except the light. Then if the seedlings are still different, it has to be because of the light."),
    ],
  },
  {
    id: "g5-spoken",
    expected: 5,
    why: "5: dictated explanation with 'which', 'however', 'evaporates', 'condenses'",
    scholarName: "Kai",
    title: "Where rain comes from",
    turns: [
      T("Where does rain come from?"),
      S("Water from the ocean and lakes evaporates when the sun heats it up, which means it turns into water vapor that rises into the sky."),
      T("Then what?"),
      S("When the vapor gets high enough it cools down and condenses into tiny droplets, and lots of droplets together make a cloud. However, the droplets are too small to fall at first."),
      T("So what makes them fall?"),
      S("The droplets bump into each other and join together, and once they get heavy enough, gravity pulls them down as rain. If it's cold enough up there, they freeze and fall as snow instead."),
      T("Why do some places get more rain than others?"),
      S("Places near mountains get a lot because the air is forced to rise over the mountain, so it cools and drops its rain on that side, while the other side stays dry."),
    ],
  },
  {
    id: "g5-typed-misspelled",
    expected: 5,
    why: "5: subordinate clauses and precise words (consistent, reward, behavior) under heavy misspelling",
    scholarName: "Mika",
    title: "Training a puppy",
    turns: [
      T("How are you training your puppy?"),
      Y("We use treats as a reward wenever she sits, but my mom says we have to be consistant or she gets confused about what we want."),
      T("Why does being consistent matter?"),
      Y("Becuase if one person gives her a treat for jumping and another person yells at her for it, she cant figure out wich behavor is good."),
      T("What have you noticed so far?"),
      Y("She learned sit really fast, although she still pulls on the leash wen she sees other dogs, wich is the hardest part."),
      T("What might help with the leash?"),
      Y("Mabye we could stop walking evrytime she pulls, so she learns that pulling actualy makes the walk slower instead of faster."),
    ],
  },
  {
    id: "g6-7-typed-fluent",
    expected: 6.5,
    why: "6–7: qualified multi-clause reasoning, 'consistent with', 'orbit is tilted'",
    scholarName: "Mele",
    title: "Why the moon has phases",
    turns: [
      T("What's your current idea about why the moon changes shape?"),
      Y("I used to think the Earth's shadow covered part of it, but that would only work during an eclipse, so it must be something about which part of the moon is lit by the sun that we can see from here."),
      T("How could you test that?"),
      Y("You could put a lamp in the middle of a dark room as the sun and hold a ball at arm's length and turn around slowly. The ball would look full when the lamp is behind you and a sliver when you're facing the lamp."),
      T("What would that predict about when a full moon rises?"),
      Y("If the full moon is opposite the sun, it should rise right around sunset. That's consistent with what I noticed on our camping trip, although I'm not sure it's exactly at sunset every time."),
      T("Why might it not be exactly at sunset?"),
      Y("Probably because the moon's orbit is tilted and it moves about 13 degrees a day, so the timing drifts. Also hills on the horizon would change what 'rising' looks like."),
    ],
  },
  {
    id: "g8-typed-argument",
    expected: 8,
    why: "8: abstract, qualified argument; 'ethical', 'conservation', 'arguably', concession structure",
    scholarName: "Rin",
    title: "Should zoos exist?",
    turns: [
      T("Should zoos exist?"),
      Y("I think it depends on what the zoo is for. If its main purpose is entertainment, it's hard to justify keeping intelligent animals in small enclosures, but conservation programs are a different case."),
      T("What makes conservation different?"),
      Y("Some species, like the California condor, arguably wouldn't exist anymore without captive breeding. The ethical cost to individual animals has to be weighed against the survival of the whole species."),
      T("Is that trade-off always worth it?"),
      Y("Not always. For animals that range over huge territories, like elephants, the evidence suggests captivity causes chronic stress, so the benefit would need to be substantial. I'd support zoos that can show measurable conservation outcomes rather than just claiming them."),
      T("How would you measure that?"),
      Y("You could track how many animals are successfully reintroduced to the wild, and whether the wild populations actually stabilize afterward, rather than counting visitors or donations."),
    ],
  },
];

const anthropic = new Anthropic();
const runs = Number(process.argv[process.argv.indexOf("--runs") + 1]) || 3;
const model = process.env.OBSERVER_MODEL || MODELS.SONNET;

async function judge(c: Case): Promise<string | null> {
  const history = c.turns.map((t, i) => ({
    id: `m${i}`,
    role: t.role,
    sourceRole: t.role,
    content: t.content,
    ...(t.role === "user" ? { inputModality: t.spoken ? ("spoken" as const) : ("typed" as const) } : {}),
  }));
  const userMessage = buildObserverUserMessage(
    buildObserverTranscript(history),
    [],
    [],
    [],
    { scholarName: c.scholarName, scholarId: "eval-scholar", title: c.title, unitContext: null },
    [],
  );
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await anthropic.messages.create({
        model,
        max_tokens: 4096,
        system: OBSERVER_SYSTEM_PROMPT,
        tools: [OBSERVER_TOOL],
        tool_choice: { type: "tool", name: "record_observations" },
        messages: [{ role: "user", content: userMessage }],
      });
      return parseObserverResponse(response.content)?.talkLevel ?? null;
    } catch (error) {
      if (attempt >= 3) throw error;
    }
  }
}

const fmt = (v: number) => (v === 0 ? "K" : String(v));

async function main() {
  console.log(`model ${model}, ${runs} runs per case\n`);
  console.log("| case | expected | grades | spread | scholar words | stored |");
  console.log("|---|---|---|---|---|---|");
  const errors: number[] = [];
  let omitted = 0;
  let total = 0;
  for (const c of CASES) {
    const window = observerTranscriptWindow(
      c.turns.map((t) => ({
        sourceRole: t.role,
        content: t.content,
        inputModality: t.role === "user" ? (t.spoken ? ("spoken" as const) : ("typed" as const)) : undefined,
      })),
    );
    const words = scholarWordCount(window);
    const grades = await Promise.all(Array.from({ length: runs }, () => judge(c)));
    const values = grades.map((g) => gradeValue(g)).filter((v): v is number => v !== null);
    total += grades.length;
    omitted += grades.length - values.length;
    for (const v of values) errors.push(v - c.expected);
    const spread = values.length ? Math.max(...values) - Math.min(...values) : null;
    const stored = grades.filter((g) => validTalkJudgment(g ?? undefined, words)).length;
    console.log(
      `| ${c.id} | ${fmt(c.expected)} | ${grades.map((g) => g ?? "—").join(", ")} | ${spread ?? "—"} | ${words} | ${stored}/${grades.length} |`,
    );
  }
  const mean = errors.reduce((a, b) => a + b, 0) / (errors.length || 1);
  const within = errors.filter((e) => Math.abs(e) <= 1).length / (errors.length || 1);
  console.log(
    `\nanswered ${errors.length}/${total} (omitted ${omitted}) · mean signed error ${mean.toFixed(2)} · within ±1: ${(within * 100).toFixed(0)}% · target |mean| ≤ 0.5 and ≥ 80%: ${Math.abs(mean) <= 0.5 && within >= 0.8 ? "MET" : "NOT MET"}`,
  );
}

void main();
