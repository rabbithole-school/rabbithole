// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

import { nativeAppSnapshotInjectionScript } from "../nativeAppSnapshotCapture";

type SnapshotOptions = {
  quality: number;
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
    toJpeg: (
      root: HTMLElement,
      options: SnapshotOptions,
    ) => Promise<string>;
  };
};

const drawImage = vi.fn();
const toDataURL = vi.fn(() => "data:image/jpeg;base64,composite");

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

function runCapture(toJpeg: NonNullable<SnapshotWindow["domtoimage"]>["toJpeg"]) {
  const snapshotWindow = window as SnapshotWindow;
  const result = new Promise<Record<string, unknown>>((resolve) => {
    snapshotWindow.ReactNativeWebView = {
      postMessage: (value) => resolve(JSON.parse(value)),
    };
  });
  snapshotWindow.domtoimage = { toJpeg };
  window.eval(
    nativeAppSnapshotInjectionScript(JSON.stringify(request), 100, 800),
  );
  return result;
}

describe("nativeAppSnapshotInjectionScript", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    drawImage.mockClear();
    toDataURL.mockClear();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(
      toDataURL,
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

  it("captures cloned canvases without changing the live DOM", async () => {
    const canvases = addCanvases();
    const displays = canvases.map((canvas) => canvas.style.display);
    let options: SnapshotOptions | undefined;
    const toJpeg = vi.fn(async (
      _root: HTMLElement,
      receivedOptions: SnapshotOptions,
    ) => {
      options = receivedOptions;
      return "data:image/jpeg;base64,capture";
    });

    await expect(runCapture(toJpeg)).resolves.toMatchObject({
      type: "rabbithole:snapshot:result",
      requestId: "request-1",
      dataUrl: "data:image/jpeg;base64,composite",
    });

    expectCanvasDomUnchanged(canvases, displays);
    expect(options).toMatchObject({
      quality: 0.7,
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
    expect(options?.filter(document.createElement("script"))).toBe(false);
    expect(options?.filter(document.createElement("canvas"))).toBe(false);
    expect(drawImage).toHaveBeenCalledTimes(3);
    expect(drawImage.mock.calls[1]?.[0]).toBe(canvases[0]);
    expect(drawImage.mock.calls[2]?.[0]).toBe(canvases[1]);
  });

  it("leaves canvases untouched when dom-to-image throws", async () => {
    const canvases = addCanvases();
    const displays = canvases.map((canvas) => canvas.style.display);
    const toJpeg = vi.fn(async () => {
      throw new Error("capture failed");
    });

    await expect(runCapture(toJpeg)).resolves.toMatchObject({
      type: "rabbithole:snapshot:result",
      requestId: "request-1",
      error: "capture failed",
    });

    expectCanvasDomUnchanged(canvases, displays);
  });
});
