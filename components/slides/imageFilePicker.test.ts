import { afterEach, describe, expect, it, vi } from "vitest";
import {
  pickImageFileWithEnvironment,
  type ImagePickerEnvironment,
  type ImagePickerInput,
} from "./imageFilePicker";

type TestFile = { name: string };
type PickerEvent = "change" | "cancel";
type Listener = () => void;

class TestFileList {
  constructor(private readonly file: TestFile) {}

  item(index: number) {
    return index === 0 ? this.file : null;
  }
}

class FakeInput implements ImagePickerInput<TestFile> {
  type = "";
  accept = "";
  files: TestFileList | null = null;
  removed = false;
  clicks = 0;
  clickError: Error | null = null;
  private readonly listeners = new Map<PickerEvent, Set<Listener>>([
    ["change", new Set()],
    ["cancel", new Set()],
  ]);

  addEventListener(event: PickerEvent, listener: Listener) {
    this.listeners.get(event)?.add(listener);
  }

  removeEventListener(event: PickerEvent, listener: Listener) {
    this.listeners.get(event)?.delete(listener);
  }

  click() {
    this.clicks += 1;
    if (this.clickError) throw this.clickError;
  }

  remove() {
    this.removed = true;
  }

  emit(event: PickerEvent) {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }

  listenerCount() {
    return [...this.listeners.values()].reduce((count, listeners) => count + listeners.size, 0);
  }
}

class FakePickerEnvironment
  implements ImagePickerEnvironment<TestFile, ReturnType<typeof setTimeout>>
{
  readonly input = new FakeInput();
  private readonly focusListeners = new Set<Listener>();

  createInput() {
    return this.input;
  }

  addFocusListener(listener: Listener) {
    this.focusListeners.add(listener);
  }

  removeFocusListener(listener: Listener) {
    this.focusListeners.delete(listener);
  }

  setTimer(callback: () => void) {
    return setTimeout(callback, 0);
  }

  clearTimer(timer: ReturnType<typeof setTimeout>) {
    clearTimeout(timer);
  }

  focus() {
    for (const listener of this.focusListeners) listener();
  }

  get focusListenerCount() {
    return this.focusListeners.size;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("pickImageFileWithEnvironment", () => {
  it("settles null when focus returns without change or cancel", async () => {
    vi.useFakeTimers();
    const environment = new FakePickerEnvironment();
    const picked = pickImageFileWithEnvironment(environment);

    environment.focus();
    await vi.advanceTimersByTimeAsync(0);

    await expect(picked).resolves.toBeNull();
    expect(environment.input).toMatchObject({ type: "file", accept: "image/*", removed: true });
  });

  it("settles with the normally selected file", async () => {
    const environment = new FakePickerEnvironment();
    const file = { name: "field-notes.png" };
    const picked = pickImageFileWithEnvironment(environment);

    environment.input.files = new TestFileList(file);
    environment.input.emit("change");

    await expect(picked).resolves.toBe(file);
  });

  it("keeps a selected file when its change event is delayed past focus", async () => {
    vi.useFakeTimers();
    const environment = new FakePickerEnvironment();
    const file = { name: "queued-selection.png" };
    const picked = pickImageFileWithEnvironment(environment);

    environment.focus();
    environment.input.files = new TestFileList(file);
    await vi.advanceTimersByTimeAsync(0);

    await expect(picked).resolves.toBe(file);
  });

  it("settles null on explicit cancellation", async () => {
    const environment = new FakePickerEnvironment();
    const picked = pickImageFileWithEnvironment(environment);

    environment.input.emit("cancel");

    await expect(picked).resolves.toBeNull();
  });

  it("cleans up and settles only once after a delayed focus fallback", async () => {
    vi.useFakeTimers();
    const environment = new FakePickerEnvironment();
    const file = { name: "chosen-late.png" };
    const picked = pickImageFileWithEnvironment(environment);
    let settlements = 0;
    void picked.then(() => {
      settlements += 1;
    });

    environment.focus();
    environment.input.files = new TestFileList(file);
    environment.input.emit("change");
    environment.input.emit("cancel");
    environment.focus();
    await vi.runAllTimersAsync();

    await expect(picked).resolves.toBe(file);
    expect(settlements).toBe(1);
    expect(environment.input.removed).toBe(true);
    expect(environment.input.listenerCount()).toBe(0);
    expect(environment.focusListenerCount).toBe(0);
  });

  it("cleans up and rejects when opening the picker throws", async () => {
    const environment = new FakePickerEnvironment();
    const error = new Error("Picker unavailable");
    environment.input.clickError = error;

    await expect(pickImageFileWithEnvironment(environment)).rejects.toBe(error);
    expect(environment.input.removed).toBe(true);
    expect(environment.input.listenerCount()).toBe(0);
    expect(environment.focusListenerCount).toBe(0);
  });
});
