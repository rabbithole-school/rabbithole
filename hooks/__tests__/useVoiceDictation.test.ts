// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useVoiceDictation } from "../useVoiceDictation";

const { transcribe } = vi.hoisted(() => ({ transcribe: vi.fn() }));
vi.mock("convex/react", () => ({ useAction: () => transcribe }));
vi.mock("@/lib/native", () => ({ haptic: vi.fn() }));
vi.mock("@/lib/voicePerf", () => ({ voiceMark: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fakeStream() {
  const stop = vi.fn();
  return { stop, getTracks: () => [{ stop }] };
}

class Recorder {
  static isTypeSupported = () => true;
  state = "inactive";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => Promise<void>) | null = null;
  stopped: Promise<void> | undefined;
  constructor(public stream: ReturnType<typeof fakeStream>) {}
  start() { this.state = "recording"; }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["audio"]) });
    this.stopped = this.onstop?.();
  }
}

let root: Root;
let container: HTMLDivElement;
let controls: ReturnType<typeof useVoiceDictation>;
let levelFrame: FrameRequestCallback;
const getUserMedia = vi.fn();
const onTranscript = vi.fn();

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  vi.stubGlobal("MediaRecorder", Recorder);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    levelFrame = callback;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("AudioContext", class {
    createMediaStreamSource() { return { connect: vi.fn() }; }
    createAnalyser() {
      return {
        fftSize: 256,
        getFloatTimeDomainData: (array: Float32Array) => array.fill(0.1),
      };
    }
    close() { return Promise.resolve(); }
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  function Probe() {
    controls = useVoiceDictation(onTranscript);
    return null;
  }
  act(() => root.render(createElement(Probe)));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("dictation cancellation", () => {
  it("stops a stream granted after the card was dismissed", async () => {
    const permission = deferred<ReturnType<typeof fakeStream>>();
    getUserMedia.mockReturnValueOnce(permission.promise);
    let start!: Promise<void>;
    act(() => { start = controls.startRecording(); });
    act(() => controls.cancelRecording());
    const stream = fakeStream();
    await act(async () => {
      permission.resolve(stream);
      await start;
    });
    expect(stream.stop).toHaveBeenCalledOnce();
    expect(controls.state).toBe("idle");
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("does not let an old permission result interrupt a new take", async () => {
    const permission = deferred<ReturnType<typeof fakeStream>>();
    getUserMedia.mockReturnValueOnce(permission.promise);
    let oldStart!: Promise<void>;
    act(() => { oldStart = controls.startRecording(); });
    act(() => controls.cancelRecording());
    const currentStream = fakeStream();
    getUserMedia.mockResolvedValueOnce(currentStream);
    await act(async () => { await controls.startRecording(); });
    const oldStream = fakeStream();
    await act(async () => {
      permission.resolve(oldStream);
      await oldStart;
    });
    expect(oldStream.stop).toHaveBeenCalledOnce();
    expect(currentStream.stop).not.toHaveBeenCalled();
    expect(controls.state).toBe("recording");
  });

  it("releases the microphone synchronously without transcribing", async () => {
    const stream = fakeStream();
    getUserMedia.mockResolvedValueOnce(stream);
    await act(async () => { await controls.startRecording(); });
    act(() => levelFrame(0));
    act(() => controls.cancelRecording());
    expect(stream.stop).toHaveBeenCalled();
    expect(controls.state).toBe("idle");
    expect(transcribe).not.toHaveBeenCalled();
    expect(onTranscript).not.toHaveBeenCalled();
  });

  it("ignores an old transcription after cancellation and a new take", async () => {
    const transcript = deferred<{ text: string }>();
    transcribe.mockReturnValueOnce(transcript.promise);
    getUserMedia.mockResolvedValueOnce(fakeStream());
    await act(async () => { await controls.startRecording(); });
    act(() => levelFrame(0));
    act(() => controls.stopRecording());
    await act(async () => {
      await vi.waitFor(() => expect(transcribe).toHaveBeenCalledOnce());
    });
    expect(controls.state).toBe("transcribing");
    act(() => controls.cancelRecording());
    getUserMedia.mockResolvedValueOnce(fakeStream());
    await act(async () => { await controls.startRecording(); });
    await act(async () => { transcript.resolve({ text: "Discard this take." }); });
    expect(onTranscript).not.toHaveBeenCalled();
    expect(controls.state).toBe("recording");
  });

  it("still delivers an uncancelled take", async () => {
    transcribe.mockResolvedValueOnce({ text: "Keep this take." });
    getUserMedia.mockResolvedValueOnce(fakeStream());
    await act(async () => { await controls.startRecording(); });
    act(() => levelFrame(0));
    act(() => controls.stopRecording());
    await act(async () => {
      await vi.waitFor(() => expect(onTranscript).toHaveBeenCalledWith("Keep this take."));
    });
    expect(controls.state).toBe("idle");
  });
});
