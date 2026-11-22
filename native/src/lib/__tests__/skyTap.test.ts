import { describe, expect, test } from "vitest";
import {
  LABEL_FONT_PX,
  screenLabelBox,
  type SkyStarLike,
} from "../../../vendor/shared/yourSkyModel";
import { STAR_HIT_RADIUS_PX, starAtPoint } from "../skyTap";

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

describe("starAtPoint", () => {
  test("a tap lands on the nearest dot within a finger's reach", () => {
    const a = star("s1", 0, 0);
    const b = star("s2", 3, 0);
    const cam = { k: 10, tx: 100, ty: 100 };
    // 12pt from s1, 18pt from s2.
    expect(starAtPoint([a, b], cam, 112, 100)?.id).toBe("s1");
    expect(starAtPoint([a, b], cam, 100, 100 + STAR_HIT_RADIUS_PX - 1)?.id).toBe("s1");
    expect(starAtPoint([a, b], cam, 100, 100 + STAR_HIT_RADIUS_PX + 30)).toBeNull();
  });

  test("a tap on a shown label opens its star; on a hidden one it doesn't", () => {
    const s = star("s1", 0, 0, { label: "How do bats find bugs in the dark?" });
    const cam = { k: LABEL_FONT_PX, tx: 300, ty: 300 };
    const box = screenLabelBox(s, cam);
    const x = box.left + 4;
    const y = box.bottom - 4;
    expect(starAtPoint([s], cam, x, y, new Set(["s1"]))?.id).toBe("s1");
    expect(starAtPoint([s], cam, x, y, new Set())).toBeNull();
  });
});
