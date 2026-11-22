import { describe, expect, test } from "vitest";
import { SKY_LABEL, skyBoxesOverlap } from "../skyLabelBox";
import {
  LABEL_FONT_PX,
  cameraOnStar,
  fitSkyCamera,
  labelCap,
  labelsToShow,
  nearbyPairs,
  questShownLine,
  screenLabelBox,
  toScreen,
  trailPairs,
  wonderAskedLine,
  zoomAt,
  zoomLimits,
  type SkyStarLike,
} from "../yourSkyModel";

function star(id: string, x: number, y: number, extra: Partial<SkyStarLike> = {}): SkyStarLike {
  return {
    id,
    kind: "wonder",
    label: `Why do stars twinkle number ${id}?`,
    x,
    y,
    bright: false,
    trailFromStarId: null,
    nearby: [],
    wonder: { askedAt: Number(id.replace(/\D/g, "")) || 0 },
    quest: null,
    ...extra,
  };
}

/** A sky laid out the way the layout keeps it: no two label boxes within
 *  SKY_LABEL.gapEm of each other. */
function grid(cols: number, rows: number): SkyStarLike[] {
  const stars: SkyStarLike[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) stars.push(star(`s${r * cols + c + 1}`, c * 14, r * 4));
  }
  return stars;
}

const vp = { w: 1200, h: 700 };

describe("fitSkyCamera", () => {
  test("every star's label sits inside the viewport, and the sky is centered", () => {
    const stars = grid(6, 5);
    const cam = fitSkyCamera(stars, vp);
    const boxes = stars.map((s) => screenLabelBox(s, { ...cam }, cam.k));
    const left = Math.min(...boxes.map((b) => b.left));
    const right = Math.max(...boxes.map((b) => b.right));
    const top = Math.min(...boxes.map((b) => b.top));
    const bottom = Math.max(...boxes.map((b) => b.bottom));
    expect(left).toBeGreaterThanOrEqual(0);
    expect(right).toBeLessThanOrEqual(vp.w);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(bottom).toBeLessThanOrEqual(vp.h);
    expect((left + right) / 2).toBeCloseTo(vp.w / 2, 5);
    expect((top + bottom) / 2).toBeCloseTo(vp.h / 2, 5);
  });

  test("the padding is the clear margin beside the outermost labels: 28px on web, 32pt on the BunnyPad", () => {
    // A wide sky in a short-and-narrow viewport, so the width decides the
    // fit and the padding is exactly what is left either side.
    const stars = grid(6, 5);
    const fits = [
      { pad: 28, w: 500, cam: fitSkyCamera(stars, { w: 500, h: 400 }) },
      // The BunnyPad passes its own padding (FIT_PAD_PT) under its top bar.
      { pad: 32, w: 500, cam: fitSkyCamera(stars, { w: 500, h: 400, top: 100 }, 32) },
    ];
    for (const { pad, w, cam } of fits) {
      const boxes = stars.map((s) => screenLabelBox(s, cam, cam.k));
      expect(Math.min(...boxes.map((b) => b.left))).toBeCloseTo(pad, 5);
      expect(w - Math.max(...boxes.map((b) => b.right))).toBeCloseTo(pad, 5);
    }
    expect(fits[1].cam.k).toBeLessThan(fits[0].cam.k);
  });

  test("one star doesn't open as a close-up", () => {
    const cam = fitSkyCamera([star("s1", 40, -12)], vp);
    expect(cam.k).toBeLessThanOrEqual(LABEL_FONT_PX * 1.5);
    const at = toScreen({ x: 40, y: -12 }, cam);
    expect(at.x).toBeCloseTo(vp.w / 2, 5);
  });
});

describe("labelsToShow", () => {
  test("with the whole sky in view, a few labels show and none overlap", () => {
    const stars = grid(6, 5);
    const cam = fitSkyCamera(stars, { w: 500, h: 400 });
    const cap = labelCap(cam.k, cam.k);
    const shown = labelsToShow(stars, cam, { w: 500, h: 400 }, { cap });
    expect(cap).toBeLessThan(stars.length);
    expect(shown.size).toBeGreaterThan(0);
    expect(shown.size).toBeLessThanOrEqual(cap);
    const boxes = stars.filter((s) => shown.has(s.id)).map((s) => screenLabelBox(s, cam));
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        expect(skyBoxesOverlap(boxes[i], boxes[j], SKY_LABEL.gapEm * LABEL_FONT_PX)).toBe(false);
      }
    }
  });

  test("once a label's em is at least its font size, every label on screen fits", () => {
    const stars = grid(3, 3);
    const cam = { k: LABEL_FONT_PX, tx: 200, ty: 200 };
    const shown = labelsToShow(stars, cam, vp, { cap: Infinity });
    expect(shown.size).toBe(stars.length);
  });

  test("the shown Quest's label comes first, and the selected star's always shows", () => {
    // Two stars on top of each other: only one label can show.
    const quest = star("q1", 0, 0, { kind: "quest", bright: true, wonder: null, quest: { shownAt: 5 } });
    const wonder = star("w9", 0.5, 0.2);
    const cam = { k: 4, tx: 300, ty: 300 };
    expect([...labelsToShow([wonder, quest], cam, vp, { cap: 8 })]).toEqual(["q1"]);
    const withSelected = labelsToShow([wonder, quest], cam, vp, { cap: 1, selectedId: "w9" });
    expect(withSelected.has("w9")).toBe(true);
  });

  test("the wonder a shown Quest grew from is labelled before newer wonders", () => {
    const origin = star("w1", 0, 0);
    const newer = star("w8", 0, 10);
    const quest = star("q1", 0, 20, {
      kind: "quest",
      bright: true,
      trailFromStarId: "w1",
      wonder: null,
      quest: { shownAt: 5 },
    });
    const cam = { k: LABEL_FONT_PX, tx: 300, ty: 100 };
    expect([...labelsToShow([newer, origin, quest], cam, vp, { cap: 2 })]).toEqual(["q1", "w1"]);
  });

  test("a selected star's nearby stars are labelled next", () => {
    const selected = star("w1", 0, 0, { nearby: ["w2"] });
    const near = star("w2", 0, 10);
    const newer = star("w9", 0, 20);
    const cam = { k: LABEL_FONT_PX, tx: 300, ty: 100 };
    const shown = labelsToShow([newer, near, selected], cam, vp, { cap: 2, selectedId: "w1" });
    expect([...shown]).toEqual(["w1", "w2"]);
  });

  test("stars off screen neither show nor count against the cap", () => {
    const far = star("s1", 1000, 0);
    const near = star("s2", 0, 0);
    const shown = labelsToShow([far, near], { k: 14, tx: 600, ty: 300 }, vp, { cap: 1 });
    expect([...shown]).toEqual(["s2"]);
  });

  test("more labels may show as the kid zooms in", () => {
    const atRest = labelCap(10, 10);
    expect(labelCap(3, 3)).toBe(atRest);
    expect(labelCap(8, 10)).toBe(atRest);
    expect(labelCap(20, 10)).toBeGreaterThan(atRest);
  });
});

describe("lines", () => {
  test("a trail runs from the wonder to its Quest, when both are on the sky", () => {
    const stars = [
      star("w1", 0, 0),
      star("q1", 10, 0, { kind: "quest", bright: true, trailFromStarId: "w1" }),
      star("q2", 20, 0, { kind: "quest", bright: true, trailFromStarId: "gone" }),
    ];
    expect(trailPairs(stars)).toEqual([["w1", "q1"]]);
  });

  test("each nearby pair is drawn once, and not where a trail already runs", () => {
    const stars = [
      star("w1", 0, 0, { nearby: ["w2", "q1", "missing"] }),
      star("w2", 5, 0, { nearby: ["w1"] }),
      star("q1", 10, 0, { kind: "quest", bright: true, trailFromStarId: "w1", nearby: ["w1"] }),
    ];
    expect(nearbyPairs(stars)).toEqual([["w1", "w2"]]);
  });
});

describe("camera moves", () => {
  test("zooming keeps the point under the cursor still, within the limits", () => {
    const cam = { k: 10, tx: 100, ty: 50 };
    const world = { x: 30, y: 20 };
    const before = toScreen(world, cam);
    const after = toScreen(world, zoomAt(cam, 2, before.x, before.y, { min: 5, max: 40 }));
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    expect(zoomAt(cam, 100, 0, 0, { min: 5, max: 40 }).k).toBe(40);
  });

  test("moving to a star centers it beside the drawer, close enough to read", () => {
    const cam = cameraOnStar({ x: 50, y: 10 }, { k: 4, tx: 0, ty: 0 }, vp, 448);
    expect(cam.k).toBeGreaterThanOrEqual(LABEL_FONT_PX);
    const at = toScreen({ x: 50, y: 10 }, cam);
    expect(at.x).toBeCloseTo((vp.w - 448) / 2, 5);
    expect(at.y).toBeGreaterThan(vp.h * 0.4);
    expect(at.y).toBeLessThan(vp.h * 0.5);
  });

  test("on a phone, moving to a star centers it above the sheet", () => {
    const phone = { w: 390, h: 780 };
    const sheet = 390;
    const cam = cameraOnStar({ x: 50, y: 10 }, { k: 4, tx: 0, ty: 0 }, phone, 0, sheet);
    const at = toScreen({ x: 50, y: 10 }, cam);
    expect(at.x).toBeCloseTo(phone.w / 2, 5);
    // The dot and its label, centered together, sit in the uncovered top.
    expect(at.y).toBeGreaterThan((phone.h - sheet) * 0.3);
    expect(at.y).toBeLessThan((phone.h - sheet) / 2);
    // No bottom inset: the same star centers on the whole height, as before.
    const full = toScreen({ x: 50, y: 10 }, cameraOnStar({ x: 50, y: 10 }, { k: 4, tx: 0, ty: 0 }, phone));
    expect(full.y).toBeGreaterThan(phone.h * 0.4);
  });

  test("over a short sheet at the closest zoom, the star and its label stay above the sheet", () => {
    // A phone on its side: a 220px sky, the sheet over the bottom 132px, and
    // one star, which the kid can zoom far into.
    const one = star("s1", 0, 0);
    const short = { w: 568, h: 220 };
    const sheet = 132;
    const k = zoomLimits(fitSkyCamera([one], short).k).max;
    const at = toScreen(one, cameraOnStar(one, { k, tx: 0, ty: 0 }, short, 0, sheet));
    const labelBottom = at.y + (SKY_LABEL.dotEm / 2 + SKY_LABEL.maxLines * SKY_LABEL.lineEm) * LABEL_FONT_PX;
    expect(at.y).toBeGreaterThan(0);
    expect(labelBottom).toBeLessThanOrEqual(short.h - sheet);
    expect(at.x).toBeCloseTo(short.w / 2, 5);
  });
});

describe("the drawer's words", () => {
  const tz = "America/Los_Angeles";
  const oct31 = Date.UTC(2026, 9, 31, 19, 0);
  const now = Date.UTC(2026, 10, 16, 19, 0);

  test("a wonder says where and when it was asked", () => {
    expect(wonderAskedLine("quests", oct31, now, tz)).toBe("You asked on Quests · October 31");
    expect(wonderAskedLine("prep", oct31, now, tz)).toBe("You asked on Scholar’s Prep · October 31");
    expect(wonderAskedLine("build", oct31, now, tz)).toBe("You asked while building · October 31");
    expect(wonderAskedLine(null, oct31, now, tz)).toBe("You asked · October 31");
    expect(wonderAskedLine("quests", Date.UTC(2025, 9, 31, 19), now, tz)).toBe(
      "You asked on Quests · October 31, 2025",
    );
  });

  test("the date is the school's day", () => {
    // 2am UTC on November 1 is still October 31 in California.
    expect(wonderAskedLine("quests", Date.UTC(2026, 10, 1, 2), now, tz)).toBe(
      "You asked on Quests · October 31",
    );
  });

  test("a Quest says its kind and when it was shown", () => {
    expect(questShownLine("app", oct31, now, tz)).toBe("App · shown October 31");
    expect(questShownLine("slides", null, now, tz)).toBe("Slides");
    expect(questShownLine(null, oct31, now, tz)).toBe("Quest · shown October 31");
  });
});

describe("the BunnyPad's top bar", () => {
  test("a fitted sky centers in the space the top bar leaves", () => {
    const stars = grid(4, 3);
    const cam = fitSkyCamera(stars, { ...vp, top: 100 });
    const boxes = stars.map((s) => screenLabelBox(s, cam, cam.k));
    const top = Math.min(...boxes.map((b) => b.top));
    const bottom = Math.max(...boxes.map((b) => b.bottom));
    expect(top).toBeGreaterThanOrEqual(100);
    expect((top + bottom) / 2).toBeCloseTo(100 + (vp.h - 100) / 2, 5);
  });
});
