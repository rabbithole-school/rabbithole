import { createElement, type ElementType } from "react";
import { act, create } from "react-test-renderer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Id } from "@/lib/convex";
import type {
  closeEmbeddedWebContent as CloseEmbeddedWebContentFn,
  openWebActivity as OpenWebActivityFn,
  openYouTubeVideo as OpenYouTubeVideoFn,
  useOpenEmbeddedWebContent as UseOpenEmbeddedWebContentFn,
} from "../externalAppHost";

const devGlobal = globalThis as { __DEV__?: boolean };
const originalDev = devGlobal.__DEV__;

let closeEmbeddedWebContent: typeof CloseEmbeddedWebContentFn;
let openWebActivity: typeof OpenWebActivityFn;
let openYouTubeVideo: typeof OpenYouTubeVideoFn;
let useOpenEmbeddedWebContent: typeof UseOpenEmbeddedWebContentFn;

beforeAll(async () => {
  devGlobal.__DEV__ = false;
  const mod = await import("../externalAppHost");
  closeEmbeddedWebContent = mod.closeEmbeddedWebContent;
  openWebActivity = mod.openWebActivity;
  openYouTubeVideo = mod.openYouTubeVideo;
  useOpenEmbeddedWebContent = mod.useOpenEmbeddedWebContent;
});

afterAll(() => {
  if (originalDev === undefined) {
    delete devGlobal.__DEV__;
  } else {
    devGlobal.__DEV__ = originalDev;
  }
});

// Capture the store content emitted by a real opener call, driven through the
// live external-store hook (no mocking — asserts the actual field set callers
// get). `act` wraps both the mount and the store update.
const PROBE = "embedded-web-content" as unknown as ElementType;

function Harness() {
  return createElement(PROBE, { content: useOpenEmbeddedWebContent() });
}

async function captureOpen(open: () => void) {
  closeEmbeddedWebContent();
  let tree!: ReturnType<typeof create>;
  await act(async () => {
    tree = create(createElement(Harness));
  });
  await act(async () => {
    open();
  });
  const content = tree.root.findByType(PROBE).props.content;
  await act(async () => tree.unmount());
  return content;
}

describe("external app host requests", () => {
  it("recognizes relative and absolute Rabbithole custom-app token URLs", async () => {
    const { externalAppHostRequestForUrl } = await import("../externalAppHost");
    const { rabbitholeWebBaseUrl } = await import("../webEmbedConfig");

    expect(
      externalAppHostRequestForUrl("/custom-apps?token=static-token"),
    ).toEqual({
      kind: "customApp",
      token: "static-token",
    });
    expect(
      externalAppHostRequestForUrl(
        new URL(
          "/custom-apps?token=absolute-token",
          `${rabbitholeWebBaseUrl}/`,
        ).toString(),
      ),
    ).toEqual({
      kind: "customApp",
      token: "absolute-token",
    });
  });

  it("keeps nonmatching and invalid token URLs on the URL host", async () => {
    const { externalAppHostRequestForUrl } = await import("../externalAppHost");

    expect(
      externalAppHostRequestForUrl(
        "https://example.com/custom-apps?token=foreign-token",
      ),
    ).toEqual({ kind: "url" });
    expect(externalAppHostRequestForUrl("/custom-apps")).toEqual({
      kind: "url",
    });
    expect(
      externalAppHostRequestForUrl("/custom-apps?token=%20%20"),
    ).toEqual({ kind: "url" });
    expect(externalAppHostRequestForUrl("not a valid absolute URL")).toEqual({
      kind: "url",
    });
  });

  it("does not persist the bearer-token URL in native custom-app heartbeats", async () => {
    const { nativeCustomAppHeartbeatArgs } = await import("../externalAppHost");
    const sessionId = "web-session-1" as import("@/lib/convex").Id<"webActivitySessions">;

    const args = nativeCustomAppHeartbeatArgs(sessionId);

    expect(args).toEqual({ sessionId, lastUrl: undefined });
    expect(args.lastUrl).toBeUndefined();
  });
});

describe("openWebActivity YouTube routing", () => {
  const launch = (activity: Parameters<typeof openWebActivity>[0]) =>
    captureOpen(() => openWebActivity(activity));

  it("routes a YouTube web activity into the sandboxed nocookie player", async () => {
    const content = await launch({
      activityId: "activity-yt" as Id<"activities">,
      title: "Photosynthesis",
      url: "https://www.youtube.com/watch?v=lZUyUkJMc3U",
      allowedHosts: null,
    });

    // Lifecycle-defining kind is preserved so webActivitySessions is unchanged.
    expect(content.kind).toBe("webActivity");
    expect(content.activityId).toBe("activity-yt");
    // …but it now plays through the locked YouTube player, not youtube.com.
    expect(content.navigationPolicy).toBe("youtube");
    expect(content.gestureMode).toBe("page");
    expect(content.url).toContain("youtube-nocookie.com/embed/lZUyUkJMc3U");
    expect(content.documentHtml).toContain("enablejsapi=1");
    // Player hosts are set explicitly so the allowlist watchdog does not count
    // them as off-domain blocks.
    expect(content.allowedHosts).toContain("youtube-nocookie.com");
  });

  it("leaves a non-YouTube web activity byte-for-byte unchanged", async () => {
    const content = await launch({
      activityId: "activity-web" as Id<"activities">,
      title: "Practice site",
      url: "https://example.com/learn",
      allowedHosts: ["example.com"],
      gestureMode: "page",
    });

    expect(content.kind).toBe("webActivity");
    expect(content.activityId).toBe("activity-web");
    expect(content.url).toBe("https://example.com/learn");
    expect(content.allowedHosts).toEqual(["example.com"]);
    expect(content.gestureMode).toBe("page");
    expect(content.navigationPolicy).toBeUndefined();
    expect(content.documentHtml).toBeUndefined();
    expect(content.documentBaseUrl).toBeUndefined();
  });
});

describe("openYouTubeVideo", () => {
  it("routes a YouTube link into the sandboxed interactive player", async () => {
    let handled: boolean | undefined;
    const content = await captureOpen(() => {
      handled = openYouTubeVideo({
        url: "https://www.youtube.com/watch?v=lZUyUkJMc3U",
        title: "Photosynthesis explained",
      });
    });

    expect(handled).toBe(true);
    expect(content.kind).toBe("interactive");
    expect(content.title).toBe("Photosynthesis explained");
    expect(content.navigationPolicy).toBe("youtube");
    expect(content.gestureMode).toBe("page");
    expect(content.documentBaseUrl).toBe(
      "https://www.youtube-nocookie.com",
    );
    expect(content.url).toContain("youtube-nocookie.com/embed/lZUyUkJMc3U");
    expect(content.allowedHosts).toContain("youtube-nocookie.com");
    expect(content.documentHtml).toContain("enablejsapi=1");
  });

  it("handles youtu.be short links", async () => {
    let handled: boolean | undefined;
    const content = await captureOpen(() => {
      handled = openYouTubeVideo({
        url: "https://youtu.be/lZUyUkJMc3U",
        title: "Clip",
      });
    });
    expect(handled).toBe(true);
    expect(content.kind).toBe("interactive");
    expect(content.url).toContain("youtube-nocookie.com/embed/lZUyUkJMc3U");
  });

  it("returns false for a non-YouTube link without opening anything", async () => {
    let handled: boolean | undefined;
    const content = await captureOpen(() => {
      handled = openYouTubeVideo({
        url: "https://example.com/article",
        title: "An article",
      });
    });
    expect(handled).toBe(false);
    expect(content).toBeNull();
  });
});
