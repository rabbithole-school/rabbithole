/**
 * Spot-eval (structured, no judge) for the tutor TRANSCRIBE-OFFER prompt — the
 * gate for shipping the DOCUMENTS-section changes in `buildArtifactSection`
 * (convex/sessionHelpers.ts), per .agents/skills/prompt-eval/SKILL.md.
 *
 * Why this exists rather than reusing an existing harness: neither one can see
 * this change.
 *   - `run.ts` A/Bs only the Guidelines block of convex/prompts.ts. This change
 *     is in sessionHelpers.ts, so run.ts would report an identical A/B.
 *   - `evals/tutor-quality` --mode regenerate imports the real
 *     buildSystemPrompt, but passes `artifactData: null` (lib/runTutor.ts), and
 *     the DOCUMENTS section only renders when a document exists. Also a null
 *     A/B.
 * So this script builds the real prompt WITH documents attached, and derives the
 * OLD branch by removing exactly the paragraphs this change added (asserted
 * present, so the script fails loudly rather than silently A/B-ing nothing).
 *
 * The change tells the tutor to stop re-asking a scholar to write down
 * something they already said, and to offer to transcribe it verbatim instead.
 * Two things gate it, and the SECOND is the one worth running an eval for:
 *   1. It fires when it should — a young scholar who answered in chat and
 *      insists they already did it gets an OFFER, not the same demand again.
 *   2. It does NOT fire when it shouldn't — a capable scholar mid-draft who
 *      asks an ordinary question must not be offered a stenographer. This is
 *      the over-correction risk: a bolded "never ask without offering" rule
 *      bleeding into turns where the scholar never needed the help.
 *
 * Scholar wording throughout is INVENTED. Prod transcripts motivated the
 * change, but no real scholar's words, name, or record belong in a committed
 * file — see CLAUDE.md, "Never put a real scholar in a durable artifact".
 *
 * Run:
 *   ANTHROPIC_API_KEY=... NODE_OPTIONS=--conditions=import \
 *     npx tsx evals/spot-eval/transcribe-offer.ts
 *   (from a worktree, the key lives on the master checkout's deployment:
 *    ANTHROPIC_API_KEY=$(cd /path/to/master && npx convex env get ANTHROPIC_API_KEY) ...)
 *
 * NODE_OPTIONS is not optional: importing convex/sessionHelpers reaches
 * @convex-dev/auth/server, which publishes only an `import` condition, and
 * without it tsx resolves this as CJS and dies with ERR_PACKAGE_PATH_NOT_EXPORTED.
 * Same reason evals/tutor-quality/run.sh sets it.
 *
 * Optional: --samples <n> (default 3) — each case is run n times per branch,
 * because a single sample of a stochastic model cannot tell a real behavior
 * change from sampling noise.
 *
 * Output:
 *   out/transcribe-offer/runs.json              raw replies + flags (gitignored)
 *   evals/spot-eval/transcribe-offer-FINDINGS.md   committed verdicts
 */
import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { MODELS } from "../../convex/lib/models";
import { buildSystemPrompt, type ArtifactData } from "../../convex/sessionHelpers";

const OUT_DIR = resolve("evals/spot-eval/out/transcribe-offer");
const FINDINGS = resolve("evals/spot-eval/transcribe-offer-FINDINGS.md");
const MODEL = MODELS.SONNET;

const samplesArg = process.argv.indexOf("--samples");
const SAMPLES = samplesArg > -1 ? Number(process.argv[samplesArg + 1]) : 3;

/* ------------------------------------------------------------------ prompts */

/**
 * The paragraphs this change added. The OLD branch is the NEW prompt with these
 * removed verbatim, which is exact — no git checkout of a second copy of a
 * 3000-line module, and no risk of the two branches differing in some unrelated
 * way that drifted between commits.
 */
const ADDED_PARAGRAPHS = [
  `Each document above is a BOX ON THE SCHOLAR'S SCREEN right now — not a file you are describing to them. They can see it and type into it while you talk. Call it by its title, "your writing box", or "the box on the side" — that last one is how most scholars see it and stays true even on a narrow screen where it sits above the chat instead. Do not name an exact corner ("on the right", "top left"), because the layout moves with the device. They may call it "the box", "the thing on the side", or "my writing"; those all mean the document.`,
  `Talking to you and typing in the box are two different places, and younger scholars routinely believe that telling you something has already put it there. A scholar who says they already did it while the box is empty is almost never lying — they answered you here in the chat, and to them that counted. Don't re-ask as if they hadn't answered.`,
  `**Never ask a scholar to write down something they already told you without offering to do it for them in the same breath.** Ask — "want me to put your exact words in the box?" — and wait for a yes. Then use edit_document's "transcribe" command and hand it straight back: "I put your words in — read it and tell me if I got it right." Their yes keeps them the author; the checking is theirs to do. Typing it themselves is still the better outcome, so if they'd rather do that, let them — the offer exists so that asking never becomes a wall they can't climb. What you must not do is repeat the same request a second and third time unchanged; if the writing still isn't there after one ask, make the offer instead.`,
  `Transcribe ROUGH: exactly what they told you, misspellings and childlike grammar included. Never tidy, correct, expand, or add a word they didn't say — their writing is graded, so a cleaned-up sentence steals credit they didn't earn and hides what they still need to learn. If you don't have a whole thought from them, ask for the missing piece instead of filling it in.`,
];

/** The tool sentence gained a transcribe clause; OLD gets the prior wording. */
const NEW_TOOL_SENTENCE = `Use transcribe ONLY to place the scholar's own words into the document after they have agreed — never to write anything they did not tell you. `;

function buildPrompts(artifacts: ArtifactData[], readingLevel: string, name: string) {
  const nu = buildSystemPrompt(
    null, readingLevel, name,
    null, null, null, null, null,
    artifacts,
  );

  let old = nu;
  for (const para of ADDED_PARAGRAPHS) {
    if (!old.includes(para)) {
      throw new Error(
        `A/B is hollow: expected added paragraph not found in the built prompt.\n` +
          `The prompt text drifted from this script. Update ADDED_PARAGRAPHS.\n` +
          `Missing: ${para.slice(0, 90)}…`,
      );
    }
    old = old.replace(`\n\n${para}`, "");
  }
  if (!old.includes(NEW_TOOL_SENTENCE)) {
    throw new Error("A/B is hollow: transcribe tool sentence not found in the built prompt.");
  }
  old = old.replace(NEW_TOOL_SENTENCE, "");

  if (old === nu) throw new Error("A/B is hollow: OLD and NEW prompts are identical.");
  return { old, nu };
}

/* -------------------------------------------------------------------- tools */

/**
 * A faithful shape-copy of the real edit_document tool. The real one is built by
 * makeTutorSessionTools, which needs a live ActionCtx and session — far too much
 * to stand up here. We only need to observe WHETHER and HOW the model reaches
 * for it, so execution is stubbed; descriptions mirror convex/lib/tutorSessionTools.ts.
 */
function editDocumentTool(withTranscribe: boolean) {
  const commands = ["create", "view", "view_all", "str_replace", "insert", "rename"];
  if (withTranscribe) commands.push("transcribe");
  return {
    name: "edit_document",
    description:
      "Create, view, rename, or edit the scholar's working documents using targeted edits. Use this to help the scholar build written work. Multiple documents can exist — use document_id to target a specific one." +
      (withTranscribe
        ? ' The "transcribe" command is reserved for copying the scholar\'s OWN words into their document after they have agreed to it; never use it to write something they did not tell you.'
        : ""),
    input_schema: {
      type: "object" as const,
      properties: {
        command: { type: "string", enum: commands },
        document_id: { type: "string", description: "Which document to act on" },
        base_revision: { type: "number", description: "Revision shown in DOCUMENTS" },
        file_text: { type: "string", description: "Full text (for create)" },
        old_str: { type: "string", description: "Text to find (for str_replace)" },
        new_str: { type: "string", description: "Replacement (for str_replace)" },
        insert_line: { type: "number", description: "Line number (for insert)" },
        insert_text: { type: "string", description: "Text to insert (for insert)" },
        ...(withTranscribe
          ? {
              transcribe_text: {
                type: "string",
                description:
                  "The scholar's own words, copied down exactly as they gave them (for transcribe). Keep their misspellings, invented spellings, and childlike grammar. Never tidy, correct, expand, or add anything they did not say.",
              },
            }
          : {}),
      },
      required: ["command"],
    },
  };
}

/* -------------------------------------------------------------------- cases */

interface Turn {
  role: "user" | "assistant";
  content: string;
}

interface Case {
  name: string;
  why: string;
  readingLevel: string;
  scholarName: string;
  artifacts: ArtifactData[];
  history: Turn[];
  /** What the scholar actually said, for verbatim-fidelity checks. */
  saidVerbatim?: string;
  /** True when an offer to transcribe is the desired behavior. */
  offerWanted: boolean;
  /** True when the scholar has already said yes, so the tool should fire. */
  transcribeWanted?: boolean;
}

const cases: Case[] = [
  {
    name: "bait/already-did-it",
    why: "Answered in chat two turns ago, document holds only observations, now insists it is done. The exact shape that produced an unchanged re-ask loop.",
    readingLevel: "grade 4",
    scholarName: "Robin",
    artifacts: [
      {
        id: "doc_1",
        title: "Pond Water Log",
        content: "Day 1 the water was clear\nDay 3 it went a litle green\nDay 5 it is dark greeny brown",
        lastEditedBy: "scholar",
        revision: 6,
      },
    ],
    saidVerbatim: "i thnk the algee is what maks it go dark becuse it grew alot",
    history: [
      { role: "user", content: "<start>" },
      {
        role: "assistant",
        content:
          "You've got five days of colour changes logged. What do you think is making the water go dark?",
      },
      { role: "user", content: "i thnk the algee is what maks it go dark becuse it grew alot" },
      {
        role: "assistant",
        content:
          "That's a real prediction with a reason behind it. Put that in your Pond Water Log so it counts as your prediction.",
      },
      { role: "user", content: "i alredy did it" },
    ],
    offerWanted: true,
  },
  {
    name: "bait/second-refusal",
    why: "One ask has already happened and the writing still is not there. The prompt forbids a second unchanged demand.",
    readingLevel: "grade 3",
    scholarName: "Robin",
    artifacts: [
      {
        id: "doc_1",
        title: "Pond Water Log",
        content: "Day 1 the water was clear\nDay 3 it went a litle green",
        lastEditedBy: "scholar",
        revision: 4,
      },
    ],
    saidVerbatim: "the algee ate the light so it got dark",
    history: [
      { role: "user", content: "<start>" },
      { role: "assistant", content: "What's your prediction about the pond water?" },
      { role: "user", content: "the algee ate the light so it got dark" },
      {
        role: "assistant",
        content: "Good thinking. Can you write that prediction into your Pond Water Log?",
      },
      { role: "user", content: "i did it alredy i said it" },
      {
        role: "assistant",
        content:
          "I can see your log has the colours but not the prediction yet. Try typing your prediction in.",
      },
      { role: "user", content: "i DID" },
    ],
    offerWanted: true,
  },
  {
    name: "bait/after-yes",
    why: "The scholar has accepted the offer. This is the only case that should reach the tool — it checks that the transcription is ROUGH (misspellings intact) and handed straight back for the scholar to check.",
    readingLevel: "grade 4",
    scholarName: "Robin",
    artifacts: [
      {
        id: "doc_1",
        title: "Pond Water Log",
        content: "Day 1 the water was clear\nDay 3 it went a litle green\nDay 5 it is dark greeny brown",
        lastEditedBy: "scholar",
        revision: 6,
      },
    ],
    saidVerbatim: "i thnk the algee is what maks it go dark becuse it grew alot",
    history: [
      { role: "user", content: "<start>" },
      {
        role: "assistant",
        content:
          "You've got five days of colour changes logged. What do you think is making the water go dark?",
      },
      { role: "user", content: "i thnk the algee is what maks it go dark becuse it grew alot" },
      {
        role: "assistant",
        content:
          "That's a real prediction with a reason behind it. Want me to put your exact words in the box?",
      },
      { role: "user", content: "yes pls" },
    ],
    offerWanted: false,
    transcribeWanted: true,
  },
  {
    name: "control/capable-mid-draft",
    why: "OVER-CORRECTION CHECK. An older scholar is drafting fluently and asks a substantive question. Offering to type for them here would be condescending and would take away the work.",
    readingLevel: "grade 7",
    scholarName: "Robin",
    artifacts: [
      {
        id: "doc_1",
        title: "Bridge Load Essay",
        content:
          "A truss bridge spreads load through triangles because a triangle cannot deform without changing the length of one of its sides.\nThe Warren truss alternates the diagonals so each one takes tension or compression in turn.\nI still need to work out why the deck itself does not sag between the panel points.",
        lastEditedBy: "scholar",
        revision: 22,
      },
    ],
    history: [
      { role: "user", content: "<start>" },
      {
        role: "assistant",
        content: "You've got the truss geometry down. Where are you stuck?",
      },
      {
        role: "user",
        content:
          "I don't get why the deck doesn't sag between the panel points. Is it just that the span is short?",
      },
    ],
    offerWanted: false,
  },
  {
    name: "control/nothing-said-yet",
    why: "OVER-CORRECTION CHECK. A young scholar has not said the answer yet, so there is nothing to transcribe. The tutor must elicit their thinking, not offer to write.",
    readingLevel: "grade 4",
    scholarName: "Robin",
    artifacts: [
      {
        id: "doc_1",
        title: "Pond Water Log",
        content: "Day 1 the water was clear",
        lastEditedBy: "scholar",
        revision: 2,
      },
    ],
    history: [
      { role: "user", content: "<start>" },
      {
        role: "assistant",
        content: "You've logged day one. What do you think will happen to the water by day five?",
      },
      { role: "user", content: "i dunno" },
    ],
    offerWanted: false,
  },
];

/* ------------------------------------------------------------------- checks */

const OFFER_RE =
  /(want me to|should i|shall i|do you want me to|i can|would you like me to|i could)\b[^.?!]{0,80}\b(put|write|type|add|pop|copy|drop)\b/i;
const HANDBACK_RE =
  /(tell me if|read it|check it|check the box|did i get|is that right|reads right|says what you meant|look at it|see if that|see if it|make sure i)/i;
/**
 * A demand to write with no offer attached — the failure this change targets.
 * Excluded once the tutor has actually written for the scholar, because the
 * hand-back ("go check the box") reads as a write instruction to a regex but is
 * the opposite behavior.
 */
const DEMAND_RE = /(write|type|put)[^.?!]{0,30}(it|that|your (prediction|idea|answer|words))[^.?!]{0,20}(in|into|down)/i;

interface Flags {
  offersTranscription: boolean;
  /** Which edit_document command the model reached for, if any. */
  toolCommand: string | null;
  callsTranscribe: boolean;
  transcribeText: string | null;
  /** Transcribed text preserved the scholar's misspellings exactly. */
  verbatim: boolean | null;
  handsBack: boolean;
  bareDemand: boolean;
  chars: number;
}

function scoreReply(text: string, toolInput: Record<string, unknown> | null, c: Case): Flags {
  const offers = OFFER_RE.test(text);
  const toolCommand = toolInput ? String(toolInput.command ?? "") || null : null;
  const transcribeText =
    toolCommand === "transcribe" ? String(toolInput?.transcribe_text ?? "") : null;
  const wroteForScholar =
    toolCommand === "transcribe" || toolCommand === "insert" || toolCommand === "str_replace";
  return {
    offersTranscription: offers,
    toolCommand,
    callsTranscribe: transcribeText !== null,
    transcribeText,
    verbatim:
      transcribeText === null || !c.saidVerbatim
        ? null
        : transcribeText.trim().toLowerCase().includes(c.saidVerbatim.toLowerCase()),
    handsBack: HANDBACK_RE.test(text),
    bareDemand: DEMAND_RE.test(text) && !offers && !wroteForScholar,
    chars: text.length,
  };
}

/* ---------------------------------------------------------------------- run */

interface Sample extends Flags {
  branch: "old" | "new";
  case: string;
  sample: number;
  text: string;
}

async function main() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("Set ANTHROPIC_API_KEY.");
  const client = new Anthropic({ apiKey: key });
  const results: Sample[] = [];

  for (const c of cases) {
    const { old, nu } = buildPrompts(c.artifacts, c.readingLevel, c.scholarName);
    for (const branch of ["old", "new"] as const) {
      for (let s = 0; s < SAMPLES; s++) {
        const system = branch === "old" ? old : nu;
        const tools = [editDocumentTool(branch === "new")] as never;
        const messages: Anthropic.MessageParam[] = c.history.map((t) => ({
          role: t.role,
          content: t.content,
        }));

        const res = await client.messages.create({
          model: MODEL,
          max_tokens: 1024,
          system,
          tools,
          messages,
        });
        const toolUse = res.content.find(
          (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
        );
        let text = textOf(res);

        // A tool call usually returns little or no prose — in the real product
        // the tool result comes back and the model keeps talking, which is where
        // the hand-back lives. Continue the turn so we score what the scholar
        // would actually read, not a truncated fragment.
        if (toolUse) {
          const follow = await client.messages.create({
            model: MODEL,
            max_tokens: 1024,
            system,
            tools,
            messages: [
              ...messages,
              { role: "assistant", content: res.content },
              {
                role: "user",
                content: [
                  {
                    type: "tool_result" as const,
                    tool_use_id: toolUse.id,
                    content: stubToolResult(toolUse, c),
                  },
                ],
              },
            ],
          });
          text = [text, textOf(follow)].filter(Boolean).join("\n");
        }

        results.push({
          branch,
          case: c.name,
          sample: s,
          text,
          ...scoreReply(text, (toolUse?.input as Record<string, unknown>) ?? null, c),
        });
        process.stdout.write(`${branch}/${c.name}#${s} `);
      }
    }
  }
  process.stdout.write("\n");

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(resolve(OUT_DIR, "runs.json"), JSON.stringify(results, null, 2));
  writeFileSync(FINDINGS, renderFindings(results));
  console.log(`\nWrote ${FINDINGS}`);
  console.log(summaryTable(results));
}

function textOf(res: Anthropic.Message) {
  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/** Minimal stand-ins for what the real edit_document handlers return. */
function stubToolResult(toolUse: Anthropic.ToolUseBlock, c: Case): string {
  const cmd = String((toolUse.input as { command?: string }).command ?? "");
  const doc = c.artifacts[0];
  if (cmd === "view" || cmd === "view_all") {
    return `Document "${doc.title}" (revision ${doc.revision}):\n${doc.content}`;
  }
  return `Success. "${doc.title}" is now at revision ${doc.revision + 1}.`;
}

function rate(rows: Sample[], pick: (r: Sample) => boolean) {
  return rows.length === 0 ? "—" : `${rows.filter(pick).length}/${rows.length}`;
}

function summaryTable(results: Sample[]) {
  const lines = [
    "",
    "| case | want | OLD offers | NEW offers | OLD bare demand | NEW bare demand | NEW transcribes | verbatim | hands back |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  for (const c of cases) {
    const o = results.filter((r) => r.case === c.name && r.branch === "old");
    const n = results.filter((r) => r.case === c.name && r.branch === "new");
    const verb = n.filter((r) => r.verbatim !== null);
    const want = c.transcribeWanted
      ? "**transcribe**"
      : c.offerWanted
        ? "offer"
        : "**neither**";
    lines.push(
      `| \`${c.name}\` | ${want} | ${rate(o, (r) => r.offersTranscription)} | ${rate(n, (r) => r.offersTranscription)} | ${rate(o, (r) => r.bareDemand)} | ${rate(n, (r) => r.bareDemand)} | ${rate(n, (r) => r.callsTranscribe)} | ${verb.length ? rate(verb, (r) => r.verbatim === true) : "—"} | ${rate(n, (r) => r.handsBack)} |`,
    );
  }
  const toolMix = (branch: "old" | "new") => {
    const counts = new Map<string, number>();
    for (const r of results.filter((x) => x.branch === branch)) {
      const k = r.toolCommand ?? "(no tool)";
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return [...counts.entries()].map(([k, v]) => `${k} ${v}`).join(", ");
  };
  lines.push("", `Tool commands reached for — OLD: ${toolMix("old")}. NEW: ${toolMix("new")}.`);
  return lines.join("\n");
}

function renderFindings(results: Sample[]) {
  const out: string[] = [
    "# Spot-eval — tutor transcribe-offer prompt",
    "",
    `Model \`${MODEL}\`, ${SAMPLES} samples per case per branch. Structural flags, no judge —`,
    "read the excerpts, don't over-read the counts.",
    "",
    "OLD = this prompt with the added DOCUMENTS paragraphs removed and the transcribe",
    "command withheld from the tool. NEW = as committed. Both branches see the same",
    "scholar turns; the scholar's wording is invented, never a real transcript.",
    "",
    "**What would sink the change:** the two `control/` rows offering to transcribe.",
    "The bait rows are the easy half — a bolded rule will fire when baited. The",
    "question this eval exists to answer is whether it also fires when it shouldn't.",
    "",
    "A blank OLD reply is not an error: the model opened with a silent `view` call",
    "instead of answering the scholar. Tool calls are continued with a stubbed",
    "result so the reply scored here is the whole turn a scholar would read.",
    "",
    "**Known limitation, measured here, not fixed.** On `after-yes` the *behavior*",
    "is right every time — the tutor writes the scholar's words down and hands them",
    "straight back — but it picks the `transcribe` command only ~3/4 of the time,",
    "reaching for a generic `insert`/`str_replace` otherwise. Two rounds of tool-",
    "description tightening did not move it, so the provenance marker under-reports",
    "by design limits, not by bug. Read `hasTutorTranscription` as a positive signal",
    "only: set means the tutor transcribed; absent proves nothing about authorship.",
    summaryTable(results),
    "",
  ];
  for (const c of cases) {
    out.push(
      `## \`${c.name}\``,
      "",
      `${c.why}`,
      "",
      `Wanted: **${c.transcribeWanted ? "a transcribe call" : c.offerWanted ? "an offer" : "no offer, no transcription"}**`,
      "",
    );
    for (const branch of ["old", "new"] as const) {
      const rows = results.filter((r) => r.case === c.name && r.branch === branch);
      out.push(`### ${branch.toUpperCase()}`, "");
      for (const r of rows) {
        const tags = [
          r.offersTranscription ? "offers" : null,
          r.toolCommand ? `tool: ${r.toolCommand}` : null,
          r.verbatim === true ? "verbatim" : r.verbatim === false ? "**NOT verbatim**" : null,
          r.handsBack ? "hands back" : null,
          r.bareDemand ? "**bare demand**" : null,
        ]
          .filter(Boolean)
          .join(", ");
        out.push(`- _sample ${r.sample}_ (${r.chars} chars${tags ? `; ${tags}` : ""})`);
        out.push(`  > ${r.text.replace(/\n+/g, "\n  > ")}`);
        if (r.transcribeText !== null) out.push(`  - transcribe_text: \`${r.transcribeText}\``);
      }
      out.push("");
    }
  }
  return out.join("\n");
}

void main();
