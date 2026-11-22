// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { nativeAppSnapshotInjectionScript } from "../nativeAppSnapshotCapture";

type SnapshotOptions = {
  bgcolor: string;
  width: number;
  height: number;
  filter: (node: Element) => boolean;
  style: {
    transform: string;
    transformOrigin: string;
    width: string;
    height: string;
  };
};

type SnapshotWindow = Window & {
  Image?: unknown;
  ReactNativeWebView?: {
    postMessage: (value: string) => void;
  };
  domtoimage?: {
    toSvg: (
      root: HTMLElement,
      options: SnapshotOptions,
    ) => Promise<string>;
  };
};

const drawImage = vi.fn();
const fillRect = vi.fn();
const toDataURL = vi.fn(() => "data:image/jpeg;base64,painted");
const SVG = "data:image/svg+xml;charset=utf-8,<svg/>";

const request = {
  protocol: "rabbithole:app-state",
  version: 1,
  nonce: "test-nonce",
  type: "rabbithole:snapshot",
  requestId: "request-1",
  width: 1_000,
  height: 500,
  maxWidth: 800,
};

function addCanvases() {
  document.body.innerHTML = `
    <main>
      <canvas id="first" width="120" height="80" style="display: block"></canvas>
      <canvas id="second" width="120" height="80"></canvas>
      <canvas id="unsized" width="0" height="0"></canvas>
      <canvas id="hidden" width="120" height="80" style="display: none"></canvas>
      <h1 id="hud">Score 12</h1>
    </main>
  `;
  return [...document.querySelectorAll("canvas")];
}

function expectCanvasDomUnchanged(
  canvases: HTMLCanvasElement[],
  displays: string[],
) {
  expect(canvases.map((canvas) => canvas.style.display)).toEqual(displays);
  expect(document.querySelectorAll("img")).toHaveLength(0);
}

// The paint step pauses between repaints, so the capture settles only after the
// fake clock moves past those pauses.
async function runCapture(
  toSvg: NonNullable<SnapshotWindow["domtoimage"]>["toSvg"],
) {
  const snapshotWindow = window as SnapshotWindow;
  const result = new Promise<Record<string, unknown>>((resolve) => {
    snapshotWindow.ReactNativeWebView = {
      postMessage: (value) => resolve(JSON.parse(value)),
    };
  });
  snapshotWindow.domtoimage = { toSvg };
  window.eval(
    nativeAppSnapshotInjectionScript(JSON.stringify(request), 6_000, 800),
  );
  await vi.advanceTimersByTimeAsync(1_000);
  return await result;
}

describe("nativeAppSnapshotInjectionScript", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = "";
    drawImage.mockClear();
    fillRect.mockClear();
    toDataURL.mockClear();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage,
      fillRect,
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(
      toDataURL,
    );
    // jsdom has no layout, so stand in for it: a canvas is on screen unless
    // it is display: none.
    vi.spyOn(HTMLCanvasElement.prototype, "getClientRects").mockImplementation(
      function (this: HTMLCanvasElement) {
        return (this.style.display === "none"
          ? []
          : [{}]) as unknown as DOMRectList;
      },
    );
    vi.spyOn(
      HTMLCanvasElement.prototype,
      "getBoundingClientRect",
    ).mockReturnValue({
      x: 10,
      y: 20,
      left: 10,
      top: 20,
      right: 130,
      bottom: 100,
      width: 120,
      height: 80,
      toJSON: () => ({}),
    });
    const snapshotWindow = window as SnapshotWindow;
    snapshotWindow.Image = class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    } as unknown as typeof Image;
    delete snapshotWindow.ReactNativeWebView;
    delete snapshotWindow.domtoimage;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders canvases in place, so what the app layers over them stays on top", async () => {
    // Drawing canvases over the rendered page hid any HUD above a full-screen
    // canvas (TRA-592). Now they render in place and the page is painted from
    // the SVG alone, more than once, because WebKit decodes the images inside
    // an SVG only after its first draw.
    const canvases = addCanvases();
    const displays = canvases.map((canvas) => canvas.style.display);
    let options: SnapshotOptions | undefined;
    const toSvg = vi.fn(async (
      _root: HTMLElement,
      receivedOptions: SnapshotOptions,
    ) => {
      options = receivedOptions;
      return SVG;
    });

    await expect(runCapture(toSvg)).resolves.toMatchObject({
      type: "rabbithole:snapshot:result",
      requestId: "request-1",
      dataUrl: "data:image/jpeg;base64,painted",
    });

    expectCanvasDomUnchanged(canvases, displays);
    expect(toSvg).toHaveBeenCalledWith(document.body, expect.anything());
    expect(options).toMatchObject({
      bgcolor: "#fff",
      width: 800,
      height: 400,
      style: {
        transform: "scale(0.8)",
        transformOrigin: "top left",
        width: "1000px",
        height: "500px",
      },
    });
    const [first, second, unsized, hidden] = canvases;
    expect(options?.filter(first)).toBe(true);
    expect(options?.filter(second)).toBe(true);
    expect(options?.filter(document.getElementById("hud")!)).toBe(true);
    expect(options?.filter(unsized)).toBe(false);
    expect(options?.filter(hidden)).toBe(false);
    expect(options?.filter(document.createElement("script"))).toBe(false);
    expect(drawImage.mock.calls.length).toBeGreaterThan(1);
    for (const [source] of drawImage.mock.calls) {
      expect(source).not.toBeInstanceOf(HTMLCanvasElement);
    }
  });

  it("leaves out an image with no pixels, which dom-to-image cannot download", async () => {
    // An app that fills an <img> in later (a hover card, say) leaves it with no
    // src. dom-to-image downloads every image it copies, and in the iPad's
    // about:blank document XMLHttpRequest.open("") throws, so before this the
    // whole capture failed whenever such an image was on the page.
    document.body.innerHTML = `
      <div id="card"><img id="later" alt="Filled in on hover"></div>
      <img id="loaded" src="data:image/png;base64,iVBORw0KGgo=">
    `;
    const loaded = document.getElementById("loaded") as HTMLImageElement;
    Object.defineProperty(loaded, "complete", { value: true });
    Object.defineProperty(loaded, "naturalWidth", { value: 40 });
    const pending = document.createElement("img");
    pending.src = "https://assets.example/api/storage/flag";
    Object.defineProperty(pending, "complete", { value: false });
    let options: SnapshotOptions | undefined;
    const toSvg = vi.fn(async (
      _root: HTMLElement,
      receivedOptions: SnapshotOptions,
    ) => {
      options = receivedOptions;
      return SVG;
    });

    await expect(runCapture(toSvg)).resolves.toMatchObject({
      dataUrl: "data:image/jpeg;base64,painted",
    });

    const later = document.getElementById("later") as HTMLImageElement;
    expect(options?.filter(later)).toBe(false);
    expect(options?.filter(loaded)).toBe(true);
    expect(options?.filter(pending)).toBe(true);
    expect(options?.filter(document.getElementById("card")!)).toBe(true);
    expect(later.hasAttribute("src")).toBe(false);
  });

  it("leaves canvases untouched when dom-to-image throws", async () => {
    const canvases = addCanvases();
    const displays = canvases.map((canvas) => canvas.style.display);
    const toSvg = vi.fn(async () => {
      throw new Error("capture failed");
    });

    await expect(runCapture(toSvg)).resolves.toMatchObject({
      type: "rabbithole:snapshot:result",
      requestId: "request-1",
      error: "capture failed",
    });

    expectCanvasDomUnchanged(canvases, displays);
  });
});
