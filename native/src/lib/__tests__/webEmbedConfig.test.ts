import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalDev = (globalThis as { __DEV__?: boolean }).__DEV__;
const originalWebUrl = process.env.EXPO_PUBLIC_RABBITHOLE_WEB_URL;

beforeEach(() => {
  vi.resetModules();
  (globalThis as { __DEV__?: boolean }).__DEV__ = false;
  delete process.env.EXPO_PUBLIC_RABBITHOLE_WEB_URL;
});

afterEach(() => {
  if (originalDev === undefined) {
    delete (globalThis as { __DEV__?: boolean }).__DEV__;
  } else {
    (globalThis as { __DEV__?: boolean }).__DEV__ = originalDev;
  }
  if (originalWebUrl === undefined) {
    delete process.env.EXPO_PUBLIC_RABBITHOLE_WEB_URL;
  } else {
    process.env.EXPO_PUBLIC_RABBITHOLE_WEB_URL = originalWebUrl;
  }
});

describe("native Rabbithole web origin", () => {
  it("defaults production web content to the canonical host", async () => {
    const { rabbitholeWebBaseUrl, rabbitholeWebUrl } = await import("../webEmbedConfig");

    expect(rabbitholeWebBaseUrl).toBe("https://rabbithole.school");
    expect(rabbitholeWebUrl("/embed/manipulative")).toBe(
      "https://rabbithole.school/embed/manipulative",
    );
  });

  it("keeps explicit development and test overrides", async () => {
    process.env.EXPO_PUBLIC_RABBITHOLE_WEB_URL = "https://preview.example.test/";

    const { rabbitholeWebBaseUrl } = await import("../webEmbedConfig");

    expect(rabbitholeWebBaseUrl).toBe("https://preview.example.test");
  });
});
