import { describe, expect, test } from "vitest";
import {
  CANVAS_MISSING_SCOPE_LINE,
  canvasErrorLine,
  composeCanvasBody,
} from "../slackCanvasReport";

describe("composeCanvasBody — shared teaser + best-effort canvas link", () => {
  const teaser = "AI spend this week: $12.00.";

  test("canvas link → teaser + link with the given open label", () => {
    const { body, mode } = composeCanvasBody({
      teaser,
      canvasUrl: "https://slack.example/canvas/123",
      canvasError: null,
      openLabel: "Open the full cost report →",
    });
    expect(mode).toBe("canvas");
    expect(body).toContain(teaser);
    expect(body).toContain("<https://slack.example/canvas/123|Open the full cost report →>");
  });

  test("missing_scope → teaser + the explicit scope-naming human-fix line", () => {
    const { body, mode } = composeCanvasBody({
      teaser,
      canvasUrl: null,
      canvasError: "missing_scope",
      openLabel: "x",
    });
    expect(mode).toBe("canvas_missing_scope");
    expect(body).toContain(CANVAS_MISSING_SCOPE_LINE);
  });

  test("other error → teaser + generic line carrying the code", () => {
    const { body, mode } = composeCanvasBody({
      teaser,
      canvasUrl: null,
      canvasError: "ratelimited",
      openLabel: "x",
    });
    expect(mode).toBe("canvas_error");
    expect(body).toContain(canvasErrorLine("ratelimited"));
  });

  test("not attempted (no url, no error) → teaser alone", () => {
    const { body, mode } = composeCanvasBody({
      teaser,
      canvasUrl: null,
      canvasError: null,
      openLabel: "x",
    });
    expect(mode).toBe("teaser");
    expect(body).toBe(teaser);
  });
});
