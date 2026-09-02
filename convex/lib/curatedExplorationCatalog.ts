/**
 * Authored inspiration for the Interpretive lens.
 *
 * Entries are not units, seeds, or assignments. They are compact, verified
 * candidates the existing constellation generator may select when a learner's
 * interests create an honest bridge. Selected entries become ordinary
 * `ai-constellation` seeds; an independent-study unit is still created only
 * after the learner launches that seed.
 */

import { cleanSeedLabel } from "./seedLabel";

export type CuratedExplorationEntry = {
  id: string;
  family: string;
  topic: string;
  domain: string;
  invitation: string;
  connectionCues: readonly string[];
  sources: readonly string[];
  /**
   * Private, bake-time steering for entries with a verified mechanism and a
   * safe investigation. Never shown in the sky or stored on the seed.
   */
  bakeAnchor?: {
    mechanism: string;
    mission: {
      does: string;
      materials: readonly string[];
      fallback: string;
    };
    evidence: {
      /**
       * Only kinds with a complete scholar capture/workbench path belong here.
       * Audio is intentionally excluded until Rabbithole can record it in-app.
       */
      kind: "artifact" | "photo";
      produces: string;
      laterUse: string;
    };
  };
};

export const CURATED_EXPLORATION_CATALOG: readonly CuratedExplorationEntry[] = [
  {
    id: "grid-second-by-second",
    family: "hidden-machinery",
    topic: "The grid's missing warehouse",
    domain: "Engineering",
    invitation:
      "The power grid stores very little electricity, so supply and demand must stay balanced moment by moment. When millions of people switch things on at once, what keeps the whole system in step?",
    connectionCues: [
      "blackouts",
      "clocks",
      "electricity",
      "guitar tuning",
      "spinning things",
      "video games",
      "weather",
      "wind turbines",
    ],
    sources: [
      "U.S. Energy Information Administration, Electricity explained",
      "North American Electric Reliability Corporation, BAL-003 Frequency Response and Frequency Bias Setting",
    ],
  },
  {
    id: "container-corner-fittings",
    family: "hidden-machinery",
    topic: "Eight holes that move everything",
    domain: "Logistics",
    invitation:
      "Standard shipping containers share the same corner fittings, so cranes, trains, trucks, and ships can all grab an unfamiliar box. How can one agreement about a few steel holes reorganize world trade?",
    connectionCues: [
      "lego",
      "maps",
      "online orders",
      "packing",
      "ports",
      "standard sizes",
      "trains",
      "trade",
    ],
    sources: [
      "ISO 668, Series 1 freight containers - Classification, dimensions and ratings",
      "ISO 1161, Series 1 freight containers - Corner and intermediate fittings",
    ],
  },
  {
    id: "concrete-hydration",
    family: "hidden-machinery",
    topic: "Concrete that hardens underwater",
    domain: "Materials science",
    invitation:
      "Concrete can harden underwater, so drying cannot be what makes it solid. Water is part of the reaction: what is growing inside the mix, and why can a large pour get hot?",
    connectionCues: [
      "ancient ruins",
      "bridges",
      "chemistry",
      "minecraft",
      "mixing",
      "rocks",
      "sandcastles",
      "swimming pools",
    ],
    sources: [
      "Portland Cement Association, How concrete is made",
      "American Concrete Institute, Cement hydration",
    ],
  },
  {
    id: "vaccine-vial-monitors",
    family: "hidden-machinery",
    topic: "Labels that remember heat",
    domain: "Public health",
    invitation:
      "Some vaccine vials carry a small square that darkens as heat exposure adds up across the whole journey. How do you design a label that remembers what happened when no refrigerator was watching?",
    connectionCues: [
      "camping",
      "chemistry",
      "color changes",
      "deliveries",
      "medicine",
      "refrigerators",
      "stickers",
      "travel",
    ],
    sources: [
      "World Health Organization, Vaccine vial monitor guidance",
      "UNICEF Supply Division, Vaccine vial monitors",
    ],
  },
  {
    id: "old-river-control",
    family: "hidden-machinery",
    topic: "The river we hold still",
    domain: "Earth science",
    invitation:
      "The Mississippi keeps trying to take a shorter route to the Gulf, while a huge control structure holds the split near 70/30. Water follows gravity; what does it take to tell a river no?",
    connectionCues: [
      "cities",
      "erosion",
      "floods",
      "gardening",
      "kayaking",
      "maps",
      "rivers",
      "sand",
    ],
    sources: [
      "U.S. Army Corps of Engineers, Old River Control Complex",
      "Flood Control Act of 1954",
    ],
  },
  {
    id: "commodity-grade-warrants",
    family: "hidden-machinery",
    topic: "Trading metal you never touch",
    domain: "Economics",
    invitation:
      "Copper can be bought and sold repeatedly while it stays inside one approved warehouse. What must everyone agree about its grade, weight, and receipt before paper can stand in for metal?",
    connectionCues: [
      "collecting",
      "fairness",
      "measuring",
      "minerals",
      "mining",
      "money",
      "promises",
      "trading cards",
    ],
    sources: [
      "London Metal Exchange, Physical market and warehouse warrants",
      "London Metal Exchange, LME Copper contract specifications",
    ],
  },
  {
    id: "near-miss-reporting",
    family: "hidden-machinery",
    topic: "Mistakes that make flying safer",
    domain: "Systems safety",
    invitation:
      "Aviation learns from near-misses by letting people confidentially report their own mistakes. Why might a system discover more danger when it protects an honest report instead of punishing it?",
    connectionCues: [
      "game bugs",
      "honesty",
      "hospitals",
      "machines",
      "planes",
      "rules",
      "sports mistakes",
      "teamwork",
    ],
    sources: [
      "NASA, Aviation Safety Reporting System",
      "James Reason, Human error: models and management, BMJ (2000)",
    ],
  },
  {
    id: "eddy-current-sorting",
    family: "hidden-machinery",
    topic: "Cans that jump sideways",
    domain: "Physics",
    invitation:
      "At recycling plants, aluminum cans can leap off a moving belt without anything touching them. A spinning magnetic field makes the metal push back - what else could you sort this way?",
    connectionCues: [
      "cans",
      "electricity",
      "magnets",
      "recycling",
      "robots",
      "scrap",
      "sorting",
      "trash",
    ],
    sources: [
      "U.S. Environmental Protection Agency, Materials recovery facilities",
      "Encyclopaedia Britannica, Eddy current",
    ],
  },
  {
    id: "setback-zoning",
    family: "hidden-machinery",
    topic: "The rule inside a skyline",
    domain: "Urban planning",
    invitation:
      "The stair-step shape of many old New York towers came from a 1916 rule meant to preserve light and air at street level. What invisible shape do building rules draw over your own town?",
    connectionCues: [
      "architecture",
      "cities",
      "drawing",
      "houses",
      "laws",
      "maps",
      "minecraft",
      "shadows",
    ],
    sources: [
      "New York City Department of City Planning, 1916 Zoning Resolution",
      "Museum of the City of New York, Zoning and the city skyline",
    ],
  },
  {
    id: "authorization-settlement",
    family: "hidden-machinery",
    topic: "Money that has not moved",
    domain: "Economics",
    invitation:
      "When a card says approved, the purchase is authorized before the banks finish moving the money through clearing and settlement. During that gap, who is promising what to whom?",
    connectionCues: [
      "allowance",
      "banks",
      "computers",
      "games with points",
      "promises",
      "receipts",
      "shopping",
      "trust",
    ],
    sources: [
      "Federal Reserve, The payment system and payment settlement",
      "Visa, Authorization, clearing and settlement overview",
    ],
  },
  {
    id: "controlled-atmosphere-storage",
    family: "hidden-machinery",
    topic: "Apples asleep in low oxygen",
    domain: "Food science",
    invitation:
      "An apple eaten in spring may have been picked in autumn and kept in a room with very little oxygen. Fruit keeps breathing after harvest - what changes when you slow that breath?",
    connectionCues: [
      "breathing",
      "chemistry",
      "cooking",
      "farms",
      "gardening",
      "grocery stores",
      "seasons",
      "smells",
    ],
    sources: [
      "Washington State University Tree Fruit Research and Extension Center, Controlled-atmosphere storage",
      "Cornell University, Postharvest biology and controlled atmospheres",
    ],
  },
  {
    id: "submarine-cable-repair",
    family: "hidden-machinery",
    topic: "Fishing up the internet",
    domain: "Telecommunications",
    invitation:
      "Most intercontinental data travels through fiber-optic cables on the seabed. When one breaks, a repair ship may drag a grapnel along the bottom to retrieve it - how would you find one thin line in a whole ocean?",
    connectionCues: [
      "computers",
      "fishing",
      "glass",
      "light",
      "long distances",
      "maps",
      "oceans",
      "ships",
    ],
    sources: [
      "International Cable Protection Committee, About submarine telecommunications cables",
      "TeleGeography, Submarine Cable Map and FAQs",
    ],
  },
  {
    id: "contract-consideration",
    family: "hidden-machinery",
    topic: "The trade inside a promise",
    domain: "Law",
    invitation:
      "In common-law contracts, a promise usually becomes enforceable only when each side gives or promises something. What is the smallest real exchange that could turn words into a contract?",
    connectionCues: [
      "arguments",
      "disagreements",
      "fairness",
      "games",
      "promises",
      "rules",
      "trades",
      "writing things down",
    ],
    sources: [
      "Restatement (Second) of Contracts, Section 71",
      "Cornell Legal Information Institute, Consideration",
    ],
  },
  {
    id: "euv-tin-droplets",
    family: "hidden-machinery",
    topic: "Tin drops that print chips",
    domain: "Engineering",
    invitation:
      "An advanced chipmaking machine fires lasers at falling tin droplets to create extreme-ultraviolet light, then guides that light with mirrors instead of lenses. Why does printing something tiny need a machine this strange?",
    connectionCues: [
      "computers",
      "drawing",
      "lasers",
      "light",
      "patterns",
      "photography",
      "stencils",
      "tiny things",
    ],
    sources: [
      "ASML, EUV lithography systems",
      "ZEISS Semiconductor Manufacturing Technology, EUV optics",
    ],
  },
  {
    id: "pipeline-batching",
    family: "hidden-machinery",
    topic: "Three fuels, one pipe",
    domain: "Chemical engineering",
    invitation:
      "A products pipeline can send gasoline, diesel, and jet fuel through the same pipe in separate batches, with no wall between them. How do operators know when one product ends and the next begins?",
    connectionCues: [
      "cars",
      "liquids",
      "maps",
      "measuring",
      "mixing",
      "planes",
      "plumbing",
      "timing",
    ],
    sources: [
      "U.S. Energy Information Administration, Oil pipelines",
      "Association of Oil Pipe Lines, Products pipelines",
    ],
  },
  {
    id: "parametric-insurance",
    family: "hidden-machinery",
    topic: "Insurance triggered by a sensor",
    domain: "Probability",
    invitation:
      "Some disaster coverage pays when a measured trigger crosses a threshold, without waiting for every loss to be inspected. That makes payment fast - but what happens when the trigger and the real damage disagree?",
    connectionCues: [
      "chance games",
      "earthquakes",
      "fairness",
      "maps",
      "predictions",
      "sensors",
      "storms",
      "weather",
    ],
    sources: [
      "World Bank, What you need to know about parametric insurance",
      "World Bank Treasury, Catastrophe bonds and disaster risk financing",
    ],
  },
  {
    id: "kilogram-redefinition",
    family: "hidden-machinery",
    topic: "Weighing against an idea",
    domain: "Metrology",
    invitation:
      "Until 2019, the world's kilogram depended on a metal cylinder kept near Paris. Now it is tied to an exact constant of nature - how can a laboratory turn an equation back into a weight?",
    connectionCues: [
      "balance scales",
      "cooking",
      "fairness",
      "machines",
      "measuring",
      "numbers",
      "science",
      "time",
    ],
    sources: [
      "Bureau International des Poids et Mesures, SI base unit definitions",
      "26th General Conference on Weights and Measures, Resolution 1 (2018)",
      "National Institute of Standards and Technology, Kibble balance",
    ],
  },
  {
    id: "pill-dissolution-testing",
    family: "hidden-machinery",
    topic: "Timing how a pill dissolves",
    domain: "Pharmacology",
    invitation:
      "Before a batch of pills ships, samples may be stirred in a warm liquid while technicians measure how quickly medicine dissolves. Two pills can contain the same amount - so why can release speed still matter?",
    connectionCues: [
      "bodies",
      "chemistry",
      "cooking",
      "dissolving",
      "experiments",
      "machines",
      "medicine",
      "timing",
    ],
    sources: [
      "United States Pharmacopeia General Chapter 711, Dissolution",
      "U.S. Food and Drug Administration, Dissolution testing guidance",
    ],
  },
  {
    id: "lunar-retroreflectors",
    family: "measure-the-unmeasurable",
    topic: "Mirrors left on the Moon",
    domain: "Physics",
    invitation:
      "Apollo crews left mirrors on the Moon, and observatories still time laser pulses bouncing off them. We can measure that the Moon drifts about 3.8 centimeters farther away each year - where is that distance coming from?",
    connectionCues: [
      "bike reflectors",
      "geometry",
      "lasers",
      "measuring tiny changes",
      "mirrors",
      "space missions",
      "the Moon",
      "tides",
    ],
    sources: [
      "NASA, The Apollo Experiment That Keeps on Giving, https://www.nasa.gov/missions/apollo/apollo-11/the-apollo-experiment-that-keeps-on-giving/",
      "NASA JPL, Apollo 11 Experiment Continues to Return Valuable Data, https://www.jpl.nasa.gov/news/apollo-11-experiment-continues-to-return-valuable-data/",
    ],
  },
  {
    id: "bobtail-squid-symbiosis",
    family: "partnerships-not-parts",
    topic: "A squid that rents light",
    domain: "Biology",
    invitation:
      "A Hawaiian bobtail squid recruits glowing bacteria from seawater, houses them in a light organ, and uses their glow to erase its shadow from predators below. How does its body welcome one useful species while refusing others?",
    connectionCues: [
      "bacteria",
      "camouflage",
      "day and night",
      "Hawaiʻi shorelines",
      "immune systems",
      "light and shadow",
      "ocean animals",
      "partnerships",
    ],
    sources: [
      "NIH NIGMS, Research Organism Superheroes: Hawaiian Bobtail Squid, https://nigms.nih.gov/biobeat/2024/05/research-organism-superheroes-hawaiian-bobtail-squid",
      "Nyholm and McFall-Ngai, The winnowing: establishing the squid-vibrio symbiosis, Nature Reviews Microbiology 2:632-642 (2004), https://doi.org/10.1038/nrmicro957",
    ],
    bakeAnchor: {
      mechanism:
        "The squid's light organ selectively recruits Vibrio fischeri, then uses the bacteria's glow to match downwelling light and erase its silhouette from predators below.",
      mission: {
        does:
          "Shine a light down onto a pale object in a dark tray, photograph its shadow, then add a dim light beneath the object and adjust it until the silhouette nearly disappears.",
        materials: [
          "a shallow tray",
          "a flashlight",
          "a small light or phone screen",
          "a pale bead or eraser",
        ],
        fallback:
          "If a second light is unavailable, use a phone screen beneath a paper stand; if the setup cannot be photographed, submit one photo of two labeled observation sketches.",
      },
      evidence: {
        kind: "photo",
        produces:
          "A paired shadow and counter-lit image, labeled with the light setting that best hid the object's silhouette.",
        laterUse:
          "The next sitting must compare the scholar's two images and use the brightness match as evidence before naming counter-illumination or explaining the squid.",
      },
    },
  },
  {
    id: "seven-riffle-shuffles",
    family: "how-random-is-random",
    topic: "Seven shuffles, then random",
    domain: "Mathematics",
    invitation:
      "For a 52-card deck, about seven riffle shuffles produce a sudden change from visibly ordered to well mixed. Before that point, traces of the old order remain - what could you measure to detect them?",
    connectionCues: [
      "card games",
      "fairness",
      "magic tricks",
      "mixing",
      "playlists",
      "probability",
      "randomness",
      "sorting",
    ],
    sources: [
      "Bayer and Diaconis, Trailing the Dovetail Shuffle to its Lair, Annals of Applied Probability 2(2):294-313 (1992), https://doi.org/10.1214/aoap/1177005705",
      "Harvey Mudd College, Seven Shuffles, https://math.hmc.edu/funfacts/seven-shuffles/",
    ],
    bakeAnchor: {
      mechanism:
        "Riffle shuffles break and interleave rising sequences; the remaining order drops sharply around seven shuffles rather than fading at a steady rate.",
      mission: {
        does:
          "Begin with a deck in order. After each of eight riffle shuffles, record the card order and count the runs that still rise from low to high.",
        materials: ["a deck of cards", "paper", "a pencil"],
        fallback:
          "If no deck is available, make 12 numbered paper slips, interleave two piles by hand, and track rising runs after each shuffle.",
      },
      evidence: {
        kind: "artifact",
        produces:
          "A shuffle-number versus rising-run table that shows whether detectable order collapsed suddenly or gradually.",
        laterUse:
          "A later sitting must graph or interrogate the scholar's actual table, including anomalies, before comparing the small experiment with the seven-shuffle result.",
      },
    },
  },
  {
    id: "cosmic-ray-vinland-date",
    family: "archives-in-unlikely-places",
    topic: "A sun storm dates Vinland",
    domain: "History",
    invitation:
      "A solar storm in 993 left one radiocarbon spike in tree rings worldwide. Norse-cut wood at L'Anse aux Meadows carries that ring, so counting outward to the bark fixes the year they were there. Why can one ring anywhere on Earth pin down a date?",
    connectionCues: [
      "archaeology",
      "auroras",
      "calendars",
      "forensics",
      "space weather",
      "tree rings",
      "Vikings",
      "voyages",
    ],
    sources: [
      "Kuitems et al., Evidence for European presence in the Americas in AD 1021, Nature (2021), https://www.nature.com/articles/s41586-021-03972-8",
      "NASA Earth Observatory, Burst of New Evidence for Viking Travels, https://science.nasa.gov/earth/earth-observatory/burst-of-new-evidence-for-viking-travels-149071/",
    ],
  },
  {
    id: "athenian-kleroterion",
    family: "rules-that-choose",
    topic: "The marble machine that governed",
    domain: "Civics",
    invitation:
      "Ancient Athens selected jurors with name tokens, a stone grid, and a tube of black and white balls. Not voting - drawing. What can a lottery protect that an election cannot?",
    connectionCues: [
      "ancient Greece",
      "class elections",
      "courts",
      "fairness",
      "machines",
      "probability",
      "rules",
      "who gets chosen",
    ],
    sources: [
      "Aristotle, Athenian Constitution, sections 63-65, https://www.perseus.tufts.edu/hopper/text?doc=Perseus%3Atext%3A1999.01.0046",
      "American School of Classical Studies at Athens, Athenian Agora Excavations, https://agora.ascsa.net/",
    ],
  },
  {
    id: "sabine-room-acoustics",
    family: "waves-you-can-map",
    topic: "The room that ate speech",
    domain: "Music and architecture",
    invitation:
      "A Harvard lecture hall made words echo into mush. Wallace Sabine moved seat cushions in and out, timed the lingering sound, and found a rule connecting a room's size, soft surfaces, and reverberation. Could you test it in your own school?",
    connectionCues: [
      "architecture",
      "concert halls",
      "echoes",
      "gyms",
      "materials",
      "music",
      "podcasts",
      "recording",
    ],
    sources: [
      "Linda Hall Library, Wallace Clement Sabine, https://www.lindahall.org/about/news/scientist-of-the-day/wallace-clement-sabine/",
      "Sabine, Collected Papers on Acoustics (1922), https://archive.org/details/collectedpaperso00sabi",
    ],
    bakeAnchor: {
      mechanism:
        "Reverberation time depends on room volume relative to sound absorption; hard reflective surfaces extend the tail, soft porous surfaces shorten it, and speech turns muddy when delayed sound overlaps later syllables.",
      mission: {
        does:
          "Record one clap three times in three different rooms, then repeat in one room after adding cushions or blankets while keeping the clap and recorder position fixed.",
        materials: [
          "a phone voice recorder",
          "cushions or blankets",
          "a tape measure",
        ],
        fallback:
          "If decay time is too hard to measure, rank repeated recordings from longest to shortest and use the one-room blanket comparison as the decisive test.",
      },
      evidence: {
        kind: "artifact",
        produces:
          "A comparison table with the prediction, repeated room observations or timings, room features, and the controlled blanket before-and-after result.",
        laterUse:
          "The next sitting must start from the scholar's actual rank order and anomalies, separate room size from surface softness, and never force a size pattern the evidence does not show.",
      },
    },
  },
  {
    id: "phantom-traffic-waves",
    family: "waves-you-can-map",
    topic: "Traffic jams with no obstacle",
    domain: "Applied mathematics",
    invitation:
      "Put cars on a circular track with no obstacle and ask everyone to drive steadily. A stop-and-go wave can still appear and travel backward around the loop. Nobody chose the jam - what makes smooth flow tip over?",
    connectionCues: [
      "bike pelotons",
      "crowds",
      "feedback loops",
      "long car rides",
      "simulations",
      "traffic",
      "waves",
      "why lines slow down",
    ],
    sources: [
      "Sugiyama et al., Traffic jams without bottlenecks - experimental evidence for the physical mechanism of the formation of a jam, New Journal of Physics (2008), https://doi.org/10.1088/1367-2630/10/3/033001",
      "MIT Traffic Research, https://math.mit.edu/traffic/",
    ],
    bakeAnchor: {
      mechanism:
        "Reaction delay and over-correction amplify a small slowdown into a stop-and-go wave that travels backward through traffic even while every vehicle moves forward.",
      mission: {
        does:
          "Have 6-10 people walk a marked loop at steady spacing. One person briefly slows once; film several laps and mark where the tight bunch appears on each pass.",
        materials: [
          "6-10 willing people",
          "chalk or removable tape",
          "a phone camera",
        ],
        fallback:
          "If a group is unavailable, use eight coins on a marked paper loop, move them in simultaneous rounds with a one-space safety gap, pause one coin once, and mark the crowded spot each round.",
      },
      evidence: {
        kind: "artifact",
        produces:
          "A sequence of loop maps or a table marking the bunch position on successive passes or rounds.",
        laterUse:
          "A later sitting must compare the marked bunch positions with the walkers' or coins' direction and let the scholar infer the wave's direction before naming the mechanism.",
      },
    },
  },
  {
    id: "polynesian-star-compass",
    family: "knowing-without-instruments",
    topic: "Finding islands without instruments",
    domain: "Navigation",
    invitation:
      "Hōkūleʻa's navigators cross thousands of miles without a compass, chart, or GPS, using a memorized star compass plus swells, birds, and clouds. Every hour they update where they think they are - could you keep that model in your head?",
    connectionCues: [
      "birds",
      "constellations",
      "estimation",
      "getting lost",
      "Hawaiʻi",
      "maps",
      "ocean waves",
      "sailing",
    ],
    sources: [
      "Polynesian Voyaging Society, The Star Compass, https://worldwidevoyage.hokulea.com/education-at-sea/polynesian-navigation/the-star-compass/",
      "Polynesian Voyaging Society, Polynesian Wayfinding, https://hokulea.com/polynesian-wayfinding/",
      "Smithsonian Folklife, Hokulea and Hawaiian Wayfinding, https://folklife.si.edu/magazine/hokulea-hawaiian-wayfinding",
    ],
  },
] as const;

function normalizeTopic(topic: string): string {
  return topic.trim().replace(/\s+/g, " ").toLowerCase();
}

const ENTRY_BY_TOPIC = new Map(
  CURATED_EXPLORATION_CATALOG.map((entry) => [
    normalizeTopic(cleanSeedLabel(entry.topic)),
    entry,
  ]),
);

export function curatedExplorationEntryForTopic(
  topic: string,
): CuratedExplorationEntry | null {
  return ENTRY_BY_TOPIC.get(normalizeTopic(cleanSeedLabel(topic))) ?? null;
}

export function capCuratedExplorationSelections<T extends { topic: string }>(
  candidates: readonly T[],
  limit = 2,
  allowCurated = true,
): T[] {
  let selected = 0;
  return candidates.filter((candidate) => {
    if (!curatedExplorationEntryForTopic(candidate.topic)) return true;
    if (!allowCurated) return false;
    if (selected >= limit) return false;
    selected++;
    return true;
  });
}

/**
 * Prompt material only. Sources stay in the reviewable catalog rather than
 * consuming generation tokens; selected copy is restored from the catalog
 * after generation so the model cannot embellish an authored invitation.
 */
export function curatedExplorationPromptSection(
  existingTopics: readonly string[],
  hasLearnerSignals = true,
): string {
  if (!hasLearnerSignals) {
    return "CURATED EXPLORATION CATALOG:\n- (not offered: no learner signal is available for an honest bridge)";
  }

  const existing = new Set(
    existingTopics.map((topic) => normalizeTopic(cleanSeedLabel(topic))),
  );
  const available = CURATED_EXPLORATION_CATALOG.filter(
    (entry) => !existing.has(normalizeTopic(cleanSeedLabel(entry.topic))),
  );

  if (available.length === 0) {
    return "CURATED EXPLORATION CATALOG:\n- (all current entries were already suggested)";
  }

  return [
    "CURATED EXPLORATION CATALOG:",
    "These are authored, verified possibilities - not a checklist or quota.",
    "Select AT MOST 2 only when a learner signal creates a specific, honest bridge.",
    "You may select none. Never force an entry merely to use the catalog.",
    "Do not generate another star that substantially overlaps a catalog entry you select.",
    'If selected, copy its "topic", "domain", and "invitation" exactly; put the learner-specific bridge in "connectionTo".',
    ...available.map(
      (entry) =>
        `- ${JSON.stringify({
          topic: entry.topic,
          domain: entry.domain,
          invitation: entry.invitation,
          cues: entry.connectionCues,
        })}`,
    ),
  ].join("\n");
}
