/**
 * Harvest human weak-labels into tutor-quality eval fixtures.
 *
 *   npx tsx evals/tutor-quality/harvest-flags.ts            # harvest all flags
 *   npx tsx evals/tutor-quality/harvest-flags.ts --since 0  # explicit lower bound
 *   npx tsx evals/tutor-quality/harvest-flags.ts --help
 *
 * Teachers 👍/👎 tutor turns while rehearsing (`testDriveFlags`) and scholars
 * flag live tutor messages as wrong (`messageFlags`). These are exactly the
 * weak labels a quality flywheel runs on, but nothing turned them into
 * fixtures. This script shells out to the `evalExport:flaggedTurns` internal
 * query, then:
 *
 *   • writes one tutor-quality fixture per 👎/"wrong" flag to
 *     evals/tutor-quality/fixtures/harvested/<flagId>.json (matching the shape
 *     the harness loads, plus a `provenance` block);
 *   • records every flag (incl. 👍 positive exemplars) in
 *     harvested/TRIAGE.md for a human to review + promote curated/redacted
 *     fixtures into the committed suite;
 *   • is idempotent via harvested/.manifest.json (processed flag ids are
 *     skipped on re-run).
 *
 * The deployment is chosen by CONVEX_DEPLOYMENT (like every other eval-export
 * call). Running against PROD requires explicit approval per
 * .claude/rules/rabbithole-convex-deploys.md — and there's rarely a reason to,
 * since harvested output is gitignored (it can contain a minor's transcript
 * text; a human curates/redacts before anything is committed).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const HARVEST_DIR = join(HERE, "fixtures", "harvested");
const MANIFEST_PATH = join(HARVEST_DIR, ".manifest.json");
const TRIAGE_PATH = join(HARVEST_DIR, "TRIAGE.md");

const HELP = `harvest-flags — turn teacher/scholar flags into tutor-quality fixtures

Usage:
  npx tsx evals/tutor-quality/harvest-flags.ts [options]

Options:
  --since <ms>   Only harvest flags created at/after this epoch-ms bound.
  --help, -h     Show this help and exit (does not touch any deployment).

Reads CONVEX_DEPLOYMENT from the environment (like the other eval-export
calls). Writes fixtures + TRIAGE.md under evals/tutor-quality/fixtures/harvested/
(gitignored). Idempotent: already-processed flag ids are skipped.
`;

// ─── Shapes ────────────────────────────────────────────────────────────────

interface Msg {
  role: string;
  content: string;
}

interface FlaggedTurn {
  source: "testDriveFlag" | "messageFlag";
  flagId: string;
  kind: "good" | "bad" | "wrong";
  note: string | null;
  flaggedMessage: Msg | null;
  context: Msg[];
  sessionId: string;
  isTestDrive: boolean;
  unitTitle: string | null;
  activityTitle: string | null;
  createdAt: number;
}

interface ManifestEntry {
  date: string; // ISO date the flag was created
  source: FlaggedTurn["source"];
  kind: FlaggedTurn["kind"];
  note: string | null;
  fixture: string | null; // repo-relative fixture path, or null for exemplars
}

interface Manifest {
  entries: Record<string, ManifestEntry>;
}

// ─── CLI ─────────────────────────────────────────────────────────────────

interface Args {
  help: boolean;
  since: number | undefined;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { help: false, since: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--since") args.since = Number(argv[++i]);
    else throw new Error(`Unknown flag: ${a} (try --help)`);
  }
  return args;
}

// ─── Convex call ────────────────────────────────────────────────────────

function fetchFlaggedTurns(since: number | undefined): FlaggedTurn[] {
  const fnArgs = since === undefined ? "{}" : JSON.stringify({ since });
  const raw = execFileSync(
    "npx",
    ["convex", "run", "evalExport:flaggedTurns", fnArgs],
    { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  return parseConvexResult(raw) as FlaggedTurn[];
}

/**
 * `convex run` prints the function's return value as JSON to stdout. Be lenient
 * about any leading log noise by extracting the first top-level JSON array.
 */
function parseConvexResult(raw: string): unknown {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("[");
    const end = trimmed.lastIndexOf("]");
    if (start !== -1 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error(`Could not parse convex output as JSON:\n${raw}`);
  }
}

// ─── Fixture emission ─────────────────────────────────────────────────────

function loadManifest(): Manifest {
  if (!existsSync(MANIFEST_PATH)) return { entries: {} };
  try {
    const parsed = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
    return parsed && typeof parsed === "object" && parsed.entries
      ? (parsed as Manifest)
      : { entries: {} };
  } catch {
    return { entries: {} };
  }
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** A 👎/"wrong" flag becomes a judged fixture; 👍 is a positive exemplar only. */
function isNegative(kind: FlaggedTurn["kind"]): boolean {
  return kind === "bad" || kind === "wrong";
}

function glyph(kind: FlaggedTurn["kind"]): string {
  return kind === "good" ? "👍" : "👎";
}

function buildFixture(t: FlaggedTurn): Record<string, unknown> {
  const turns: Msg[] = [...t.context];
  if (t.flaggedMessage) turns.push(t.flaggedMessage);
  const anchor =
    t.unitTitle || t.activityTitle
      ? {
          unitTitle: t.unitTitle,
          lessonTitle: null,
          activityTitle: t.activityTitle,
          activityKind: null,
        }
      : null;
  return {
    id: `harvested-${t.flagId}`,
    description: `Harvested ${t.source} ${glyph(t.kind)} flag${t.note ? `: ${t.note}` : ""}`,
    // PII discipline: the scholar is always the literal "Scholar" — never a name.
    scholar: { name: "Scholar", readingLevel: null },
    anchor,
    turns,
    provenance: {
      flagId: t.flagId,
      source: t.source,
      note: t.note,
      sessionId: t.sessionId,
      harvestedAt: new Date().toISOString(),
    },
  };
}

function renderTriage(manifest: Manifest): string {
  const rows = Object.entries(manifest.entries).sort(
    (a, b) => a[1].date.localeCompare(b[1].date) || a[0].localeCompare(b[0]),
  );
  const body =
    rows.length === 0
      ? "_(no flags harvested yet)_"
      : rows
          .map(([, e]) => {
            const note = (e.note ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
            const target = e.fixture ?? "positive exemplar";
            return `| ${e.date} | ${e.source} | ${glyph(e.kind)} | ${note} | ${target} |`;
          })
          .join("\n");
  return `# Harvested flag triage

Weak labels harvested from \`testDriveFlags\` (teacher 👍/👎) and \`messageFlags\`
(scholar "got this wrong") by \`evals/tutor-quality/harvest-flags.ts\`.

**This directory is gitignored** — harvested content can contain a minor's
transcript text. A human reviews each row below and promotes a **curated,
redacted** copy into the committed \`evals/tutor-quality/fixtures/\` suite before
anything lands in git. 👎/"wrong" flags emit a fixture to judge; 👍 flags are
positive exemplars (no fixture, listed for reference).

To run a harvested fixture explicitly (it is NOT auto-loaded by the harness):

    ./evals/tutor-quality/run.sh --case fixture:harvested/<flagId>

| date | source | 👍/👎 | note | fixture / status |
|---|---|---|---|---|
${body}
`;
}

// ─── Main ────────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }

  mkdirSync(HARVEST_DIR, { recursive: true });
  const manifest = loadManifest();

  const flags = fetchFlaggedTurns(args.since);
  let emitted = 0;
  let exemplars = 0;
  let skipped = 0;

  for (const t of flags) {
    if (manifest.entries[t.flagId]) {
      skipped++;
      continue; // idempotent — already processed
    }

    let fixtureRel: string | null = null;
    if (isNegative(t.kind)) {
      const fixturePath = join(HARVEST_DIR, `${t.flagId}.json`);
      writeFileSync(fixturePath, `${JSON.stringify(buildFixture(t), null, 2)}\n`);
      fixtureRel = relative(REPO_ROOT, fixturePath);
      emitted++;
    } else {
      exemplars++;
    }

    manifest.entries[t.flagId] = {
      date: isoDate(t.createdAt),
      source: t.source,
      kind: t.kind,
      note: t.note,
      fixture: fixtureRel,
    };
  }

  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(TRIAGE_PATH, renderTriage(manifest));

  console.error(
    `Harvested ${flags.length} flag(s): ${emitted} fixture(s), ` +
      `${exemplars} positive exemplar(s), ${skipped} already processed.`,
  );
  console.error(`Fixtures + TRIAGE.md under ${relative(REPO_ROOT, HARVEST_DIR)}/`);
}

main();
