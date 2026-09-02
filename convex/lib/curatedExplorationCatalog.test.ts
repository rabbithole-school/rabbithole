import { describe, expect, test } from "vitest";
import {
  CURATED_EXPLORATION_CATALOG,
  capCuratedExplorationSelections,
  curatedExplorationEntryForTopic,
  curatedExplorationPromptSection,
} from "./curatedExplorationCatalog";

describe("curated exploration catalog", () => {
  test("keeps entries compact, unique, sourced, and broadly connectable", () => {
    const ids = new Set<string>();
    const topics = new Set<string>();

    for (const entry of CURATED_EXPLORATION_CATALOG) {
      expect(entry.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(ids.has(entry.id)).toBe(false);
      ids.add(entry.id);

      const normalizedTopic = entry.topic.toLowerCase();
      expect(topics.has(normalizedTopic)).toBe(false);
      topics.add(normalizedTopic);

      expect(entry.family).toBeTruthy();
      expect(entry.topic.trim().split(/\s+/).length).toBeLessThanOrEqual(6);
      expect(entry.invitation.length).toBeLessThanOrEqual(260);
      expect(entry.connectionCues.length).toBeGreaterThanOrEqual(4);
      expect(entry.connectionCues.length).toBeLessThanOrEqual(8);
      expect(entry.sources.length).toBeGreaterThan(0);
      if (entry.bakeAnchor) {
        expect(entry.bakeAnchor.mechanism.length).toBeLessThanOrEqual(240);
        expect(entry.bakeAnchor.mission.does.length).toBeLessThanOrEqual(220);
        expect(entry.bakeAnchor.mission.materials.length).toBeGreaterThan(0);
        expect(entry.bakeAnchor.mission.materials.length).toBeLessThanOrEqual(4);
        expect(entry.bakeAnchor.mission.fallback.length).toBeLessThanOrEqual(220);
        expect(["artifact", "photo"]).toContain(entry.bakeAnchor.evidence.kind);
        expect(entry.bakeAnchor.evidence.produces.length).toBeLessThanOrEqual(180);
        expect(entry.bakeAnchor.evidence.laterUse.length).toBeLessThanOrEqual(240);
        for (const value of [
          entry.bakeAnchor.mechanism,
          entry.bakeAnchor.mission.does,
          entry.bakeAnchor.mission.fallback,
          entry.bakeAnchor.evidence.produces,
          entry.bakeAnchor.evidence.laterUse,
          ...entry.bakeAnchor.mission.materials,
        ]) {
          expect(value).not.toMatch(/https?:\/\//i);
        }
      }
    }
  });

  test("resolves authored content by normalized topic", () => {
    const entry = CURATED_EXPLORATION_CATALOG[0];
    expect(
      curatedExplorationEntryForTopic(`  ${entry.topic.toUpperCase()}  `),
    ).toEqual(entry);
    expect(
      curatedExplorationEntryForTopic(`${entry.topic} -> a learner bridge`),
    ).toEqual(entry);
    expect(curatedExplorationEntryForTopic("not in the catalog")).toBeNull();
  });

  test("stays broad beyond the initial hidden-machinery family", () => {
    const families = new Set(
      CURATED_EXPLORATION_CATALOG.map((entry) => entry.family),
    );
    const domains = new Set(
      CURATED_EXPLORATION_CATALOG.map((entry) => entry.domain),
    );

    expect(
      CURATED_EXPLORATION_CATALOG.some(
        (entry) => entry.family === "hidden-machinery",
      ),
    ).toBe(true);
    expect(families.size).toBeGreaterThanOrEqual(6);
    expect(domains.size).toBeGreaterThanOrEqual(12);
  });

  test("keeps bake anchors private and intentionally partial", () => {
    const anchored = CURATED_EXPLORATION_CATALOG.filter(
      (entry) => entry.bakeAnchor,
    );
    const prompt = curatedExplorationPromptSection([]);

    expect(anchored).toHaveLength(4);
    expect(new Set(anchored.map((entry) => entry.bakeAnchor!.evidence.kind))).toEqual(
      new Set(["artifact", "photo"]),
    );
    for (const entry of anchored) {
      expect(prompt).not.toContain(entry.bakeAnchor!.mechanism);
      expect(prompt).not.toContain(entry.bakeAnchor!.mission.does);
      expect(prompt).not.toContain(entry.bakeAnchor!.evidence.produces);
    }
  });

  test("offers only unvisited entries and makes selection optional and capped", () => {
    const first = CURATED_EXPLORATION_CATALOG[0];
    const second = CURATED_EXPLORATION_CATALOG[1];
    const section = curatedExplorationPromptSection([first.topic]);

    expect(section).not.toContain(`"topic":"${first.topic}"`);
    expect(section).toContain(`"topic":"${second.topic}"`);
    expect(section).toContain("AT MOST 2");
    expect(section).toContain("You may select none");
    expect(section).toContain("not a checklist or quota");
    expect(section).toContain("substantially overlaps");
  });

  test("suppresses a decorated already-visited topic via the same normalization", () => {
    const first = CURATED_EXPLORATION_CATALOG[0];
    const section = curatedExplorationPromptSection([
      `${first.topic} -> a learner bridge`,
    ]);

    expect(section).not.toContain(`"topic":"${first.topic}"`);
  });

  test("withholds catalog entries when there is no learner signal", () => {
    const section = curatedExplorationPromptSection([], false);

    expect(section).toContain("not offered");
    expect(section).not.toContain(CURATED_EXPLORATION_CATALOG[0].topic);
    expect(
      capCuratedExplorationSelections(
        [
          { topic: CURATED_EXPLORATION_CATALOG[0].topic },
          { topic: "A model-generated star" },
        ],
        2,
        false,
      ),
    ).toEqual([{ topic: "A model-generated star" }]);
  });

  test("keeps at most two catalog selections without dropping original stars", () => {
    const [first, second, third] = CURATED_EXPLORATION_CATALOG;
    const candidates = [
      { topic: `${first.topic} -> a model-added bridge` },
      { topic: "A model-generated star" },
      { topic: second.topic },
      { topic: third.topic },
    ];

    expect(capCuratedExplorationSelections(candidates)).toEqual(
      candidates.slice(0, 3),
    );
  });
});
