import { describe, expect, it } from "vitest";

import {
  RABBITHOLE_APP_STYLESHEET,
  RABBITHOLE_APP_STYLE_ELEMENT,
} from "./rabbitholeAppStyles";
import {
  injectAppStateSdk,
  RABBITHOLE_APP_STATE_SDK,
} from "../lib/appStateBridge.mjs";
import {
  APP_SANDBOX_CSP,
  prepareCustomAppSandbox,
} from "./customAppSandbox";
import { DOM_TO_IMAGE_SOURCE } from "./domToImageSource";

describe("rabbithole-app.css brand stylesheet", () => {
  it("inlines the Hanken Grotesk font as a data URI so it needs no network", () => {
    expect(RABBITHOLE_APP_STYLESHEET).toContain("@font-face");
    expect(RABBITHOLE_APP_STYLESHEET).toContain("font-family: 'Hanken Grotesk'");
    expect(RABBITHOLE_APP_STYLESHEET).toContain("src: url(data:font/woff2;base64,");
    // No webfont/CDN fetch — the strict custom-app CSP would block it.
    expect(RABBITHOLE_APP_STYLESHEET).not.toMatch(/https?:\/\//);
  });

  it("defines the brand control defaults, classes, and custom properties", () => {
    for (const token of ["--rh-primary", "--rh-bg", "--rh-fg", "--rh-radius-md"]) {
      expect(RABBITHOLE_APP_STYLESHEET).toContain(token);
    }
    for (const cls of [".rh-card", ".rh-toolbar", ".rh-banner", ".rh-chip"]) {
      expect(RABBITHOLE_APP_STYLESHEET).toContain(cls);
    }
    // The purple primary + the cyan rehearsal-banner fill are the brand anchors.
    expect(RABBITHOLE_APP_STYLESHEET).toContain("#a960bc");
    expect(RABBITHOLE_APP_STYLESHEET).toContain("#f0fbfc");
    // 44px touch targets on interactive controls.
    expect(RABBITHOLE_APP_STYLESHEET).toContain("--rh-touch: 44px");
  });
});

describe("brand stylesheet injection through the shared bridge path", () => {
  const app =
    "<!doctype html><html><head></head><body><button>Go</button></body></html>";

  it("is injected by the workshop host after the bridge scripts, before app markup", () => {
    const out = injectAppStateSdk(app);
    const libraryScript = `<script>${DOM_TO_IMAGE_SOURCE}</script>`;
    const stateScript = `<script>${RABBITHOLE_APP_STATE_SDK}</script>`;
    const libraryIndex = out.indexOf(libraryScript);
    const snapshotIndex = out.indexOf(
      "<script>",
      libraryIndex + libraryScript.length,
    );
    const stateIndex = out.indexOf(stateScript);
    const styleIndex = out.indexOf(RABBITHOLE_APP_STYLE_ELEMENT);
    const appIndex = out.indexOf("<button>Go</button>");

    expect(libraryIndex).toBeGreaterThanOrEqual(0);
    expect(snapshotIndex).toBeGreaterThanOrEqual(
      libraryIndex + libraryScript.length,
    );
    expect(stateIndex).toBeGreaterThan(snapshotIndex);
    expect(styleIndex).toBeGreaterThanOrEqual(stateIndex + stateScript.length);
    expect(appIndex).toBeGreaterThanOrEqual(
      styleIndex + RABBITHOLE_APP_STYLE_ELEMENT.length,
    );
  });

  it("reaches the custom-app host too, under a CSP that allows the data-URI font", async () => {
    const { csp, srcDoc } = await prepareCustomAppSandbox(
      app,
      injectAppStateSdk,
    );
    expect(srcDoc).toContain(RABBITHOLE_APP_STYLE_ELEMENT);
    // font-src data: is what lets the inlined @font-face load under default-src 'none'.
    expect(csp).toContain("font-src data:");
    expect(APP_SANDBOX_CSP).toContain("font-src data:");
  });
});
