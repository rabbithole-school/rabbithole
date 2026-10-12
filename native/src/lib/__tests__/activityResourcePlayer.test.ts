import { describe, expect, test } from "vitest";

import {
  buildYouTubeResourceDocument,
  isAllowedYouTubeResourceUrl,
  youTubePlayerContent,
  YOUTUBE_RESOURCE_BASE_URL,
} from "../activityResourcePlayer";

describe("activity resource YouTube player", () => {
  test("allows player traffic but blocks YouTube escape routes", () => {
    expect(
      isAllowedYouTubeResourceUrl(
        "https://www.youtube-nocookie.com/embed/lZUyUkJMc3U",
      ),
    ).toBe(true);
    expect(
      isAllowedYouTubeResourceUrl("https://www.youtube.com/iframe_api"),
    ).toBe(true);
    expect(
      isAllowedYouTubeResourceUrl(
        "https://rr1---sn.example.googlevideo.com/videoplayback",
      ),
    ).toBe(true);
    expect(
      isAllowedYouTubeResourceUrl(
        "https://www.youtube.com/watch?v=lZUyUkJMc3U",
      ),
    ).toBe(false);
    expect(
      isAllowedYouTubeResourceUrl("https://www.youtube.com/@some-channel"),
    ).toBe(false);
    expect(
      isAllowedYouTubeResourceUrl("https://www.google.com/search?q=games"),
    ).toBe(false);
    expect(isAllowedYouTubeResourceUrl("https://example.com")).toBe(false);
  });

  test("builds a referrer-identified player that removes the end screen", () => {
    const html = buildYouTubeResourceDocument(
      "https://www.youtube-nocookie.com/embed/lZUyUkJMc3U?playsinline=1",
    );

    expect(html).toContain("enablejsapi=1");
    expect(html).toContain(encodeURIComponent(YOUTUBE_RESOURCE_BASE_URL));
    expect(html).toContain("player.getDuration()");
    expect(html).toContain("frame.style.visibility = 'hidden'");
    expect(html).toContain("Watch again");
  });
});

describe("youTubePlayerContent", () => {
  test("builds the locked sandbox player field set for a YouTube link", () => {
    const content = youTubePlayerContent(
      "https://www.youtube.com/watch?v=lZUyUkJMc3U",
    );
    expect(content).not.toBeNull();
    expect(content?.navigationPolicy).toBe("youtube");
    expect(content?.gestureMode).toBe("page");
    expect(content?.documentBaseUrl).toBe(YOUTUBE_RESOURCE_BASE_URL);
    expect(content?.url).toContain("youtube-nocookie.com/embed/lZUyUkJMc3U");
    expect(content?.allowedHosts).toContain("youtube-nocookie.com");
    expect(content?.documentHtml).toContain("enablejsapi=1");
  });

  test("returns null for a non-YouTube URL so the caller keeps its own shape", () => {
    expect(youTubePlayerContent("https://example.com/learn")).toBeNull();
  });
});
