import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { SlideCanvasElementContent } from "./SlideCanvas";

const frame = { x: 0, y: 0, w: 100, h: 100, rotation: 0 };

function image(alt: string) {
  return { id: "image", type: "image" as const, assetId: "asset", alt, frame };
}

function video(alt: string) {
  return { id: "video", type: "video" as const, assetId: "asset", alt, frame };
}

describe("SlideCanvas media accessibility", () => {
  test("treats whitespace-only alt text as empty for a resolved image", () => {
    const html = renderToStaticMarkup(
      createElement(SlideCanvasElementContent, {
        el: image(" \n "),
        readOnly: true,
        resolveAsset: () => "https://example.com/image.png",
      }),
    );

    expect(html).toContain('alt=""');
  });

  test("uses a trimmed nonblank label for an image fallback", () => {
    const html = renderToStaticMarkup(
      createElement(SlideCanvasElementContent, {
        el: image("  A mountain  "),
        readOnly: true,
      }),
    );

    expect(html).toContain(">A mountain</span>");
  });

  test("uses normalized video alt text as the resolved video label", () => {
    const html = renderToStaticMarkup(
      createElement(SlideCanvasElementContent, {
        el: video("  A waterfall  "),
        readOnly: true,
        resolveAsset: () => "https://example.com/video.mp4",
      }),
    );

    expect(html).toContain('aria-label="A waterfall"');
  });

  test("uses the default label for a video fallback with whitespace-only alt text", () => {
    const html = renderToStaticMarkup(
      createElement(SlideCanvasElementContent, {
        el: video(" \n "),
        readOnly: true,
      }),
    );

    expect(html).toContain(">Video</span>");
  });
});
