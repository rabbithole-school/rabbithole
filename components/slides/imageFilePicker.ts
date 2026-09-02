type PickerEvent = "change" | "cancel";

interface FileListLike<TFile> {
  item(index: number): TFile | null;
}

export interface ImagePickerInput<TFile> {
  type: string;
  accept: string;
  readonly files: FileListLike<TFile> | null;
  addEventListener(event: PickerEvent, listener: () => void): void;
  removeEventListener(event: PickerEvent, listener: () => void): void;
  click(): void;
  remove(): void;
}

export interface ImagePickerEnvironment<TFile, TTimer = unknown> {
  createInput(): ImagePickerInput<TFile>;
  addFocusListener(listener: () => void): void;
  removeFocusListener(listener: () => void): void;
  setTimer(callback: () => void): TTimer;
  clearTimer(timer: TTimer): void;
}

const browserImagePickerEnvironment: ImagePickerEnvironment<File, number> = {
  createInput() {
    const input = document.createElement("input");
    return {
      get type() {
        return input.type;
      },
      set type(value) {
        input.type = value;
      },
      get accept() {
        return input.accept;
      },
      set accept(value) {
        input.accept = value;
      },
      get files() {
        return input.files;
      },
      addEventListener(event, listener) {
        input.addEventListener(event, listener);
      },
      removeEventListener(event, listener) {
        input.removeEventListener(event, listener);
      },
      click() {
        input.click();
      },
      remove() {
        input.remove();
      },
    };
  },
  addFocusListener(listener) {
    window.addEventListener("focus", listener);
  },
  removeFocusListener(listener) {
    window.removeEventListener("focus", listener);
  },
  setTimer(callback) {
    return window.setTimeout(callback, 0);
  },
  clearTimer(timer) {
    window.clearTimeout(timer);
  },
};

/**
 * Opens a one-shot image picker. Some browsers return window focus without
 * emitting `cancel`, so focus schedules a deferred, file-aware fallback.
 */
export function pickImageFileWithEnvironment<TFile, TTimer>(
  environment: ImagePickerEnvironment<TFile, TTimer>,
): Promise<TFile | null> {
  return new Promise((resolve, reject) => {
    const input = environment.createInput();
    let settled = false;
    let fallbackTimer: TTimer | null = null;

    const cleanup = () => {
      if (fallbackTimer !== null) {
        environment.clearTimer(fallbackTimer);
        fallbackTimer = null;
      }
      input.removeEventListener("change", onChange);
      input.removeEventListener("cancel", onCancel);
      environment.removeFocusListener(onFocus);
      input.remove();
    };

    const settle = (file: TFile | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(file);
    };

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const onChange = () => settle(input.files?.item(0) ?? null);
    const onCancel = () => settle(null);
    const onFocus = () => {
      if (settled || fallbackTimer !== null) return;
      fallbackTimer = environment.setTimer(() => {
        fallbackTimer = null;
        settle(input.files?.item(0) ?? null);
      });
    };

    input.type = "file";
    input.accept = "image/*";
    input.addEventListener("change", onChange);
    input.addEventListener("cancel", onCancel);
    environment.addFocusListener(onFocus);

    try {
      input.click();
    } catch (error) {
      fail(error);
    }
  });
}

export function pickImageFile(): Promise<File | null> {
  return pickImageFileWithEnvironment(browserImagePickerEnvironment);
}
