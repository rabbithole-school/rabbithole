import { describe, expect, test } from "vitest";
import {
  buildVersionMaterial,
  computePromptVersion,
} from "../lib/promptVersion";

// ── computePromptVersion ─────────────────────────────────────────────

describe("computePromptVersion", () => {
  test("returns a 12-char lowercase hex string", async () => {
    const v = await computePromptVersion();
    expect(v).toMatch(/^[0-9a-f]{12}$/);
  });

  test("is stable across calls when code + env are unchanged", async () => {
    // The runtime clock line no longer lives in the base prompt (it moved to
    // per-turn message context via buildClockLine, which the hash material doesn't
    // render), so the material is inherently free of volatile wall-clock text.
    // Both the material and the hash must be byte-for-byte identical.
    expect(buildVersionMaterial()).toEqual(buildVersionMaterial());
    const a = await computePromptVersion();
    const b = await computePromptVersion();
    expect(a).toEqual(b);
    // And the hash actually reflects the material (not a constant).
    expect(a).toEqual((await computePromptVersion()));
  });
});

// ── buildVersionMaterial — what feeds the hash ───────────────────────

describe("buildVersionMaterial", () => {
  test("the hash material carries no live date/time line", () => {
    const material = buildVersionMaterial();
    // The volatile clock line moved out of buildBasePrompt to the per-turn
    // message context (buildClockLine), which the hash material deliberately does
    // NOT render — so no "Current date and time" text appears at all, and the
    // hash never varies with the wall clock. (The DATE_LINE normalizer is kept
    // as a defensive no-op should a clock line ever reappear in the base prompt.)
    expect(material).not.toMatch(/Current date and time:/);
    expect(material).not.toMatch(/Current date and time: \w+day,/);
  });

  test("covers all three opening-turn directives (TRA-234)", () => {
    // These moved out of the cached stable prefix into the dynamic tail; an
    // edit to any of them must still bump the version. A falsy lastSessionAt
    // silently yields null for the two returning variants, so assert on text.
    const material = buildVersionMaterial();
    expect(material).toContain("FIRST MESSAGE:");
    expect(material).toContain("in this same sitting");
    expect(material).toContain("The scholar has used Rabbithole before");
  });
});

// ── env sensitivity — the active soul variant moves the hash ─────────

describe("computePromptVersion — soul doc sensitivity", () => {
  test("disabling the soul doc changes the material and the hash", async () => {
    const original = process.env.RABBITHOLE_SOUL_DOC;
    try {
      // Default: soul doc on.
      delete process.env.RABBITHOLE_SOUL_DOC;
      const defaultMaterial = buildVersionMaterial();
      const defaultHash = await computePromptVersion();
      expect(defaultMaterial).toContain("stands for");

      // Disabling it drops the section entirely → different hash.
      process.env.RABBITHOLE_SOUL_DOC = "off";
      const offMaterial = buildVersionMaterial();
      const offHash = await computePromptVersion();
      expect(offMaterial).not.toContain("stands for");
      expect(offMaterial).not.toEqual(defaultMaterial);
      expect(offHash).not.toEqual(defaultHash);
    } finally {
      if (original === undefined) delete process.env.RABBITHOLE_SOUL_DOC;
      else process.env.RABBITHOLE_SOUL_DOC = original;
    }
  });
});

describe("computePromptVersion — tutor gate sensitivity", () => {
  test("enabled prompt add-ons change the hash", async () => {
    const original = {
      chatPractice: process.env.CHAT_PRACTICE_ENABLED,
      teachBack: process.env.TEACH_BACK_ENABLED,
    };
    try {
      delete process.env.CHAT_PRACTICE_ENABLED;
      delete process.env.TEACH_BACK_ENABLED;
      const gatesOff = await computePromptVersion();

      process.env.CHAT_PRACTICE_ENABLED = "true";
      const chatPracticeOn = await computePromptVersion();
      expect(chatPracticeOn).not.toEqual(gatesOff);
      expect(buildVersionMaterial()).toContain("serve_practice_problem");

      process.env.TEACH_BACK_ENABLED = "true";
      const bothOn = await computePromptVersion();
      expect(bothOn).not.toEqual(chatPracticeOn);
      const bothMaterial = buildVersionMaterial();
      expect(bothMaterial).toContain("start_teach_back");
      expect(bothMaterial).toContain("Teach-back mode is on");
    } finally {
      if (original.chatPractice === undefined)
        delete process.env.CHAT_PRACTICE_ENABLED;
      else process.env.CHAT_PRACTICE_ENABLED = original.chatPractice;
      if (original.teachBack === undefined)
        delete process.env.TEACH_BACK_ENABLED;
      else process.env.TEACH_BACK_ENABLED = original.teachBack;
    }
  });
});
