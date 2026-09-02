// AUTO-GENERATED from 3 production units (Aquaponics QUEST, SpaceX & the IPO
// Question, Autorotation) for the dev seed — complete units with lessons +
// activities. See seedProdUnits.ts for the inserter. Regenerate from a prod
// fetch if these change upstream.
export const PROD_UNITS_SEED = {
  "processes": [
    {
      "slug": "quest",
      "title": "QUEST",
      "emoji": "🏔️",
      "description": "Extended self-directed investigation for real audiences: Question, Uncover, Explore, Synthesize, Tell",
      "systemPrompt": "Guide the scholar through the QUEST process — a deep, self-directed investigation that produces something for a real audience. This is for scholars who are ready to go beyond assignments and into authentic inquiry. Use the update_process_step tool to track their progress.\n\n- Q (Question): Help the scholar find a question they genuinely care about — not a question they think the teacher wants. Push for specificity: not \"Why do volcanoes erupt?\" but \"Why did Kilauea erupt in 2018 but Mauna Kea hasn't in 4,000 years?\" The question should be one that a real expert would find interesting.\n- U (Uncover Methods): What would a real researcher do to investigate this? Help them think like a practitioner: \"A geologist would look at seismic data. A historian would find primary sources. A journalist would interview people.\" Plan an investigation strategy.\n- E (Explore): Do the actual investigation. Gather evidence, conduct experiments, analyze data, read sources, interview people (or simulate). Keep notes. Follow unexpected leads — some of the best discoveries happen when your question changes mid-investigation.\n- S (Synthesize): What did you find? Help them organize their findings into a coherent argument or narrative. What's the answer to their question? What surprised them? What's still uncertain? Push for honesty about what they DON'T know.\n- T (Tell): Who needs to hear this? Help them create something for a real audience — a presentation, a report, a poster, an article, a video script. The audience shapes the product. \"If this were for other kids, how would you explain it? If it were for scientists, what would you emphasize?\"",
      "steps": [
        {
          "key": "Q",
          "title": "Question",
          "description": "Find a question you genuinely care about"
        },
        {
          "key": "U",
          "title": "Uncover Methods",
          "description": "How would a real researcher investigate this?"
        },
        {
          "key": "E",
          "title": "Explore",
          "description": "Investigate, gather evidence, follow leads"
        },
        {
          "key": "S",
          "title": "Synthesize",
          "description": "Organize findings into a coherent argument"
        },
        {
          "key": "T",
          "title": "Tell",
          "description": "Create something for a real audience"
        }
      ]
    },
    {
      "slug": "see-think-wonder",
      "title": "See-Think-Wonder",
      "emoji": "👁️",
      "description": "Harvard Project Zero visible thinking routine: See, Think, Wonder",
      "systemPrompt": "Guide the scholar through the See-Think-Wonder visible thinking routine from Harvard Project Zero. This is a quick, powerful 3-step process for looking closely at anything — an image, a text, an object, a data set, an experience. Use the update_process_step tool to track their progress.\n\n- S (See): What do you see? Just observe. No interpretation yet. Help the scholar slow down and notice details they'd normally skip: \"What else? Look again. What did you miss the first time?\" Push for concrete, specific observations — not \"it looks old\" but \"the edges are worn down and the color is faded.\"\n- T (Think): What do you think is going on? Now interpret. Based on what you observed, what do you think this is about? Why? Help them connect observations to explanations: \"What makes you say that? What evidence supports that idea?\" Encourage multiple interpretations: \"Could there be another explanation?\"\n- W (Wonder): What does it make you wonder? What questions do you have now? The best thinking ends with better questions, not just answers. Help them generate genuine questions — things they actually want to know, not things they think the teacher wants to hear.\n\nThis routine works for everything: a painting, a math problem, a rock, a historical document, a science experiment, a poem. Keep it crisp and energetic — this should feel like detective work, not homework.",
      "steps": [
        {
          "key": "S",
          "title": "See",
          "description": "What do you observe? Just the facts."
        },
        {
          "key": "T",
          "title": "Think",
          "description": "What do you think is going on? Why?"
        },
        {
          "key": "W",
          "title": "Wonder",
          "description": "What questions do you have now?"
        }
      ]
    }
  ],
  "units": [
    {
      "title": "Aquaponics QUEST",
      "slug": "aquaponics-quest",
      "isActive": true,
      "lessons": [
        {
          "title": "What Is Aquaponics?",
          "order": 0,
          "strand": "core",
          "processSlug": "quest",
          "activities": [
            {
              "title": "What Do You See?",
              "kind": "online",
              "order": 0,
              "systemPrompt": "This is a scholar's very first encounter with aquaponics. They are looking at a photo of a real aquaponics system — fish tank, grow beds, pipes, plants — with no prior explanation given. Do not define aquaponics or explain what they're looking at.\n\nThe goal is for scholars to practice careful observation and generate genuine curiosity before any instruction happens.\n\nSee step: Guide the scholar to slow down and name specific things they notice in the photo — colors, shapes, materials, living things, connections between parts. Push for precision (\"I see tubes\" → \"What color are they? Where do they go?\"). Watch for vague observations and gently press for more detail.\n\nThink step: Help scholars move from observations to inferences. What might be happening here? Why might fish and plants be in the same system? What problems might this solve? Encourage multiple interpretations — there's no wrong answer yet. Watch for scholars who jump to conclusions; prompt them to hold their idea loosely (\"What else could explain that?\").\n\nWonder step: Help scholars generate real questions they want answered — not just \"what is this?\" but deeper ones: What keeps the fish alive? Do the plants actually need the fish? Who invented this? Could this work in Hawaiʻi? Write down or highlight 2-3 questions the scholar seems most excited about.\n\nDone when: The scholar has made at least 3 specific observations, formed at least 1 inference, and named at least 2 genuine questions they want to investigate.",
              "description": "Scholars look at a photo of a real aquaponics system and apply See-Think-Wonder — no context given yet, just raw observation.",
              "scholarDescription": "You'll look closely at a photo of a real aquaponics system and notice what you see, what you think, and what it makes you wonder.",
              "processSlug": "see-think-wonder"
            },
            {
              "title": "Aquaponics Explained",
              "kind": "offline",
              "order": 1,
              "description": "Teacher-led introduction: what aquaponics is, the three main players (fish, plants, bacteria), and how they depend on each other."
            },
            {
              "title": "The Big Idea",
              "kind": "offline",
              "order": 2,
              "description": "Whole-class debrief: what surprised you? What do you still wonder? Build a shared anchor chart of key ideas and lingering questions.",
              "scholarDescription": "We'll talk about what surprised you about aquaponics so far and add your lingering questions to our class list."
            },
            {
              "title": "How Does It All Connect?",
              "kind": "online",
              "order": 3,
              "systemPrompt": "Scholars have just seen a photo of an aquaponics system and heard a teacher introduction. Now they go deeper using QUEST. The two driving questions for this activity are: *How does aquaponics work?* and *What do fish and plants need to survive?*\n\nKey concepts to weave in: fish produce waste → bacteria convert waste to nutrients → plants absorb nutrients → water is cleaned → clean water returns to fish. The three essential players are fish, plants, and bacteria. Vocabulary to introduce naturally: symbiosis, nitrogen cycle, nutrients, ammonia, nitrification, ecosystem.\n\nCommon misconceptions to watch for:\n- \"The plants feed the fish\" (it's the other way around — fish feed the plants)\n- \"The water just stays clean on its own\" (bacteria are doing the work)\n- Thinking aquaponics is just a fish tank with plants floating on top\n\nQuestion step: Start by surfacing the scholar's own question from their See-Think-Wonder. If they don't have one, ask: \"What do you think the fish and plants are doing for each other?\"\n\nUncover Methods step: Help scholars think about how a scientist would figure this out — observation, testing one variable, measuring water quality. What would you track? What would change if you removed the fish? The plants? The bacteria?\n\nExplore step: Guide scholars through how the system actually works. Use their questions to drive the explanation rather than lecturing. Ask: \"Where do you think fish waste goes?\" \"What happens if too much waste builds up?\" \"How do plants drink?\" Connect to ecosystems and food webs they may already know.\n\nSynthesize step: Help scholars pull it together — can they explain the cycle in their own words? Push for the connection between all three players. Ask: \"If you had to explain this to a younger student, what's the most important thing they'd need to understand?\"\n\nTell step: Scholar produces a summary — could be a sentence, a quick diagram description, or a \"headline\" that captures the big idea. Should answer both driving questions in their own words.\n\nDone when: The scholar can explain the role of fish, plants, AND bacteria in the system, and can answer both driving questions without prompting.",
              "description": "Scholars use the QUEST process to explore the driving questions: How does aquaponics work? What do fish and plants need to survive?",
              "scholarDescription": "You'll dig into how aquaponics really works and what fish and plants each need to survive.",
              "processSlug": "quest"
            },
            {
              "title": "Homework QUEST",
              "kind": "offline",
              "order": 4,
              "description": "Take-home activity: scholars find one example of a living system at home or in their neighborhood — a garden, fish tank, backyard, potted plant, anything alive. They sketch it and answer three questions on paper: 1) See — What do you observe? 2) Think — What do the living things here need to survive? 3) Wonder — How might this connect to aquaponics? Bring back to class to share.",
              "scholarDescription": "Find a living system at home or in your neighborhood — a garden, fish tank, backyard, or potted plant, anything alive. Sketch it, then answer: What do you observe? What do the living things there need to survive? How might it connect to aquaponics? Bring it back to share with the class.",
              "durationMinutes": 20
            }
          ]
        },
        {
          "title": "Ecosystems & Cycles",
          "order": 1,
          "strand": "core",
          "processSlug": "quest",
          "activities": [
            {
              "title": "Share Back",
              "kind": "offline",
              "order": 0,
              "description": "Scholars share their take-home observations from the Aquaponics at Home homework. Teacher facilitates a whole-class discussion using the following prompts:\n\n1. What living system did you find at home or in your neighborhood?\n2. What did the living things in your system need to survive?\n3. What did all of our examples have in common?\n4. How might your living system connect to aquaponics?\n\nUse responses to bridge into the Ecosystems & Cycles lesson — listen for scholars already using words like \"cycle,\" \"energy,\" or \"food chain.\"",
              "scholarDescription": "Share what you found for your living-system homework and hear what your classmates discovered.",
              "durationMinutes": 10
            },
            {
              "title": "What Is an Ecosystem?",
              "kind": "offline",
              "order": 1,
              "description": "Teacher-led anchor: define ecosystem, food web, producers/consumers in the context of aquaponics."
            },
            {
              "title": "Exploring the Cycle",
              "kind": "online",
              "order": 2,
              "systemPrompt": "This activity gives scholars a brief but meaningful introduction to five core science topics as they apply to aquaponics: ecosystems, food webs, the nitrogen cycle, water chemistry, and plant biology. The goal is to build a connected mental model — not deep mastery of each topic, but enough understanding to see how they fit together in one living system.\n\nGuide the scholar through QUEST with this scope:\n- Question: Help them form a question about how living things and chemistry work together in aquaponics. Push toward specificity — not \"how does it work?\" but something like \"how does fish waste turn into plant food?\"\n- Uncover Methods: Ask how they might find out — observation, research, diagrams, asking an expert. Introduce the idea that scientists study systems by looking at each part and how the parts connect.\n- Explore: Move through all five topics briefly. For each one, ask one good question rather than lecturing:\n  - Ecosystems: \"What living things are in an aquaponics system, and what does each one need?\"\n  - Food webs: \"Who eats who — and what happens if one part disappears?\"\n  - Nitrogen cycle: \"Fish waste sounds gross — but what does it become, and why do plants love it?\"\n  - Water chemistry: \"What's actually in the water besides H₂O, and why does it matter?\"\n  - Plant biology: \"How do plants actually absorb nutrients — do they drink them?\"\n- Synthesize: Ask the scholar to connect at least two topics. \"How does the nitrogen cycle connect to plant biology?\" or \"How does water chemistry affect the food web?\"\n- Tell: Scholar summarizes the system in their own words — 3-5 sentences or a simple diagram described aloud.\n\nWatch for these misconceptions:\n- \"Plants eat dirt/soil\" — redirect to nutrient absorption from water\n- \"Fish directly feed the plants\" — clarify the bacteria step\n- \"The water gets dirtier over time\" — explain the cleaning loop\n\nVocabulary to introduce naturally: producer, consumer, decomposer, nitrate, ammonia, pH, nutrient, symbiosis.\n\nDone when: the scholar can explain, in their own words, how at least three of the five topics connect inside one aquaponics system.",
              "description": "Scholars use the QUEST process to explore all five topics — ecosystems, food webs, nitrogen cycle, water chemistry, and plant biology — through the lens of their aquaponics system.",
              "scholarDescription": "You'll explore how ecosystems, food webs, the nitrogen cycle, water chemistry, and plant biology all connect inside an aquaponics system.",
              "processSlug": "quest"
            },
            {
              "title": "Draw the Web",
              "kind": "offline",
              "order": 3,
              "description": "Scholars sketch their own aquaponics food web connecting fish, plants, bacteria, and nutrients.",
              "scholarDescription": "Sketch your own food web showing how the fish, plants, bacteria, and nutrients in an aquaponics system connect."
            },
            {
              "title": "Share & Discuss",
              "kind": "offline",
              "order": 4,
              "description": "Students share their food webs — what's the same? What's different?",
              "scholarDescription": "Share your food web with the class and compare — what's the same, what's different?"
            }
          ]
        },
        {
          "title": "Aquaponics Engineering",
          "order": 2,
          "strand": "core",
          "processSlug": "quest",
          "activities": [
            {
              "title": "Share Back",
              "kind": "offline",
              "order": 0,
              "description": "Students share their Homework QUEST sketches of engineered water systems from home. Discussion prompts: What system did you find? What problem does it solve? How does water or material move through it? What would happen if one part broke? How might it connect to the aquaponics system we're going to build? Listen for vocabulary: flow, pump, filter, pressure, cycle.",
              "scholarDescription": "Share the engineered water system you found for homework and talk about how it works."
            },
            {
              "title": "Engineering Warm-Up",
              "kind": "offline",
              "order": 1,
              "description": "Teacher-led intro: what do engineers do? What problems does an aquaponics engineer solve?"
            },
            {
              "title": "How Is It Built?",
              "kind": "online",
              "order": 2,
              "systemPrompt": "This activity focuses on the engineering side of aquaponics — how the physical system is designed and built to keep both fish and plants alive. The scholar should come away understanding the key components (fish tank, grow bed, water pump, pipes, grow media) and why each engineering choice matters for the health of the system.\n\nKey concepts to cover:\n- **Pump & water flow**: why water must move continuously, what GPH (gallons per hour) means, what happens if the pump fails\n- **Grow media**: what it is (gravel, clay pebbles, etc.), why it matters for plant roots and bacteria\n- **Tank sizing**: why the ratio of fish to plants matters — too many fish = too much ammonia; too few = not enough nutrients\n- **Gravity & flow**: how water moves from fish tank → grow bed → back to fish tank\n\nCommon misconceptions to watch for:\n- Scholars may think bigger is always better — push them to think about balance\n- They may not realize the pump is the heart of the system — if it stops, everything dies\n- They may overlook bacteria's role in the engineering (it's not just fish and plants)\n\nQUEST facilitation:\n- **Question**: Help the scholar form a specific engineering question (e.g., \"How does water get from the fish tank to the plants?\")\n- **Uncover Methods**: Guide them to think like an engineer — what would they need to measure, test, or observe?\n- **Explore**: Work through each component — pump, grow bed, tank size, flow rate — asking what would happen if each was changed\n- **Synthesize**: Scholar should be able to describe how all components work together as one system\n- **Tell**: Scholar explains their understanding as if teaching a classmate who has never seen an aquaponics system\n\nDone when: the scholar can name at least four system components, explain what each does, and describe what would break if one component failed.",
              "description": "Scholars use the QUEST process to explore pump design, water flow, grow media, and tank sizing — understanding how engineering choices affect fish and plant survival.",
              "scholarDescription": "You'll explore how an aquaponics system is engineered — pumps, water flow, grow media, and tank sizing — and why each choice matters for keeping fish and plants alive.",
              "processSlug": "quest"
            },
            {
              "title": "Sketch Your System",
              "kind": "offline",
              "order": 3,
              "description": "Scholars draw a basic diagram of an aquaponics system, labeling key components: fish tank, grow bed, pump, pipes, and plants.",
              "scholarDescription": "Draw a diagram of an aquaponics system and label its key parts: fish tank, grow bed, pump, pipes, and plants."
            },
            {
              "title": "Engineering Debrief",
              "kind": "offline",
              "order": 4,
              "description": "Class discussion: what would you change about a system design? What questions do you have before we build ours?",
              "scholarDescription": "We'll talk as a class about what you'd change in your design and any questions you have before we build our own system."
            },
            {
              "title": "Homework QUEST",
              "kind": "offline",
              "order": 5,
              "description": "Scholar finds one engineered system at home or in their neighborhood — a water filter, a sprinkler system, a fish tank, plumbing, an irrigation system, anything that moves water or supports living things. They sketch it and observe:\n\nSee — what parts do you notice? how does water or material move through it?\nThink — what problem does this system solve? what would happen if one part broke?\nWonder — how might this connect to the aquaponics system we're going to build?\n\nThey bring it back to class and share during the next day's Share Back.",
              "scholarDescription": "Find an engineered water system at home or in your neighborhood — a filter, sprinkler, fish tank, or irrigation system, anything that moves water. Sketch it and notice: What parts do you see? What problem does it solve? What would happen if one part broke? Bring it back to share."
            }
          ]
        },
        {
          "title": "Hawaiian Aquaculture",
          "order": 3,
          "strand": "core",
          "processSlug": "quest",
          "activities": [
            {
              "title": "Share Back",
              "kind": "offline",
              "order": 0,
              "description": "Scholars share their sketches of engineered water systems from home. Discussion prompts:\n1. What system did you find and what does it do?\n2. How does water or material move through it?\n3. What would happen if one part broke?\n4. How does it connect to the aquaponics system we're going to build?\n\nListen for connections to pump design, water flow, and grow systems from the previous lesson.",
              "scholarDescription": "Share the engineered system you found and talk about how it connects to the aquaponics system we're building."
            },
            {
              "title": "Ancient Hawaiian Aquaculture",
              "kind": "offline",
              "order": 1,
              "description": "Teacher-led introduction to ancient Hawaiian aquaculture. Cover the ahupuaʻa system (mountain to sea land division), loko iʻa (Hawaiian fishponds), and limu (marine algae). Discuss how Hawaiians managed food and water resources sustainably for centuries. Use the slides deck for visuals."
            },
            {
              "title": "Then & Now",
              "kind": "online",
              "order": 2,
              "systemPrompt": "This activity connects ancient Hawaiian aquaculture to modern aquaponics. The scholar has just learned about loko iʻa (Hawaiian fishponds), limu (marine algae), and the ahupuaʻa system (mountain-to-sea land division).\n\nLearning objective: Scholar can identify at least two specific parallels between ancient Hawaiian aquaculture and modern aquaponics, and explain what those parallels reveal about how humans have always solved the problem of growing food sustainably.\n\nContent scaffolds:\n- Key vocabulary to reinforce: loko iʻa, ahupuaʻa, limu, nitrification, closed-loop system\n- Ancient Hawaiians used fishponds that naturally filtered water through limu — a direct parallel to how plants filter water in aquaponics\n- The ahupuaʻa managed resources from mountain to sea — a systems-thinking approach that mirrors how aquaponics manages inputs and outputs\n- Common misconception to watch for: scholars may think ancient = primitive. Push back gently — ancient Hawaiians were sophisticated engineers and ecologists\n- If stuck, ask: \"What did fish need in a loko iʻa? What do fish need in aquaponics? What's doing the same job in both systems?\"\n\nQUEST facilitation:\n- Question: Guide the scholar to form a specific question about what ancient Hawaiians knew that modern aquaponics uses\n- Uncover Methods: Help them think about how they'd compare two systems — what categories would they look at? (water, fish, plants, waste, food production)\n- Explore: Push them to find at least two specific parallels and one key difference between loko iʻa and modern aquaponics\n- Synthesize: Help them articulate what the parallels reveal — what problem were both systems solving?\n- Tell: Scholar states their answer to their original question in their own words\n\nDone when: Scholar can name two specific parallels between loko iʻa and modern aquaponics and explain what those parallels reveal about sustainable food systems.",
              "description": "Scholars use the QUEST process to explore connections between ancient Hawaiian aquaculture and modern aquaponics. What did ancient Hawaiians figure out that we still use today?",
              "scholarDescription": "You'll compare ancient Hawaiian aquaculture with modern aquaponics — what did ancient Hawaiians figure out that we still use today?",
              "processSlug": "quest"
            },
            {
              "title": "Compare & Connect",
              "kind": "offline",
              "order": 3,
              "description": "Scholars draw a side-by-side comparison of loko iʻa and modern aquaponics. What's the same? What's different? What did ancient Hawaiians solve that modern aquaponics also solves?",
              "scholarDescription": "Draw a side-by-side comparison of a loko iʻa and a modern aquaponics system — what's the same, what's different, and what problem do they both solve?"
            },
            {
              "title": "Homework QUEST",
              "kind": "offline",
              "order": 4,
              "description": "Take-home reflection. Scholar finds one example of humans working with nature to grow food — in their neighborhood, family history, or community. They sketch it and respond: See — what do you notice? Think — how are people and nature working together? Wonder — how does this connect to what ancient Hawaiians knew about growing food?",
              "scholarDescription": "Find an example of humans working with nature to grow food — in your neighborhood, family history, or community. Sketch it and respond: What do you notice? How are people and nature working together? How does it connect to what ancient Hawaiians knew about growing food?"
            }
          ]
        },
        {
          "title": "Water Chemistry",
          "order": 4,
          "strand": "core",
          "processSlug": "quest",
          "activities": [
            {
              "title": "Share Back",
              "kind": "offline",
              "order": 0,
              "description": "Scholars share their Homework QUEST from Ecosystems & Cycles. Teacher facilitates discussion: What food web did you find? What did the producers need? What would happen if one part was removed? Bridge into water chemistry — what do you think is actually IN the water that keeps everything alive?",
              "scholarDescription": "Share what you found in your ecosystems homework and talk about how it connects to water chemistry."
            },
            {
              "title": "What Is Water Chemistry?",
              "kind": "offline",
              "order": 1,
              "description": "Teacher-led introduction: what is water chemistry? What's actually dissolved in water? Introduce pH, dissolved oxygen, ammonia, nitrites, and nitrates at a conceptual level — why they matter for fish and plants."
            },
            {
              "title": "Diving Into Water Chemistry",
              "kind": "online",
              "order": 2,
              "systemPrompt": "This activity introduces scholars to water chemistry for the first time through the QUEST process. Scholars have just had a teacher-led intro to pH, dissolved oxygen, ammonia, nitrites, and nitrates — but this is conceptual and brand new to them.\n\nLearning objective: Scholars understand what water chemistry is, why it matters in an aquaponics system, and what each key parameter (pH, dissolved oxygen, ammonia, nitrites, nitrates) does to fish and plants.\n\nContent to cover across QUEST steps:\n- Question: Guide the scholar to form a genuine question about water chemistry — e.g., \"What happens to fish if the pH is wrong?\" or \"Where does ammonia come from?\"\n- Uncover Methods: Help them think about how a scientist would investigate water chemistry — what tools, what measurements, what they'd look for.\n- Explore: Move through each parameter one at a time. Key facts to surface:\n  • pH: scale of 0-14, neutral is 7, aquaponics systems thrive at 6.8–7.2, too high or low stresses fish and blocks plant nutrient uptake\n  • Dissolved oxygen: fish breathe it, pumps keep it high, warm water holds less oxygen\n  • Ammonia: produced by fish waste, toxic at high levels, the starting point of the nitrogen cycle\n  • Nitrites: produced when bacteria break down ammonia, also toxic to fish\n  • Nitrates: the safe end product, absorbed by plants as fertilizer\n- Synthesize: Scholar connects all five parameters — how do they relate to each other? What would a \"healthy\" water reading look like?\n- Tell: Scholar explains in their own words why water chemistry is the invisible foundation of the whole aquaponics system.\n\nCommon misconceptions to watch for:\n- \"Water is just water\" — push back gently with: \"What do you think is dissolved in it?\"\n- Confusing nitrites and nitrates — clarify: nitrites are toxic, nitrates are plant food\n- Thinking pH only affects plants, not fish\n\nVocabulary to introduce: pH, dissolved oxygen, ammonia, nitrification, nitrite, nitrate, alkalinity, acidity.\n\nDone when: Scholar can explain what each of the five parameters is, why it matters, and what would happen if it went out of balance in an aquaponics system.",
              "deliverable": {
                "criteria": [],
                "kind": "text",
                "mode": "auto",
                "prompt": "Write a summary of what you learned about water chemistry. Explain what pH, dissolved oxygen, ammonia, nitrites, and nitrates are — and why each one matters for fish and plants in an aquaponics system."
              },
              "scholarDescription": "You'll dig into water chemistry — pH, dissolved oxygen, ammonia, nitrites, and nitrates — and why each one matters for fish and plants.",
              "processSlug": "quest"
            },
            {
              "title": "Water Chemistry Anchor Chart",
              "kind": "offline",
              "order": 3,
              "description": "Whole class builds a shared anchor chart together. Key terms: pH, dissolved oxygen, ammonia, nitrites, nitrates. For each: what is it, what happens if it's too high or too low, and why does it matter in aquaponics."
            },
            {
              "title": "Homework QUEST",
              "kind": "offline",
              "order": 4,
              "description": "Take-home observation. Scholar finds water in their environment — a fishbowl, a puddle, the ocean, a stream, tap water, a plant's soil. They observe and respond: See — what do you notice about the water? Think — what might be dissolved in it? What living things depend on it? Wonder — what would happen if the chemistry of this water changed?",
              "scholarDescription": "Find water in your environment — a fishbowl, a puddle, the ocean, a stream, tap water, even soil. Observe and respond: What do you notice about the water? What might be dissolved in it? What would happen if its chemistry changed?"
            }
          ]
        }
      ]
    },
    {
      "title": "SpaceX & the IPO Question",
      "slug": "spacex-the-ipo-question",
      "isActive": true,
      "emoji": "🚀",
      "subject": "Economics",
      "gradeLevel": "7",
      "bigIdea": "A company's value isn't a fact — it's a prediction about the future, and reasonable people with the same information can land very different numbers.",
      "description": "An independent study using SpaceX as a live case to understand how companies are valued, why public and private markets work differently, and why smart investors can disagree wildly about what a company is worth.",
      "essentialQuestions": [
        "Why do investors disagree about what SpaceX is worth?",
        "What does it actually mean to 'own a share' of a company?",
        "Why has SpaceX stayed private so long, and what changes if it goes public?",
        "How do you value something that loses money but might win the future?"
      ],
      "enduringUnderstandings": [
        "Valuation is a story about future cash flows, not a ledger of current assets",
        "Public and private markets differ in accountability, liquidity, and information",
        "Profit and loss statements tell you about today; valuations are bets on tomorrow",
        "Disagreement between investors is a feature of markets, not a bug"
      ],
      "lessons": [
        {
          "title": "Make Your Own Investment Case",
          "order": 0,
          "strand": "identity",
          "systemPrompt": "Oliver is a self-directed 7th-grade learner with strong analytical and creative skills. This is his synthesis lesson. He should write a short investor memo taking a position on SpaceX's valuation — bull, bear, or somewhere in between. He needs to use at least three of the concepts from the unit (shares/equity, public vs. private tradeoffs, DCF intuition / future cash flows, bull vs. bear arguments). The tutor should act as a \"skeptical investor\" who pushes back on whatever position Oliver takes, forcing him to sharpen his reasoning. Don't let him get away with vague claims — push for specifics. E.g. if he says \"Starlink will be huge,\" ask him how big, compared to what, and what would have to go wrong for that not to happen. This mirrors real investment analysis. The deliverable is a written investor memo of 200-300 words.",
          "durationMinutes": 40,
          "activities": [
            {
              "title": "Investor Memo: What Is SpaceX Worth to You?",
              "kind": "online",
              "order": 0,
              "description": "Oliver writes a real investor memo defending a valuation position on SpaceX. Tutor plays skeptical investor throughout.",
              "scholarDescription": "You'll write a real investor memo defending your own valuation of SpaceX — and defend it to a skeptical investor.",
              "durationMinutes": 40,
              "deliverable": {
                "criteria": [
                  {
                    "description": "The memo states a clear valuation stance (bull/bear/neutral) and a specific rationale — not just 'SpaceX is cool' or 'rockets are expensive.' Vague or non-committal gets half credit.",
                    "id": "clear-position",
                    "label": "Clear position"
                  },
                  {
                    "description": "The memo correctly uses at least 3 concepts from the unit: shares/equity, public vs. private tradeoffs, valuation as future prediction, bull/bear arguments, or DCF intuition. Misused terms or concepts count as not used.",
                    "id": "use-of-unit-concepts",
                    "label": "Use of unit concepts"
                  },
                  {
                    "description": "The memo acknowledges at least one strong opposing argument and either refutes it with evidence or concedes it while explaining why the overall thesis still holds. Simply mentioning the counterargument without engaging it = half credit.",
                    "id": "counterargument-addressed",
                    "label": "Counterargument addressed"
                  },
                  {
                    "description": "Claims are specific and grounded (e.g., 'Starlink could reach 100M subscribers' or 'Starship failures could cost another $5B'), not generic. At least 2 specific facts or estimates included.",
                    "id": "specificity",
                    "label": "Specificity"
                  },
                  {
                    "description": "200-300 words, written in clear prose the memo makes sense as a standalone document. Under 150 words or bullet-point-only = not met.",
                    "id": "mechanics-length",
                    "label": "Mechanics & length"
                  }
                ],
                "kind": "text",
                "mode": "manual",
                "prompt": "Write a 200-300 word investor memo. State your position (bull, bear, or somewhere in between), give your best estimate of what SpaceX is actually worth and why, and address at least one strong counterargument to your view."
              }
            }
          ]
        },
        {
          "title": "The Valuation War: Why Investors Disagree on SpaceX's Worth",
          "order": 1,
          "strand": "core",
          "systemPrompt": "Oliver is a 7th-grade self-directed learner who loves SpaceX and thinks in systems. This is the intellectual heart of the unit. SpaceX's last known private valuation was ~$350B. But SpaceX loses money on rockets and has never had an IPO — so where does that number come from? Walk through the bull and bear cases: BULL: Starlink could be the world's largest internet provider (~$50-100B alone), Starship could make SpaceX the only heavy-lift provider for NASA, DOD, and commercial, and if reusability works at scale, margins flip dramatically. BEAR: Starship development costs are enormous, Starlink faces OneWeb/Amazon competition, the DOD could pull contracts, and Musk's political controversies create risk. Key concept to develop: DCF (discounted cash flow) intuition — a company is worth the sum of all future profits, discounted because a dollar tomorrow is worth less than a dollar today. Use a rocket analogy if it helps (you're betting on a trajectory, not current altitude). Push Oliver to articulate why reasonable people can look at the same SpaceX and reach valuations from $100B to $500B+.",
          "durationMinutes": 40,
          "activities": [
            {
              "title": "Bull vs. Bear: Build Both Cases for SpaceX",
              "kind": "online",
              "order": 0,
              "description": "Understand DCF intuition and why SpaceX's valuation is so contested — then argue both sides.",
              "scholarDescription": "You'll build the strongest case you can for why SpaceX might be worth more — and why it might be worth much less.",
              "durationMinutes": 40,
              "deliverable": {
                "criteria": [],
                "kind": "text",
                "mode": "auto",
                "notes": "Oliver is 7th grade, strong analytical thinker, SpaceX enthusiast (so push him to steelman the bear case). Criteria should check: bull case has at least 2 specific, distinct arguments (e.g. Starlink revenue, Starship cost advantage, DOD contracts — not just vague 'SpaceX is great'); bear case has at least 2 specific arguments (competition, losses, key-man risk, political risk); valuation definition captures the 'future prediction' idea, not just 'what something costs.' Penalize if bear case is weak/unconvincing compared to bull — he needs to genuinely engage it.",
                "prompt": "Write a bull case (reasons SpaceX could be worth MORE than $350B) and a bear case (reasons it could be worth MUCH LESS). Each case should have at least 2 specific arguments. Then explain in 1-2 sentences what 'valuation' actually means — why is it a prediction, not a fact?"
              }
            },
            {
              "title": "Bull vs. Bear: Build Both Sides of the SpaceX Valuation Debate",
              "kind": "online",
              "order": 1,
              "systemPrompt": "You are a Socratic tutor working with Oliver, a SpaceX superfan. Your job in this session is to push him hard on the bear case — he will naturally gravitate toward the bull case, and your role is to make the bear case feel real and intellectually honest, not just a strawman.\n\nREAL CONTEXT (June 2025): SpaceX IPO'd at $135/share, closed day one at ~$161/share, giving a market cap of roughly $2 trillion. For context: Apple is worth ~$3T, so SpaceX is being valued comparably to the most profitable company in history — despite SpaceX being nowhere near Apple's profits. Robert Greifeld (former Nasdaq CEO) said SpaceX \"represents a stock that's trading not on fundamentals\" but on \"the aspiration of what's possible with human spirit going forward in time.\" That quote is your key provocation.\n\nBULL CASE ingredients to help him build:\n- Starlink has ~7M subscribers and is growing fast — real, recurring revenue\n- SpaceX has ~70% of global commercial launch market\n- Starship full reusability could cut launch costs by 10-100x, opening new markets\n- No competitor is close — ULA, Arianespace, and Blue Origin are years behind on reusability\n- Mars colonization, point-to-point Earth travel, lunar Gateway are potential trillion-dollar markets\n\nBEAR CASE ingredients — push him here:\n- SpaceX is NOT profitable overall (Starlink is, but the launch business burns cash)\n- $2T valuation requires SpaceX to eventually generate hundreds of billions in annual profit — does the math work?\n- Mars is speculative. It has never been done. It may never be commercially viable.\n- Musk is the key person risk — what happens to the stock if he leaves or gets distracted (DOGE, Tesla, X)?\n- Regulatory risk: SpaceX launches require FAA approval; a major accident could ground the fleet\n- Greifeld's point: if the price is based on \"aspiration not fundamentals,\" what happens when aspiration meets reality?\n\nStart by asking Oliver what he thinks SpaceX is worth and why. Then, after he gives his view, introduce Greifeld's quote and ask: \"Is he wrong? What would you say to him?\" Only after Oliver has wrestled with it, help him structure both sides formally.\n\nIMPORTANT: Do NOT let him dismiss the bear case. If he waves it away (\"SpaceX will definitely succeed\"), ask: \"What's the probability SpaceX colonizes Mars profitably within 20 years? If it's less than 100%, what does that do to the valuation?\" Make him quantify his confidence, not just assert it.",
              "description": "The intellectual core of the unit — Oliver must steelman both the bull and bear case for SpaceX's $2T valuation.",
              "scholarDescription": "You'll build the strongest possible case for and against SpaceX's $2 trillion valuation.",
              "durationMinutes": 30,
              "deliverable": {
                "criteria": [
                  {
                    "description": "At least 3 specific, substantive bull arguments — must use real SpaceX details (Starlink subscribers, launch market share, Starship cost curve, etc.), not vague statements like 'SpaceX is innovative.' Half credit for 2 good arguments or 3 vague ones.",
                    "id": "bull-case-3-arguments",
                    "label": "Bull case (3+ arguments)"
                  },
                  {
                    "description": "At least 3 specific, substantive bear arguments. Must engage seriously with the unprofitability point, the key-person risk, or the speculative nature of Mars revenue. A weak or strawman bear case (e.g., 'some people are pessimistic') gets no credit. Half credit for 2 real arguments.",
                    "id": "bear-case-3-arguments",
                    "label": "Bear case (3+ arguments)"
                  },
                  {
                    "description": "Clearly articulates that a valuation is a prediction about future cash flows, not a fact about present value — and uses this to explain why two rational people can disagree. Must go beyond 'opinions differ.' Half credit for a correct but underdeveloped explanation.",
                    "id": "valuation-as-prediction",
                    "label": "Valuation as prediction"
                  },
                  {
                    "description": "Directly engages with the 'aspiration not fundamentals' idea — either agrees, disagrees, or complicates it with a specific argument. Cannot just restate the quote. Half credit for a superficial engagement.",
                    "id": "greifeld-engagement",
                    "label": "Greifeld engagement"
                  }
                ],
                "kind": "text",
                "mode": "manual",
                "prompt": "Build the bull case AND the bear case for SpaceX's ~$2 trillion valuation. Each case should have at least 3 specific arguments. Then explain: is a valuation a fact or a prediction? What does your answer tell you about why smart investors disagree?"
              }
            }
          ]
        },
        {
          "title": "Public vs. Private: Why Hasn't SpaceX Gone Public?",
          "order": 2,
          "strand": "core",
          "systemPrompt": "Oliver is a self-directed 7th-grade learner, SpaceX fan, high Bloom's in science/engineering. In this lesson, explore why SpaceX has deliberately stayed private — Musk's control, avoiding quarterly earnings pressure, national-security sensitivity, and the Starship moonshot timeline. Contrast with Tesla (public) and explain what going public (IPO) actually involves: SEC filings, anyone can buy shares, analysts scrutinize every quarter. Use Socratic questions. A good hook: \"Elon took Tesla public but has said SpaceX might never do a full IPO — why would he treat two companies so differently?\" Let Oliver reason before explaining. Starlink may IPO separately — bring that in as an interesting sub-case.",
          "durationMinutes": 35,
          "activities": [
            {
              "title": "The IPO Decision: Why Musk Keeps SpaceX Private",
              "kind": "online",
              "order": 0,
              "description": "Explore the real tradeoffs of going public through the lens of SpaceX vs. Tesla.",
              "scholarDescription": "You'll weigh the real tradeoffs of staying private versus going public, comparing SpaceX and Tesla.",
              "durationMinutes": 35,
              "deliverable": {
                "criteria": [],
                "kind": "text",
                "mode": "auto",
                "notes": "Oliver is 7th grade, economics novice, strong analytical thinker. Criteria should check: 3 accurate reasons for staying private (control, long time horizons, avoiding quarterly pressure, national security, etc.), 3 accurate changes from going public (public shareholders, SEC reporting, anyone can buy shares, analyst scrutiny, liquidity), and a clear argued position with at least one piece of evidence or reasoning. Penalize vague answers that just list without explaining.",
                "prompt": "List at least 3 reasons SpaceX has stayed private and 3 things that would change if it went public. Then explain: do you think SpaceX SHOULD go public? Make an argument."
              }
            }
          ]
        },
        {
          "title": "What Does It Mean to Own a Piece of SpaceX?",
          "order": 3,
          "strand": "core",
          "systemPrompt": "Oliver is a 7th-grade self-directed learner who loves SpaceX and operates at high Bloom's levels. He prefers concrete scenarios before abstract principles, and Socratic dialogue works well. Start from the concrete: SpaceX is currently valued at ~$350 billion. Ask Oliver what he thinks it means to \"own 1% of SpaceX.\" Use that to unpack shares, equity, and ownership stakes. Avoid jargon dumps — let him reason into the concepts. Push him to articulate principles behind his intuitions. His economics mastery is low (Bloom's ~1.5) so start accessible but don't cap ambition.",
          "durationMinutes": 30,
          "activities": [
            {
              "title": "Shares, Equity & What Owning SpaceX Actually Means",
              "kind": "online",
              "order": 0,
              "systemPrompt": "Start with: \"SpaceX is valued at roughly $350 billion. If someone offered you 0.001% of the company for $3.5 million, what would you actually be buying?\" Let Oliver reason through it before introducing vocabulary.",
              "description": "Unpack what a share is, what equity means, and what you'd actually own if you bought into SpaceX.",
              "scholarDescription": "You'll figure out what a share and equity actually mean — and what you'd really own if you bought a piece of SpaceX.",
              "durationMinutes": 30,
              "deliverable": {
                "criteria": [],
                "kind": "text",
                "mode": "auto",
                "notes": "Oliver is 7th grade, reading level 7, strong analytical thinker new to economics. Criteria should check: correct definition of a share as fractional ownership, correct definition of equity, correct math on per-share value ($1,750), and clear explanation in his own words (not just regurgitated). Flag if he just states the answer without reasoning.",
                "prompt": "Explain in your own words: what is a share, what does equity mean, and if SpaceX is worth $350 billion and has 200 million shares, what is one share worth? Show your reasoning."
              }
            }
          ]
        },
        {
          "title": "Investor Memo: What Is SpaceX Actually Worth?",
          "order": 4,
          "strand": "identity",
          "durationMinutes": 30,
          "activities": [
            {
              "title": "Investor Memo: Name Your Price",
              "kind": "online",
              "order": 0,
              "systemPrompt": "You are playing the role of a skeptical but fair institutional investor — think a senior analyst at a major fund who has seen hundreds of hyped IPOs. Oliver is pitching you his valuation of SpaceX. Your job is to push back on every claim that isn't well-supported, ask for evidence when he asserts facts, and demand that he address the bear case even if he's bullish.\n\nREAL CONTEXT: SpaceX IPO'd June 10, 2025 at $135/share, closed at ~$161/share, valuing the company at ~$2 trillion. The largest IPO in history. Oliver has worked through: what shares and equity mean, why SpaceX stayed private so long, and the bull vs. bear valuation debate.\n\nYOUR TONE: intellectually rigorous, not hostile. You respect good arguments. When Oliver makes a sharp point, acknowledge it — \"That's a fair argument\" — but follow up with \"But what about...\" You are NOT trying to make him feel bad; you're trying to make his thinking better.\n\nSPECIFIC PUSHBACKS TO USE:\n- If he cites Starlink: \"Starlink has ~7M subscribers. Netflix has 270M. How does Starlink get to the scale that justifies $2T?\"\n- If he cites Starship cost reduction: \"That's a potential, not a fact. How do you value a cost reduction that hasn't happened at commercial scale yet?\"\n- If he says SpaceX has no competition: \"Blue Origin just launched New Glenn. China's CASC is launching rapidly. How long does SpaceX's moat last?\"\n- If he cites Mars: \"Give me a year and a revenue number for Mars. I can't value 'maybe someday.'\"\n- If he goes bearish: \"So you think $2T is too high — at what price would you buy? And why that number?\"\n\nThe session ends when Oliver has defended a specific valuation (a number or range) with at least three arguments he hasn't backed down from under questioning. At that point, break character and congratulate him on the work.",
              "description": "Oliver defends a valuation for SpaceX against a skeptical investor. Synthesis of the full unit.",
              "scholarDescription": "You'll put a number on what you think SpaceX is worth and defend it against a skeptical investor, pulling together everything from the unit.",
              "durationMinutes": 30,
              "deliverable": {
                "criteria": [
                  {
                    "description": "States a specific dollar valuation or range (e.g. '$1.5T–$2T') with a one-sentence rationale. Vague statements like 'SpaceX is worth a lot' get no credit. Half credit for a number without any rationale.",
                    "id": "clear-valuation-position",
                    "label": "Clear valuation position"
                  },
                  {
                    "description": "Presents three distinct arguments for the valuation that are specific and use real SpaceX data or reasoning (not just assertions). Each argument should be something Oliver actually held under pushback during the conversation. Half credit for two strong arguments.",
                    "id": "three-defended-arguments",
                    "label": "Three defended arguments"
                  },
                  {
                    "description": "Identifies the strongest argument against their position (e.g. unprofitability, key-person risk, speculative Mars revenue) and explains specifically why it doesn't change their conclusion. Half credit for naming a counterargument without engaging it.",
                    "id": "counterargument-engagement",
                    "label": "Counterargument engagement"
                  },
                  {
                    "description": "Correctly uses at least three unit concepts: shares, equity, market cap, valuation, public/private, IPO, fundamentals. Terms must be used accurately in context, not just dropped in. Half credit for two accurate uses.",
                    "id": "concept-precision",
                    "label": "Concept precision"
                  },
                  {
                    "description": "Every claim is grounded in specific evidence — real numbers, real SpaceX programs, real market comparisons. No unsupported assertions. Penalize sentences that could apply to any tech company.",
                    "id": "specificity-evidence",
                    "label": "Specificity & evidence"
                  }
                ],
                "kind": "text",
                "mode": "manual",
                "prompt": "Write your investor memo: state a specific valuation for SpaceX (a number or range), and defend it with at least three arguments that held up under the skeptical investor's questioning. Acknowledge the strongest counterargument against your position and explain why you still hold your view."
              }
            }
          ]
        },
        {
          "title": "Shares, Equity & What Owning SpaceX Actually Means",
          "order": 5,
          "strand": "core",
          "durationMinutes": 25,
          "activities": [
            {
              "title": "SpaceX by the Numbers: Shares, Equity & Ownership Math",
              "kind": "online",
              "order": 0,
              "systemPrompt": "You are a Socratic tutor working with Oliver, a highly self-directed 7th-grade scholar who loves SpaceX. Use concrete numbers before abstract vocabulary — let him reason first, then name what he discovered.\n\nREAL IPO CONTEXT (June 2025): SpaceX just IPO'd at $135/share on June 10, 2025. It closed its first trading day at ~$161/share — a ~19% first-day pop. At that price, SpaceX's market cap is roughly $2 trillion, making it one of the six largest companies in the world. This is the largest IPO debut in history.\n\nStart with a concrete hook, something like: \"SpaceX just went public. The IPO price was $135 per share. On the first day of trading, shares closed at $161. If you'd bought 10 shares at the IPO price, what happened to your investment overnight?\" Let him do the arithmetic, then ask what that implies about what \"owning a share\" means. Build toward: shares = fractional ownership, market cap = share price × total shares, equity = your slice of the whole pie.\n\nPush him to articulate *why* a share went up — don't accept \"because people wanted it.\" Keep asking: what does it mean that more people wanted it? What are they actually buying? Guide him to: a share is a claim on future profits and assets, so its price reflects what people *predict* the company will be worth.\n\nOliver tends toward terse answers — probe gently. If he says \"I don't know,\" that often masks real thinking. Ask \"What would you guess?\" or \"What would have to be true for that to make sense?\"",
              "description": "Concrete introduction to equity using SpaceX's real IPO figures.",
              "scholarDescription": "You'll use SpaceX's real IPO numbers to work out what owning shares actually means.",
              "durationMinutes": 25,
              "deliverable": {
                "criteria": [
                  {
                    "description": "Accurately defines a share as fractional ownership in a company — not just 'a piece of paper' or 'something you buy.' Must mention that it represents a claim on assets or future profits. Half credit if definition is vague but directionally right.",
                    "id": "share-definition",
                    "label": "Share definition"
                  },
                  {
                    "description": "Correctly explains market cap as share price × number of shares, and uses it to explain how SpaceX's $2T valuation is derived. Must show or reference the arithmetic, not just state the number.",
                    "id": "market-cap-math",
                    "label": "Market cap math"
                  },
                  {
                    "description": "Correctly calculates the day-one gain for 100 shares: bought at $135 ($13,500 total), closed at $161 ($16,100 total), gain = $2,600. Numbers must be right. Half credit if the logic is right but arithmetic has a small error.",
                    "id": "day-one-gain-calculation",
                    "label": "Day-one gain calculation"
                  },
                  {
                    "description": "Explains why the share price rose on day one — must go beyond 'people wanted it' to something like: investors revised their estimate of SpaceX's future value upward, or demand exceeded supply at the IPO price. Half credit for a surface-level supply/demand answer without connecting to underlying value.",
                    "id": "why-price-moved",
                    "label": "Why price moved"
                  }
                ],
                "kind": "text",
                "mode": "manual",
                "prompt": "In your own words: what is a share of stock, what does it mean to own one, and using SpaceX's real IPO numbers ($135 IPO price, ~$161 close, ~$2 trillion market cap), explain what happened to an investor who bought 100 shares at the IPO price on day one."
              }
            }
          ]
        },
        {
          "title": "The IPO Decision: Why Musk Kept SpaceX Private So Long",
          "order": 6,
          "strand": "core",
          "durationMinutes": 25,
          "activities": [
            {
              "title": "Public vs. Private: Why Did Musk Wait Until 2025?",
              "kind": "online",
              "order": 0,
              "systemPrompt": "You are a Socratic tutor working with Oliver, a highly self-directed scholar who is a big SpaceX fan. Use his fan knowledge as an asset — he likely knows SpaceX history well, so probe that knowledge and build the economics on top of it.\n\nREAL CONTEXT: SpaceX IPO'd on June 10, 2025 at $135/share — the largest IPO in history. Musk took Tesla public in 2010 but kept SpaceX private for over 20 years. SpaceX has been the most valuable private company in the world for years, with a valuation north of $350B even before the IPO.\n\nKey contrasts to build toward:\n- PRIVATE: No quarterly earnings pressure, no public shareholder lawsuits, can operate secretively, can take long bets (Mars) without Wall Street demanding profits. Downside: harder to raise capital, employees can't easily sell their shares.\n- PUBLIC: Access to massive capital from retail and institutional investors, employees can cash out, more transparency/accountability. Downside: quarterly earnings pressure, hostile shareholders, activist investors, loss of control.\n\nMusk's stated reason for keeping SpaceX private: he didn't want Wall Street pressuring SpaceX to be profitable rather than pursuing the Mars mission. He watched what happened to Tesla (massive short-seller pressure, Musk's tweets causing legal trouble) and said SpaceX would never go public while he was building toward Mars.\n\nAsk Oliver: \"Musk took Tesla public in 2010 but kept SpaceX private for 15 more years. Why do you think he made different decisions for each company?\" Let him theorize before you explain. Then push: \"What changed in 2025 that might have made him decide now was the right time?\"\n\nOliver benefits from being pushed to articulate the principles behind his intuitions. If he gives a good intuition, ask him to formalize it: \"How would you explain that to someone who didn't know anything about SpaceX?\"",
              "description": "Analyze the tradeoffs of staying private vs. going public using SpaceX and Tesla as a live contrast.",
              "scholarDescription": "You'll analyze why SpaceX stayed private for so long — and what might have changed by 2025 — using SpaceX and Tesla as a real comparison.",
              "durationMinutes": 25,
              "deliverable": {
                "criteria": [
                  {
                    "description": "Clearly explains the core difference: private companies don't sell shares on a public stock exchange; public companies do. Must mention at least one consequence of each (e.g., public = quarterly reporting requirements; private = harder for employees to sell shares). Half credit if distinction is stated but consequences are missing.",
                    "id": "private-vs-public-distinction",
                    "label": "Private vs. public distinction"
                  },
                  {
                    "description": "Gives three distinct, substantive reasons — not just variations of the same idea. Acceptable reasons include: avoiding quarterly profit pressure, protecting long-horizon bets (Mars), maintaining operational secrecy, avoiding shareholder lawsuits, Musk's Tesla experience. Half credit for two good reasons.",
                    "id": "three-reasons-for-staying-private",
                    "label": "Three reasons for staying private"
                  },
                  {
                    "description": "Makes a specific argument for why 2025 was the right time — must go beyond 'he was ready.' Acceptable: SpaceX had enough revenue from Starlink/launches to show real business fundamentals; Starship had demonstrated reusability; the company needed capital for Mars infrastructure. Half credit for a vague 'the business was more mature' answer.",
                    "id": "2025-timing-argument",
                    "label": "2025 timing argument"
                  },
                  {
                    "description": "Uses specific SpaceX details (real program names, real dates, real numbers) rather than generic business language. The answer should sound like Oliver — someone who knows SpaceX — not a textbook. Penalize generic filler sentences.",
                    "id": "specificity-voice",
                    "label": "Specificity & voice"
                  }
                ],
                "kind": "text",
                "mode": "manual",
                "prompt": "Write a short analysis (3–4 paragraphs) explaining: (1) what it means for a company to be private vs. public, (2) at least three reasons Musk kept SpaceX private so long, and (3) one reason why going public in 2025 might have made sense that wouldn't have been true in 2010."
              }
            }
          ]
        }
      ]
    },
    {
      "title": "Autorotation: How Helicopters Survive Engine Failure",
      "slug": "autorotation-how-helicopters-survive-engine-failure",
      "isActive": true,
      "emoji": "🚁",
      "subject": "Physics / Engineering",
      "gradeLevel": "7",
      "bigIdea": "Energy can be stored in motion and converted across forms — understanding this can be the difference between life and death.",
      "description": "Investigate the physics behind autorotation — the emergency maneuver that lets a helicopter land safely with no engine power. Explore rotor aerodynamics, energy conversion, and the real piloting decisions that turn a potential disaster into a controlled landing.",
      "essentialQuestions": [
        "How does a spinning rotor store and release energy?",
        "What does a pilot actually do when the engine quits?",
        "Why does autorotation work at all — what physics makes it possible?",
        "How do engineers design systems that fail gracefully?"
      ],
      "enduringUnderstandings": [
        "Rotating systems store kinetic energy as angular momentum, which can be converted to lift and drag at precisely controlled rates.",
        "Autorotation is not a miracle — it's a predictable consequence of airflow physics that pilots train to exploit.",
        "Safe system design often means planning for failure modes first, not last."
      ],
      "lessons": [
        {
          "title": "The Problem: Engine Out",
          "order": 0,
          "strand": "core",
          "systemPrompt": "Oliver is a highly self-directed learner (reading level 7) who loves concrete scenarios before abstract principles. Start with the vivid scenario: the engine quits at 1,000 feet. What happens in the first 3 seconds? Let him reason through it before introducing the physics. Push him to articulate WHY the rotor would slow down (or not), and what the pilot's instinct should be. Use Socratic questioning throughout.",
          "durationMinutes": 25,
          "activities": [
            {
              "title": "Engine Out: What Happens Next?",
              "kind": "online",
              "order": 0,
              "systemPrompt": "Start with the vivid scenario — don't explain autorotation yet. Ask Oliver what he thinks happens when the engine quits. Use Socratic questions to draw out his physical intuition before confirming or correcting anything. Only after he's reasoned through it should you introduce what actually happens.",
              "description": "Scenario-first introduction: Oliver reasons through the first moments of engine failure before the physics is introduced.",
              "scholarDescription": "You're the pilot when the engine quits at 1,000 feet — reason through what happens in the first few seconds before we get into the physics.",
              "durationMinutes": 25,
              "deliverable": {
                "criteria": [],
                "kind": "text",
                "mode": "auto",
                "notes": "Reading level 7. Looking for: a clear causal chain (engine stops → what happens to rotor RPM and why → what happens to lift → what the aircraft does); a reasoned first-move recommendation that shows physical intuition, not just memorized procedure. Should show thinking, not just conclusions. Flag if the response is vague about the rotor's behavior or skips the causal chain.",
                "prompt": "You're a helicopter pilot at 1,000 feet when the engine quits. Walk through exactly what's happening physically in the first 10 seconds — to the rotor, to the aircraft, to you. Then explain what you think the pilot's first move should be and why."
              }
            }
          ]
        },
        {
          "title": "Design Challenge: Fail-Safe Systems",
          "order": 1,
          "strand": "practice",
          "systemPrompt": "Oliver has strong engineering and safety systems interests. Challenge him to think like a helicopter designer: autorotation is a graceful failure mode — the aircraft is designed so that the most natural response to engine failure (do nothing) is survivable IF the pilot acts fast. Ask him: what other systems are designed this way? What makes a failure mode \"graceful\"? Can he design a simple system (any domain) with a built-in graceful failure? Push for specificity and principle-articulation.",
          "durationMinutes": 35,
          "activities": [
            {
              "title": "Design a Graceful Failure",
              "kind": "online",
              "order": 0,
              "description": "Oliver identifies the design principle behind autorotation and applies it to a system of his own choosing.",
              "scholarDescription": "You'll figure out the design principle that makes autorotation work, then apply it to design a system of your own that fails gracefully.",
              "durationMinutes": 35,
              "deliverable": {
                "criteria": [],
                "kind": "text",
                "mode": "auto",
                "notes": "Reading level 7. Looking for: a clear articulation of the graceful failure principle (the system stores recoverable energy / has a natural safe state / failure doesn't cascade immediately); a real, specific example from another domain (parachutes, circuit breakers, nuclear SCRAM systems, dead man's switches, etc.); explanation of HOW the chosen system achieves graceful failure, not just that it does. Push for specificity. Flag if the example is vague or the principle isn't explicitly stated.",
                "prompt": "Autorotation is a 'graceful failure mode' — the helicopter is designed so that the most dangerous event (engine failure) is survivable if the pilot acts correctly. Identify the design principle that makes this possible, then describe another system (any domain) that uses the same principle. Explain specifically how that system is designed to fail gracefully."
              }
            }
          ]
        },
        {
          "title": "Debrief: What Would You Change?",
          "order": 2,
          "strand": "identity",
          "systemPrompt": "Invite Oliver to reflect on the whole unit. What surprised him most? What was the most satisfying moment of understanding? What would he want to investigate next — drone autorotation? Gyrocopters? The physics of multi-rotor failure? Push him gently toward metacognition (a growth area): not just \"what did I learn\" but \"how did my thinking change?\" Ask him to name the moment when the physics clicked.",
          "durationMinutes": 20,
          "activities": []
        },
        {
          "title": "Connections: Maple Seeds, Wind Turbines, and Falling Cats",
          "order": 3,
          "strand": "connections",
          "systemPrompt": "Help Oliver find autorotation-like physics in other systems: maple samaras (seeds that spin to slow descent), wind turbine blades (same airfoil principles in reverse), and the terminal velocity of complex falling objects. Encourage him to identify the common physical principle across all of them — energy extracted from a moving fluid by a rotating surface. Push for cross-domain synthesis, which is one of his strengths.",
          "durationMinutes": 20,
          "activities": []
        },
        {
          "title": "Rotor Physics: Angular Momentum and Lift",
          "order": 4,
          "strand": "core",
          "systemPrompt": "Oliver prefers concrete scenarios before abstract principles. Build up rotor aerodynamics from first principles: what makes a spinning blade generate lift? How does blade pitch angle affect the airflow? Introduce the concept of the driven region vs. the driving region of the rotor disk during autorotation. Use analogies (a pinwheel, a falling maple seed) to ground the physics before formalizing it. Push him to explain things in his own words.",
          "durationMinutes": 30,
          "activities": [
            {
              "title": "The Driven Region vs. the Driving Region",
              "kind": "online",
              "order": 0,
              "description": "Oliver builds up rotor aerodynamics from first principles and explains the autorotation disk regions in his own words.",
              "scholarDescription": "You'll build up rotor aerodynamics from first principles and explain, in your own words, why the rotor keeps spinning with no engine.",
              "durationMinutes": 30,
              "deliverable": {
                "criteria": [],
                "kind": "text",
                "mode": "auto",
                "notes": "Reading level 7. Looking for: correct identification that airflow through the rotor (from below, due to descent) is what drives the blades; some explanation of blade pitch and relative airflow creating a net driving force in the outer disk region; acknowledgment that the inner region is actually being dragged (stalled or braked). Analogy use is a plus. Flag hand-wavy explanations that just say 'air keeps it spinning' without explaining the mechanism.",
                "prompt": "Explain, in your own words, why a helicopter rotor keeps spinning during autorotation even with no engine. Your explanation should describe what's happening at the blade — the airflow, the forces, and why different parts of the rotor disk behave differently."
              }
            }
          ]
        },
        {
          "title": "The Maneuver: What the Pilot Actually Does",
          "order": 5,
          "strand": "core",
          "systemPrompt": "Walk Oliver through the three phases of an autorotation: (1) the entry — lowering collective immediately to preserve rotor RPM; (2) the glide — trading altitude for rotor energy; (3) the flare and cushion — converting rotor kinetic energy to lift at the last moment. Ask him to predict what happens if the pilot waits too long to lower collective, or flares too late. Use real cockpit descriptions and let him reason through the tradeoffs before confirming.",
          "durationMinutes": 30,
          "activities": [
            {
              "title": "Three Phases, Three Decisions",
              "kind": "online",
              "order": 0,
              "description": "Oliver traces the three-phase autorotation maneuver and reasons through what goes wrong when pilots make mistakes at each phase.",
              "scholarDescription": "You'll trace the three phases of an autorotation landing and reason through what goes wrong if a pilot gets the timing wrong.",
              "durationMinutes": 30,
              "deliverable": {
                "criteria": [],
                "kind": "text",
                "mode": "auto",
                "notes": "Reading level 7. The three phases are: (1) Entry — lower collective immediately to preserve rotor RPM; (2) Glide — controlled descent trading altitude for rotor energy; (3) Flare and cushion — using stored rotor KE at the last moment to arrest descent. Each phase explanation should include the physics of what's happening, not just the procedure. Failure mode reasoning (what if you wait too long?) should show causal physical thinking. Flag if phases are described procedurally without physical reasoning.",
                "prompt": "Describe the three phases of an autorotation landing. For each phase, explain what the pilot does, why they do it, and what goes wrong if they do it too late (or not at all)."
              }
            }
          ]
        }
      ]
    }
  ]
};
