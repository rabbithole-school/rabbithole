import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fluencyLabel, fluencyTitleLabel, MASTERY_LABELS } from "./masteryLexicon";

describe("MASTERY_LABELS", () => {
  it("maps every practice-mastery band to shared prose, no percentages", () => {
    const cases: [keyof typeof MASTERY_LABELS, string][] = [
      ["not_started", "not started"],
      ["practicing", "practicing"],
      ["placed", "placed"],
      ["fluent", "fluent"],
      ["overlearned", "rock solid"],
    ];
    for (const [band, label] of cases) {
      expect(MASTERY_LABELS[band]).toBe(label);
      expect(label).not.toMatch(/%/);
    }
  });
});

describe("fluencyLabel", () => {
  it("maps the 1-3 automaticity ladder to prose", () => {
    expect(fluencyLabel(1)).toBe("effortful");
    expect(fluencyLabel(2)).toBe("fluent");
    expect(fluencyLabel(3)).toBe("automatic");
  });

  it("returns null for an absent or unknown reading", () => {
    expect(fluencyLabel(undefined)).toBeNull();
    expect(fluencyLabel(null)).toBeNull();
    expect(fluencyLabel(4)).toBeNull();
  });
});

describe("fluencyTitleLabel", () => {
  it("is the Title-case rendering of the same words", () => {
    expect(fluencyTitleLabel(1)).toBe("Effortful");
    expect(fluencyTitleLabel(2)).toBe("Fluent");
    expect(fluencyTitleLabel(3)).toBe("Automatic");
  });

  it("returns null for an absent or unknown reading", () => {
    expect(fluencyTitleLabel(undefined)).toBeNull();
    expect(fluencyTitleLabel(null)).toBeNull();
    expect(fluencyTitleLabel(0)).toBeNull();
  });
});

// The native iPad app can't import from shared/ at runtime (metro won't crawl
// outside its root under --reset-cache), so native/scripts/sync-vendor.js copies
// this file to native/vendor/shared/masteryLexicon.ts read-only. Web and native
// must agree on the mastery/fluency words — a drift here silently forks
// scholar-facing copy. This makes divergence un-mergeable: re-run
// `node native/scripts/sync-vendor.js` after editing shared/masteryLexicon.ts.
describe("native vendor copy is in lockstep", () => {
  it("native/vendor/shared/masteryLexicon.ts is byte-identical to shared/masteryLexicon.ts", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "masteryLexicon.ts"), "utf8");
    const vendored = readFileSync(
      join(here, "..", "native", "vendor", "shared", "masteryLexicon.ts"),
      "utf8",
    );
    expect(vendored, "vendor copy drifted — run `node native/scripts/sync-vendor.js`").toBe(
      source,
    );
  });
});
