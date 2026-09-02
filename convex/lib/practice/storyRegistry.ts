/**
 * Story registry — curated, verified skill->world bridge stories.
 *
 * Runtime truth lives on `knowledgeNodeEdges.story`; this file is the reviewable
 * starter bank. Rebuilds seed missing durable story edges but never overwrite an
 * existing durable edge for the same pair.
 */

export type StoryKind = "instantiates" | "applies" | "history" | "etymology";

export type RegistryQuestion = {
  text: string;
  answer?: string;
  answerType?: "integer" | "decimal" | "fraction" | "multipleChoice";
  choices?: string[];
  technique?: string;
  bloomLevel?: number;
};

type RegistryStoryBase = {
  fromKey: string;
  toKey: string;
  toLabel: string;
  toDomain: string;
  kind: StoryKind;
  hook: string;
  // 1-3 sentence card teaser: the hook + the surprise, withholding the full
  // explanation so "Find out more" still delivers it Socratically. The card
  // renders THIS in place of `narrative`; the full narrative remains the tutor
  // thread's context (storyOpen). Content metadata, not a UI primitive.
  teaser?: string;
  // One curiosity cue, authored per story or stable world family. It must suggest
  // an entry point without literally illustrating or resolving the story.
  visualEmoji?: string;
  narrative: string;
  source?: string;
  // Provenance stamped onto the seeded edge's story. Omit for the hand-curated
  // starter bank (defaults to "registry"); "generated" marks entries that were
  // LLM-authored and adversarially fact-checked before being committed here.
  provenance?: "registry" | "generated";
};

export type RegistryStory = RegistryStoryBase &
  (
    | { probe?: string; questions?: never }
    | { probe?: never; questions?: RegistryQuestion[] }
  );

const STORY_FAMILY_VISUALS: Record<string, string> = {
  "cicada life cycles": "🪲",
  algorithms: "⚙️",
  cryptography: "🔐",
  "modular arithmetic": "🔄",
  "error-detecting codes": "✅",
  "numeral systems": "✍️",
  "number words across languages": "🗣️",
  timekeeping: "🕰️",
  "exponential growth": "♟️",
  "figurate numbers": "🔲",
  "mathematical notation": "🟰",
  "scale of the universe": "🔭",
  "ancient egyptian mathematics": "🏺",
  "musical rhythm": "🥁",
  "carpentry measurement": "📏",
  "map scale": "🗺️",
  "risk and insurance": "🎲",
  "games of chance": "🎲",
  "history of probability": "✉️",
  "weather forecasting": "🌦️",
  "number words": "🔤",
  "history of mathematical notation": "🟰",
  "group theory": "🧩",
  "maya mathematics": "🐚",
  subitizing: "👀",
  "anumeric languages": "🗣️",
  "banker's rounding": "🏦",
  "two's complement": "💻",
  "mechanical calculators": "⚙️",
  "lattice multiplication": "🧮",
  "cyclic numbers": "🔁",
  "polynomial arithmetic": "📐",
  "naming large numbers": "🔎",
  "ulam spiral": "🌀",
  polyrhythm: "🥁",
  "pythagorean tuning": "🎵",
  "hunting gears": "⚙️",
  "mediants and farey sequences": "➗",
  "egyptian & russian peasant multiplication": "🏺",
  "mental abacus (anzan)": "🧮",
  "modular multiplication circles": "🕰️",
  "sieve of eratosthenes": "🧹",
  "simpson's paradox": "📊",
  "divisor pairs & the locker problem": "🔒",
  "fair cake-cutting": "🍰",
  "binary (base-2) fractions": "📄",
  "the change-making problem": "⚖️",
  "reverse polish notation": "🧮",
  reciprocals: "🔍",
  "the chinese remainder theorem": "🧩",
  "the house edge": "🎰",
  "the checkout total": "🧾",
  "highway speed": "🛣️",
  "orders of magnitude": "🌌",
  "kenken puzzles": "🧩",
  "p vs np": "💻",
  "al-jabr": "📜",
  "temperature scales": "🌡️",
  "method of false position": "🏺",
};

const STORY_REGISTRY_BASE: RegistryStory[] = [
  {
    fromKey: "prime_factorization",
    toKey: "cicada life cycles",
    toLabel: "Cicada life cycles",
    toDomain: "biology",
    kind: "instantiates",
    hook: "Cicadas that count in primes",
    teaser:
      "Some cicadas wait exactly 13 or 17 years underground, then swarm all at once — and both numbers are prime. Biologists suspect that prime is the whole trick to staying alive.",
    narrative:
      "Periodical cicadas in North America stay underground 13 or 17 years, then a whole brood surfaces at once — and both cycle lengths are prime. One leading hypothesis: a prime cycle almost never lines up with the shorter boom-bust cycles of predators, so the brood rarely emerges into a hungry year. A 12-year cicada would meet a 2-, 3-, 4-, or 6-year predator cycle every single emergence; a 13-year one shares no factors with any of them.",
    probe:
      "A 12-year cicada meets a predator on a 4-year cycle every time it comes up. How often would a 13-year cicada meet it?",
    source: "Magicicada spp.; predator-satiation / cycle-avoidance hypothesis (e.g. Goles, Schulz & Markus 2001)",
  },
  {
    fromKey: "lcm",
    toKey: "cicada life cycles",
    toLabel: "Cicada life cycles",
    toDomain: "biology",
    kind: "instantiates",
    hook: "The 221-year cicada reunion",
    teaser:
      "In 2024 two different cicada broods surfaced together for the first time since 1803, and they won't do it again until 2245. The gap between those reunions is hiding a multiplication you already know.",
    narrative:
      "In 2024, a 13-year cicada brood and a 17-year brood emerged in the same season — the first time since 1803. That's not a coincidence of history; it's the least common multiple: 13 × 17 = 221, and both numbers are prime, so the LCM is their product. The next double emergence is 2245.",
    questions: [
      {
        text:
          "One brood surfaces every 13 years, the other every 17; both came up in 2024. In what calendar year do they next surface together?",
        answer: "2245",
        answerType: "integer",
        technique: "application_direct",
        bloomLevel: 3,
      },
      {
        text:
          "The two broods' reunion gap is exactly 13 × 17 = 221 years — their two cycle lengths multiplied. Why does multiplying give the gap here, when for a 12-year and a 4-year cycle the gap is much smaller than 12 × 4?",
      },
    ],
    source: "Broods XIX (13-yr) and XIII (17-yr), co-emerged 2024; widely reported",
  },
  {
    fromKey: "gcf",
    toKey: "algorithms",
    toLabel: "Algorithms",
    toDomain: "computer-science",
    kind: "history",
    hook: "The oldest algorithm still running",
    teaser:
      "A recipe for finding the greatest common factor was written down around 300 BC, and it is still running inside your phone right now — older than the Colosseum and quietly guarding your messages.",
    narrative:
      "Euclid wrote down a step-by-step recipe for finding the greatest common factor around 300 BC — repeatedly divide and keep the remainder. It's one of the oldest algorithms known, and it isn't a museum piece: computers run it constantly today, inside fraction arithmetic and the cryptography that protects messages.",
    source: "Euclid, Elements, Book VII (c. 300 BC)",
  },
  {
    fromKey: "prime_composite",
    toKey: "cryptography",
    toLabel: "Cryptography",
    toDomain: "computer-science",
    kind: "applies",
    hook: "Primes guard your secrets",
    teaser:
      "Multiplying two giant primes together is easy, but working backward to find them can stump the fastest computers on Earth for longer than a lifetime. Your private messages hide inside that gap.",
    narrative:
      "A lot of internet encryption rests on a lopsided fact about primes: multiplying two enormous primes together is easy, but starting from the product and recovering the primes (factoring) is so hard that even the fastest computers can't do it in a human lifetime. Your message rides inside that one-way street.",
    source: "RSA public-key cryptography (Rivest–Shamir–Adleman, 1977)",
  },
  {
    fromKey: "divisibility_rules_3_9",
    toKey: "modular arithmetic",
    toLabel: "Modular arithmetic",
    toDomain: "math",
    kind: "instantiates",
    hook: "Why the digit-sum trick isn't a trick",
    teaser:
      "Add up a number's digits and you can instantly tell whether 9 divides it. That shortcut feels like a magic trick, and the reason it works comes down to the number 10.",
    narrative:
      "Adding up digits to test for 9 works because 10 leaves a remainder of 1 when divided by 9 — so every power of ten does too, and each digit carries its full value's remainder. The rule is place value and remainders shaking hands, and it would work in any base: in base 8, the same trick tests for 7.",
    probe:
      "Would your digit-sum trick for 9s still work if we wrote numbers in base 8? What number would it test for instead?",
  },
  {
    fromKey: "remainder_cycles",
    toKey: "error-detecting codes",
    toLabel: "Error-detecting codes",
    toDomain: "computer-science",
    kind: "applies",
    hook: "The last digit that catches typos",
    teaser:
      "The last digit of a credit card number has a secret job: it is a trap for typos. Get one digit wrong and it quietly refuses to add up, so the machine catches you before anything is charged.",
    narrative:
      "The final digit of a credit card number or a book's ISBN isn't part of the number — it's a check digit, computed from the others with remainder arithmetic. Type one digit wrong and the remainder comes out different, so the machine catches the typo before anything gets charged.",
    source: "Luhn algorithm (mod 10); ISBN check digits",
    questions: [
      {
        text:
          "A book's ISBN-13 self-checks like this: multiply its 13 digits by 1, 3, 1, 3, ... from left to right, add the products, and a valid code makes that total a multiple of 10. A scanner reads the first 12 digits as 978-0-306-40615 but the 13th (check) digit is smudged. The 13th digit is multiplied by 1. What must it be so the code is valid?",
        answer: "7",
        answerType: "integer",
        technique: "application_direct",
        bloomLevel: 3,
      },
    ],
  },
  {
    fromKey: "place_value_multidigit",
    toKey: "numeral systems",
    toLabel: "Numeral systems",
    toDomain: "history",
    kind: "history",
    hook: "Why Roman engineers couldn't long-divide",
    teaser:
      "The Romans built roads and aqueducts across a continent, yet they could not do long division on paper the way you can. Their own numerals made it impossible.",
    narrative:
      "Roman numerals have no place value and no zero, so column arithmetic — carrying, borrowing, long division — is impossible in the notation itself. Romans computed on pebble-boards and abaci instead (our word 'calculate' comes from calculus, a counting pebble). Positional digits with zero reached Europe from Indian mathematicians by way of the Arab world, and arithmetic as we write it became possible.",
    probe: "Would your carrying trick survive if you had to write the numbers as MMDCCLX?",
    source: "Fibonacci, Liber Abaci (1202), which introduced Hindu–Arabic numerals to Europe",
  },
  {
    fromKey: "tens_ones_to_99",
    toKey: "number words across languages",
    toLabel: "Number words across languages",
    toDomain: "linguistics",
    kind: "etymology",
    hook: "We count in tens because of your hands",
    teaser:
      "There is a reason the world mostly counts in tens, and you are holding it: ten fingers. Some languages still count by twenties, and the leftovers are hiding in words people say today.",
    narrative:
      "'Digit' is Latin digitus — finger. Base ten won because humans carry ten of them. Not everyone agreed: French still says quatre-vingts ('four twenties') for 80, a leftover from counting by twenties — fingers and toes.",
  },
  {
    fromKey: "factors_and_multiples",
    toKey: "timekeeping",
    toLabel: "Timekeeping",
    toDomain: "history",
    kind: "history",
    hook: "Why 12 and 60 rule your day",
    teaser:
      "An hour has 60 minutes, a circle has 360 degrees, and eggs come in twelves. That is no accident — 12 and 60 were chosen thousands of years ago for a reason still ticking on your clock.",
    narrative:
      "An hour has 60 minutes, a circle 360 degrees, eggs come in dozens — because 12 and 60 have an unusual number of factors for their size. 60 splits evenly into halves, thirds, quarters, fifths, sixths, tenths… The Babylonians built their number system on 60 for exactly this reason, and their choice is still on your clock.",
  },
  {
    fromKey: "exponents_repeated_mult",
    toKey: "exponential growth",
    toLabel: "Exponential growth",
    toDomain: "math",
    kind: "instantiates",
    hook: "The chessboard that bankrupts a kingdom",
    teaser:
      "A man asks for one grain of rice on the first chessboard square, doubled on each square after. It sounds humble, until the last square alone owes more rice than the whole world grows in centuries.",
    narrative:
      "In the old legend, a reward of one grain of rice on the first chessboard square, doubled on each of the 64 squares, sounds humble — but the last square alone holds 2⁶³ grains, about nine quintillion, centuries' worth of the entire world's rice harvest. Repeated multiplication doesn't grow; it explodes.",
    probe: "One grain, doubled 63 times. Estimate: could the kingdom pay it? How would you even check?",
  },
  {
    fromKey: "square_cube_numbers",
    toKey: "figurate numbers",
    toLabel: "Figurate numbers",
    toDomain: "math",
    kind: "instantiates",
    hook: "Square numbers actually make squares",
    teaser:
      "Line up 1, then 4, then 9 pebbles and each really does form a perfect square. Add the odd numbers 1, 3, 5, 7 and you can watch why it happens before anyone proves it to you.",
    narrative:
      "The Greeks arranged pebbles: 1, 4, 9, 16 form literal squares, and each next square is the last one plus an L-shaped border of odd size. That's why 1 + 3 + 5 + 7 = 16 — the sum of the first n odd numbers is always n², and you can see it before you can prove it.",
    probe: "Add 1 + 3 + 5 + 7. Now try drawing it as a square that grows an L each time. What's happening?",
  },
  {
    fromKey: "order_of_operations",
    toKey: "mathematical notation",
    toLabel: "Mathematical notation",
    toDomain: "history",
    kind: "history",
    hook: "The rule mathematicians had to agree on",
    teaser:
      "Type 1 + 2 × 3 into a basic calculator and it says 9; type it into a scientific one and it says 7. Neither is broken — they follow different rules that people had to argue their way into.",
    narrative:
      "Order of operations isn't a law of nature — it's a convention, like grammar, that settled in as algebra notation matured. Machines expose the seam: a basic four-function calculator works left to right and says 1 + 2 × 3 = 9, while a scientific calculator honors precedence and says 7. Same keys, different grammar.",
    probe: "Two calculators give different answers to 1 + 2 × 3. Neither is broken. What's going on?",
  },
  {
    fromKey: "powers_of_ten",
    toKey: "scale of the universe",
    toLabel: "Scale of the universe",
    toDomain: "astronomy",
    kind: "applies",
    hook: "Picnic blanket to the whole universe in ~26 steps",
    teaser:
      "Start at a picnic blanket and zoom out by ten times, again and again. In only a couple dozen steps you have left the whole galaxy behind — multiplying by ten is the fastest ladder there is.",
    narrative:
      "There's a famous short film, Powers of Ten (1977), that zooms out by ×10 every ten seconds: a picnic blanket, a city, the Earth, the solar system, the galaxy — the visible universe arrives in only a few dozen steps. Multiplying by ten is the fastest ladder there is; scientists write the universe in its rungs.",
    questions: [
      {
        text:
          "In the film Powers of Ten, the view starts 1 meter wide and becomes 10 times wider every 10 seconds. A museum label says the view is 30 meters wide at 30 seconds. Is the label correct?",
        answer: "2",
        answerType: "multipleChoice",
        choices: ["Yes", "No — it should be 300", "No — it should be 1000"],
        technique: "application_interpret",
        bloomLevel: 3,
      },
      {
        text:
          "In Powers of Ten the Solar-System frame is about 10^13 meters wide and the Milky-Way frame is about 10^21 meters wide — 8 of the ×10 steps apart. A student says the galaxy frame is \"8 times\" wider. By what factor is it actually wider?",
        answer: "1",
        answerType: "multipleChoice",
        choices: ["8 times", "100 million times", "10 billion times"],
        technique: "application_spot_error",
        bloomLevel: 4,
      },
    ],
    source: "Charles & Ray Eames, Powers of Ten (1977)",
  },
  {
    fromKey: "unit_fraction",
    toKey: "ancient egyptian mathematics",
    toLabel: "Ancient Egyptian mathematics",
    toDomain: "history",
    kind: "history",
    hook: "Egypt wrote every fraction with a 1 on top",
    teaser:
      "Ancient Egyptian scribes almost never wrote 3/4. They would write 1/2 plus 1/4 instead, running an entire kingdom's bread and beer on the very fractions you are learning first.",
    narrative:
      "Ancient Egyptian scribes (the Rhind Papyrus, ~1650 BC) wrote fractions almost exclusively as sums of DISTINCT unit fractions: not 3/4, but 1/2 + 1/4. Dividing bread and beer among workers, they ran an entire economy on the pieces you're learning first.",
    source: "Rhind Mathematical Papyrus, c. 1650 BC",
  },
  {
    fromKey: "equivalent_fractions_general",
    toKey: "musical rhythm",
    toLabel: "Musical rhythm",
    toDomain: "music",
    kind: "instantiates",
    hook: "Two quarter notes ARE a half note",
    teaser:
      "Clap two quarter notes, then clap one half note — they take exactly the same time. Music has been writing 2/4 = 1/2 out loud for centuries, and you can hear it.",
    narrative:
      "Music notation is fraction arithmetic that you can hear: a whole note splits into two halves, four quarters, eight eighths, and a 3/4 time signature literally means three quarter-note beats per measure. When two quarter notes fill the same time as one half note, that's 2/4 = 1/2 — equivalence, out loud.",
    probe: "Clap two quarter notes, then one half note. Same length of time. What does that say about 2/4 and 1/2?",
  },
  {
    fromKey: "common_denominators",
    toKey: "carpentry measurement",
    toLabel: "Carpentry measurement",
    toDomain: "engineering",
    kind: "applies",
    hook: "Why carpenters avoid thirds",
    teaser:
      "Look closely at a tape measure and you will find halves, quarters, eighths, and sixteenths, but never a third of an inch. Carpenters chose those denominators on purpose, and it makes their fractions add up with no work.",
    narrative:
      "A tape measure divides the inch into halves, quarters, eighths, sixteenths — all powers of two, so any two marks already share a denominator and lengths add without converting. A third of an inch never lands on a mark: the tool itself chose denominators that play well together.",
    questions: [
      {
        text:
          "A tape measure divides each inch only into halves, quarters, eighths, and sixteenths — so every printed mark is some number of sixteenths (k/16). A plan calls for the exact 1/3-inch point. Among the printed marks on this tape, where does that point fall?",
        answer: "1",
        answerType: "multipleChoice",
        choices: [
          "Right on a 1/3-inch printed mark — every tape has thirds",
          "Between the 5/16 and 6/16 printed marks — no printed mark equals 1/3",
          "Exactly on the 5/16 printed mark, since 5/16 = 1/3",
        ],
        technique: "application_interpret",
        bloomLevel: 4,
      },
    ],
  },
  {
    fromKey: "fraction_scaling",
    toKey: "map scale",
    toLabel: "Map scale",
    toDomain: "geography",
    kind: "instantiates",
    hook: "Every map is a multiplication by a fraction",
    teaser:
      "A trail map shrinks a whole mountain down to fit in your hand by multiplying every distance by the same fraction, all at once. Zoom a photo and you have just done the exact same trick.",
    narrative:
      "A 1:24,000 trail map is the world scaled by the fraction 1/24000 — every real distance multiplied by it, all at once, in both directions. Zoom a photo to 3/4 and you've done the same thing. Fraction multiplication isn't shrinking numbers; it's resizing simulator.",
    questions: [
      {
        text:
          "A trail is 1 mile long in the real world. It's printed on two maps: one at scale 1:24,000 (every real distance × 1/24,000) and one at 1:62,500 (× 1/62,500). A hiker says the trail must look longer on the 1:62,500 map because 62,500 is the bigger number. On which map is the 1-mile trail actually drawn longer?",
        answer: "1",
        answerType: "multipleChoice",
        choices: [
          "The 1:62,500 map — the bigger number means a bigger drawing",
          "The 1:24,000 map — you multiply by 1/24,000, and 1/24,000 is the bigger fraction, so the trail is drawn longer",
          "Both the same — map scale doesn't change how long the trail is drawn",
        ],
        technique: "application_spot_error",
        bloomLevel: 4,
      },
    ],
  },
  {
    fromKey: "law_of_large_numbers",
    toKey: "risk and insurance",
    toLabel: "Risk and insurance",
    toDomain: "economics",
    kind: "instantiates",
    hook: "Why the casino always wins (and how insurance works)",
    teaser:
      "One spin of a roulette wheel is anyone's guess, yet a casino can predict a million spins closely enough to build a skyscraper on it. Insurance companies quietly run the very same math.",
    narrative:
      "One spin of a roulette wheel is anyone's guess; a million spins are almost perfectly predictable. Casinos and insurance companies are the same business: each single event is uncertain, but the long-run average is so reliable you can build a skyscraper on it. The law of large numbers is that reliability, made precise.",
    questions: [
      {
        text:
          'At a roulette wheel, red has come up 6 times in a row. A gambler says, "By the law of large numbers, black is now due — it has to come up to balance things out." Is he applying the law correctly?',
        answer: "1",
        answerType: "multipleChoice",
        choices: [
          "Yes — black is now more likely",
          'No — each spin is independent; the law is about long-run averages, not "catching up"',
        ],
        technique: "application_spot_error",
        bloomLevel: 4,
      },
    ],
  },
  {
    fromKey: "compound_two_dice",
    toKey: "games of chance",
    toLabel: "Games of chance",
    toDomain: "games",
    kind: "instantiates",
    hook: "Why 7 owns the dice table",
    teaser:
      "Roll two dice and 7 comes up more than any other total, by a lot. Game designers know it, which is why the robber in Catan and the whole game of craps are built around that one number.",
    narrative:
      "With two dice there are 36 equally likely rolls, and six of them make 7 — more than any other total (2 and 12 get one way each). Game designers build around this: it's why the robber in Catan lives on 7 and why craps pivots on it.",
    questions: [
      {
        text:
          "Two dice give 36 equally likely rolls: 7 comes up 6 ways, 2 comes up 1 way. In a board game, rolling a 7 is how many times as likely as rolling a 2?",
        answer: "6",
        answerType: "integer",
        technique: "application_interpret",
        bloomLevel: 3,
      },
      {
        text:
          "Seven comes up six times as often as two. If you were designing a board game, which totals would you make powerful and which would you make rare — and why would 7 be the natural 'special' number?",
      },
    ],
  },
  {
    fromKey: "sample_space",
    toKey: "history of probability",
    toLabel: "History of probability",
    toDomain: "history",
    kind: "history",
    hook: "Probability was invented in letters about gambling",
    teaser:
      "The entire mathematics of chance began because a gambler in 1654 kept losing money and wanted to know why. Two of history's great mathematicians worked out the answer by mail.",
    narrative:
      "In 1654 a French gambler asked Blaise Pascal why certain dice bets kept losing money, and Pascal worked it out in letters with Pierre de Fermat — counting complete sample spaces carefully for the first time. The mathematics of chance was born as correspondence about a game.",
    questions: [
      {
        text:
          "In the 1600s gamblers noticed that when three dice are thrown, a total of 10 comes up a little more often than 9 — even though each total can be written as six different number-triples (for 9: 1-2-6, 1-3-5, 1-4-4, 2-2-5, 2-3-4, 3-3-3). The Grand Duke of Tuscany asked Galileo to explain. What is the resolution?",
        answer: "0",
        answerType: "multipleChoice",
        choices: [
          "The equally likely outcomes are ordered rolls, not triples: 10 comes from 27 ordered rolls but 9 from only 25",
          "The dice must be loaded so that 10 is heavier than 9",
          "There are actually seven triples for 10 and six for 9",
        ],
        technique: "application_spot_error",
        bloomLevel: 4,
      },
    ],
    source: "Pascal–Fermat correspondence, 1654 (the Chevalier de Méré's problems)",
  },
  {
    fromKey: "experimental_probability",
    toKey: "weather forecasting",
    toLabel: "Weather forecasting",
    toDomain: "earth-science",
    kind: "applies",
    hook: "What '70% chance of rain' actually means",
    teaser:
      "A '70% chance of rain' sounds simple, but it means something far more exact than most people think. And forecasters get graded on it, in public, every single day.",
    narrative:
      "A forecast of 70% doesn't mean 'mostly raining' — roughly speaking, it means that of all the past days that looked like this one, about 7 in 10 ended up wet. Forecasters keep score against reality (it's called calibration), which makes weather one of the few places you can watch experimental probability get graded in public.",
    questions: [
      {
        text:
          'Two forecasters each said "70% chance of rain" on 100 different days. For Forecaster A it actually rained on 71 of those days; for Forecaster B it rained on 40 of them. Whose "70%" forecasts were better calibrated — closer to what really happened?',
        answer: "0",
        answerType: "multipleChoice",
        choices: ["Forecaster A", "Forecaster B", "They were equally good"],
        technique: "application_interpret",
        bloomLevel: 4,
      },
      {
        text:
          'The forecast said "70% chance of rain," and the day turned out completely dry. A friend says, "That proves the 70% forecast was just wrong." Does one dry day prove the forecast was wrong?',
        answer: "1",
        answerType: "multipleChoice",
        choices: [
          "Yes — it should have rained",
          "No — a 70% forecast expects about 3 in 10 such days to stay dry",
        ],
        technique: "application_spot_error",
        bloomLevel: 3,
      },
    ],
  },

  // -- Generated batch (LLM-authored, adversarially fact-checked, curated 2026-07) --
  {
    fromKey: "compose_ten",
    toKey: "number words",
    toLabel: "Number Words",
    toDomain: "linguistics",
    kind: "etymology",
    hook: "'Eleven' means 'one left over'",
    teaser:
      "Why isn't 11 just called 'oneteen'? The words 'eleven' and 'twelve' hide an old secret about your ten fingers, and it is the reason the pattern snaps neatly into place at 'thirteen'.",
    narrative:
      "Why isn't 11 called 'oneteen'? Because 'eleven' comes from Old English endleofan — 'one left' — and 'twelve' from twelf, 'two left': one or two left over after you've used up all ten fingers. Then the pattern switches: 'thir-teen,' 'four-teen' just mean 'three and ten,' 'four and ten.' The teens are hiding a ten inside every word.",
    probe:
      "Say 'thirteen, fourteen, fifteen' slowly. Where's the ten hiding? Now why do you think 'eleven' and 'twelve' break that pattern?",
    source: "Old English endleofan ('one left') and twelf ('two left'); '-teen' from tene, ten. Germanic number etymology.",
    provenance: "generated",
  },
  {
    fromKey: "compare_within_10",
    toKey: "history of mathematical notation",
    toLabel: "History of Mathematical Notation",
    toDomain: "history",
    kind: "history",
    hook: "The = sign is two lines 'because no two things are more equal'",
    teaser:
      "For centuries people wrote out 'is equal to' in words, every single time. Then one tired mathematician in 1557 drew two little parallel lines instead, and gave a reason you will never forget.",
    narrative:
      "Before 1557 people wrote 'is equal to' in words. A Welsh mathematician, Robert Recorde, got tired of it and invented '=' — a pair of parallel lines — 'bicause noe 2 thynges can be moare equalle' than two lines of the same length. The < and > signs came a bit later. The symbols you use to compare numbers each had an inventor.",
    probe:
      "Recorde picked two equal-length parallel lines for '='. If you had to invent a brand-new symbol for 'greater than,' what would you draw, and why?",
    source: "Robert Recorde, The Whetstone of Witte (1557); < and > signs from Thomas Harriot, published 1631.",
    provenance: "generated",
  },
  {
    fromKey: "add_subtract_properties",
    toKey: "group theory",
    toLabel: "Group Theory",
    toDomain: "math",
    kind: "instantiates",
    hook: "3+5=5+3, but your Rubik's cube disagrees",
    teaser:
      "Adding does not care about order — 3+5 is always 5+3. That feels obvious, until you turn a Rubik's cube two ways and land in two different places. Some operations do not play so fair.",
    narrative:
      "Addition doesn't care about order — 3+5 and 5+3 always match. That's called being 'commutative,' and it feels obvious. But it's special: twist a Rubik's cube right-then-up and you get a different result than up-then-right. Turning in 3-D, shuffling steps, even subtraction (5−3 ≠ 3−5) all break the rule. Order not mattering is a gift, not a given.",
    questions: [
      {
        text:
          "A student sees that 3 + 5 = 5 + 3 and 6 + 2 = 2 + 6, and decides: \"The order you do two things in never changes the result.\" To test that in real life, they compare putting on socks-then-shoes with shoes-then-socks. What does the test reveal about the rule?",
        answer: "1",
        answerType: "multipleChoice",
        choices: [
          "Order never matters, so both give the same result",
          "Addition commutes, but many actions (socks-then-shoes vs shoes-then-socks) come out different — commuting is special, not universal",
          "Addition doesn't really commute either",
        ],
        technique: "application_spot_error",
        bloomLevel: 4,
      },
    ],
    source: "Commutative property; non-commutative (non-abelian) groups — e.g. the Rubik's Cube group and 3-D rotations.",
    provenance: "generated",
  },
  {
    fromKey: "place_value_to_1000",
    toKey: "maya mathematics",
    toLabel: "Maya Mathematics",
    toDomain: "history",
    kind: "history",
    hook: "The Maya wrote zero as a seashell",
    teaser:
      "The 0 in 305 is doing a quiet, crucial job. Inventing a symbol for 'nothing here' turned out to be one of the hardest ideas in history, and the Maya cracked it over 1,500 years ago — as a shell.",
    narrative:
      "Place value needs a zero — a mark meaning 'nothing in this column' so 305 doesn't collapse into 35. Only a few peoples ever invented one from scratch. The Maya were one, over 1,500 years ago: they built a place-value system (in twenties, not tens) and drew zero as a little shell shape, carving huge dates into stone monuments. Zero isn't obvious — it's one of history's great inventions.",
    probe:
      "Without a zero, how would you tell apart 35, 305, and 350 on the page? What is the 0 in 305 actually doing?",
    source: "Maya Long Count: a vigesimal (base-20) positional system using a shell glyph for zero, first centuries BC–AD.",
    provenance: "generated",
  },
  {
    fromKey: "count_objects_within_10",
    toKey: "subitizing",
    toLabel: "Subitizing",
    toDomain: "cognitive-science",
    kind: "instantiates",
    hook: "You don't count to three — you just see it",
    teaser:
      "Glance at three dots and you do not count them, you just know. That instant knowing has a name and a hard limit, and somewhere past four it quietly hands you back to counting.",
    narrative:
      "Show someone two or three dots and they don't count — they instantly know 'three.' Psychologists call this subitizing (from Latin subitus, 'sudden'), and it works up to about four; past that, you really do have to count. Even some animals show a quick sense of small numbers. Counting is the skill you fall back on when your instant number-sense runs out.",
    questions: [
      {
        text:
          "People can recognize a tiny group of dots — up to about four — in a single glance, without counting one by one. You want to show a friend 8 dots so they can tell it's 8 instantly. Which layout works best?",
        answer: "1",
        answerType: "multipleChoice",
        choices: [
          "8 dots scattered at random",
          "Two separate groups of 4",
          "One long row of 8 dots",
        ],
        technique: "application_interpret",
        bloomLevel: 3,
      },
    ],
    source: "Subitizing, coined by Kaufman, Lord, Reese & Volkmann (1949); from Latin subitus, 'sudden.'",
    provenance: "generated",
  },
  {
    fromKey: "cardinality_within_10",
    toKey: "anumeric languages",
    toLabel: "Anumeric Languages",
    toDomain: "linguistics",
    kind: "applies",
    hook: "A language with almost no number words",
    teaser:
      "Somewhere in the Amazon, people speak a language with no exact word for seven — only words like 'few' and 'many'. Counting is a tool for thinking that not every language hands you.",
    narrative:
      "It feels obvious that the last word you count tells how many — but that rides on having counting words at all. The Pirahã people of the Amazon have only approximate quantity words, closer to 'few' and 'many' than to exact numbers. In experiments, matching an exact large pile from memory becomes genuinely hard without words to pin the count. The counting you're learning is also a tool for thinking that not every language hands you.",
    probe:
      "If your language had no word for 'seven,' how would you make sure two piles held exactly the same amount?",
    source: "Pirahã numerical cognition — Gordon, Science (2004); Frank, Everett, Fedorenko & Gibson, Cognition (2008).",
    provenance: "generated",
  },
  {
    fromKey: "round_to_nearest_10_100",
    toKey: "banker's rounding",
    toLabel: "Banker's Rounding",
    toDomain: "computer-science",
    kind: "applies",
    hook: "Computers don't always round .5 up",
    teaser:
      "You were taught to always round a 5 up. Banks and computers often do not, and their stranger rule is quietly fixing a fairness problem hiding inside yours.",
    narrative:
      "You learned to round a 5 up. But always rounding halves up quietly nudges totals a little too high across millions of numbers. So banks and computers often use 'round half to even': 2.5 goes to 2, but 3.5 goes to 4, so the ups and downs cancel out. It's the built-in default in the math chips inside your devices. Even rounding hides a fairness problem.",
    questions: [
      {
        text:
          "To avoid a tiny upward bias when rounding millions of half-values, banks use \"round half to even\": a value ending in .5 goes to the nearest EVEN whole number. Under this rule 2.5 rounds to 2 and 3.5 rounds to 4. What does 4.5 round to?",
        answer: "4",
        answerType: "integer",
        technique: "application_interpret",
        bloomLevel: 4,
      },
    ],
    source: "Round-half-to-even ('banker's rounding'), the default rounding mode in the IEEE 754 floating-point standard.",
    provenance: "generated",
  },
  {
    fromKey: "subtract_2digit_regroup",
    toKey: "two's complement",
    toLabel: "Two's Complement",
    toDomain: "computer-science",
    kind: "applies",
    hook: "Computers subtract without ever borrowing",
    teaser:
      "Borrowing across zeros is the annoying part of subtraction, so computers flat-out refuse to do it. They turn every subtraction into an addition instead, and machines have pulled that trick for a hundred years.",
    narrative:
      "Borrowing across zeros is the fiddly part of subtraction — so computers refuse to do it. To compute A − B, a chip flips every bit of B, adds 1, and then simply ADDS. Subtraction turns into addition, no borrowing anywhere. The trick is called two's complement, and it isn't new: hand-cranked adding machines a century ago subtracted the very same way, by adding a number's 'complement' instead of taking it away.",
    questions: [
      {
        text:
          "An old adding machine can only ADD, never subtract. To compute 53 - 27 it instead adds the 100's-complement of 27, which is 73: it shows 53 + 73 = 126, then throws away the leading 1 (the hundred). Why does discarding that 100 give the right answer to 53 - 27?",
        answer: "0",
        answerType: "multipleChoice",
        choices: [
          "73 = 100 - 27, so 53 + 73 = (53 - 27) + 100; removing the extra 100 leaves 53 - 27 = 26",
          "The machine is broken, and 126 is the true answer",
          "You always drop the first digit when subtracting",
        ],
        technique: "application_interpret",
        bloomLevel: 4,
      },
    ],
    source: "Two's complement arithmetic (modern CPUs); the older 'method of complements' used in mechanical calculators",
    provenance: "generated",
  },
  {
    fromKey: "mult_commutative_associative",
    toKey: "group theory",
    toLabel: "Group Theory",
    toDomain: "mathematics",
    kind: "instantiates",
    hook: "Multiplication doesn't care about order — almost nothing else agrees",
    teaser:
      "3 × 4 is the same as 4 × 3 — just a rectangle of dots turned sideways. That 'order does not matter' rule feels ordinary, yet it is rare enough that a whole branch of math exists to study when it breaks.",
    narrative:
      "3 × 4 = 4 × 3, and 3 rows of 4 dots is just the same picture turned sideways. This 'order doesn't matter' rule feels obvious — but it's actually rare. On a Rubik's cube, turning the right face then the top lands you somewhere totally different from top then right. Socks then shoes isn't shoes then socks. The branch of math that studies exactly when order matters is called group theory.",
    questions: [
      {
        text:
          "In a 3-D graphics tool, scaling a model by 3 then by 4 gives the same size as scaling by 4 then by 3 (both x12). But rotating it 90 degrees about the x-axis then the y-axis leaves it facing a DIFFERENT way than y-then-x. Which idea explains why the scalings agree but the rotations don't?",
        answer: "0",
        answerType: "multipleChoice",
        choices: [
          "Multiplying scale factors commutes (order can't change the product), but 3-D rotations don't commute",
          "Scalings also depend on order; the tool has a bug",
          "Rotations commute but scalings don't",
        ],
        technique: "application_spot_error",
        bloomLevel: 4,
      },
    ],
    source: "Commutativity; group theory studies non-commutative operations like cube rotations and matrix multiplication",
    provenance: "generated",
  },
  {
    fromKey: "add_multidigit_algorithm",
    toKey: "mechanical calculators",
    toLabel: "Mechanical Calculators",
    toDomain: "history",
    kind: "history",
    hook: "The hardest part of an early calculator was carrying the 1",
    teaser:
      "Carrying the 1 is automatic for you. Getting a machine to do it was the great engineering puzzle of the 1600s, and a teenager named Blaise Pascal solved it with falling brass levers.",
    narrative:
      "When you add a tall column, carrying into the next place is automatic for you. Building a machine to do it was the great engineering puzzle of the 1600s. Blaise Pascal, still a teenager, built a brass calculator in 1642 whose cleverest part was a falling-lever mechanism that carried automatically from ones to tens to hundreds — so 999 + 1 could cascade all the way. Every digital adder since wrestles that same carry problem.",
    questions: [
      {
        text:
          "A cheap mechanical counter can roll the ones wheel from 9 around to 0, but its carry is broken — it never passes a carry to the next wheel. It currently reads 0699 and you add 1. A working machine would carry and show 0700. What does the broken counter display instead?",
        answer: "690",
        answerType: "integer",
        technique: "application_interpret",
        bloomLevel: 4,
      },
    ],
    source: "Pascal's calculator, the 'Pascaline', built by Blaise Pascal in 1642",
    provenance: "generated",
  },
  {
    fromKey: "area_model_multiplication",
    toKey: "lattice multiplication",
    toLabel: "Lattice Multiplication",
    toDomain: "history",
    kind: "history",
    hook: "Your area-model grid is a centuries-old algorithm",
    teaser:
      "That grid you draw to multiply big numbers is not a modern classroom invention. Renaissance mathematicians were drawing the very same boxes and diagonals more than 500 years ago.",
    narrative:
      "Breaking a multiplication into a rectangle of partial products isn't a modern classroom invention — it's centuries old. Medieval mathematicians called it 'lattice' or gelosia multiplication; it appears in Renaissance arithmetic texts like the 1478 Treviso Arithmetic, drawn as a grid crossed with little diagonals. It works for exactly the same reason a rectangle's area does: length × width, split into pieces and added back together.",
    probe:
      "Draw 23 × 14 as one rectangle cut into four smaller rectangles. Add the four areas. Why must that total equal the answer you'd get the long way?",
    source: "Lattice (gelosia) multiplication; the Treviso Arithmetic (1478)",
    provenance: "generated",
  },
  {
    fromKey: "long_division_1digit_divisor",
    toKey: "cyclic numbers",
    toLabel: "Cyclic Numbers",
    toDomain: "mathematics",
    kind: "instantiates",
    hook: "Long-divide 1 by 7 and you uncover a number that juggles its own digits",
    teaser:
      "Divide 1 by 7 and the answer never stops: 0.142857, over and over. Multiply that block by 2, or by 3, and the same six digits come back — just shuffled, like a card trick.",
    narrative:
      "Work out 1 ÷ 7 by long division and it never stops: 0.142857 142857 142857… forever. The repeating block, 142857, is magical — multiply it by 2 and you get 285714; by 3 you get 428571: the SAME six digits, just rotated around. It's called a cyclic number, and your long division is exactly what reveals it, one remainder at a time.",
    questions: [
      {
        text:
          "Dividing 1 / 7 by hand gives the decimal digits 1, 4, 2, 8, 5, 7 — and then the leftover (remainder) becomes 1 again, exactly the remainder you started with. What are the next six digits, and why?",
        answer: "0",
        answerType: "multipleChoice",
        choices: [
          "1, 4, 2, 8, 5, 7 again — once a remainder repeats, every following step repeats identically, so 142857 cycles forever",
          "The division ends, because the remainder is 1",
          "0, 0, 0, 0, 0, 0 — the decimal terminates",
        ],
        technique: "application_interpret",
        bloomLevel: 4,
      },
    ],
    source: "1/7 = 0.142857…; 142857 is the best-known cyclic number, found in the repeating decimal of 1/7",
    provenance: "generated",
  },
  {
    fromKey: "expanded_form_multidigit",
    toKey: "polynomial arithmetic",
    toLabel: "Polynomial Arithmetic",
    toDomain: "mathematics",
    kind: "instantiates",
    hook: "Every number is secretly a polynomial",
    teaser:
      "You already write 345 as 300 + 40 + 5. What if you swapped every 10 for the letter x? You would be one small step from algebra, and numbers and equations are far closer than they look.",
    narrative:
      "Expanded form says 345 = 300 + 40 + 5 = 3×10² + 4×10 + 5. That is exactly a polynomial — 3x² + 4x + 5 — with x set to 10. It's no accident: our whole number system is polynomials written in base ten. That's why multiplying two multi-digit numbers looks so much like multiplying two polynomials, with 'carrying' as the only extra step — and computers use that link to multiply gigantic numbers quickly.",
    questions: [
      {
        text:
          "Multiplying 15 x 17 is like multiplying (x + 5)(x + 7) with x = 10. As polynomials, (x + 5)(x + 7) = x^2 + 12x + 35. But 15 x 17 = 255, whose digits are 2, 5, 5 — not 1, 12, 35. What turns the coefficients 1, 12, 35 into the digits 2, 5, 5?",
        answer: "0",
        answerType: "multipleChoice",
        choices: [
          "Carrying: 35 leaves 5 and carries 3; 12 + 3 = 15 leaves 5 and carries 1; 1 + 1 = 2",
          "Rounding each coefficient down to one digit",
          "Nothing — 15 x 17 doesn't actually equal 255",
        ],
        technique: "application_interpret",
        bloomLevel: 4,
      },
    ],
    source: "Positional notation is a polynomial in its base; the basis of fast multiplication algorithms like Karatsuba's",
    provenance: "generated",
  },
  {
    fromKey: "compare_multidigit",
    toKey: "history of mathematical notation",
    toLabel: "History of Mathematical Notation",
    toDomain: "history",
    kind: "history",
    hook: "The equals sign was somebody's idea",
    teaser:
      "Every time you write 43 > 27 you are using a 400-year-old shorthand that somebody had to invent. Before that, people wrote their comparisons out the long way, in words.",
    narrative:
      "In 1557 a Welsh doctor, Robert Recorde, got tired of writing \"is equalle to\" over and over, so he invented \"=\": two parallel lines, he said, \"bicause noe 2 thynges can be moare equalle.\" Before symbols like these caught on, people mostly wrote comparisons out in words. The < and > you use came a bit later, from Thomas Harriot's notebooks, printed in 1631. Every time you write 43 > 27 you're using a 400-year-old shorthand.",
    questions: [
      {
        text:
          "In Roman numerals, MCM (1900) uses fewer symbols than MDCCCLXXXVIII (1888), yet 1900 is the larger number — so \"more symbols means bigger\" fails. Written our way, 1900 and 1888 are instantly comparable. What feature of our notation lets you decide which is bigger just by scanning from the left?",
        answer: "0",
        answerType: "multipleChoice",
        choices: [
          "Place value: digits line up by place, so you compare the highest place first — Roman numerals aren't positional",
          "Our numerals are newer, so they're always the bigger amount",
          "You count the symbols; fewer symbols means the bigger number",
        ],
        technique: "application_interpret",
        bloomLevel: 4,
      },
    ],
    source: "Robert Recorde, The Whetstone of Witte (1557); Thomas Harriot, Artis Analyticae Praxis (1631)",
    provenance: "generated",
  },
  {
    fromKey: "number_name_to_standard",
    toKey: "naming large numbers",
    toLabel: "Naming Large Numbers",
    toDomain: "math",
    kind: "etymology",
    hook: "A nine-year-old named a giant number — and a search engine",
    teaser:
      "When a mathematician needed a name for 1 followed by 100 zeros, he asked his nine-year-old nephew. The kid's made-up word stuck, and a famous company is named after a misspelling of it.",
    narrative:
      "When mathematician Edward Kasner wanted a name for 1 followed by 100 zeros, he asked his nine-year-old nephew, Milton Sirotta, who blurted out \"googol.\" The name stuck. Decades later a new company ended up with an accidental misspelling of it that the founders kept: Google. The number you can barely say in words is far bigger than the count of every atom in the visible universe.",
    probe:
      "A googol is 1 with 100 zeros — more than the number of atoms in the visible universe. Is there anything real you could ever actually count with it?",
    source: "Edward Kasner & James Newman, Mathematics and the Imagination (1940)",
    provenance: "generated",
  },
  {
    fromKey: "prime_or_composite",
    toKey: "ulam spiral",
    toLabel: "Ulam Spiral",
    toDomain: "math",
    kind: "history",
    hook: "The doodle that found a pattern in the primes",
    teaser:
      "Stuck in a boring meeting in 1963, a mathematician doodled the numbers in a spiral and circled the primes. They did not scatter randomly — they lined up in streaks nobody fully understands even now.",
    narrative:
      "In 1963 mathematician Stanislaw Ulam was stuck in a boring meeting, so he doodled — writing the whole numbers in a square spiral and circling the primes. To his surprise the primes didn't scatter randomly; many lined up along diagonal streaks. Mathematicians can partly explain them — some diagonal formulas churn out lots of primes — but the deep pattern of the primes is still one of math's great mysteries. You can draw it yourself: spiral the numbers outward, mark which are prime, and watch the lines appear.",
    questions: [
      {
        text:
          "The prime-rich formula n^2 + n + 41 (found by Euler) gives 41, 43, 47, 53, 61, 71, ... — every value prime for a long streak, and on an Ulam-style spiral they line up along one diagonal. Compute it at n = 40: you get 1681. Is 1681 prime, and what does that mean for the streak?",
        answer: "0",
        answerType: "multipleChoice",
        choices: [
          "Composite — 1681 = 41 x 41 — so the prime streak finally breaks at n = 40",
          "Prime — 1681 is odd, so it must be prime",
          "Prime — Euler proved the formula gives a prime for every n",
        ],
        technique: "application_spot_error",
        bloomLevel: 4,
      },
    ],
    source: "Stanislaw Ulam (1963); popularized by Martin Gardner, Scientific American (1964)",
    provenance: "generated",
  },
  {
    fromKey: "common_multiples",
    toKey: "polyrhythm",
    toLabel: "Polyrhythm",
    toDomain: "music",
    kind: "instantiates",
    hook: "Two rhythms that drift apart and snap back together",
    teaser:
      "Tap one hand every 3 beats and the other every 4. They start together, drift out of sync, then lock perfectly back into place, and exactly when they do is no accident.",
    narrative:
      "In a \"3 against 4\" polyrhythm, one hand taps every 3 beats and the other every 4. They start together, wander out of sync, and lock back into place exactly every 12 beats — the least common multiple of 3 and 4. Drummers from West Africa to composers like Chopin build music on that pull between two clocks that only agree on their common multiples.",
    questions: [
      {
        text:
          "In a 3-against-4 polyrhythm, your left hand strikes every 3 pulses and your right hand every 4 pulses, both starting together on pulse 0. A drummer says the hands next land together on pulse 7 because 3 + 4 = 7. When do the two hands actually strike at the same instant again?",
        answer: "0",
        answerType: "multipleChoice",
        choices: [
          "Pulse 12 — the first pulse that is a multiple of both 3 and 4; 7 is a multiple of neither",
          "Pulse 7, because 3 + 4 = 7",
          "Never — they only lined up at the very start",
        ],
        technique: "application_spot_error",
        bloomLevel: 4,
      },
    ],
    source: "Polyrhythm in West African drumming and Romantic piano; 3-against-4 realigns at LCM(3,4)=12",
    provenance: "generated",
  },
  {
    fromKey: "fraction_number_line",
    toKey: "pythagorean tuning",
    toLabel: "Pythagorean Tuning",
    toDomain: "music",
    kind: "instantiates",
    hook: "The number line you can hear",
    teaser:
      "Press a guitar string exactly halfway and the note jumps up a full octave; press at 2/3 and you get a perfect chord-mate. The simplest fractions make the most beautiful sounds, and people noticed 2,500 years ago.",
    narrative:
      "Stretch a string and pluck it. Press exactly halfway — at 1/2 its length — and the note jumps up an octave; press at 2/3 and you get a perfect fifth, at 3/4 a fourth. The simplest fractions make the most pleasing notes, a discovery credited to Pythagoras' followers using a one-string instrument called a monochord. A guitar approximates these — but only the octave fret sits exactly halfway; the others are nudged slightly so every key sounds good.",
    questions: [
      {
        text:
          "On a plucked string, the SHORTER the vibrating part, the higher the note. Pressing at the 1/2 point gives the octave; pressing at the 2/3 point gives another note (the \"fifth\"). On the 0-to-1 number line, 2/3 sits farther from 0 than 1/2 — so its vibrating part is longer. Compared with the octave, is the 2/3 note higher or lower?",
        answer: "0",
        answerType: "multipleChoice",
        choices: [
          "Lower — 2/3 > 1/2 means a longer vibrating string, and a longer string sounds lower",
          "Higher — a bigger fraction always means a higher note",
          "The same pitch, since both are simple fractions",
        ],
        technique: "application_interpret",
        bloomLevel: 3,
      },
    ],
    source: "Pythagorean tuning and the monochord; ratios 2:1 (octave), 3:2 (fifth), 4:3 (fourth)",
    provenance: "generated",
  },
  {
    fromKey: "simplify_fractions",
    toKey: "hunting gears",
    toLabel: "Hunting Gears",
    toDomain: "engineering",
    kind: "applies",
    hook: "Why good gears have \"ugly\" tooth counts",
    teaser:
      "Engineers deliberately give gears tooth counts that refuse to simplify, like 17 and 40. That awkward-looking choice is exactly what keeps the gears from wearing out early.",
    narrative:
      "A fraction is in lowest terms when its top and bottom share no common factor. Gear designers want the same thing: with tooth counts that share a factor (like 20 and 40) the same tooth pairs meet again and again, but with coprime counts (like 17 and 40) every tooth on one eventually meets every tooth on the other, spreading contact — and wear — across all the pairs. Engineers call the trick a \"hunting tooth\" and deliberately pick counts that won't simplify.",
    questions: [
      {
        text:
          "Gear designers often pick a \"hunting\" pair — two tooth counts that share NO common factor — so every tooth of one gear eventually meets every tooth of the other, spreading wear evenly. Which is a hunting pair: 12 teeth & 18 teeth, or 13 teeth & 40 teeth?",
        answer: "0",
        answerType: "multipleChoice",
        choices: [
          "13 & 40 — they share no factor bigger than 1 (12 & 18 both share 6)",
          "12 & 18 — smaller tooth counts always wear more evenly",
          "Both pairs are hunting pairs",
        ],
        technique: "application_interpret",
        bloomLevel: 4,
      },
    ],
    source: "\"Hunting tooth\" gear design: coprime tooth counts distribute wear evenly",
    provenance: "generated",
  },

  // -- Generated batch 2 (LLM-authored, adversarially fact-checked, curated 2026-07-11) --
  {
    fromKey: "order_fractions",
    toKey: "mediants and farey sequences",
    toLabel: "Mediants and Farey Sequences",
    toDomain: "math",
    kind: "instantiates",
    hook: "The 'wrong' way to add fractions lands you neatly in between",
    teaser:
      "The classic fraction mistake — adding the tops and adding the bottoms — is flat wrong as a sum. Yet the answer always lands neatly between the two fractions you started with, and mathematicians gave it a name.",
    narrative:
      "Everyone's tempting mistake when adding fractions is to add the tops and add the bottoms: 1/3 and 1/2 becomes 2/5. As a sum it's flat wrong — but that number always slips neatly BETWEEN the two you started with (1/3 = 0.33, 2/5 = 0.40, 1/2 = 0.50). Mathematicians call it the mediant, and it's no accident: repeat it and you build the Farey sequences and the Stern–Brocot tree, a structure that lists every fraction in lowest terms exactly once.",
    questions: [
      {
        text:
          "Add the tops and add the bottoms of 1/3 and 1/2 to get the mediant 2/5. Put 1/3, 2/5, and 1/2 in order — does 2/5 fall strictly BETWEEN the other two?",
        answer: "0",
        answerType: "multipleChoice",
        choices: ["Yes", "No"],
        technique: "application_interpret",
        bloomLevel: 3,
      },
      {
        text:
          "The mediant of two fractions always lands between them. What happens if you keep taking mediants of mediants — which fractions can you eventually reach, and is there one you can never land on?",
      },
    ],
    source: "The mediant (a+c)/(b+d) of two fractions; Farey sequences and the Stern–Brocot tree, which enumerate the rationals via repeated mediants",
    provenance: "generated",
  },
  {
    fromKey: "mult_distributive",
    toKey: "egyptian & russian peasant multiplication",
    toLabel: "Egyptian & Russian Peasant Multiplication",
    toDomain: "history",
    kind: "history",
    hook: "Multiply the way ancient Egyptians did — only doubling and adding, no times tables at all",
    teaser:
      "Ancient Egyptian scribes multiplied huge numbers without ever learning a times table. All they did was double and add, and the same idea runs inside the computer you are reading this on.",
    narrative:
      "To find 13 × 47, an Egyptian scribe never used a times table. He wrote 47 and kept doubling — 94, 188, 376 — then added only the doublings that build 13 (= 1 + 4 + 8): 47 + 188 + 376 = 611. It works because 13 × 47 = (1 + 4 + 8) × 47 — the distributive property in disguise. Russian peasants used the very same trick, and the same shift-and-add idea sits underneath how computers multiply to this day.",
    probe:
      "Break 13 into 1 + 4 + 8, so 13 × 47 becomes 1×47 + 4×47 + 8×47. Why does splitting one number into a sum and multiplying each piece separately always land on the same answer?",
    source: "Doubling ('Egyptian') multiplication, Rhind Mathematical Papyrus c. 1650 BC; the same 'Russian peasant' method; binary shift-and-add multiplication in CPUs",
    provenance: "generated",
  },
  {
    fromKey: "make_ten_strategy",
    toKey: "mental abacus (anzan)",
    toLabel: "Mental Abacus (Anzan)",
    toDomain: "cognitive-science",
    kind: "applies",
    hook: "The kids who add faster than a calculator",
    teaser:
      "There are children who can add a long column of numbers faster than someone else can type it into a calculator. Their secret starts with a trick you already know — filling up to ten.",
    narrative:
      "The make-ten strategy — to add 8 + 5, first fill up to ten (8 + 2), then add the leftover 3 — leans on knowing the pairs that make ten by heart. The Japanese soroban abacus leans on the same complement pairs, including the make-ten pairs whenever a carry is needed. Children who master it eventually drop the beads and just picture the frame in their minds — a skill called 'anzan' — and the fastest can add a long list of numbers in their heads faster than someone else can type them into a calculator.",
    probe:
      "To add 8 + 6 by making ten, what do you split the 6 into — and why that pair? What fact about 8 did you need to know instantly?",
    source: "Japanese soroban abacus ten-complement addition; 'anzan' mental-abacus calculation (studied by Frank & Barner, among others)",
    provenance: "generated",
  },

  // -- Wow batch (tournament/research pipeline, adversarially fact-checked, 2026-07-11) --
  {
    fromKey: "skip_count_2s_5s_10s",
    toKey: "modular multiplication circles",
    toLabel: "Modular Multiplication Circles",
    toDomain: "math",
    kind: "instantiates",
    hook: "Skip-counting around a clock draws secret geometry",
    teaser:
      "Put ten dots in a circle and skip-count around them, drawing a line to each landing. Different jumps trace different hidden shapes, and one rule turns the whole circle into a perfect heart.",
    narrative:
      "Draw 10 dots around a circle. Skip-count by 2 and connect the landings: 0-2-4-6-8-0 draws the even-number pentagon. Skip by 5 and you bounce across one diameter. Skip by 3 and you visit every dot before returning. Which shape you get depends on the factors you share with the clock. And a cousin rule — connect every dot n to the dot 2n — turns 200 dots into a perfect heart-shaped curve, the cardioid, the same heart hiding on the edge of the Mandelbrot set.",
    questions: [
      {
        text:
          "Ten dots are spaced evenly around a circle and labeled 0 through 9. Starting at 0 you skip-count by 2, drawing a line to each dot you land on: 0 -> 2 -> 4 -> 6 -> 8 -> ? A friend says the next dot is 10. Which dot do you actually land on?",
        answer: "0",
        answerType: "integer",
        technique: "application_spot_error",
        bloomLevel: 4,
      },
    ],
    source: "Modular arithmetic on a circle; Mathologer, 'Times Tables, Mandelbrot and the Heart of Mathematics'",
    provenance: "generated",
  },
  {
    fromKey: "skip_count_2s_5s_10s",
    toKey: "sieve of eratosthenes",
    toLabel: "Sieve of Eratosthenes",
    toDomain: "math",
    kind: "history",
    hook: "Skip-counting is how you hunt primes",
    teaser:
      "Chant 2, 4, 6, 8 and cross those out, then do the 3s, then the 5s. Whatever survives your skip-counting is a prime — an ancient prime-hunting method you already know how to run.",
    narrative:
      "Write the numbers 2 to 30. Skip-count by 2 and cross out every multiple after 2; skip-count by 3 and cross out every multiple after 3; then by 5, crossing out 25. What survives — 2, 3, 5, 7, 11, 13, 17, 19, 23, 29 — are exactly the primes. The kid-skill of chanting 2, 4, 6, 8 becomes the Sieve of Eratosthenes, an ancient algorithm still used to hunt primes. Skip-counting isn't just faster counting; it's a filter that reveals the hidden structure of multiplication.",
    questions: [
      {
        text:
          "On a Sieve of Eratosthenes from 2 to 50, you've already crossed out every multiple of 2 and every multiple of 3. A classmate says 25 must be prime because it's odd and isn't a multiple of 3. Which pass of the sieve proves them wrong?",
        answer: "0",
        answerType: "multipleChoice",
        choices: [
          "The multiples-of-5 pass — 25 = 5 x 5, so skip-counting by 5 crosses it out",
          "The multiples-of-2 pass — 25 is even",
          "No pass — 25 really is prime",
        ],
        technique: "application_spot_error",
        bloomLevel: 4,
      },
    ],
    source: "Sieve of Eratosthenes, attributed to Eratosthenes of Cyrene; described in ancient arithmetic traditions",
    provenance: "generated",
  },
  {
    // Level-fit move (task f24): authored on `compare_unlike` (grade-4 fraction
    // comparison), but the story's core — combining two ratios into a pooled
    // average and comparing the results (195/630 vs 149/551) — is grade-6+
    // (weighted averages / decimal division). Rehomed to `ratio_compare`
    // (grade 6, "Compare two ratios using equivalent ratios or unit rates"), the
    // exact skill Simpson's Paradox subverts. Content unchanged (fact-checked).
    fromKey: "ratio_compare",
    toKey: "simpson's paradox",
    toLabel: "Simpson's Paradox",
    toDomain: "statistics",
    kind: "applies",
    hook: "A player can beat his rival two seasons straight — and still lose the combined average",
    teaser:
      "David Justice out-hit Derek Jeter in 1995, then out-hit him again in 1996. So who had the better batting average across both years together? The answer flips the moment you combine them.",
    narrative:
      "In 1995 David Justice out-hit Derek Jeter, .253 to .250. In 1996 Justice won again, .321 to .314. Better both years — so better overall, right? Combine each player's two seasons into one fraction of hits over at-bats: Jeter's (12+183)/(48+582) = 195/630, about .310; Justice's (104+45)/(411+140) = 149/551, about .270. Jeter wins the combined record by a mile. Fractions with unlike denominators don't compare like whole numbers — winning every part doesn't mean winning the whole. Statisticians call it Simpson's Paradox.",
    questions: [
      {
        text:
          "Justice out-hit Jeter in 1995 and again in 1996. Pool each player's two seasons into one hits/at-bats fraction — Jeter (12+183)/(48+582), Justice (104+45)/(411+140). Who has the higher COMBINED batting average?",
        answer: "1",
        answerType: "multipleChoice",
        choices: ["Justice", "Jeter", "Exactly tied"],
        technique: "application_interpret",
        bloomLevel: 4,
      },
    ],
    source: "Jeter vs. Justice 1995-96 season batting lines (Baseball-Reference); the classic textbook case of Simpson's Paradox",
    provenance: "generated",
  },
  {
    fromKey: "arrays_concept",
    toKey: "divisor pairs & the locker problem",
    toLabel: "Divisor pairs & the locker problem",
    toDomain: "math",
    kind: "instantiates",
    hook: "Almost every array of dots has a secret twin — except one shape, which is its own twin.",
    teaser:
      "Turn a 3×4 array of dots on its side and you get its twin, 4×3. Almost every number's arrays pair up like that, but a rare few hide one lonely shape with no twin at all — and there is a beautiful reason why.",
    narrative:
      "A 3×4 array (3 rows of 4) and a 4×3 array (4 rows of 3) hold the same total, just rotated — a twin pair. Twelve has three such pairs: 1×12/12×1, 2×6/6×2, 3×4/4×3 — six shapes total. But a square array, like 4×4, is its OWN rotation: it has no twin. That's why only perfect-square numbers have an odd count of array-shapes — every other number's shapes pair up and cancel, but a square has one shape left unmatched. It's also why, in the classic '100 lockers' puzzle, only perfect-square lockers end up open.",
    questions: [
      {
        text:
          "In the locker problem, locker n is toggled once for every divisor of n, and ends OPEN only if it's toggled an odd number of times. Divisors usually come in pairs — like 2 and 8 for 16 — which makes an even count. Which lockers end up open?",
        answer: "0",
        answerType: "multipleChoice",
        choices: [
          "The perfect squares (1, 4, 9, 16, ...) — a square has one divisor that pairs with itself (4 x 4 = 16), making the count odd",
          "The even-numbered lockers, because 2 divides them",
          "The prime-numbered lockers, because primes have few divisors",
        ],
        technique: "application_interpret",
        bloomLevel: 4,
      },
    ],
    source: "Number-of-divisors theorem: a positive integer has an odd number of divisors iff it's a perfect square (elementary number theory); illustrated by the '100 lockers' puzzle.",
    provenance: "generated",
  },
  {
    fromKey: "partition_shapes",
    toKey: "fair cake-cutting",
    toLabel: "Fair cake-cutting",
    toDomain: "game-theory",
    kind: "applies",
    hook: "The fairest half is the one you are willing to lose",
    teaser:
      "Two kids, one brownie: how do you split it so nobody feels cheated? One tiny rule — I cut, you choose — forces a perfectly fair split, with no ruler and no grown-up judge.",
    narrative:
      "When two kids split one brownie, the classic rule is: I cut, you choose. The cutter is forced to make the shares feel equal, because the chooser will take the better-looking piece. The surprise: you do not need matching shapes, a ruler, or an adult judge. Partitioning is about equal value or area, and one tiny game rule makes fairness happen. Mathematicians turned that playground move into cake-cutting theory, then asked how to divide fairly among 3, 4, or 100 people.",
    questions: [
      {
        text:
          "In \"I cut, you choose,\" you cut a cake into two pieces and the OTHER person picks first, taking whichever piece they prefer. To be sure you'll be happy no matter which piece is left for you, how should you cut?",
        answer: "0",
        answerType: "multipleChoice",
        choices: [
          "Into two pieces you value equally, so either leftover is fine",
          "Make one piece clearly bigger and hope they take the small one",
          "Cut any two pieces — it doesn't matter, since they choose first",
        ],
        technique: "application_interpret",
        bloomLevel: 4,
      },
    ],
    source: "Steinhaus, 'The problem of fair division' (Econometrica, 1948); cut-and-choose protocol",
    provenance: "generated",
  },
  {
    fromKey: "partition_shapes",
    toKey: "binary (base-2) fractions",
    toLabel: "Binary (base-2) fractions",
    toDomain: "computer-science",
    kind: "instantiates",
    hook: "With only halving folds, fourths are exact every time — and thirds are impossible",
    teaser:
      "Fold a strip of paper in half, then in half again, and you land exactly on fourths every time. Now try to fold your way to exact thirds — you never can, and computers slam into the very same wall.",
    narrative:
      "Fold a strip of paper in half — exact, instant, every time. Fold again for fourths, again for eighths: repeated halving always lands exactly on the mark. Now try to reach exact thirds using ONLY halving folds — fold a thousand times and you never get there, because thirds aren't built from halves. Computers hit the identical wall: binary numbers are built entirely from halving, so they store 1/2, 1/4, and 1/8 perfectly but can never finish writing 1/3 — it becomes an endlessly repeating pattern.",
    questions: [
      {
        text:
          "Fold a paper strip in half, then in half again, then unfold: the creases land at 1/4, 1/2, and 3/4. A friend is sure that folding in half enough more times will eventually put a crease EXACTLY on the 1/3 mark. Can any number of halving-folds ever land a crease on 1/3?",
        answer: "0",
        answerType: "multipleChoice",
        choices: [
          "No — every halving-crease sits at some k/2^n (a fraction with a power-of-2 bottom), and 1/3 can't be written that way",
          "Yes — after enough folds a crease lands exactly on 1/3",
          "Yes — the 3/4 crease is already close enough to count as 1/3",
        ],
        technique: "application_spot_error",
        bloomLevel: 4,
      },
    ],
    source: "Dyadic rationals (fractions built by repeated halving) vs. non-dyadic fractions; IEEE 754 binary floating-point cannot exactly represent 1/3.",
    provenance: "generated",
  },
  {
    fromKey: "subtract_within_20",
    toKey: "the change-making problem",
    toLabel: "The change-making problem",
    toDomain: "computer-science",
    kind: "applies",
    hook: "The 'grab the biggest jump' trick you use to subtract can actually fail.",
    teaser:
      "To subtract, you grab the biggest jump first, and cashiers make change the same greedy way. It works for real coins, but invent a few strange coins and that trusty trick suddenly gives the wrong answer.",
    narrative:
      "To subtract 15-8 by counting up, you grab the biggest jump first: 8→10 (+2), then 10→15 (+5), giving 7. Cashiers make change the same greedy way, and for U.S. coins, always grabbing the biggest coin first happens to use the fewest coins possible. But invent coins worth 1¢, 3¢, and 4¢: to make 6¢, grabbing the biggest coin first gives 4+1+1 (three coins), when 3+3 (two coins) is better. The exact strategy that always works for you can silently fail — computer scientists have to prove which coin systems are safe.",
    questions: [
      {
        text:
          "A machine has only coins worth 1, 3, and 4. To make 6 it always grabs the biggest coin that fits: 4, then 1, then 1 — three coins. A teammate says this must use the fewest coins, since each step took the biggest jump. Are three coins really the fewest for 6?",
        answer: "0",
        answerType: "multipleChoice",
        choices: [
          "No — 3 + 3 makes 6 with just two coins; grabbing the biggest first isn't always best",
          "Yes — biggest-first always uses the fewest coins",
          "No — the fewest is 1 + 1 + 1 + 1 + 1 + 1",
        ],
        technique: "application_spot_error",
        bloomLevel: 4,
      },
    ],
    source: "The change-making problem in computer science; {1,3,4} is a classic coin system where the greedy algorithm fails to find the minimum number of coins.",
    provenance: "generated",
  },
  {
    fromKey: "two_step_expressions",
    toKey: "reverse polish notation",
    toLabel: "Reverse Polish Notation",
    toDomain: "computer-science",
    kind: "history",
    hook: "There's a real calculator notation with zero rules to memorize for order of operations.",
    teaser:
      "Order of operations makes you memorize which step comes first. Some real calculators throw that rule out entirely — you just type the steps in the order they truly happen, the same way you would in your head.",
    narrative:
      "To evaluate 3×4+2, you follow a memorized rule: multiply before you add. But classic calculators like the HP-12C skip the rule entirely — you type '3 [enter] 4 [×] 2 [+]' and it computes as you go, because you enter the steps in the exact order they truly happen. It's called Reverse Polish Notation, built from a system by logician Jan Łukasiewicz, and it's exactly how a two-step expression like 'triple a number, then add 5' already unfolds in your head: one step, then the next, no precedence rule required.",
    questions: [
      {
        text:
          "Write '3×4+2' as two actions in the order they truly happen (step 1, step 2). Now do the same for '5+2×3' — does the written order match the order the actions happen in?",
      },
      {
        text:
          "On a Reverse Polish (RPN) calculator you enter operations in the order they happen — no order-of-operations rule. You press: 5 [enter] 2 [+] 3 [×]. A friend expects the answer 11, the same as 5 + 2 × 3 with the usual \"multiply first\" rule. What does the RPN calculator actually display?",
        answer: "21",
        answerType: "integer",
        technique: "application_direct",
        bloomLevel: 4,
      },
      {
        text:
          "With the usual rules, 5 + 2 × 3 equals 11, because you multiply before you add. Written correctly for a Reverse Polish (RPN) calculator, where each operation runs as it is entered, this is: 5 [enter] 2 [enter] 3 [×] [+]. Does that key sequence also give 11?",
        answer: "0",
        answerType: "multipleChoice",
        choices: ["Yes", "No"],
        technique: "application_interpret",
        bloomLevel: 4,
      },
    ],
    source: "Reverse Polish Notation, based on Jan Łukasiewicz's Polish notation (1920s); used in HP calculators such as the HP-35 (1972) and HP-12C (1981).",
    provenance: "generated",
  },
  {
    fromKey: "divide_fractions",
    toKey: "reciprocals",
    toLabel: "Reciprocals",
    toDomain: "math",
    kind: "instantiates",
    hook: "Dividing by a tiny piece can make the answer bigger",
    teaser:
      "Divide by something smaller than 1 and the answer grows instead of shrinking. Ask how many one-third cups fit inside half a cup and that backwards-looking 'flip and multiply' rule finally makes sense.",
    narrative:
      "Try 1/2 divided by 1/3. If division asks 'how many of these fit?', then you are asking how many one-third cups fit inside half a cup. One full third fits, and half of another third fits, so the answer is 1 1/2. The rule that looked backwards — keep, change, flip — is just the reciprocal counting how many divisor-sized pieces fit. Dividing by a smaller-than-1 piece can make the count bigger.",
    questions: [
      {
        text:
          "You only have a 1/3-cup scoop and need 1/2 a cup. How many 1/3-cup scoops fit into 1/2 a cup? Give the exact fraction (1/2 ÷ 1/3).",
        answer: "3/2",
        answerType: "fraction",
        technique: "application_direct",
        bloomLevel: 3,
      },
      {
        text:
          "Dividing 1/2 by 1/3 gave an answer BIGGER than 1/2. When does dividing make a number grow instead of shrink — and why does that never happen when you divide by a whole number?",
      },
    ],
    source: "The measurement (quotitive) model of division; division as 'how many fit' and the reciprocal rule",
    provenance: "generated",
  },
  {
    fromKey: "division_with_remainders",
    toKey: "the chinese remainder theorem",
    toLabel: "The Chinese Remainder Theorem",
    toDomain: "math",
    kind: "history",
    hook: "The 'leftover' part of division can be enough to rebuild the entire number you started with.",
    teaser:
      "Pick a secret number, divide it by 3, by 5, and by 7, and keep only the three leftovers — toss the number itself. Those scraps are enough to rebuild your exact number, and the trick is over 1,500 years old.",
    narrative:
      "Pick any whole number from 1 to 104 and divide it by 3, by 5, and by 7 — keep only the three remainders, and throw the number itself away. It feels like you've lost information, since school treats a remainder as the disposable leftover bit. But those three remainders are enough to reconstruct your exact original number, guaranteed, as long as it's under 3×5×7=105. This is the Chinese Remainder Theorem, first recorded in a 3rd–5th century Chinese text, and it still speeds up modern cryptographic computation today.",
    questions: [
      {
        text:
          "An old puzzle: a secret number between 1 and 104 leaves remainder 1 when divided by 3, remainder 2 when divided by 5, and remainder 3 when divided by 7. Which of these could be the secret number?",
        answer: "1",
        answerType: "multipleChoice",
        choices: ["37", "52", "67"],
        technique: "application_interpret",
        bloomLevel: 4,
      },
    ],
    source: "The Chinese Remainder Theorem, first recorded in the Sunzi Suanjing (3rd–5th century CE); used today in CRT-based RSA decryption speedups.",
    provenance: "generated",
  },
  {
    fromKey: "probability_as_fraction",
    toKey: "the house edge",
    toLabel: "The house edge",
    toDomain: "games",
    kind: "applies",
    hook: "The billboard shows the prize so you won't look at the fraction under it",
    teaser:
      "A Powerball billboard screams the jackpot in glowing numbers — but the real number is the one it hides: a single ticket's chance is 1 in 292,201,338. Buying a hundred tickets barely moves it.",
    narrative:
      "A jackpot probability is just a fraction: 1 favorable ticket over every possible ticket. Powerball has 292,201,338 possible tickets, so one ticket is 1/292,201,338. The huge prize is a magician's flourish that keeps your eyes off that denominator. Try to fight it by buying 100 tickets and the fraction becomes 100/292,201,338 — still only about 1 in 3 million. The prize grows on the billboard; the fraction under it barely blinks. That gap between what you pay and what the fraction is worth is the house's edge.",
    source:
      "Powerball official jackpot odds, 1 in 292,201,338 (5 of 69 white balls × 1 of 26 red; matrix since Oct 2015), powerball.com",
    provenance: "generated",
    questions: [
      {
        text:
          "A single Powerball ticket wins the jackpot with probability 1 in 292,201,338. A friend buys 100 tickets to 'really boost' his odds. His chance is now closest to:",
        answer: "0",
        answerType: "multipleChoice",
        choices: ["1 in 3 million", "1 in 300,000", "1 in 30,000"],
        technique: "application_interpret",
        bloomLevel: 4,
      },
    ],
  },
  {
    fromKey: "complement_probability",
    toKey: "the house edge",
    toLabel: "The house edge",
    toDomain: "games",
    kind: "applies",
    hook: "You stare at the one number you picked; the wheel is built from the 37 you didn't",
    teaser:
      "On a spinning prize wheel you watch your one number. A roulette wheel has 38 pockets and pays 35-to-1 when your number hits — a payout that looks generous until you count the pockets you're ignoring.",
    narrative:
      "Bet one number on an American roulette wheel and your chance of winning is 1/38. The complement — 1 minus that — is 37/38, the chance you lose, and it does all the casino's work. The payout is 35-to-1, which would be a perfectly fair game on a 36-pocket wheel. But the wheel has 38 pockets: the two extra green ones, 0 and 00, are pure house. You watch the single number you chose; the machine is engineered out of the 37 you didn't.",
    source:
      "American (double-zero) roulette: 38 pockets (1–36, 0, 00); a single-number 'straight-up' bet pays 35 to 1",
    provenance: "generated",
    questions: [
      {
        text:
          "An American roulette wheel has 38 pockets and you bet on one number. Written as a fraction in lowest terms, what is the probability the ball does NOT land on your number?",
        answer: "37/38",
        answerType: "fraction",
        technique: "application_direct",
        bloomLevel: 3,
      },
      {
        text:
          "You bet $1 on one number each spin. Over an average 38 spins you'd win once (paid $35) and lose the other 37. After those 38 spins, are you:",
        answer: "2",
        answerType: "multipleChoice",
        choices: ["Ahead", "Exactly even", "Behind"],
        technique: "application_interpret",
        bloomLevel: 4,
      },
    ],
  },
  {
    fromKey: "expected_frequency",
    toKey: "the house edge",
    toLabel: "The house edge",
    toDomain: "games",
    kind: "applies",
    hook: "'Someone always wins' is true — for the crowd, and false for you, from the very same math",
    teaser:
      "When a jackpot gets giant, the news says a winner is 'basically guaranteed.' It's right — expected winners scale with tickets sold. That exact same math says YOUR one ticket is expected to win essentially never.",
    narrative:
      "Expected frequency means scaling a probability up to a count: multiply the chance per ticket by how many tickets there are. For a huge Powerball drawing, hundreds of millions of tickets sell, so the expected number of jackpot winners across everybody is a small handful — 'someone wins' really is near-guaranteed. But feed your own single ticket into the same formula and the expected count of jackpots is 1 × 1/292,201,338 ≈ 0. The crowd wins; you don't. And the sales that make a winner likely (hundreds of millions of dollars in tickets) dwarf the prize — that overflow is the house edge.",
    source:
      "Powerball odds 1 in 292,201,338 (powerball.com); expected winners = tickets sold × per-ticket probability",
    provenance: "generated",
    questions: [
      {
        text:
          "For a record drawing, suppose 584,402,676 random tickets are sold and each wins the jackpot with probability 1 in 292,201,338. On average, how many jackpot winners should you expect?",
        answer: "2",
        answerType: "integer",
        technique: "application_direct",
        bloomLevel: 3,
      },
      {
        text:
          "That drawing expects about 2 winners among all players. Applying the same expected-frequency formula to your OWN single ticket, your expected number of jackpots is:",
        answer: "2",
        answerType: "multipleChoice",
        choices: ["Also about 2", "About 1", "Essentially zero — still 1 in 292 million"],
        technique: "application_interpret",
        bloomLevel: 4,
      },
    ],
  },
  {
    fromKey: "percent_discount_price",
    toKey: "the checkout total",
    toLabel: "The checkout total",
    toDomain: "money",
    kind: "applies",
    hook: "Two 20%-off coupons don't add up to 40% off",
    teaser:
      "Stack a 20%-off coupon on top of another 20%-off coupon and it feels like 40% off. It isn't — the store quietly keeps some of that second twenty, and the missing bit is hiding in a multiplication.",
    narrative:
      "Stack two 20%-off coupons and your gut says 40% off. But the second coupon takes 20% off the ALREADY-reduced price, not the original. A discount isn't a subtraction you can add up; it's a multiplication: 20% off means × 0.80. Two of them is × 0.80 × 0.80 = × 0.64 — so 36% off, not 40%. The store keeps that missing 4%. Percent changes chain by multiplying, which is exactly why 'off, then off again' always beats you by a little.",
    source:
      "Successive percent discounts multiply: (1 − 0.20)(1 − 0.20) = 0.64, i.e. 36% off, not 40% — the standard 'stacked coupon' arithmetic of retail pricing.",
    provenance: "generated",
    questions: [
      {
        // S5 · interpret the result — application_interpret. Questioner (A2): a shopper
        // deciding whether stacking two 20%-off coupons is the same as one 40%-off deal.
        // HAND-VERIFY: 1 − (0.80 × 0.80) = 1 − 0.64 = 0.36 => 36% off (NOT 40%).
        text:
          "A store lets you stack two separate '20% off' coupons, the second applied to the already-discounted price. The total discount off the original price is:",
        answer: "1",
        answerType: "multipleChoice",
        choices: ["40% off", "36% off", "44% off"],
        technique: "application_interpret",
        bloomLevel: 4,
      },
      {
        // S1 · direct application — application_direct. Questioner (A2): the same shopper
        // at the register working out what they'll actually pay.
        // HAND-VERIFY: $50 × 0.80 × 0.80 = $50 × 0.64 = $32.00 exactly.
        text:
          "A $50 jacket, with both '20% off' coupons stacked. What is the final price, in dollars?",
        answer: "32",
        answerType: "integer",
        technique: "application_direct",
        bloomLevel: 3,
      },
    ],
  },
  {
    fromKey: "percent_sales_tax",
    toKey: "the checkout total",
    toLabel: "The checkout total",
    toDomain: "money",
    kind: "applies",
    hook: "Tax-then-discount costs exactly the same as discount-then-tax",
    teaser:
      "Does the cashier ring up your discount before the tax, or after? It feels like it should matter to the penny. It never does — and the reason is a property of multiplication you've known since third grade.",
    narrative:
      "You'd swear the order matters: apply the 20% discount first and you're taxed on less, so surely it's cheaper than taxing first and discounting after. But a discount is × 0.80 and adding 8% tax is × 1.08, and multiplication doesn't care about order: price × 0.80 × 1.08 is the same number as price × 1.08 × 0.80. The total is identical to the penny, every time. The surprise isn't that it's close — it's that the commutative property makes it exactly equal.",
    source:
      "A discount (× 0.80) and a sales tax (× 1.08) are each a multiplication; multiplication is commutative, so applying them in either order yields the identical total.",
    provenance: "generated",
    questions: [
      {
        // S5 · interpret / decide — application_interpret. Questioner (A2): a shopper who
        // suspects the cashier's ordering changed what they owe.
        // HAND-VERIFY: for any price P, P × 0.80 × 1.08 = P × 1.08 × 0.80 (commutativity).
        //   Concrete check: P = 100 -> 100 × 0.80 × 1.08 = 86.40; 100 × 1.08 × 0.80 = 86.40. Same.
        text:
          "At the register a 20% discount and an 8% sales tax are both applied to your purchase. Compared with the reverse order (tax first, then discount), the final total is:",
        answer: "0",
        answerType: "multipleChoice",
        choices: [
          "The same either way",
          "Cheaper when the discount is applied first",
          "Cheaper when the tax is applied first",
        ],
        technique: "application_interpret",
        bloomLevel: 4,
      },
    ],
  },
  {
    fromKey: "percent_of_quantity",
    toKey: "the checkout total",
    toLabel: "The checkout total",
    toDomain: "money",
    kind: "applies",
    hook: "8% of 25 is a pain — but 25% of 8 is the same thing, and it's 2",
    teaser:
      "Working out 8% of $25 in your head is annoying. So flip it: 25% of 8 is a quarter of 8, which is 2 — and it's the exact same answer. Any percent-of can be turned around like this.",
    narrative:
      "Figuring 8% of 25 in your head is fiddly. But 'a% of b' means (a × b) ÷ 100, and multiplication doesn't care about order — so a% of b always equals b% of a. Flip the awkward 8% of 25 into 25% of 8, which is just a quarter of 8: exactly 2. Same for a tip or a tax: 15% of 60 is a chore, but 60% of 15 = 9 in one step. The 'hard' percent and an 'easy' one are the same number wearing different clothes.",
    source:
      "The percent-flip identity: a% of b = b% of a, since both equal (a × b) ⁄ 100.",
    provenance: "generated",
    questions: [
      {
        // S5 · interpret / choose the equal computation — application_interpret.
        // Questioner (A2): someone computing 8% of a $25 bill in their head.
        // HAND-VERIFY: 8% of 25 = 0.08 × 25 = 2. 25% of 8 = 0.25 × 8 = 2. Equal.
        //   Distractors: 8 × 25 = 200 (dropped the /100); 80% of 25 = 20 (wrong percent).
        text:
          "You need 8% of a $25 bill in your head. Which is an EQUAL and easier computation?",
        answer: "0",
        answerType: "multipleChoice",
        choices: ["25% of 8", "8 × 25", "80% of 25"],
        technique: "application_interpret",
        bloomLevel: 4,
      },
    ],
  },
  {
    fromKey: "rate_measurement_conversion",
    toKey: "highway speed",
    toLabel: "Highway speed",
    toDomain: "driving",
    kind: "applies",
    hook: "60 miles per hour is 88 feet every single second",
    teaser:
      "A speed limit sign says 60. In the units your eyes actually use — feet and seconds — that same speed is 88 feet per second. The mile and the hour were hiding just how fast you're really moving.",
    narrative:
      "'60 miles per hour' is built from units too big to feel: a mile is 5,280 feet, an hour is 3,600 seconds. A conversion factor is just a rate equal to 1, so multiply through: 60 × 5,280 ÷ 3,600 = 88. The very same speed is 88 feet every second. The friendly number on the sign is an illusion of the units — switch to feet and seconds and the speed you live at looks a lot more serious.",
    source:
      "Unit conversion: 1 mile = 5,280 ft, 1 hour = 3,600 s, so 60 mph = 60 × 5280 ⁄ 3600 = 88 ft/s (the standard traffic-engineering figure).",
    provenance: "generated",
    questions: [
      {
        // S1 · direct application — application_direct. Questioner (A2): a driver (or driver-ed
        // student) translating the speedometer into feet per second to judge stopping distance.
        // HAND-VERIFY: 60 × 5280 = 316,800; 316,800 ÷ 3600 = 88. Exactly 88 ft/s.
        // ANSWER-UNIT CONSTRAINT: no stored answerUnit, so the unit "feet per second" is
        //   named IN THE STEM and the answer is the bare number 88.
        text:
          "Convert 60 miles per hour to feet per second, using 1 mile = 5,280 feet and 1 hour = 3,600 seconds. Give the answer in feet per second.",
        answer: "88",
        answerType: "integer",
        technique: "application_direct",
        bloomLevel: 3,
      },
      {
        // S5 · interpret the result — application_interpret. Questioner (A2): the same driver
        // sanity-checking that the two speeds are one speed.
        // HAND-VERIFY: from the conversion above, 60 mph = 88 ft/s exactly => the SAME speed.
        text:
          "So a car cruising at 60 miles per hour, compared with something moving at 88 feet per second, is going:",
        answer: "2",
        answerType: "multipleChoice",
        choices: ["Faster", "Slower", "The same speed"],
        technique: "application_interpret",
        bloomLevel: 3,
      },
    ],
  },
  {
    fromKey: "rate_constant_speed",
    toKey: "highway speed",
    toLabel: "Highway speed",
    toDomain: "driving",
    kind: "applies",
    hook: "At highway speed you clear a whole football field every three seconds",
    teaser:
      "88 feet per second sounds abstract until you lay it against something you know: a football field is 300 feet. So at 60 mph you cross an entire field, goal line to goal line, in about three seconds.",
    narrative:
      "Put 88 feet per second next to something you can picture: a football field runs 300 feet between the goal lines. At a constant 88 ft/s, the time to cover it is distance ÷ speed = 300 ÷ 88 ≈ 3.4 seconds — call it three. Say 'one-Mississippi, two-Mississippi, three-Mississippi' and at highway speed you've just erased a football field. That's why a two-second glance at your phone is 176 feet driven blind.",
    source:
      "A regulation American football field is 100 yards = 300 feet between the goal lines; 300 ÷ 88 ≈ 3.4 s at 88 ft/s.",
    provenance: "generated",
    questions: [
      {
        // S5 · interpret the result — application_interpret. Questioner (A2): a driver-ed
        // instructor making highway speed concrete for a new driver.
        // HAND-VERIFY: 300 ft ÷ 88 ft/s = 3.409… s ≈ 3 s. (Distractors 10 s, 30 s are off by 3x, 10x.)
        // Chosen as a bucketed MC (not a raw time) so no tolerance/rounding key is needed.
        text:
          "A car holds a steady 88 feet per second. A football field is 300 feet long. About how long does the car take to travel one football field?",
        answer: "0",
        answerType: "multipleChoice",
        choices: ["About 3 seconds", "About 10 seconds", "About 30 seconds"],
        technique: "application_interpret",
        bloomLevel: 3,
      },
      {
        // S1 · direct application — application_direct. Questioner (A2): the same instructor
        // showing how far a 2-second phone glance carries the car.
        // HAND-VERIFY: 88 ft/s × 2 s = 176 ft. Exact integer, unit "feet" NAMED IN STEM
        //   (answer-unit constraint again -> bare number 176).
        text:
          "At a steady 88 feet per second, how far does the car travel during a 2-second glance away from the road? Give the answer in feet.",
        answer: "176",
        answerType: "integer",
        technique: "application_direct",
        bloomLevel: 3,
      },
    ],
  },
  {
    fromKey: "rate_unit_whole_numbers",
    toKey: "highway speed",
    toLabel: "Highway speed",
    toDomain: "driving",
    kind: "applies",
    hook: "A quarter mile in fifteen seconds is exactly the 88-feet-per-second speed again",
    teaser:
      "Watch a car cover a quarter mile — 1,320 feet — in 15 seconds and work out its speed per second. You land right back on 88 feet per second, the same 60-mph highway speed, arrived at from the opposite direction.",
    narrative:
      "A unit rate answers 'how much for one?' — here, how many feet per one second. A quarter mile is 1,320 feet (a quarter of 5,280). Cover it in 15 seconds at a steady pace and the unit rate is 1,320 ÷ 15 = 88 feet per second. That's the same 88 ft/s that 60 mph converts to — so this car is doing exactly 60 mph. Two different measurements, one speed: dividing distance by time to get a per-second rate is the same idea as converting the units, viewed from the other side.",
    source:
      "A quarter mile = 5,280 ⁄ 4 = 1,320 ft; 1,320 ft ÷ 15 s = 88 ft/s, equal to 60 mph.",
    provenance: "generated",
    questions: [
      {
        // S1 · direct application (unit rate) — application_direct. Questioner (A2): someone
        // timing a car over a measured quarter mile to find its speed.
        // HAND-VERIFY: 1,320 ft ÷ 15 s = 88 ft/s. Exact integer, unit "feet per second"
        //   NAMED IN STEM (answer-unit constraint) -> bare number 88.
        text:
          "A car travels a quarter mile — 1,320 feet — in 15 seconds at a steady speed. What is its speed in feet per second?",
        answer: "88",
        answerType: "integer",
        technique: "application_direct",
        bloomLevel: 3,
      },
    ],
  },
  {
    fromKey: "sci_notation_operations",
    toKey: "orders of magnitude",
    toLabel: "Orders of magnitude",
    toDomain: "physics",
    kind: "applies",
    hook: "When you radio Mars, your voice takes minutes to arrive",
    teaser:
      "Light is instant on Earth. But Mars is so far that a message sent at light speed still takes many minutes to get there — and the delay is just one big number divided by another, both in scientific notation.",
    narrative:
      "On Earth, light crosses a room before you notice. Across the solar system it crawls. When Mars is about 2.4 × 10^11 meters away and light travels 3.0 × 10^8 meters per second, the travel time is distance ÷ speed. Divide in scientific notation — split the coefficients from the powers of ten: (2.4 ÷ 3.0) × 10^(11−8) = 0.8 × 10^3 = 800 seconds, over 13 minutes. Every 'live' conversation with a Mars rover is really a delayed letter, and scientific notation is what makes the delay computable at all.",
    source:
      "Earth–Mars distance varies ~5.5 × 10^10 to ~4 × 10^11 m; at 2.4 × 10^11 m and light speed 3.0 × 10^8 m/s, one-way light time = 800 s ≈ 13.3 min.",
    provenance: "generated",
    questions: [
      {
        // S1 · direct application — application_direct. Questioner (A2): a mission engineer
        // (or a curious kid) working out the radio delay to a Mars rover.
        // HAND-VERIFY: (2.4 × 10^11) ÷ (3.0 × 10^8)
        //   = (2.4 ÷ 3.0) × 10^(11−8) = 0.8 × 10^3 = 8.0 × 10^2 = 800 s. Exact integer.
        // Unit "seconds" NAMED IN STEM; answer is the bare, short (3-digit) number 800.
        text:
          "Mars is 2.4 × 10^11 meters from Earth and light travels 3.0 × 10^8 meters per second. How many seconds does a radio signal take to reach Mars? Give the answer in seconds.",
        answer: "800",
        answerType: "integer",
        technique: "application_direct",
        bloomLevel: 4,
      },
    ],
  },
  {
    fromKey: "sci_notation_convert",
    toKey: "orders of magnitude",
    toLabel: "Orders of magnitude",
    toDomain: "physics",
    kind: "applies",
    hook: "A ten-year-old has already lived over three hundred million seconds",
    teaser:
      "Ask a kid how old they are in seconds and the honest answer is staggering: a ten-year-old has been alive for more than 300 million seconds — and scientific notation is the only comfortable way to write it.",
    narrative:
      "One year is about 3.15 × 10^7 seconds — already 31.5 million. Live ten of them and you multiply by 10, which just bumps the power of ten by one: 10 × (3.15 × 10^7) = 3.15 × 10^8 seconds. That's 315 million seconds behind a ten-year-old, and writing it as 3.15 × 10^8 keeps the size legible instead of a smear of zeros. Comparing magnitudes is the whole point of scientific notation: the exponent, 8, is the headline — you've lived on the order of 100 million seconds.",
    source:
      "1 year ≈ 3.15 × 10^7 s (365.25 days × 86,400 s ≈ 3.156 × 10^7); 10 years ≈ 3.15 × 10^8 s.",
    provenance: "generated",
    questions: [
      {
        // S1/S5 · express and compare magnitude — application_interpret. Questioner (A2): a
        // kid working out their own age in seconds and stunned by the size.
        // HAND-VERIFY: 10 × (3.15 × 10^7) = 3.15 × 10^8 (multiplying by 10 adds 1 to the exponent).
        //   Distractors: 3.15 × 10^7 (forgot to multiply); 3.15 × 10^9 (added two zeros).
        // MULTIPLE CHOICE so the exponent format isn't a free-text false-negative trap.
        text:
          "One year is about 3.15 × 10^7 seconds. Written in scientific notation, roughly how many seconds has a 10-year-old been alive?",
        answer: "1",
        answerType: "multipleChoice",
        choices: ["3.15 × 10^7", "3.15 × 10^8", "3.15 × 10^9"],
        technique: "application_interpret",
        bloomLevel: 3,
      },
    ],
  },
  {
    fromKey: "exp_product_quotient",
    toKey: "orders of magnitude",
    toLabel: "Orders of magnitude",
    toDomain: "physics",
    kind: "applies",
    hook: "A teaspoon of a neutron star would weigh about a billion tons",
    teaser:
      "Crush the mass of the Sun into a city-sized ball and you get a neutron star. Its density is so extreme that a sugar-cube's worth outweighs a mountain — and you find the order of magnitude just by subtracting exponents.",
    narrative:
      "A neutron star packs roughly 10^30 kilograms of mass into a ball only about 10^12 cubic meters in volume — Sun-scale mass in a city-scale space. Density is mass ÷ volume, and dividing powers of ten just subtracts the exponents: 10^30 ÷ 10^12 = 10^(30−12) = 10^18. So the density is on the order of 10^18 kilograms per cubic meter — a billion billion. That's why a teaspoon of the stuff would outweigh a mountain: the quotient rule for exponents is doing all the work of grasping a number nothing on Earth prepares you for.",
    source:
      "A neutron star has mass ~1.4 solar masses (~2.8 × 10^30 kg) in a ball of radius ~10 km (volume ~4 × 10^12 m^3), giving a density on the order of 10^18 kg/m^3 — nuclear density.",
    provenance: "generated",
    questions: [
      {
        // S1 · direct application of the quotient rule — application_direct. Questioner (A2):
        // an astronomy student estimating a neutron star's order-of-magnitude density.
        // HAND-VERIFY: 10^30 kg ÷ 10^12 m^3 = 10^(30−12) = 10^18 kg/m^3. The ANSWER IS THE
        //   EXPONENT (a bare number, 18) so there's no format ambiguity and no long typed value.
        text:
          "A neutron star has a mass of about 10^30 kilograms packed into a volume of about 10^12 cubic meters. Its density is mass divided by volume. On the order of 10 to what power (in kg per cubic meter) is that density?",
        answer: "18",
        answerType: "integer",
        technique: "application_direct",
        bloomLevel: 3,
      },
    ],
  },

  // ── early-algebra (generated 2026-08-11) ──
  {
    fromKey: "expr_evaluate_exponents",
    toKey: "the equation x^y = y^x",
    toLabel: "The Equation x^y = y^x",
    toDomain: "mathematics",
    kind: "instantiates",
    hook:
      "Swapping numbers never matters for multiplication — but exponents have one secret tie",
    teaser:
      "You know 2×4 and 4×2 both make 8. But 2³ and 3² are 8 and 9 — for exponents, swapping almost never ties. Almost. There's exactly one whole-number pair where it does.",
    narrative:
      "Swap the numbers in a product and nothing changes: 2×4 = 4×2. Try exponents and it falls apart: 2³ = 8 but 3² = 9; 3⁴ = 81 but 4³ = 64. So hunt for different positive whole numbers a and b where aᵇ and bᵃ tie. Up to order, there is exactly one pair: 2⁴ = 16 and 4² = 16. One way to see why is to compare ln(n)/n: it rises until e ≈ 2.718 and then falls, so a nonmatching pair must straddle e. Among whole numbers, only 2 and 4 land at the same height.",
    probe:
      "Check 2⁵ against 5², then 3⁴ against 4³ — the swaps do not tie. Now try 2⁴ and 4². Why should 2 and 4 be the only different positive whole numbers where aᵇ = bᵃ?",
    visualEmoji: "🔀",
    source:
      "Marta Sved, 'On the Rational Solutions of x^y = y^x,' Mathematics Magazine 63(1), 1990, 30-33; the nontrivial positive-integer solutions are (2,4) and (4,2), and the log comparison uses ln(n)/n with maximum at e.",
    provenance: "generated",
  },
  {
    fromKey: "expr_translate_words",
    toKey: "the birth of symbolic algebra",
    toLabel: "The Birth of Symbolic Algebra",
    toDomain: "history",
    kind: "history",
    hook: "Al-Khwarizmi's algebra was paragraphs before algebra became symbols",
    teaser:
      "Turning 'a number and its double, plus seven' into n + 2n + 7 feels like busywork. But compact algebra symbols had to be invented: al-Khwarizmi solved equations in prose, and Viète later made letters into a system.",
    narrative:
      "The algebra you translate — 'a number and its double, plus seven' becomes n + 2n + 7 — once had to live in sentences. Al-Khwarizmi's algebra book, written around 830 CE, solves equations entirely in words with no symbols. In 1591 François Viète helped turn algebra into a compact symbolic system: letters could stand for known and unknown quantities, so a whole calculation fit on one line you could see and rearrange. Turning words into symbols was not busywork; it was an invention that changed what algebra could do.",
    probe:
      "Take x² + 3x + 2 and write it out with no algebra symbols at all — only words, the way al-Khwarizmi's algebra did. Now imagine solving it in that form. What did inventing the symbols buy you?",
    visualEmoji: "📜",
    source:
      "MacTutor, 'Al-Khwarizmi': al-Khwarizmi's Algebra is entirely in words with no symbols; MacTutor, 'François Viète': In artem analyticam isagoge (1591) introduced systematic algebraic notation with letters for known and unknown quantities.",
    provenance: "generated",
  },
  {
    fromKey: "expr_evaluate_two_variables",
    toKey: "the heat index",
    toLabel: "The Heat Index",
    toDomain: "meteorology",
    kind: "applies",
    hook:
      "No thermometer directly measures the 'feels like' number on your weather app",
    teaser:
      "Your phone shows the temperature and, under it, a different 'feels like' number. Nothing measured that second one — it's an expression with two inputs, worked out for today's values.",
    narrative:
      "Your weather app shows two numbers: air temperature, and a 'feels like' value that may be several degrees off. A thermometer measures the first one; the second is computed. The U.S. National Weather Service heat index uses two inputs — air temperature and relative humidity — in the Rothfusz regression, an equation fit to Robert Steadman's 1979 apparent-temperature tables. That is an expression with two variables: feed in today's temperature and humidity, and out comes one number. The same 90°F can feel mild in dry air and brutal in wet air because humidity changes how well sweat evaporates.",
    probe:
      "On a dry day and a muggy day the thermometer reads the same 90°F, but the 'feels like' numbers are far apart. If temperature is identical both days, which second variable is doing the work — and why can't one thermometer show it directly?",
    visualEmoji: "🌡️",
    source:
      "American Meteorological Society Glossary, 'heat index'; NWS/WPC, 'Heat Index Equation': Rothfusz regression computes apparent temperature from air temperature and relative humidity, adapting Steadman's 1979 tables.",
    provenance: "generated",
  },
  {
    fromKey: "eq_unknown_in_arithmetic",
    toKey: "kenken puzzles",
    toLabel: "KenKen Puzzles",
    toDomain: "puzzles",
    kind: "applies",
    hook: "A KenKen cage is an equation with the numbers erased",
    teaser:
      "The little '12x' clue in a KenKen cage is not asking you to compute 12. It is daring you to find the hidden numbers that make 12 true.",
    narrative:
      "In KenKen, a cage clue like '12x' gives only a target and an operation. The cells are unknowns: 3 and 4 might fit, 2 and 6 might fit, but rows and columns can kill one pair. Japanese teacher Tetsuya Miyamoto invented KenKen in 2004 to turn arithmetic into constraint-solving. A blank is not empty; it is a number waiting to make every clue true at once.",
    probe:
      "In a two-cell cage labeled '12x', list the pairs that could work. Now add the row rule: no repeated numbers. Which pairs survive?",
    source:
      "KenKen puzzle rules; invented by Japanese mathematics teacher Tetsuya Miyamoto in 2004.",
    provenance: "generated",
  },
  {
    fromKey: "eq_test_solution",
    toKey: "p vs np",
    toLabel: "P vs NP",
    toDomain: "computer-science",
    kind: "instantiates",
    hook: "Checking the answer can be easier than finding it",
    teaser:
      "A number can be painful to find but easy to check. Computer scientists turned that gap into one of the biggest unsolved questions in math.",
    narrative:
      "Try x = 4 in 3x + 2 = 14: one substitution tells you yes. Finding 4 might take algebra, but checking it is quick. Computer scientists made that gap famous as P vs NP: for some puzzles, a proposed answer is easy to verify even when finding one seems far harder. A filled Sudoku grid can be checked row by row; the open question is whether every quickly checkable problem is also quickly solvable.",
    probe:
      "Check x = 4 in 3x + 2 = 14. Now imagine finding x from scratch. Which job was faster, and why might that gap matter?",
    source:
      "Clay Mathematics Institute, P vs NP Millennium Problem; Yato and Seta (2003), generalized Sudoku is NP-complete.",
    provenance: "generated",
  },
  {
    fromKey: "eq_one_step_add_sub",
    toKey: "al-jabr",
    toLabel: "Al-jabr",
    toDomain: "history",
    kind: "etymology",
    hook: "Algebra began as restoration",
    teaser:
      "When you add 7 to both sides of x - 7 = 12, you are not just 'moving numbers'. You are doing the move that gave algebra its name.",
    narrative:
      "Solving x - 7 = 12 by adding 7 to both sides feels like undoing a school rule. The word algebra itself began with that move. Al-Khwarizmi's 9th-century book used al-jabr, often translated as restoration or completion, for restoring an equation by moving a subtracted term across. When you add 7 back, you are doing the operation that gave algebra its name.",
    probe:
      "In x - 7 = 12, what has been 'taken away'? Add it back to both sides. Why is restoration a perfect name for that move?",
    source:
      "Al-Khwarizmi, al-Kitab al-mukhtasar fi hisab al-jabr wal-muqabala (9th century); al-jabr as restoration/completion.",
    provenance: "generated",
  },
  {
    fromKey: "eq_two_step_integers",
    toKey: "temperature scales",
    toLabel: "Temperature Scales",
    toDomain: "measurement",
    kind: "applies",
    hook: "The two thermometers agree at -40",
    teaser:
      "Fahrenheit and Celsius almost never show the same number. But there is one freezing point where the two scales cross, and a signed equation finds it.",
    narrative:
      "Fahrenheit and Celsius use different zeroes and different step sizes, so their numbers usually disagree. But they cross once. If the same number is both readings, then C = 9/5 C + 32. Subtract 9/5 C from both sides to get -4/5 C = 32, so C = -40. At -40, the two thermometers finally tell the same story. A signed two-step equation found a hidden meeting point between real scales.",
    probe:
      "Set the readings equal: C = 9/5 C + 32. Can you solve the signed equation and find the one temperature where both thermometers match?",
    source:
      "Fahrenheit-Celsius conversion F = (9/5)C + 32; Anders Celsius's 1742 temperature scale.",
    provenance: "generated",
  },
  {
    fromKey: "eq_two_step_fraction_decimal",
    toKey: "method of false position",
    toLabel: "Method of False Position",
    toDomain: "history",
    kind: "history",
    hook: "The wrong guess that solves the equation",
    teaser:
      "An ancient Egyptian scribe could start with an answer he knew was false and still use it to land exactly on the truth.",
    narrative:
      "Ancient Egyptian scribes sometimes solved unknown-number problems by choosing a convenient wrong answer first. In Rhind Problem 26, a quantity plus its quarter equals 15. Guess 4: 4 + 1 = 5. The target 15 is three times bigger, so scale the guess too: 4 x 3 = 12. Check: 12 + 3 = 15. The false position was not a mistake; it was the handle.",
    probe:
      "For 'a number plus its quarter is 15,' try the false guess 4. It gives 5. How can that wrong result tell you the right number?",
    source:
      "Rhind Mathematical Papyrus Problem 26; ancient Egyptian method of false position for linear 'aha' quantity problems.",
    provenance: "generated",
  },
  {
    fromKey: "pattern_rule_sequence",
    toKey: "the collatz conjecture",
    toLabel: "The Collatz Conjecture",
    toDomain: "math",
    kind: "instantiates",
    hook: "A rule a 4th grader can run — that mathematicians still cannot prove",
    teaser:
      "Pick a positive whole number. If it's even, halve it; if it's odd, triple it and add one. Every starting number checked so far falls to 1 — but no one has proved the rule works for all of them.",
    visualEmoji: "🧊",
    narrative:
      "Take a positive whole number and follow one rule: even → halve it, odd → triple it and add 1. Start at 6: 6, 3, 10, 5, 16, 8, 4, 2, 1. It bounces up and down like a hailstone, then crashes to 1. Try 27 and it takes 111 steps, but still lands on 1. Every tested starting number up to at least 2^68 does. Yet no one has proved every positive number must. This is the Collatz conjecture (Lothar Collatz, 1937); Paul Erdős said mathematics may not be ready for such problems and rated it a $500 problem.",
    probe:
      "Even → halve, odd → triple-plus-one. Run it from 7 and you land on 1. Every tested starting number has. What would it take to prove no number can get stuck or wander forever?",
    source:
      "MathWorld, 'Collatz Problem' (Lothar Collatz, 1937; Erdős quote); OEIS A006577 (27 reaches 1 in 111 steps); Erdős Problems #1135 ($500 prize-scale clarification); David Barina Collatz news page (verified below 2^68 on May 7, 2020).",
    provenance: "generated",
  },
  {
    fromKey: "pattern_function_machine_one_step",
    toKey: "the caesar cipher",
    toLabel: "The Caesar Cipher",
    toDomain: "cryptography",
    kind: "instantiates",
    hook: "A function machine Julius Caesar used to hide secret letters",
    teaser:
      "Feed a letter in, add 3, read the new letter out: A→D, B→E. That tiny one-step machine turns your name into gibberish — and Suetonius says Caesar used it when a letter needed secrecy.",
    visualEmoji: "🗝️",
    narrative:
      "A one-step function machine takes an input, applies one rule, gives an output. Make the rule '+3' and feed it letters: A→D, B→E, C→F. HELLO becomes KHOOR. Suetonius says Caesar used this shift when he had something confidential to write: to decode it, the reader substituted the fourth letter for the first, D for A. The magic is the machine run backwards: to read the secret, put the output in and subtract 3. The same little machine that scrambles a message, reversed, unlocks it — a doorway into cryptography.",
    probe:
      "Your +3 machine turns HELLO into KHOOR. A friend gets KHOOR and needs the message back. What rule should their machine use — and how is it related to yours?",
    source:
      "Suetonius, Life of the Deified Julius §56: Caesar wrote confidential letters in cipher; decipher by substituting the fourth letter for the first, D for A. Classical Caesar cipher / shift substitution.",
    provenance: "generated",
  },
  {
    fromKey: "pattern_table_missing_value",
    toKey: "the periodic table's gaps",
    toLabel: "The periodic table's gaps",
    toDomain: "chemistry",
    kind: "applies",
    hook: "He left blanks in his table on purpose — and filled them with elements no one had found",
    teaser:
      "In 1869 a chemist arranged the known elements in a grid and hit gaps. Instead of guessing, he left them blank and used the pattern to predict the weight of an element nobody had isolated yet.",
    visualEmoji: "🧪",
    narrative:
      "Finding a missing value in a table means trusting the pattern. Dmitri Mendeleev did it with the known elements. Arranging them by atomic weight and chemical properties in 1869, he found holes — so he left them empty and read the pattern across the gaps. For one blank, eka-silicon, he predicted a gray element with atomic weight about 72. Seventeen years later Clemens Winkler isolated germanium: gray, atomic weight 72.6, almost exactly his number. A blank in a table wasn't a hole in his knowledge — it was a prediction waiting to come true.",
    probe:
      "Mendeleev met a gap in his table and used the pattern to estimate the missing element's weight before anyone isolated it. If your input–output table skips a row, what lets you say what belongs there?",
    source:
      "Royal Society of Chemistry, 'Germanium' (Mendeleev's 1869 table, eka-silicon predicted atomic weight 72 and gray color, Winkler isolated germanium in 1886 with atomic weight 72.6); Bates College, 'Mendeleev's Predictions for Eka-Silicon'.",
    provenance: "generated",
  },
  {
    fromKey: "pattern_linear_table_rule",
    toKey: "mark twain's mississippi extrapolation",
    toLabel: "Mark Twain's Mississippi extrapolation",
    toDomain: "literature",
    kind: "applies",
    hook: "Follow the pattern too far and the Mississippi becomes a mile and three-quarters long",
    teaser:
      "A table with a steady rule lets you predict values it doesn't list. Mark Twain ran that exact trick on the Mississippi River — and proved you can predict your way straight into nonsense.",
    visualEmoji: "🌊",
    narrative:
      "A linear rule — same change each step — lets you predict values a table never listed. Push it too far, though, and it lies. Mark Twain did the math in 1883: the Lower Mississippi had shortened 242 miles in 176 years, about 1⅓ miles a year. Extend that steady rate and 'any calm person' can 'see' that 742 years from now the river will be just 'a mile and three-quarters long,' and a million years ago it 'stuck out over the Gulf of Mexico like a fishing-rod.' Same arithmetic, same table — inside the little window it describes a real pattern; stretched a thousand steps, it becomes a joke.",
    probe:
      "Twain's rule (the river had been losing about 1⅓ miles a year) runs a million years backward and says the river was 1,300,000 miles long. What went wrong — the arithmetic, or trusting a local pattern that far?",
    source:
      "Mark Twain, Life on the Mississippi (1883), ch. 17: the Lower Mississippi shortened 242 miles in 176 years; Twain extrapolates to 'a mile and three-quarters' in 742 years and 'like a fishing-rod' a million years ago.",
    provenance: "generated",
  },
  {
    fromKey: "pattern_graph_rate_change",
    toKey: "hubble's law",
    toLabel: "Hubble's Law",
    toDomain: "cosmology",
    kind: "applies",
    hook: "The slope of one straight line is the expansion rate of the universe",
    teaser:
      "Read the rate of change off a line and you get its slope. In 1929 Edwin Hubble used a graph of galaxy speeds and distances to estimate a slope — the number we now call the expansion rate of the universe.",
    visualEmoji: "🎈",
    narrative:
      "The rate of change of a linear graph is its slope: rise over run. In 1929 Edwin Hubble plotted galaxies' recession speeds against their distances. The pattern was roughly linear, and the slope became the Hubble constant: the expansion rate of the universe. The wonder hides in the units. Flip that slope upside down and you get a time, the Hubble time. With modern values it is about 13-14 billion years — not an exact birthday, but a rough cosmic clock surprisingly close to the universe's measured age.",
    probe:
      "Hubble's line says farther galaxies recede faster. A slope is speed ÷ distance; flip it and the units become distance ÷ speed. What kind of quantity is that, and why might it point toward the age of the universe?",
    source:
      "Edwin Hubble's 1929 velocity-distance relation; Britannica, 'Hubble's law' and 'Hubble constant' (v = H0d, H0 expansion rate, reciprocal 13-14 billion years approximate cosmic timescale); NASA, 'The Hubble Constant and Hubble Tension' (modern age about 13.8 billion years).",
    provenance: "generated",
  },
  {
    fromKey: "ineq_symbol_meaning",
    toKey: "habitable zone",
    toLabel: "Habitable Zone",
    toDomain: "astronomy",
    kind: "instantiates",
    hook: "The < sign can draw a planet's just-right zone",
    teaser:
      "A habitable zone is not one magic orbit. It is a band of possible distances: too close is too hot, too far is too cold, and the inequality marks the maybe-life region between.",
    narrative:
      "NASA defines a star's habitable zone as the range of distances where liquid water could exist on a planet's surface. That is an inequality, not a single answer: inner edge < planet distance < outer edge. The symbol is doing more than saying which number is bigger; it draws the allowed zone. A comparison sign can become a filter for possible simulator.",
    probe:
      "Draw a star, then mark an inner edge and an outer edge. If a planet's distance is x, what does inner < x < outer mean the planet must do?",
    visualEmoji: "🪐",
    source:
      "NASA Science, 'The Habitable Zone': the distance from a star at which liquid water could exist on orbiting planets' surfaces.",
    provenance: "generated",
  },
  {
    fromKey: "ineq_test_solution",
    toKey: "constraint satisfaction problems",
    toLabel: "Constraint Satisfaction Problems",
    toDomain: "computer-science",
    kind: "instantiates",
    hook: "A wrong Sudoku guess is still useful",
    teaser:
      "When a Sudoku pencil mark breaks a row rule, the puzzle did not waste your time. The failed candidate made the possible world smaller.",
    narrative:
      "In Sudoku, a penciled 7 is a candidate you try to kill. If the row, column, or box already has a 7, that candidate fails. Computer scientists call this a constraint satisfaction problem: variables have possible values, and constraints erase the impossible ones. Testing x = 4 in x < 6 is the same tiny move. A 'no' answer is not failure; it shrinks the search.",
    probe:
      "Test 4, 6, and 9 in x < 6. Which candidates survive? How is that like crossing out impossible Sudoku pencil marks?",
    visualEmoji: "🧩",
    source:
      "A.K. Mackworth, 'Consistency in Networks of Relations,' Artificial Intelligence 8 (1977), pp. 99-118; Helmut Simonis, 'Sudoku as a Constraint Problem' (2005).",
    provenance: "generated",
  },
  {
    fromKey: "ineq_negative_coefficient",
    toKey: "screen coordinate systems",
    toLabel: "Screen Coordinate Systems",
    toDomain: "computer-graphics",
    kind: "applies",
    hook: "On a screen, jumping higher can make y smaller",
    teaser:
      "Graph paper says bigger y means higher. Your screen often says the opposite, and that backwards axis is the same reason a negative coefficient flips an inequality.",
    narrative:
      "On graph paper, larger y means higher. On an HTML canvas, the origin is the top-left corner and y increases downward. So a game character jumping up can have a smaller y-number. The measuring rule runs backward. A negative coefficient does the same thing to a number line: it reverses order, so a constraint pointing one way must flip when you solve it.",
    probe:
      "Draw a 10-high screen with y = 0 at the top. Which point is higher, y = 2 or y = 8? What happened to the direction of the comparison?",
    visualEmoji: "🎮",
    source:
      "MDN Web Docs, Canvas tutorial: the canvas origin is at the top-left and the y-axis increases downward.",
    provenance: "generated",
  },
  {
    fromKey: "ineq_context_two_step",
    toKey: "clinical fever thresholds",
    toLabel: "Clinical Fever Thresholds",
    toDomain: "medicine",
    kind: "applies",
    hook: "A fever line is a two-step inequality in disguise",
    teaser:
      "A thermometer can say 100.4 degrees F or 38 degrees C and mean the same boundary. The health rule did not change; the scale did.",
    narrative:
      "The CDC uses 100.4 degrees F (38 degrees C) as a measured fever threshold. The two numbers match because F = (9/5)C + 32. To translate the rule F >= 100.4, solve (9/5)C + 32 >= 100.4: subtract 32, then multiply by 5/9, giving C >= 38. A two-step inequality turns one real health boundary into another thermometer's language.",
    probe:
      "Start with (9/5)C + 32 >= 100.4. Can you undo the +32 and the ×9/5 to find the Celsius fever threshold?",
    visualEmoji: "🌡️",
    source:
      "CDC Port Health definitions: fever is a measured temperature of 100.4°F (38°C) or greater; NOAA/National Weather Service temperature conversion F = (9/5)C + 32.",
    provenance: "generated",
  },

  // ── geometry-measurement (generated 2026-08-11) ──
  {
    fromKey: "length_iterate_units",
    toKey: "horse height in hands",
    toLabel: "Horse height in hands",
    toDomain: "animals",
    kind: "applies",
    hook: "A horse is measured in hands - but not your hand",
    teaser:
      "If you measure a toy horse with your hand and I use mine, the number changes. Real horse people solved that by turning a hand into a fixed four-inch unit.",
    narrative:
      "A horse's height is still given in hands, but a hand is no longer a random person's palm: it is exactly 4 inches, and the height is measured from the ground to the withers. That is the same rule as your cube train: every unit must be the same size, touching end to end. Body parts became math only after people stopped using actual bodies.",
    probe:
      "Measure a book with your palm, then with a friend's. Why are the counts different? What would happen if both palms had to be exactly 4 inches?",
    visualEmoji: "🐴",
    source:
      "Britannica, 'hand' (unit standardized at 4 inches, used for horse height); American Museum of Natural History, 'Measuring Horses'.",
    provenance: "generated",
  },
  {
    fromKey: "tell_time_to_minute",
    toKey: "clock angles",
    toLabel: "Clock angles",
    toDomain: "geometry",
    kind: "instantiates",
    hook: "Every minute is a 6-degree turn",
    teaser:
      "Those tiny tick marks are not decoration. Each one is the long hand turning exactly one sixtieth of a circle.",
    narrative:
      "A clock is a circle, and a circle is 360 degrees. The minute hand makes one full circle in 60 minutes, so each tiny tick is 360 ÷ 60 = 6 degrees. When you read 7:23, you are not just naming a time; you are reading 23 little turns, or 138 degrees, around a circle.",
    probe:
      "If the minute hand moves 6 degrees each minute, how far has it turned after 10 minutes?",
    visualEmoji: "🕰️",
    source:
      "Clock-angle mathematics: a 360-degree circle divided into 60 minute marks gives 6 degrees per minute.",
    provenance: "generated",
  },
  {
    fromKey: "elapsed_time_minutes",
    toKey: "modular arithmetic",
    toLabel: "Modular arithmetic",
    toDomain: "math",
    kind: "instantiates",
    hook: "On a clock, 55 + 10 becomes 5",
    teaser:
      "The answer after 10 minutes from 7:55 is not 7:65. The clock bends your number line into a circle.",
    narrative:
      "Elapsed-time math crosses the hour because minutes wrap after 60. From 7:55, five minutes gets you to 8:00, and five more gets you to 8:05. On an ordinary number line, 55 + 10 = 65; on a clock, 65 minutes means 1 hour and 5 minutes. The reset at 60 is not a mistake - it is modular arithmetic you can watch.",
    probe:
      "Start at 3:50 and add 25 minutes. What happens when your count passes 60?",
    visualEmoji: "🔄",
    source:
      "Modular arithmetic modulo 60; NIST time convention that one hour has 60 minutes.",
    provenance: "generated",
  },
  {
    fromKey: "coin_values",
    toKey: "coin names as fractions",
    toLabel: "Coin names as fractions",
    toDomain: "money",
    kind: "etymology",
    hook: "The tiny dime is worth two nickels",
    teaser:
      "A dime is smaller than a nickel but worth twice as much. Coin value is a code, not a size contest.",
    narrative:
      "Coin values look like memorizing: penny 1, nickel 5, dime 10, quarter 25. But the names hide clues. A quarter is one fourth of a dollar, so four make $1. A dime comes from a word for tenth, so ten make $1. The tiny dime being worth two nickels is the giveaway: money is a value code, not a measurement of metal.",
    probe:
      "If 'quarter' means fourth, how many quarters make one dollar? If a dime is a tenth, how many dimes?",
    visualEmoji: "🪙",
    source:
      "U.S. Mint, 'Coin Specifications' and 'Circulating Coins'; Merriam-Webster, 'dime' from Latin decima, tenth.",
    provenance: "generated",
  },
  {
    fromKey: "measure_with_ruler",
    toKey: "fencepost counting",
    toLabel: "Fencepost counting",
    toDomain: "math",
    kind: "instantiates",
    hook: "A ruler counts the gaps, not the marks",
    teaser:
      "Line up 6 blocks and count them: 6. Now count the cracks between them: only 5. That missing one is the whole reason a ruler starts at 0 instead of 1.",
    narrative:
      "Put 6 blocks in a row: 6 blocks, but only 5 gaps between them. Length is the gaps, not the marks -- so if you line an object up at the '1' and read the far end, you count one mark too many. That's why the ruler's first mark is 0: you're counting spaces. Builders hit this as the 'fencepost problem' -- a 100-foot fence with a post every 10 feet needs 11 posts, not 10 -- and the same no-zero trap is why the 21st century began in 2001, not 2000.",
    probe:
      "A straight fence is 100 feet long with a post every 10 feet. How many posts? Count carefully -- it isn't 10.",
    visualEmoji: "🚧",
    source:
      "Fencepost/off-by-one error; U.S. Naval Observatory, 'The 21st Century and the 3rd Millennium' (no year zero; 21st century began Jan. 1, 2001).",
    provenance: "generated",
  },
  {
    fromKey: "measure_from_nonzero",
    toKey: "burning an inch",
    toLabel: "Burning an inch",
    toDomain: "engineering",
    kind: "applies",
    hook: "Carpenters start at the 1, not the end — on purpose",
    teaser:
      "The very tip of a tape measure is its least trustworthy part, so pros ignore it: they start measuring from the 1-inch mark and subtract. Starting in the 'wrong' place is how they get it exactly right.",
    narrative:
      "The hook on a tape measure gets bent and loose, so the end is the least reliable spot. Carpenters 'burn an inch': line the object up at the 1-inch mark instead of the tip, read the far end, then subtract 1. Start at 5, end at 17 → the length is 12. It's the same subtraction you use when something doesn't begin at zero — and tradespeople do it deliberately, because a clean middle mark beats a worn-out end.",
    probe:
      "You line a board up at the 3-inch mark and its other end hits 20. Not starting at zero — so how long is the board?",
    visualEmoji: "📐",
    source:
      "Carpentry 'burn an inch' technique (Dunn DIY, 'How to Use a Tape Measure'; standard trade practice).",
    provenance: "generated",
  },
  {
    fromKey: "compare_lengths_difference",
    toKey: "human body proportions",
    toLabel: "Human body proportions",
    toDomain: "art",
    kind: "instantiates",
    hook: "Your reach can almost match your height",
    teaser:
      "Measure how tall you are, then measure your reach from fingertip to fingertip with arms spread wide. Compare the two lengths -- the difference is often tiny, and that near-match surprised an ancient Roman enough to write it down.",
    narrative:
      "Compare two lengths of your own body: your height, and your arm span from fingertip to fingertip, arms stretched out. They often come out very close, though not exactly for every body. Vitruvius described the ideal 2,000 years ago, and Leonardo da Vinci drew it as the famous Vitruvian Man, the figure fitting a square. Finding 'how much longer' isn't just subtraction -- sometimes it uncovers a hidden near-equality.",
    probe:
      "Measure your height. Now measure your arm span, fingertip to fingertip. Which is longer -- and by how much? Guess before you check.",
    visualEmoji: "🧍",
    source:
      "Vitruvius, De architectura, Book III; Leonardo da Vinci, Vitruvian Man (c. 1490); pediatric arm-span/height studies show a close but not exact relationship.",
    provenance: "generated",
  },
  {
    fromKey: "measure_half_quarter_inch",
    toKey: "the barleycorn",
    toLabel: "The barleycorn",
    toDomain: "history",
    kind: "history",
    hook: "Your shoe size is measured in grains of barley",
    teaser:
      "Your ruler splits the inch into halves and quarters -- but your shoes split it into thirds. Every whole shoe size is exactly one-third of an inch bigger than the last, and that third has a name older than your ruler.",
    narrative:
      "On your ruler an inch breaks into halves, quarters, eighths. But there's another split hiding on your feet: about 700 years ago, a 1324 English statute defined an inch as three barleycorns laid end to end. Shoemakers still use that old step -- each whole shoe size is one barleycorn, 1/3 inch, longer than the one before, and a half-size is 1/6 inch. When you measure to the nearest quarter-inch you're reading fractions of an inch; your shoes just use thirds instead.",
    probe:
      "A size 8 and a size 9 shoe -- how much longer is the 9? The answer is a fraction of an inch with an ancient name.",
    visualEmoji: "👟",
    source:
      "English statute attributed to Edward II (1324): three barleycorns make an inch; barleycorn = 1/3 inch; UK/US shoe sizing uses one barleycorn per full size.",
    provenance: "generated",
  },
  {
    fromKey: "tell_time_hour_half_hour",
    toKey: "sundials",
    toLabel: "Sundials",
    toDomain: "history",
    kind: "history",
    hook: "Clock hands copied sundial shadows",
    teaser:
      "Clock hands did not have to turn 'clockwise' -- early clockmakers chose it. At the northern latitudes where European mechanical clocks grew up, the thing they copied was a shadow.",
    narrative:
      "Why do clock hands go that way? In northern-latitude Europe, a horizontal sundial's shadow sweeps the direction we now call 'clockwise' as the sun crosses the southern sky. Early mechanical clockmakers copied that familiar sundial motion. In the Southern Hemisphere the shadow direction reverses, so a clockmaking tradition born there might have named the opposite turn 'clockwise.'",
    probe:
      "Use a stick as a sundial and mark its shadow twice. If you're at northern latitudes, does it swing the same way as clock hands?",
    visualEmoji: "☀️",
    source:
      "History Facts, 'Why Do Clocks Move Clockwise?'; northern-hemisphere sundial shadow direction and mechanical-clock convention.",
    provenance: "generated",
  },
  {
    fromKey: "elapsed_time_minutes",
    toKey: "daylight saving time",
    toLabel: "Daylight saving time",
    toDomain: "history",
    kind: "applies",
    hook: "Where clocks spring forward, 2:30 a.m. doesn't happen",
    teaser:
      "Adding minutes across the hour is easy -- until a daylight saving night in places that use it, when the clock jumps from 2:00 straight to 3:00. There, an hour on the clock simply vanishes.",
    narrative:
      "Normally, 40 minutes after 2:30 is 3:10 -- you carry across the hour. But in places that observe daylight saving time, the 'spring forward' change skips local clocks from 2:00 a.m. straight to 3:00 a.m., so the 2 o'clock hour never exists. On that night, 'how long from 1:45 to 3:15?' is not 90 real minutes -- it's 30. Clock time and real time do not always match.",
    probe:
      "In a place where clocks jump 2:00 → 3:00, how much real time passes between 1:45 and 3:15? It looks like 90 minutes. It isn't.",
    visualEmoji: "⏰",
    source:
      "NIST Daylight Saving Time Rules (observing U.S. jurisdictions: second Sunday in March, 2:00 a.m. skips to 3:00 a.m.; Hawaii/most Arizona/territories do not observe).",
    provenance: "generated",
  },
  {
    fromKey: "count_mixed_coins",
    toKey: "commodity money",
    toLabel: "Commodity money",
    toDomain: "economics",
    kind: "history",
    hook: "The tiniest coin in the jar is worth double the bigger one beside it",
    teaser:
      "When you count a pile of coins, you can't go by size: the dime is smaller than the nickel yet worth twice as much. That backwards fact is a fossil from when U.S. dimes were made of real silver.",
    narrative:
      "Sorting coins to count them, you hit something odd: the dime is the smallest coin in the jar, yet it is worth double the bigger nickel. Size can't tell you value -- and there's a reason. U.S. dimes were once mostly silver, so a ten-cent coin could stay small while still carrying valuable metal. Nickels were larger base-metal coins. Run a finger around a dime's edge and you'll feel tiny ridges: on precious-metal coins, reeded edges made shaving silver from the rim easy to spot.",
    probe:
      "Feel the edge of a dime and a quarter (ridged), then a penny and a nickel (smooth). Why would only some coins get ridges -- and what does that hint they were once made of?",
    source:
      "U.S. Mint, Coin Specifications (dime 17.91 mm, 10c, reeded; nickel 21.21 mm, 5c, plain); U.S. dime history / Coinage Act of 1965 references (90% silver dimes through 1964); U.S. Mint reeded-edge explanation (anti-clipping on precious-metal coins).",
    visualEmoji: "🪙",
    provenance: "generated",
  },
  {
    fromKey: "liquid_volume_measure",
    toKey: "capillary action",
    toLabel: "Capillary action",
    toDomain: "physics",
    kind: "instantiates",
    hook: "The water in the measuring cup isn't actually flat",
    teaser:
      "Pour water into a skinny measuring cup and look at it sideways: the surface isn't flat -- it curves up at the edges. That curve is a clue to the stickiness that helps plants pull water upward.",
    narrative:
      "To measure liquid you read the line where it meets the marks -- but look closely at water in a narrow glass and the surface is not flat. It dips in the middle and climbs the sides, making a concave meniscus (you read the bottom). Water climbs because adhesion to glass beats cohesion between water molecules. In a thin tube that same adhesion, plus cohesion and surface tension, can pull water upward against gravity. In plants, those forces help keep water moving through xylem while transpiration from leaves does the long-distance pull.",
    probe:
      "Put water in a clear, narrow glass and look at the surface from the side at eye level. Which way does it curve -- up at the edges or down in the middle? Now guess: what makes the water climb the glass at all?",
    source:
      "Khan Academy, Capillary action and why we see a meniscus (water-in-glass adhesion exceeds cohesion); standard cohesion-tension/transpiration-pull explanation of xylem water transport.",
    visualEmoji: "💧",
    provenance: "generated",
  },
  {
    fromKey: "partition_rectangles_rows_cols",
    toKey: "the pixel grid",
    toLabel: "The pixel grid",
    toDomain: "computer-science",
    kind: "instantiates",
    hook: "The picture on the screen is really a wall of tiny squares in rows and columns",
    teaser:
      "The smooth photo on a phone is secretly a rectangle split into rows and columns of tiny squares -- millions of them. Drip one drop of water on the screen and you can see them yourself.",
    narrative:
      "Split a rectangle into equal rows and columns of little squares and you've built the idea behind a modern screen. A digital picture is sampled into a grid of pixels; many screens render each pixel with tiny red, green, and blue subpixels. A phone might have about 1,000 across and 2,000 down, roughly two million picture elements. You can't normally see them, but a tiny water drop can act like a convex lens, magnifying the colored subpixel pattern so the smooth image breaks into rows and columns.",
    probe:
      "Put one small drop of water on a phone screen (ask first!) and look very closely. What shapes are hiding inside the picture -- and how are they arranged?",
    source:
      "Raster/digital displays as pixel grids with RGB subpixels (Geometrian, Subpixel Zoo); a small water droplet can act as a convex lens that magnifies screen subpixels.",
    visualEmoji: "🔬",
    provenance: "generated",
  },
  {
    fromKey: "area_unit_squares",
    toKey: "pick's theorem",
    toLabel: "Pick's theorem",
    toDomain: "math",
    kind: "instantiates",
    hook: "You can find a shape's exact area by counting dots instead of squares",
    teaser:
      "Measuring area means counting the unit squares that fit inside. But if you draw a shape on dot paper, there's a stranger way: just count the dots, and a tiny formula hands you the exact area.",
    narrative:
      "You find area by counting the unit squares inside a shape. Now draw a polygon on dot paper so every corner sits on a dot, and try something that shouldn't work: count the dots strictly inside it (call it I), count the dots on its edges (B), and compute I + B/2 − 1. That number is the exact area — no square-counting needed. A rectangle 2 across and 3 up has 2 inside dots and 10 edge dots: 2 + 5 − 1 = 6, and sure enough it holds 6 squares. Georg Pick found this in 1899, and it works for any straight-sided shape, however jagged.",
    probe:
      "Draw any straight-sided shape on dot paper with each corner on a dot. Count the dots strictly inside, and the dots on the edge. Could just those two counts really pin down the area exactly — with no ruler?",
    source:
      "Pick's theorem (Georg Pick, 1899): for a simple lattice polygon, Area = I + B/2 − 1, where I = interior lattice points and B = boundary lattice points.",
    visualEmoji: "📐",
    provenance: "generated",
  },
  {
    fromKey: "perimeter_polygons",
    toKey: "the isoperimetric problem",
    toLabel: "The isoperimetric problem",
    toDomain: "math",
    kind: "instantiates",
    hook: "Two fences the same length can hold wildly different amounts of land",
    teaser:
      "Add up the sides and you get the perimeter -- the length of fence around a shape. But the same length of fence can pen a tiny yard or a huge one, and there's one shape that always wins.",
    narrative:
      "Perimeter is just the sum of the sides -- the fence around a shape. It's tempting to think more fence means more room, but perimeter doesn't decide area. Take a loop of string the same length every time: stretch it into a long thin rectangle and it holds almost nothing; square it up and it holds much more; bend it into a circle and it holds the most land possible for that much fence. This is the isoperimetric problem, and nature 'solves' it too: a soap bubble pulls into a sphere because that shape wraps the most air in the least skin.",
    probe:
      "Make a loop of string and lay it out as a long skinny rectangle, then as a fat square, using the exact same string. Which one pens more floor space -- and what shape would beat them both?",
    source:
      "Wolfram MathWorld, Isoperimetric Problem: the circle maximizes area for fixed perimeter; Hutchings, UC Berkeley, Soap bubbles and isoperimetric problems: surface tension minimizes area for enclosed volume, with the sphere as the Euclidean single-bubble minimizer.",
    visualEmoji: "🫧",
    provenance: "generated",
  },
  {
    fromKey: "area_rectangle",
    toKey: "the square-cube law",
    toLabel: "The square-cube law",
    toDomain: "physics",
    kind: "instantiates",
    hook: "Make a rectangle twice as big and you get four times as much, not two",
    teaser:
      "Area is length times width -- but that means doubling both side lengths doesn't double a shape. A screen with double the width and height holds four times the picture, and Galileo used the same scaling idea to explain why giants could not simply be scaled-up people.",
    narrative:
      "Area is length x width, so it depends on two directions at once. Double both sides of a 2-by-2 square to make 4-by-4: you don't get 8 squares, you get 16 -- four times as many. That is why a screen with double the width and height has four times the picture area. Galileo's Two New Sciences made the bigger leap in 1638: strength follows cross-section (area), while weight follows volume. A giant with the same proportions as a person would need disproportionately thicker bones.",
    probe:
      "Draw a 2-by-2 square and count the little squares inside. Now double each side to 4-by-4 and count again. You only doubled the sides -- how many times bigger did the area get?",
    source:
      "Galileo, Two New Sciences (1638), square-cube/scaling argument; University of Virginia, Scaling: Why Giants Don't Exist.",
    visualEmoji: "🍕",
    provenance: "generated",
  },
  {
    fromKey: "area_distributive",
    toKey: "the multiply-by-11 trick",
    toLabel: "The multiply-by-11 trick",
    toDomain: "math",
    kind: "instantiates",
    hook: "The 'put the sum in the middle' x11 trick is really a rectangle split in two",
    teaser:
      "There's a magic trick for multiplying by 11: to do 24 x 11, add 2 and 4 and drop the 6 in the middle -- 264. It looks like sorcery, but it's just a rectangle cut into two friendlier pieces.",
    narrative:
      "Splitting a rectangle shows that a x (b + c) = a x b + a x c -- chop one side into friendly parts and add the pieces. That's the secret behind the 11 trick. To do 24 x 11, split 11 into 10 + 1: a 24-by-11 rectangle becomes 24 x 10 = 240 plus 24 x 1 = 24, and 240 + 24 = 264. Watch the digits: 2, then 2 + 4, then 4 -- the middle digit is just the two outer digits added. Many mental-math shortcuts use this same move: cut a hard multiplication into easier pieces and add them back.",
    probe:
      "Do 24 x 11 by adding 24 x 10 and 24 x 1. Then look at the answer's digits: a 2, a middle digit, a 4. Where did that middle digit come from -- and would the trick still work for 72 x 11?",
    source:
      "Distributive property: n x 11 = n x (10 + 1); standard two-digit x11 shortcut inserts the digit sum as the middle digit only when the digit sum is under 10, with carrying otherwise.",
    visualEmoji: "🎩",
    provenance: "generated",
  },
  {
    fromKey: "area_perimeter_relationship",
    toKey: "coastline paradox",
    toLabel: "Coastline paradox",
    toDomain: "mathematics",
    kind: "instantiates",
    hook: "The same island can have many perimeters",
    teaser:
      "Measure a jagged coast with a long ruler, then with a tiny one. The island's area barely changes, but the coastline gets longer - and that paradox opened the door to fractals.",
    visualEmoji: "🌊",
    narrative:
      "Draw a wiggly island and measure its coast with big steps. Now use steps half as long: the island did not gain land, but your perimeter usually grows because the smaller ruler ducks into more wiggles. Lewis Fry Richardson studied this scale effect, and Benoit Mandelbrot made it famous as the coastline paradox. Area can feel stable while perimeter depends on how closely you look.",
    probe:
      "Draw a wiggly island. Count its edge with finger-width steps, then pencil-width steps. Did the island's area change, or did your perimeter-measuring ruler change the story?",
    source:
      "Benoit Mandelbrot, 'How Long Is the Coast of Britain?' Science (1967); Richardson effect summaries in Wolfram MathWorld and Britannica.",
    provenance: "generated",
  },
  {
    fromKey: "area_parallelogram",
    toKey: "cavalieri's principle",
    toLabel: "Cavalieri's principle",
    toDomain: "mathematics",
    kind: "instantiates",
    hook: "A slanted stack keeps the same area",
    teaser:
      "Push a neat stack of cards sideways and the side turns into a parallelogram. It looks bigger and slantier, but every slice is still the same slice.",
    visualEmoji: "📚",
    narrative:
      "Push the top of a sticky-note stack sideways. From the side, the rectangle has become a parallelogram, but every horizontal layer is the same length as before, only shifted. Cavalieri's principle says matching slices give matching area; modern math calls this a shear, and a shear preserves area. That is why base x height ignores the slanted side.",
    probe:
      "Make a neat stack of cards, then push the top sideways. Did you add any cards? If every layer still has the same length, what should happen to the area of the side shape?",
    source:
      "Bonaventura Cavalieri, Geometria indivisibilibus (1635); Cavalieri's principle; standard result that shear transformations preserve area.",
    provenance: "generated",
  },
  {
    fromKey: "area_trapezoid",
    toKey: "trapezoidal rule",
    toLabel: "Trapezoidal rule",
    toDomain: "calculus",
    kind: "applies",
    hook: "Calculus measures curves by pretending they are trapezoids",
    teaser:
      "A curve seems too bendy to measure. Then you draw skinny trapezoids under it, add their areas, and a grade-6 shape becomes a first step toward calculus.",
    visualEmoji: "📈",
    narrative:
      "Sketch a smooth hill on graph paper. Mark equal widths, connect neighboring heights with straight segments, and the space under the curve breaks into skinny trapezoids. Add those trapezoid areas and you have the trapezoidal rule, a numerical-integration method. The surprise is honest: a trapezoid is not just a formula shape; it is a way to make curves measurable.",
    probe:
      "Draw a curved hill across four equal grid spaces. Connect the measured heights with straight lines. What shapes did you create under the curve, and how could their areas estimate the whole hill's area?",
    source:
      "Trapezoidal rule in numerical integration; Wolfram MathWorld, 'Trapezoidal Rule' and 'Newton-Cotes Formulas'; Mathematics LibreTexts.",
    provenance: "generated",
  },
  {
    fromKey: "volume_conservation",
    toKey: "cavalieri's principle",
    toLabel: "Cavalieri's Principle",
    toDomain: "mathematics",
    kind: "instantiates",
    hook: "The leaning stack has the same volume",
    teaser:
      "Push a neat stack of cards sideways until it slants like a staircase. It looks bigger and stranger, but the volume did not budge.",
    narrative:
      "Stack identical cards straight up, then slide the top ones sideways into a lean. Every horizontal slice is still one card, and the stack has the same number of slices, so the volume is unchanged. Bonaventura Cavalieri made this into a 1635 principle: if two solids have equal cross-section areas at every height, they have equal volumes. A slanted shape can be the same stack in disguise.",
    probe:
      "Push a stack of index cards sideways. Did any card appear or vanish? What does that say about the stack's volume?",
    visualEmoji: "🃏",
    source:
      "Bonaventura Cavalieri, Geometria indivisibilibus (1635); Cavalieri's principle on equal cross-sections and equal volumes.",
    provenance: "generated",
  },
  {
    fromKey: "volume_rectangular_prism",
    toKey: "minecraft chunks",
    toLabel: "Minecraft Chunks",
    toDomain: "games",
    kind: "applies",
    hook: "Minecraft loads the world in 98,304-block prisms",
    teaser:
      "The landscape feels endless, but the game secretly chops it into invisible boxes. One current Overworld chunk is a volume problem with a giant answer.",
    narrative:
      "In Minecraft Java Edition, an Overworld chunk is 16 blocks wide, 16 long, and 384 high: 16 x 16 x 384 = 98,304 possible block positions. The game does not load 'a place'; it loads rectangular prisms of block-space. Length x width x height is not just a worksheet shortcut. It is how a giant digital world is chopped into boxes your computer can manage.",
    probe:
      "Compute 16 x 16 first. Now multiply by 384. How many block positions hide inside one chunk?",
    visualEmoji: "⛏️",
    source:
      "Minecraft Wiki, Chunk: Java Edition Overworld chunks are 16 blocks by 16 blocks by 384 blocks in height.",
    provenance: "generated",
  },
  {
    fromKey: "volume_fractional_edges",
    toKey: "the square-cube law",
    toLabel: "The Square-Cube Law",
    toDomain: "physics",
    kind: "instantiates",
    hook: "Half-size cubes are not half the volume",
    teaser:
      "Shrink a cube to half its length, half its width, and half its height. Your eye wants to say 'half as big,' but the cube has played a trick on you.",
    narrative:
      "Cut a cube in half in all three directions: half as long, half as wide, half as tall. You do not get 1/2 the volume; you get 1/2 x 1/2 x 1/2 = 1/8. It takes eight half-size cubes to rebuild the original. Galileo's square-cube law says scaling length by a fraction makes volume change by that fraction cubed. A tiny model is not just smaller; it is smaller in three directions at once.",
    probe:
      "Draw a cube split halfway along length, width, and height. Count the little cubes. Why did 'half-size' turn into one-eighth volume?",
    visualEmoji: "🧊",
    source:
      "Galileo Galilei, Two New Sciences (1638); square-cube law: volume scales with the cube of linear scale.",
    provenance: "generated",
  },
  {
    fromKey: "angle_concept",
    toKey: "turtle geometry",
    toLabel: "Turtle Geometry",
    toDomain: "computer-science",
    kind: "history",
    hook: "A square is four turns for a tiny turtle",
    teaser:
      "Tell a screen turtle to walk forward, turn right, and repeat. The angle stops being a corner on paper and becomes an action you can command.",
    narrative:
      "Logo turtle graphics, developed by Seymour Papert and colleagues, lets kids draw by commanding a turtle: forward, right 90, forward, right 90. In turtle geometry an angle is not a corner sitting still; it is the turn that changes the path. Repeat the same walk-and-turn four times and a square appears. Change only the turn, and the whole shape changes. Geometry becomes choreography a computer can run.",
    probe:
      "Pretend you are the turtle: walk forward, turn right a quarter-turn, and repeat four times. What shape did your turns draw?",
    visualEmoji: "🐢",
    source:
      "MIT Logo Foundation, A Logo Primer; Seymour Papert's Logo turtle graphics and forward/turn commands for turtle geometry.",
    provenance: "generated",
  },
  {
    fromKey: "angle_turns_circle",
    toKey: "eratosthenes measures the earth",
    toLabel: "Eratosthenes measures the Earth",
    toDomain: "history",
    kind: "history",
    hook: "One stick, one shadow, and the size of the whole planet",
    teaser:
      "A librarian in Alexandria worked out how big the entire Earth is — from nothing but the angle of a shadow at noon. His answer came out astonishingly close.",
    narrative:
      "About 2,200 years ago Eratosthenes learned that at noon on one midsummer day the sun shone straight down a deep well in a southern city, casting no shadow — yet in Alexandria a standing stick still cast one. That shadow's angle was about 7 degrees, which is 1/50 of a full 360-degree turn. So he reasoned: if the gap between the cities is 1/50 of the way around the Earth, the whole planet must be 50 times that distance. The cities are roughly 800 km apart, so about 50 x 800 = 40,000 km around — startlingly close to the real size of the Earth, and no ruler ever touched the ground.",
    probe:
      "The shadow's angle was 1/50 of a full turn, and the two cities sit about 800 km apart. Without ever laying a ruler across the planet, how could you turn those two facts into the distance all the way around the Earth?",
    source:
      "Eratosthenes of Cyrene (c. 240 BC), reported by Cleomedes; APS News, 'Eratosthenes Measures Earth' (2006): 7.2 degrees = 1/50 circle, Syene-Alexandria ~5,000 stadia, circumference ~250,000 stadia. Stadion length is debated; common conversions put the result roughly near Earth's ~40,000 km circumference.",
    visualEmoji: "🌍",
    provenance: "generated",
  },
  {
    fromKey: "angle_measure_protractor",
    toKey: "trisecting the angle",
    toLabel: "Trisecting the angle",
    toDomain: "math",
    kind: "history",
    hook: "The 2,000-year-old puzzle your protractor solves in seconds",
    teaser:
      "For over two thousand years, the greatest geometers tried to split any angle into three equal parts using only a compass and a straightedge — and always failed. Your cheap plastic protractor does it instantly, and there's a deep reason why.",
    narrative:
      "Cutting an angle into three equal parts sounds as easy as cutting it in half. But with only a compass and an unmarked straightedge — the classical Greek tools — it is impossible for most angles. Mathematicians chased it for over 2,000 years, until Pierre Wantzel proved in 1837 that it cannot be done: a 60-degree angle can never be split into three 20-degree angles that way. Yet a protractor trisects it in seconds — you MEASURE the 60 degrees, divide by 3, and draw 20. The protractor's secret power is that it reads the number of degrees, turning a famous impossibility into ordinary division.",
    probe:
      "A compass and straightedge can cut any angle exactly in half, again and again forever. So why is cutting an angle into THREE equal parts impossible with those same tools — yet trivial the instant you can measure its degrees?",
    source:
      "Trisecting a general angle with compass and unmarked straightedge is impossible; proved by Pierre Wantzel (1837). Trisecting 60 degrees requires cos(20 degrees), a root of the irreducible cubic 8x^3-6x-1. One of the three classical construction problems of antiquity.",
    visualEmoji: "✂️",
    provenance: "generated",
  },
  {
    fromKey: "benchmark_angles",
    toKey: "measuring the sky by hand",
    toLabel: "Measuring the sky by hand",
    toDomain: "astronomy",
    kind: "applies",
    hook: "Your fist is a protractor, and your pinky can hide the moon",
    teaser:
      "Hold your fist out at arm's length: for most people it covers about 10 degrees of sky. Skywatchers measure angles across the whole sky with their hands, and there's a neat reason it works so well.",
    narrative:
      "Stretch your arm all the way out. Your fist spans about 10 degrees of sky; a single pinky covers about 1 degree. The full moon looks huge, but it is only about half a degree across — so your outstretched pinky can completely cover it. Skywatchers measure the sky this way, with no tool at all. The clever part: it works for almost everyone, big or small, because a taller person has a longer arm AND a bigger hand — the two grow together, so the angle they cut stays about the same. Your own body is a built-in set of angle benchmarks.",
    probe:
      "A tall adult and a small child each hold out a fist and say it covers about 10 degrees of sky. The adult's fist is much bigger — so why don't the two of them end up measuring very different angles?",
    source:
      "timeanddate.com, 'Measuring the Sky by Hand': fist at arm's length ~10 degrees, little finger ~1 degree, full Moon ~30 arcminutes. EarthSky, 'Sky measurements: Degrees, arcminutes and arcseconds': fist ~10 degrees, pinky ~1-1.5 degrees, full Moon ~1/2 degree, hand size roughly proportional to arm length.",
    visualEmoji: "✋",
    provenance: "generated",
  },
  {
    fromKey: "parallel_perpendicular_lines",
    toKey: "linear perspective",
    toLabel: "Linear perspective",
    toDomain: "art",
    kind: "history",
    hook: "Parallel train tracks meet on paper — and that is how depth appears",
    teaser:
      "You're taught that parallel lines never meet. Yet in a photo or lifelike drawing of train tracks, the rails seem to rush together at a point on the horizon. Renaissance artists learned to draw receding parallels that way.",
    narrative:
      "Parallel lines never meet on the flat geometry page. But look down a long straight road or train track: the two edges are truly parallel, yet they seem to race together to one point on the horizon, the 'vanishing point.' Around 1420 the architect Brunelleschi demonstrated this geometry, and Alberti wrote it down in 1435 — to draw receding parallel edges realistically, you make them converge. Mathematicians later built projective geometry, where parallel lines can meet at a 'point at infinity.' Draw two lines to one dot, add rungs, and the flat page leaps into depth.",
    probe:
      "Draw two lines that meet at a single dot, then add evenly spaced rungs between them like a ladder. The lines are just ink on flat paper — so why does the drawing suddenly look like it's stretching away into the distance?",
    source:
      "Linear perspective: Brunelleschi's demonstration (c. 1420) and Alberti's De pictura (1435), summarized by Britannica, 'Linear Perspective.' Projective geometry adds points at infinity; MathWorld, 'Projective Geometry' and 'Point at Infinity.'",
    visualEmoji: "🛤️",
    provenance: "generated",
  },
  {
    fromKey: "angle_sum_triangle",
    toKey: "spherical geometry",
    toLabel: "Spherical geometry",
    toDomain: "math",
    kind: "instantiates",
    hook: "The triangle with three right angles",
    teaser:
      "Draw a triangle on a ball: equator, meridian, meridian. It can have three square corners, and that impossible sum is a detector for whether your world is flat.",
    narrative:
      "On flat paper, every triangle's angles add to 180 degrees. On a globe, walk along the equator, turn 90 degrees up a meridian to the North Pole, turn 90 degrees down another meridian, then turn 90 degrees back along the equator. You just traced a triangle with three right angles: 270 degrees total. The school rule was not fake; it was a hidden flatness test. Girard's theorem measures the extra angle as spherical area.",
    probe:
      "Can you make the same three-right-angle triangle on an orange with a marker? Where does the extra 90 degrees come from?",
    visualEmoji: "🌐",
    source:
      "Spherical geometry; Girard's theorem / spherical excess (Wolfram MathWorld, 'Girard's Spherical Excess Formula').",
    provenance: "generated",
  },
  {
    fromKey: "coordinate_plane_first_quadrant",
    toKey: "john snow cholera map",
    toLabel: "John Snow cholera map",
    toDomain: "public-health",
    kind: "history",
    hook: "The dot map that accused a pump",
    teaser:
      "A dot on a map can be a clue. In 1854, a cluster of black marks made an invisible killer point back to one London water pump.",
    narrative:
      "In 1854 London, physician John Snow marked cholera deaths on a street map. The dots crowded around the Broad Street pump, so a place became evidence: each plotted point said, 'look here.' Snow combined the map with interviews and argued that contaminated water from that pump was spreading the disease; local officials removed the handle. A coordinate plane does the same strange move in miniature: a pair of numbers turns where into a pattern you can reason about.",
    probe:
      "If five mystery stomachaches in your classroom all plotted near one water fountain, what would you check first?",
    visualEmoji: "🗺️",
    source:
      "John Snow's 1854 Broad Street cholera map; London Museum, 'John Snow: Cholera & the Broad Street pump'; National Geographic Education, 'Mapping a London Epidemic.'",
    provenance: "generated",
  },
  {
    fromKey: "line_symmetry",
    toKey: "kaleidoscope",
    toLabel: "Kaleidoscope",
    toDomain: "optics",
    kind: "instantiates",
    hook: "The mirror that turns one slice into a universe",
    teaser:
      "A single wedge of beads looks ordinary until mirrors copy it. The line of symmetry becomes a machine, not a decoration.",
    narrative:
      "In 1816, Scottish scientist David Brewster invented the kaleidoscope, then patented it in 1817. Its trick is brutally simple: angled mirrors reflect one little slice again and again, so a few loose colored pieces become a whole symmetric world. When you draw a line of symmetry, you are not just checking whether two halves match; you are finding the mirror rule that can generate the other half.",
    probe:
      "Put a small paper shape beside a mirror. Which half did you draw, and which half did the mirror generate?",
    visualEmoji: "🔁",
    source:
      "Encyclopaedia Britannica, 'Kaleidoscope'; Smithsonian Institution object record for Brewster's kaleidoscope.",
    provenance: "generated",
  },
  {
    fromKey: "coordinate_distance",
    toKey: "taxicab geometry",
    toLabel: "Taxicab geometry",
    toDomain: "math",
    kind: "instantiates",
    hook: "The city where diagonals are illegal",
    teaser:
      "On grid streets, the shortest path can be longer than the bird's path. Your same-row subtraction is the first piece of a whole different geometry.",
    narrative:
      "On a city grid, a taxi cannot cut through buildings; it moves along streets. Taxicab geometry defines distance as horizontal blocks plus vertical blocks: |x1 - x2| + |y1 - y2|. If two points share a row, the vertical part is zero, so distance collapses to the subtraction you already do. The surprise is that changing what paths are allowed changes the geometry itself: circles become diamonds, and nearest can mean something new.",
    probe:
      "On a grid, how many shortest taxi paths go from (0, 0) to (3, 2)? What shape is everything 3 blocks from home?",
    visualEmoji: "🚕",
    source:
      "Taxicab metric / Manhattan distance; Wolfram MathWorld, 'Taxicab Metric.'",
    provenance: "generated",
  },
  {
    fromKey: "coordinate_perimeter_area",
    toKey: "shoelace formula",
    toLabel: "Shoelace formula",
    toDomain: "math",
    kind: "instantiates",
    hook: "A polygon whose area falls out of its vertices",
    teaser:
      "List the corners around a shape and cross-multiply like lacing a shoe. The coordinates alone can give the area, even when the sides tilt.",
    narrative:
      "For rectangles on a grid, you count side lengths and multiply. The shoelace formula opens the secret door: any simple polygon's area can be computed from its ordered vertex coordinates. Write the first point again at the end, multiply down one diagonal column and up the other, subtract, then halve. The shoelace is not a drawing trick; it is a coordinate machine that turns a boundary walk into area.",
    probe:
      "Try the square (0, 0), (4, 0), (4, 3), (0, 3). Does the shoelace total give the same 12 square units you get by length times width?",
    visualEmoji: "🥾",
    source:
      "Shoelace formula / surveyor's formula / Gauss's area formula; Wolfram MathWorld, 'Shoelace Formula.'",
    provenance: "generated",
  },

  // ── integers-rationals (generated 2026-08-11) ──
  {
    fromKey: "positive_negative_contexts",
    toKey: "the long war on negative numbers",
    toLabel: "The long war on negative numbers",
    toDomain: "history",
    kind: "history",
    hook: "Negative answers once looked absurd to great mathematicians",
    teaser:
      "To you, owing 3 dollars as −3 feels ordinary. Diophantus called one negative-answer equation absurd, and even in 1758 some British mathematicians said negatives did not exist — long after Brahmagupta had written debt-and-fortune sign rules in India.",
    visualEmoji: "📜",
    narrative:
      "To you, −3 can simply mean 'you owe 3.' But for a long time, that idea looked impossible to many mathematicians: Diophantus called an equation with a negative solution 'absurd,' and in 1758 Francis Maseres and William Frend still argued that negative numbers did not exist. Yet in India back in 628 CE, Brahmagupta had already written sign rules using fortunes and debts: a debt times a debt makes a fortune, (−)(−) = (+). You can use a number that once looked impossible.",
    probe:
      "Brahmagupta wrote his rules as money — fortunes and debts. Using only that idea, can you argue why taking away a debt (a 'debt of a debt') should turn into a fortune? What everyday money moment makes (−)(−) = (+) feel true?",
    source:
      "MacTutor, Brahmagupta biography: Brāhmasphuṭasiddhānta (628) and fortunes/debts sign rules; NRICH, 'The History of Negative Numbers': Diophantus called a negative-result equation 'absurd'; Maseres (1758) and Frend argued negatives did not exist.",
    provenance: "generated",
  },
  {
    fromKey: "integers_on_number_line",
    toKey: "absolute zero",
    toLabel: "Absolute zero",
    toDomain: "physics",
    kind: "applies",
    hook: "The number line runs forever downward — real cold does not",
    teaser:
      "On the number line you can always step one more to the left: −100, −101, −102. Temperature looks similar on a thermometer — until absolute zero shows that physical cold has a floor.",
    visualEmoji: "❄️",
    narrative:
      "A number line has no end: name any integer and you can always go one lower. Temperature seems to copy it — thermometers show −5, −20, −40. But real cold has a wall. Absolute zero is −273.15°C, or 0 K: the point where a system has as little thermal energy as it can. Lord Kelvin proposed an absolute temperature scale in 1848 that starts there. The math line is endless; ordinary cold quietly stops.",
    probe:
      "You can subtract 1 forever on the number line. So why can't a freezer just keep going −274, −275, −300 degrees Celsius? What would a temperature below all possible thermal motion even mean?",
    source:
      "NIST, 'How Low Can Temperature Go? Lord Kelvin and the Science of Absolute Zero': Lord Kelvin calculated absolute zero as −273.15°C in 1848; absolute zero is the coldest possible temperature, 0 K.",
    provenance: "generated",
  },
  {
    fromKey: "additive_inverses_make_zero",
    toKey: "antimatter",
    toLabel: "Antimatter",
    toDomain: "physics",
    kind: "instantiates",
    hook: "When +1 meets its antimatter twin, both vanish into light",
    teaser:
      "You just made +5 and −5 add to zero on paper. The universe has a wilder version: pair a particle with its exact antimatter twin and they do not merely cancel — their mass becomes flashes of energy.",
    visualEmoji: "⚛️",
    narrative:
      "Every electron carries charge −1. Its antimatter twin, the positron, carries +1. When an electron and positron meet, the total charge is 0 — but the particles do not merely disappear. They annihilate, turning their rest-mass energy into two 511 keV gamma-ray photons. Dirac predicted the anti-electron in 1931; Anderson found the positron in 1932. PET scanners use those paired flashes to build images of activity in the brain.",
    probe:
      "On paper, +1 and −1 make 0 and nothing else happens. In a PET scanner, an electron and positron have charges that sum to zero, yet two bursts of light shoot in opposite directions. Why must zero total charge still leave energy behind?",
    source:
      "CERN timeline: Dirac published the 1931 anti-electron prediction; Nobel/APS: Anderson discovered the positron in 1932; NCBI Bookshelf PET chapter: positron-electron annihilation emits two opposite 511 keV photons used for PET brain imaging.",
    provenance: "generated",
  },
  {
    fromKey: "multiply_integers",
    toKey: "brahmagupta's debts and fortunes",
    toLabel: "Brahmagupta's Debts and Fortunes",
    toDomain: "history-of-mathematics",
    kind: "history",
    hook: "The first sign rules were debts and fortunes",
    teaser:
      "A mathematician in 628 CE wrote negative numbers as debts and positives as fortunes. His strangest line sounds exactly like your sign rule.",
    narrative:
      "In 628 CE, Brahmagupta wrote rules for positives as fortunes and negatives as debts. His `Brahmasphutasiddhanta` says the product or quotient of two debts is one fortune. That is the sign rule hiding in history: one negative reverses the effect, but a second negative reverses it back. The weird classroom fact that a negative times a negative is positive once lived in the everyday language of owing and owning.",
    probe:
      "Make a debt card worth -3. If one reversal changes fortune to debt, what should two reversals do? Why would Brahmagupta call two debts multiplying a fortune?",
    visualEmoji: "📜",
    source:
      "Brahmagupta, `Brahmasphutasiddhanta` (628 CE); MacTutor biography quoting the debt/fortune rules for products and quotients.",
    provenance: "generated",
  },
  {
    fromKey: "integer_sign_rules",
    toKey: "orientation-preserving isometries",
    toLabel: "Orientation-Preserving Isometries",
    toDomain: "geometry",
    kind: "instantiates",
    hook: "Every negative sign is a flip",
    teaser:
      "Flip a paper arrow once and it is reversed. Flip it again and the arrow is back. Several negative factors follow the same hidden rule.",
    narrative:
      "Cut an arrow from paper and flip it over: its handedness reverses. Flip it again and the arrow is back to its original orientation. Geometry calls a single reflection orientation-reversing and two reflections orientation-preserving. That is the same sign logic as a product with several negative factors: every negative is a flip, and only an odd number leaves the final answer facing the negative way.",
    probe:
      "Hold a paper arrow. Flip it once, twice, three times. Which counts leave it reversed? How does that match products with 1, 2, or 3 negative factors?",
    visualEmoji: "🔁",
    source:
      "University of Washington, `Orientation Preserving and Reversing Isometries of the Plane`: even products of reflections preserve orientation; odd products reverse it.",
    provenance: "generated",
  },
  {
    fromKey: "integer_context_problems",
    toKey: "badwater-to-whitney vertical relief",
    toLabel: "Badwater-to-Whitney Vertical Relief",
    toDomain: "geography",
    kind: "applies",
    hook: "A mountain trip starts below zero",
    teaser:
      "Death Valley's salt flat is below sea level, and Mount Whitney is far above it. The trip's height change only works if zero is a line you can cross.",
    narrative:
      "Badwater Basin in Death Valley sits 282 feet below sea level, while Mount Whitney's summit is 14,505 feet above it. The elevation change is not 14,505 - 282; the start is -282, so 14,505 - (-282) = 14,787 feet. A negative height is not less real than a positive one. Sea level is the zero line, and crossing it turns subtraction into adding the distance below.",
    probe:
      "Draw sea level as 0, Badwater at -282, and Mount Whitney at 14,505. How far apart are the two heights, and why does subtracting -282 add?",
    visualEmoji: "⛰️",
    source:
      "U.S. National Park Service, Badwater Basin (282 ft below sea level); NPS, Seeing and Climbing Mt. Whitney (14,505 ft NAVD88).",
    provenance: "generated",
  },
  {
    fromKey: "add_subtract_signed_rationals",
    toKey: "nepal standard time",
    toLabel: "Nepal Standard Time",
    toDomain: "timekeeping",
    kind: "applies",
    hook: "A real clock is +5 3/4 hours",
    teaser:
      "Not every time zone is a neat whole-hour jump. Nepal's offset is five hours and forty-five minutes, so clock math can demand signed fractions.",
    narrative:
      "Nepal uses UTC+5:45, not a whole-hour offset. If a friend at UTC sends a message at noon, Kathmandu time is 12 + 5 3/4 = 5:45 p.m.; going back means subtracting the same signed rational. Time zones turn fractions with signs into clock jumps. The 45-minute offset is the surprise: the world's clocks are not all spaced by neat one-hour steps.",
    probe:
      "If UTC time is 8:00 a.m., add Nepal's +5 3/4 hour offset. What local time is it in Kathmandu? What operation takes you back to UTC?",
    visualEmoji: "🕰️",
    source:
      "IANA tz database, `Asia/Kathmandu`: Nepal changed from +5:30 to +5:45 in 1986 and remains at +5:45; timeanddate.com, Time Zones in Nepal.",
    provenance: "generated",
  },
  {
    fromKey: "divide_signed_rationals",
    toKey: "cartesian slope",
    toLabel: "Cartesian Slope",
    toDomain: "coordinate-geometry",
    kind: "instantiates",
    hook: "Two negative moves can make a positive slope",
    teaser:
      "Trace a line down and left: both the rise and run are negative. Somehow the steepness is positive, and the grid can show why.",
    narrative:
      "On a coordinate grid, slope is signed rise divided by signed run. From (2, 1) to (-4, -2), the run is -6 and the rise is -3, so the slope is (-3)/(-6) = 1/2. Walk the same line backward and both signs flip, but the steepness does not. Coordinate geometry turns division of signed rationals into a fact about a line: direction can reverse while slope stays positive.",
    probe:
      "Plot (2, 1) and (-4, -2). Count the signed run and signed rise from the first point to the second. Why is the slope positive?",
    visualEmoji: "📈",
    source:
      "René Descartes, `La Géométrie` (1637), foundational coordinate geometry; modern slope as signed rise over signed run in analytic geometry.",
    provenance: "generated",
  },
  {
    fromKey: "rational_coordinate_pairs",
    toKey: "the marriage of algebra and geometry",
    toLabel: "The Marriage of Algebra and Geometry",
    toDomain: "history",
    kind: "history",
    hook: "The day a shape became an equation",
    teaser:
      "Plotting a point as two numbers feels like bookkeeping. But in the 1600s, Descartes and Fermat made a stranger leap: curves and equations turned out to be two views of the same thing.",
    narrative:
      "Coordinate pairs let a drawing and an equation talk to each other. In 1637 René Descartes used coordinates to study curves with algebra; Pierre de Fermat developed the same idea independently in the 1630s. A circle you can draw is exactly the set of points whose coordinates satisfy x² + y² = r². Suddenly a geometry question could be answered with algebra, and back again. That is why coordinate geometry is also called analytic or Cartesian geometry.",
    probe:
      "A circle is a shape you draw; x² + y² = 25 is an equation you solve. Descartes said they're the same object. How could pinning points to number-pairs turn one into the other?",
    visualEmoji: "📈",
    source:
      "Britannica, `La Géométrie`: Descartes' 1637 work is foundational to analytic/coordinate geometry and credited with Fermat; Britannica, `Analytic geometry`: Descartes and Fermat independently founded analytic geometry in the 1630s; Encyclopedia of Mathematics, `Analytic geometry`: Descartes (1637) gave a clear account of the coordinate method and foundations.",
    provenance: "generated",
  },
  {
    fromKey: "rational_between_numbers",
    toKey: "the discovery of irrational numbers",
    toLabel: "The Discovery of Irrational Numbers",
    toDomain: "math",
    kind: "instantiates",
    hook: "You can always fit one more fraction in — forever",
    teaser:
      "Between 1.4 and 1.5 you can wedge 1.45; between 1.41 and 1.42, another. You never run out of room, so the fractions ought to fill the whole line. Except the ancient Greeks found a point no fraction can ever land on.",
    narrative:
      "Pick any two fractions and you can always find one between them — their average works — so between ANY two there are infinitely many. The fractions are packed infinitely tight; it feels like they must fill the line with no gaps left. But keep hunting the number whose square is 2: 1.4, 1.41, 1.414, 1.4142… you close in forever and NEVER land exactly. The Pythagoreans proved √2 is no fraction at all. The line holds irrational points invisibly wedged among your infinitely dense fractions, challenging the old dream that everything is commensurable as a ratio.",
    probe:
      "You can always average two fractions to get one between them, forever. Yet √2 slips through every time. If the fractions are infinitely dense, how can the line still hold points that none of them ever hits?",
    visualEmoji: "🕳️",
    source:
      "Wolfram MathWorld, `Pythagoras's Constant`: √2 is the unit-square hypotenuse and the Pythagoreans proved it irrational; Britannica, `Pythagoreanism—Metaphysics and number theory`: Pythagoreans treated things as measurable/commensurable or proportional in terms of number.",
    provenance: "generated",
  },
  {
    fromKey: "signed_fraction_decimal_equivalence",
    toKey: "zeno's paradox",
    toLabel: "Zeno's Paradox",
    toDomain: "math",
    kind: "instantiates",
    hook: "0.999… doesn't get close to 1. It IS 1.",
    teaser:
      "Convert 1/3 to a decimal and it never stops: 0.333…. Now multiply both sides by 3. The left is 1; the right is 0.999…. A check you can finish in ten seconds forces a conclusion your gut will fight — the same knot the Greeks tied 2,400 years ago.",
    narrative:
      "Turn 1/3 into a decimal: 0.333… forever. Multiply by 3 — the left side is 1, so 0.999… must equal 1 exactly, not \"almost.\" Two different-looking decimals, the very same number. It sounds like a trick, but it's the puzzle Zeno posed around 450 BC: to cross a room you first go halfway, then half of what's left, forever — infinitely many steps, yet you arrive. Because 1/2 + 1/4 + 1/8 + … really does add to exactly 1. An endless run of shrinking pieces can total a whole number, and 0.999… is that sum standing in front of you.",
    probe:
      "1/3 = 0.333…, so 3 × 0.333… = 0.999… — but 3 × 1/3 = 1. If 0.999… weren't equal to 1, how big is the gap between them? Try to name one number that fits inside it.",
    visualEmoji: "🐢",
    source:
      "ProofWiki, `0.999...=1`: geometric-series, fraction, multiplication-by-10, long-division, and sequence proofs; Wolfram MathWorld, `Zeno's Paradoxes`: dichotomy paradox and convergent half-step series; Britannica, `Zeno of Elea`: c. 495-c. 430 BCE.",
    provenance: "generated",
  },
];

// A family cue keeps several stories opening onto the same world from acquiring
// competing decoration. Individual stories may still author a more specific cue.
export const STORY_REGISTRY: RegistryStory[] = STORY_REGISTRY_BASE.map((story) => ({
  ...story,
  ...(story.visualEmoji === undefined
    ? { visualEmoji: STORY_FAMILY_VISUALS[story.toKey] }
    : {}),
}));
