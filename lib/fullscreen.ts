// The Fullscreen API with Safari's prefixed fallback (iPadOS Safari still
// ships only `webkitRequestFullscreen` for non-video elements on some
// versions). Structural types so tests can pass plain fakes.

export type FullscreenTarget = {
  requestFullscreen?: () => Promise<void>;
  webkitRequestFullscreen?: () => void;
};

export type FullscreenDocument = {
  fullscreenElement?: unknown;
  webkitFullscreenElement?: unknown;
  exitFullscreen?: () => Promise<void>;
  webkitExitFullscreen?: () => void;
};

/** Ask the browser to take `el` full screen. Resolves false when the browser
 * has no Fullscreen API or refuses (the caller still covers the window, so
 * Present works either way). */
export async function enterFullscreen(el: FullscreenTarget): Promise<boolean> {
  try {
    if (el.requestFullscreen) {
      await el.requestFullscreen();
      return true;
    }
    if (el.webkitRequestFullscreen) {
      el.webkitRequestFullscreen();
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

export function fullscreenElementOf(doc: FullscreenDocument): unknown {
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

/** Leave full screen if the page is in it; a no-op otherwise. */
export async function exitFullscreen(doc: FullscreenDocument): Promise<void> {
  if (fullscreenElementOf(doc) === null) return;
  try {
    if (doc.exitFullscreen) await doc.exitFullscreen();
    else doc.webkitExitFullscreen?.();
  } catch {
    // Already out (Esc raced the Done tap): nothing to undo.
  }
}
