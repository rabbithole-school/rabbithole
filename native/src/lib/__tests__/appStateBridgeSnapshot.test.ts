import { describe, expect, it } from "vitest";

import * as appStateBridge from "../../../vendor/shared/appStateBridge.mjs";
import { APP_KIT_V2_FILES } from "../../../vendor/shared/appKit";
import {
  APP_SANDBOX_CSP,
  prepareCustomAppSandbox,
} from "../../../vendor/shared/customAppSandbox";
import { DOM_TO_IMAGE_SOURCE } from "../../../vendor/shared/domToImageSource";

const bridge = appStateBridge as typeof appStateBridge & {
  APP_SNAPSHOT_READY_TYPE: "rabbithole:snapshot:ready";
  APP_SNAPSHOT_RESULT_TYPE: "rabbithole:snapshot:result";
  RABBITHOLE_APP_SNAPSHOT_SDK: string;
  createAppSnapshotRequestMessage: (
    nonce: string,
    requestId: string,
    maxWidth?: number,
    width?: number,
    height?: number,
  ) => Record<string, unknown>;
};

describe("native app snapshot bridge vendor", () => {
  it("parses ready and successful result messages", () => {
    expect(
      bridge.parseAppStateBridgeMessage({
        protocol: bridge.APP_STATE_PROTOCOL,
        version: bridge.APP_STATE_PROTOCOL_VERSION,
        nonce: "nonce-1",
        type: bridge.APP_SNAPSHOT_READY_TYPE,
      }),
    ).toEqual({
      type: "rabbithole:snapshot:ready",
      nonce: "nonce-1",
    });
    expect(
      bridge.parseAppStateBridgeMessage({
        protocol: bridge.APP_STATE_PROTOCOL,
        version: bridge.APP_STATE_PROTOCOL_VERSION,
        nonce: "nonce-1",
        type: bridge.APP_SNAPSHOT_RESULT_TYPE,
        requestId: "request-1",
        dataUrl: "data:image/jpeg;base64,/9j/2Q==",
        hash: "abc123",
      }),
    ).toEqual({
      type: "rabbithole:snapshot:result",
      nonce: "nonce-1",
      requestId: "request-1",
      dataUrl: "data:image/jpeg;base64,/9j/2Q==",
      hash: "abc123",
    });
  });

  it("builds the nonce-bound host request used by injectJavaScript", () => {
    expect(
      bridge.createAppSnapshotRequestMessage(
        "nonce-1",
        "request-1",
        640,
        1024,
        768,
      ),
    ).toEqual({
      protocol: "rabbithole:app-state",
      version: 1,
      nonce: "nonce-1",
      type: "rabbithole:snapshot",
      requestId: "request-1",
      maxWidth: 640,
      width: 1024,
      height: 768,
    });
  });

  it("uses the React Native WebView channel and bundles snapshot capture inline", () => {
    expect(bridge.RABBITHOLE_APP_SNAPSHOT_SDK).toContain(
      "ReactNativeWebView.postMessage",
    );
    expect(bridge.RABBITHOLE_APP_SNAPSHOT_SDK).toContain(
      "__rabbitholeSnapshotReceive",
    );
    expect(bridge.RABBITHOLE_APP_SNAPSHOT_SDK).toContain(
      "document.querySelectorAll(\"canvas\")",
    );
    expect(bridge.RABBITHOLE_APP_SNAPSHOT_SDK).toContain(
      'n.tagName!=="CANVAS"&&n.tagName!=="SCRIPT"',
    );
    expect(bridge.injectAppStateSdk("<body>App</body>")).toContain(
      `<script>${DOM_TO_IMAGE_SOURCE}</script>`,
    );
    expect(bridge.RABBITHOLE_APP_STATE_SDK).toContain("askTutor:T");
  });

  it("ships and inlines the same v2 kit in native srcdoc", async () => {
    const sources = {
      "katex.inline.css": ".katex{display:inline-block}",
      "katex.min.js": "window.katex={render:function(){}};",
    } as const;
    const { csp, srcDoc } = await prepareCustomAppSandbox(
      '<link rel="stylesheet" href="/app-kit/v2/katex.inline.css"><script src="/app-kit/v2/katex.min.js"></script>',
      appStateBridge.injectAppStateSdk,
      async (file) => sources[file as keyof typeof sources],
    );

    expect(APP_KIT_V2_FILES).toEqual([
      "p5.min.js",
      "fraction.min.js",
      "katex.min.js",
      "katex.inline.css",
      "jsxgraph.min.js",
      "jsxgraph.min.css",
      "math.min.js",
      "three.iife.min.js",
      "rh-expression-editor.js",
      "rh-expression-editor.css",
    ]);
    expect(csp).toBe(APP_SANDBOX_CSP);
    expect(srcDoc).not.toContain('src="/app-kit/');
    expect(srcDoc).not.toContain('href="/app-kit/');
    expect(srcDoc).toContain(sources["katex.min.js"]);
    expect(srcDoc).toContain(sources["katex.inline.css"]);
  });

  it("allows one image and connection source for a shared storage path", async () => {
    const { csp, srcDoc } = await prepareCustomAppSandbox(
      '<img src="/app-assets/fish"><img src="/app-assets/reef">',
      appStateBridge.injectAppStateSdk,
      async () => undefined,
      (id) =>
        id === "fish"
          ? "https://assets.example/api/storage/fish-id"
          : "https://assets.example/api/storage/reef-id",
    );

    expect(csp).toContain(
      "img-src data: blob: https://assets.example/api/storage/;",
    );
    expect(csp).toContain(
      "connect-src https://assets.example/api/storage/;",
    );
    expect(
      csp.match(/https:\/\/assets\.example\/api\/storage\//g),
    ).toHaveLength(2);
    expect(
      csp.match(
        /img-src data: blob: https:\/\/assets\.example\/api\/storage\//g,
      ),
    ).toHaveLength(1);
    expect(
      csp.match(
        /connect-src https:\/\/assets\.example\/api\/storage\//g,
      ),
    ).toHaveLength(1);
    expect(csp).not.toContain("connect-src https://assets.example;");
    expect(srcDoc).not.toContain("/app-assets/");
    expect(srcDoc).toContain(
      "https://assets.example/api/storage/fish-id",
    );
    expect(srcDoc).toContain(
      "https://assets.example/api/storage/reef-id",
    );
  });

  it("keeps the zero-asset native CSP byte-identical", async () => {
    const { csp } = await prepareCustomAppSandbox(
      "<main>reef</main>",
      appStateBridge.injectAppStateSdk,
      async () => undefined,
    );

    expect(csp).toBe(APP_SANDBOX_CSP);
  });
});
