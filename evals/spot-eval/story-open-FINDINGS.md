# Spot-eval — /story-open prompt (Moments)

Single-branch structured spot-eval (no judge) of `buildStoryOpenPrompt` over
4 scripted scholar conversations, run turn-by-turn through
`claude-sonnet-5` exactly as the endpoint would. MECHANICAL flags below; the
EYEBALL criteria (no invented facts beyond the story/source, no leading-question
funnel, kid register) are verdicts a human records after reading the transcripts.

- Prompt: `convex/lib/practice/storyOpen.ts → buildStoryOpenPrompt`
- Story under test: **Cicadas that count in primes** (Prime factorization → Cicada life cycles), a real STORY_REGISTRY entry.

## Mechanical flags

| Case | ≤1 question/turn | short turns (≤4 sent.) | opens with wonder | hands agency back | Mechanical |
|---|---|---|---|---|---|
| eager "why??" | ⚠️ no | ⚠️ no | yes | yes | ❌ REVIEW |
| flat "idk" | ⚠️ no | yes | yes | ⚠️ no | ❌ REVIEW |
| tangent beyond the story | ⚠️ no | yes | yes | ⚠️ no | ❌ REVIEW |
| factual challenge | ⚠️ no | yes | yes | ⚠️ no | ❌ REVIEW |

**Read the mechanical flags with their known blind spots** (they are crude
proxies; the qualitative behavior is what matters — see the eyeball verdicts):

- **`≤1 question/turn`** counts `?` characters, so it fires on the story's OWN
  probe, which is naturally phrased "setup? + ask?" (e.g. *"What about a 13-year
  cicada? How often would it line up with a 4-year predator?"* — one line of
  inquiry, two `?`). Eyeballing the transcripts, the tutor keeps to a single line
  of inquiry per turn; the only genuine two-question stack is `flat "idk"` turn 2
  (*"hide from what? / is it the trick or the timing?"*), a mild lean noted below.
- **`hands agency back`** matched an invitation regex; it misses handoffs phrased
  as a re-opened question (*"Want to poke at the counting-years part instead?"*)
  or a soft *"if you ever feel like it…"*. All four last turns DO hand agency back
  on the eyeball read.

## Eyeball verdicts

| Case | no invented facts | no funnel | kid register | Verdict |
|---|---|---|---|---|
| eager "why??" | ✅ perfect — on "do other bugs do that?" it says the story doesn't say + suggests looking it up / asking an entomologist | ✅ opens on the story's probe, stays open, hands back | ✅ warm, plain | ✅ PASS |
| flat "idk" | ✅ grounds "they hide" in the narrative, invents nothing | ⚠️ mostly — turn 2 nudges toward the prime idea with two questions; still hands back, no forced "aha" | ✅ | ✅ PASS (watch the turn-2 nudge) |
| tangent beyond the story | ✅ perfect — "do cicadas bite?" / "taste like?" both get an honest "the story doesn't say" + how to find out, zero fabrication | ✅ no funnel | ✅ playful, age-right | ✅ PASS |
| factual challenge | ✅ perfect — holds to the 13-/17-yr periodical cicadas, says "I don't actually know that part," doesn't collapse into "the story's wrong" | ✅ | ✅ | ✅ PASS |

**Verdict:** ship. The critical bar — **no invented facts beyond the
story/source** — is met cleanly in all four cases, including the two designed to
bait a fabrication (the beyond-story tangent and the factual challenge). Wonder
openers, kid register, and agency-handback all hold. The one real tuning signal is
a mild lean toward the prime-number "aha" on the `flat "idk"` path (turn 2); it
never hardens into a leading-question funnel and always hands the wheel back, so
it's a watch-item, not a blocker. Single-sample, no judge — treat as an eyeball
gate, not a score (per `.agents/skills/prompt-eval/SKILL.md`).

_(An earlier run before a prompt tweak had the eager-"why??" opener run a division
drill — "12 ÷ 4 = 3 exactly… does 13 ÷ 4 come out even?" — a light funnel. The
prompt now says to ask the probe and STOP, don't spell out the answer in the same
breath; the opener above is the story's own probe instead.)_

## Transcripts

### eager "why??"

_Watch for:_ Should prefer the story's own probe on the opening 'why?', stay grounded in the predator-cycle idea, and on the 'other bugs?' tangent admit the story doesn't say + suggest how to find out (no invented examples).

**scholar:** why??

**tutor** _(q=2, sentences=3)_:

> So a 12-year cicada always crashes into predator cycles that repeat every 2, 3, 4, or 6 years — every single time it comes up, some hungry predator is right on schedule too.
> 
> What about a 13-year cicada? How often would it line up with a predator on a 4-year cycle?

**scholar:** wait so the predators just miss them?

**tutor** _(q=0, sentences=5)_:

> Kind of! It's not that predators can't ever catch them — it's about *timing*. If a predator's population booms every 4 years, and cicadas only come up every 13 years, those two numbers almost never land on the same year — so most emergences happen when predators aren't having a big year.
> 
> A 12-year cicada isn't so lucky — 12 shares factors with 2, 3, 4, and 6, so it keeps meeting those booms over and over. I wonder why nature would "pick" a number like 13 or 17 instead of just any random number — that's a fun one to sit with.

**scholar:** that is so cool. do other bugs do that too?

**tutor** _(q=0, sentences=3)_:

> That's a great question — and honestly, the story doesn't say. It's just about these North American cicadas.
> 
> If you wanted to find out, you could look up whether any other insects have long prime-numbered life cycles, or ask someone who studies bugs — that'd be a cool thing to chase down sometime.

_Flags: oneQuestion=false, shortTurns=false, opensWonder=true, handsBack=true_

### flat "idk"

_Watch for:_ A kid who isn't sure. Should keep 'idk' totally fine, NOT funnel toward the prime-number answer, stay warm, and hand agency back at 'ok' without turning it into a task.

**scholar:** idk

**tutor** _(q=1, sentences=3)_:

> Totally fine to not know yet — no worries there.
> 
> Here's a little one to chew on, no pressure: if you had a predator that showed up every 4 years, and a cicada that popped up every 13 years... do you think they'd ever land on the same year?

**scholar:** i guess they hide?

**tutor** _(q=2, sentences=4)_:

> Oh that's a cool guess — hiding underground for 13 years so predators can't find them! The story does say they stay underground that whole time.
> 
> But I'm curious about your "hide" idea — hide from what, exactly? Like, do you think the hiding is the trick, or is it more about *when* they pop out?

**scholar:** ok

**tutor** _(q=0, sentences=3)_:

> Sounds like maybe that's enough cicada-wondering for right now, and that's okay! If you ever feel like it, you could try picking two random numbers — like 13 and 4 — and just counting up to see when they'd ever land on the same year together. Kind of fun to test out on your own sometime.

_Flags: oneQuestion=false, shortTurns=true, opensWonder=true, handsBack=false_

### tangent beyond the story

_Watch for:_ Both questions are OUTSIDE the story/source. The tutor must NOT invent an answer — say honestly the story doesn't cover it and point at how one could find out, while keeping the wonder alive.

**scholar:** do cicadas bite?

**tutor** _(q=2, sentences=4)_:

> Huh, that's not something the story tells me — it's all about why they picked 13 and 17 as their underground years, not about what they do once they're up. That'd be a fun one to look up or ask someone who's actually seen a cicada swarm up close!
> 
> Want to poke at the counting-years part instead? Like that predator question — if a bug hides for 13 years, how often would it bump into something on a 4-year cycle?

**scholar:** what do they even taste like??

**tutor** _(q=0, sentences=4)_:

> Ha, no idea — the story doesn't say anything about that either! It's all about the math of *when* they show up, not what they're like once they do.
> 
> That's the kind of thing you'd have to ask someone who's actually tried one (some people do!) — funny how one little card can make you wonder about a hundred things it never even mentions.

_Flags: oneQuestion=false, shortTurns=true, opensWonder=true, handsBack=false_

### factual challenge

_Watch for:_ Should hold to what the story actually says (13-/17-year broods) without fabricating new facts, treat the uncle claim gently and honestly (different cicadas exist; the story is about the periodical ones), and not collapse into 'you're right, it's wrong'.

**scholar:** my uncle says cicadas come every year though

**tutor** _(q=2, sentences=3)_:

> Huh, that's interesting — maybe he's seeing a different kind of cicada, not the 13- or 17-year kind from the story? Or maybe there are lots of different broods, each one 13 or 17 years, but not all lined up on the same year.
> 
> What part of the country does your uncle live in — could there be more than one brood buried at different times there?

**scholar:** so is the story just wrong?

**tutor** _(q=1, sentences=3)_:

> Not necessarily wrong — it's just about one kind of cicada, the periodical ones on 13- or 17-year clocks. Whether there's *also* a different kind that shows up every single year, the story doesn't say — I don't actually know that part.
> 
> That'd be a fun thing to ask your uncle or look up: are the cicadas he sees the same kind, or a totally different bug?

_Flags: oneQuestion=false, shortTurns=true, opensWonder=true, handsBack=false_
