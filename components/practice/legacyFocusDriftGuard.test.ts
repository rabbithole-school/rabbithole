import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { describe, expect, test } from "vitest";

const repoRoot = join(__dirname, "..", "..");

const RUNTIME_API_FILES = [
  "convex/mathFocus.ts",
  "convex/practiceSkills.ts",
  "convex/cohortPractice.ts",
  "convex/teacherToday.ts",
  "convex/lib/practiceSkillTreeTools.ts",
];

const PLAYLIST_CARD_FILES = [
  "components/practice/PlaylistCard.tsx",
  "native/src/components/practice/PracticePlaylistCard.tsx",
];

const DELETED_UI_CONTROL_FILES = [
  "components/practice/MathFocusBulkDialog.tsx",
  "components/practice/AccessSegmented.tsx",
  "components/practice/DomainServingControl.tsx",
  "components/practice/TeacherLockMark.tsx",
  "native/src/components/practice/MathFocusBulkDialog.tsx",
  "native/src/components/practice/AccessSegmented.tsx",
  "native/src/components/practice/DomainServingControl.tsx",
  "native/src/components/practice/TeacherLockMark.tsx",
];

const joinName = (parts: string[]) => parts.join("");

const RETIRED_IDENTIFIERS = [
  ["scholar", "Domain", "Focus"],
  ["math", "Focus", "Nudges"],
  ["legacy", "_migration"],
  ["run", "Legacy", "Math", "Focus", "Purge"],
  ["verify", "Legacy", "Math", "Focus", "Purge"],
].map(joinName);

const REMOVED_PUBLIC_NAMES = [
  ["apply", "To", "Scholars"],
  ["set", "Primary", "Domain"],
  ["set", "Strand", "Unlocked"],
  ["set", "Domain", "Status", "For", "Scholars"],
  ["backfill", "From", "Practice"],
  ["focus", "For", "Scholar"],
  ["current", "Focus", "For", "Scholar"],
  ["set", "Teacher", "Focus", "Skill", "Key"],
  ["checkpoint", "Flags", "For", "Scope"],
  ["get_", "scholar_", "math_", "focus"],
  ["set_", "scholar_", "math_", "focus"],
].map(joinName);

const RETIRED_STATUSES = [
  ["ac", "tive"],
  ["dor", "mant"],
].map(joinName);

const SCANNED_ROOTS = [
  "app",
  "components",
  "convex",
  "evals",
  "hooks",
  "lib",
  "native",
  "scripts",
  "shared",
  ".github",
];

const SCANNED_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".json",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);

function readSource(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

function sourceFiles(root: string): string[] {
  const absoluteRoot = join(repoRoot, root);
  if (!existsSync(absoluteRoot)) return [];

  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (
        entry.name === ".git" ||
        entry.name === ".next" ||
        entry.name === "coverage" ||
        entry.name === "node_modules"
      ) {
        continue;
      }
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (SCANNED_EXTENSIONS.has(extname(entry.name))) {
        files.push(relative(repoRoot, path));
      }
    }
  };
  visit(absoluteRoot);
  return files;
}

describe("retired focus controls structural guard", () => {
  test("retired schema, migration, and source literals stay absent from current code, tests, and generated declarations", () => {
    const files = SCANNED_ROOTS.flatMap(sourceFiles);
    for (const file of files) {
      const source = readSource(file);
      for (const identifier of RETIRED_IDENTIFIERS) {
        expect(source, `${file} should not reference ${identifier}`).not.toContain(
          identifier,
        );
      }
    }
  });

  test("removed public mutation/query names do not reappear in runtime API files", () => {
    for (const file of RUNTIME_API_FILES) {
      const source = readSource(file);
      for (const name of REMOVED_PUBLIC_NAMES) {
        expect(source, `${file} should not reference ${name}`).not.toContain(name);
      }
    }
  });

  test("removed tool names do not reappear in the practice skill tree module", () => {
    const source = readSource("convex/lib/practiceSkillTreeTools.ts");
    for (const name of REMOVED_PUBLIC_NAMES.slice(-2)) {
      expect(source).not.toContain(name);
    }
  });

  test("focusScope / recordRanDry do not reappear in the web or native playlist cards", () => {
    for (const file of PLAYLIST_CARD_FILES) {
      const source = readSource(file);
      expect(source, `${file} should not reference focusScope`).not.toMatch(
        /focusScope/,
      );
      expect(source, `${file} should not reference recordRanDry`).not.toMatch(
        /recordRanDry/,
      );
    }
  });

  test("the deleted focus-curation UI control files do not reappear", () => {
    for (const file of DELETED_UI_CONTROL_FILES) {
      expect(() => readSource(file), `${file} should not exist`).toThrow();
    }
  });

  test("retired status gates do not reappear in public runtime or UI files", () => {
    for (const file of [...RUNTIME_API_FILES, ...PLAYLIST_CARD_FILES]) {
      const source = readSource(file);
      for (const status of RETIRED_STATUSES) {
        expect(
          source,
          `${file} should not gate on the retired ${status} status`,
        ).not.toMatch(
          new RegExp(`status\\s*===\\s*["']${status}["']`),
        );
      }
    }
  });
});
