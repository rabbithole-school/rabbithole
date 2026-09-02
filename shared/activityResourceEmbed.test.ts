import { describe, expect, test } from "vitest";

import {
  activityResourceEmbedUrl,
  youtubeVideoId,
} from "./activityResourceEmbed";

describe("activity resource embeds", () => {
  test.each([
    "https://www.youtube.com/watch?v=lZUyUkJMc3U",
    "https://youtu.be/lZUyUkJMc3U",
    "https://www.youtube.com/embed/lZUyUkJMc3U",
    "https://youtube.com/shorts/lZUyUkJMc3U",
    "https://youtube.com/live/lZUyUkJMc3U",
  ])("extracts a YouTube id from %s", (url) => {
    expect(youtubeVideoId(url)).toBe("lZUyUkJMc3U");
  });

  test("converts videos to a privacy-enhanced in-app player URL", () => {
    expect(
      activityResourceEmbedUrl({
        kind: "video",
        url: "https://www.youtube.com/watch?v=lZUyUkJMc3U",
      }),
    ).toBe(
      "https://www.youtube-nocookie.com/embed/lZUyUkJMc3U" +
        "?playsinline=1&rel=0&iv_load_policy=3&disablekb=1&color=white" +
        "&cc_load_policy=1&cc_lang_pref=en",
    );
  });

  test("keeps files and websites at their authored URL", () => {
    expect(
      activityResourceEmbedUrl({
        kind: "link",
        url: "https://example.com/field-guide",
      }),
    ).toBe("https://example.com/field-guide");
    expect(activityResourceEmbedUrl({ kind: "file", url: null })).toBeNull();
  });
});
