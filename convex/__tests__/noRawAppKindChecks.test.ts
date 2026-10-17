// TRA-519 ratchet: behavior never reads an activity's raw kind for app-ness,
// and session app features never key on the builder-primary sessionMode by
// accident. After the fold, a new app activity is stored as
// { kind: "online", appActivity: true }, so a raw `.kind === "vibecode"`
// silently misses it and a raw `.kind === "online"` silently pulls it in.
// Use shared/appSurface.ts: isAppActivity / effectiveActivityKind, and
// sessionAppContextFor for session gates.
//
// Scope: Convex server code (convex/**, minus generated code and tests).
// The web/native clients are guarded by their own lanes.
//
// HOW TO EXTEND / RATCHET:
//   • A new raw check anywhere → this test fails. Use the helpers instead.
//   • ALLOWED below caps each file at its current count, with the reason the
//     sites are legitimate (builder-primary on purpose, the normalizer itself,
//     the migration) or the lane that converts them (L2: prompts, tools,
//     stream). A lane that removes a site should lower the cap (or delete the
//     entry) in the same change, so the count can only go down. Raising a cap
//     needs a reason a reviewer agrees is builder-primary-by-design.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

const REPO_ROOT = join(__dirname, "..", "..");
const CONVEX_DIR = join(REPO_ROOT, "convex");

const RAW_CHECKS: RegExp[] = [
  /\.kind\s*[!=]==?\s*["']vibecode["']/,
  /sessionMode\s*[!=]==?\s*["']vibecode["']/,
  // Session mode from a bare kind can't see { online, appActivity }.
  /\bsessionModeForActivityKind\(/,
];

const ALLOWED: Record<string, { max: number; why: string }> = {
  "convex/lib/appActivity.ts": {
    max: 3,
    why: "the write-side normalizer of the legacy kind itself",
  },
  "convex/migrations.ts": {
    max: 2,
    why: "foldVibecodeIntoOnline + verifyVibecodeFold read the legacy kind",
  },
  "convex/sessions.ts": {
    max: 2,
    why: "builder-primary on purpose: getWithMessages.builderPrimary and resolveTurnForSession's builder-primary branch",
  },
  "convex/workshopPolicy.ts": {
    max: 1,
    why: "builder-primary on purpose: resolveTurnModeForStream's builder-primary branch",
  },
  "convex/lib/freePlay.ts": {
    max: 1,
    why: "builder-primary on purpose: free play starts only from a builder session",
  },
  "convex/appStates.ts": {
    max: 1,
    why: "listSessionStatesForScholar stays builder-primary in PR2 (follow-up)",
  },
  "convex/appOffTrackAlert.ts": {
    max: 1,
    why: "builder-primary until PR3/B3 generalizes the alert",
  },
  // ── L2 (prompts, tools, stance, stream) converts these ──
  "convex/http.ts": { max: 4, why: "L2: stream gates → builderFeatures/Stance" },
  "convex/sessionHelpers.ts": { max: 7, why: "L2: prompt assembly → appContext" },
  "convex/sessionStreamHelpers.ts": { max: 2, why: "L2: renderChecksEnabled / stance" },
  "convex/prompts.ts": { max: 1, why: "L2" },
  "convex/lib/tutorSessionTools.ts": { max: 2, why: "L2: tool offering → builderFeatures" },
  "convex/lib/tutorModel.ts": { max: 1, why: "L2: 64k budget → appBuild" },
  "convex/lib/designerTools.ts": { max: 1, why: "L2: designerToolOffer → builderStance" },
  "convex/lib/aideTools.ts": { max: 1, why: "create_scholar_activity reports an existing app row's effective kind as \"app\"" },
  "convex/lib/unitDesignerTools.ts": { max: 2, why: "L2: unit designer kind mapping" },
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === "_generated" || name === "__tests__" || name === "node_modules") {
        continue;
      }
      walk(path, out);
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*")
  );
}

function rawCheckCounts(): Map<string, { count: number; lines: string[] }> {
  const counts = new Map<string, { count: number; lines: string[] }>();
  for (const path of walk(CONVEX_DIR)) {
    const rel = relative(REPO_ROOT, path).split("\\").join("/");
    const lines = readFileSync(path, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (isCommentLine(line)) return;
      if (!RAW_CHECKS.some((re) => re.test(line))) return;
      const entry = counts.get(rel) ?? { count: 0, lines: [] };
      entry.count += 1;
      entry.lines.push(`${rel}:${index + 1}: ${line.trim()}`);
      counts.set(rel, entry);
    });
  }
  return counts;
}

describe("no raw app-kind checks in Convex server code (TRA-519)", () => {
  test("every raw check is in an allowlisted file, within its cap", () => {
    const violations: string[] = [];
    for (const [file, { count, lines }] of rawCheckCounts()) {
      const allowed = ALLOWED[file]?.max ?? 0;
      if (count > allowed) {
        violations.push(
          `${file}: ${count} raw check(s), allowed ${allowed}. Use isAppActivity / effectiveActivityKind / sessionAppContextFor (shared/appSurface.ts).\n  ${lines.join("\n  ")}`,
        );
      }
    }
    expect(violations, violations.join("\n\n")).toEqual([]);
  });

  test("the scanner still sees the allowlisted builder-primary sites", () => {
    // Guards the scanner itself: if the patterns stop matching, the ratchet
    // above would pass vacuously.
    const counts = rawCheckCounts();
    expect(counts.get("convex/lib/appActivity.ts")?.count ?? 0).toBeGreaterThan(0);
    expect(counts.get("convex/sessions.ts")?.count ?? 0).toBeGreaterThan(0);
  });
});
