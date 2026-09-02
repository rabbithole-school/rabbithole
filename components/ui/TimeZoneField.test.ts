import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  listTimeZones,
  timeZoneOptions,
  tzOffsetMinutes,
} from "@/lib/timeZones";

const UNCOMMON_VALID_ZONE = "US/Hawaii";
const COMMON_ZONE = "Pacific/Auckland";

function values(value: string): string[] {
  return timeZoneOptions(value).map((option) => option.value);
}

describe("TimeZoneField collection synchronization", () => {
  it("adds an uncommon valid zone when an initially empty value hydrates", () => {
    expect(tzOffsetMinutes(UNCOMMON_VALID_ZONE)).not.toBeNull();
    expect(listTimeZones()).not.toContain(UNCOMMON_VALID_ZONE);

    expect(values("")).not.toContain(UNCOMMON_VALID_ZONE);
    const hydrated = values(UNCOMMON_VALID_ZONE);
    expect(hydrated).toContain(UNCOMMON_VALID_ZONE);
    expect(hydrated).toEqual(expect.arrayContaining(listTimeZones()));
  });

  it("switches between uncommon and common zones without retaining a stale option", () => {
    expect(values(UNCOMMON_VALID_ZONE)).toContain(UNCOMMON_VALID_ZONE);

    const common = values(COMMON_ZONE);
    expect(common).toContain(COMMON_ZONE);
    expect(common).not.toContain(UNCOMMON_VALID_ZONE);
    expect(common).toHaveLength(listTimeZones().length);
  });

  it("keeps the full list available and searchable after hydrating an uncommon zone", () => {
    const hydrated = timeZoneOptions(UNCOMMON_VALID_ZONE);
    expect(hydrated).toHaveLength(listTimeZones().length + 1);

    const matches = hydrated.filter((option) =>
      option.label.toLocaleLowerCase().includes("auck"),
    );
    expect(matches.map((option) => option.value)).toContain(COMMON_ZONE);
  });

  it("preserves empty and invalid stored-value handling", () => {
    expect(timeZoneOptions("")).toEqual(timeZoneOptions());

    const invalid = "Not/AZone";
    const invalidItems = timeZoneOptions(invalid);
    expect(invalidItems.map((option) => option.value)).toContain(invalid);
    expect(invalidItems).toHaveLength(listTimeZones().length + 1);
  });

  it("synchronizes Chakra collection state in an effect, not during render", () => {
    const source = readFileSync(
      new URL("./TimeZoneField.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toMatch(
      /useEffect\(\(\) => \{\s*set\(items\);?\s*\}, \[items, set\]\);?/,
    );

    const hookStart = source.indexOf("useListCollection<TimeZoneOption>");
    const effectStart = source.indexOf("useEffect(", hookStart);
    expect(hookStart).toBeGreaterThan(-1);
    expect(effectStart).toBeGreaterThan(hookStart);
    expect(source.slice(hookStart, effectStart)).not.toMatch(/\bset\(/);
  });
});
