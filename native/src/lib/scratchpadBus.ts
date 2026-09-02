/**
 * Transport for the canonical native Scratchpad host. Rabbit Slides mounts that
 * host once inside its full-screen editor; other surfaces may stay dark without
 * growing their own handwriting implementation.
 *
 * Outside the mounted slides editor, `requestCapture()` remains a safe null
 * operation because no host publishes a provider.
 */

export type ScratchTarget = {
  /** What to do with the captured PNG (upload + attach to tutor, etc.). */
  onCapture: (uri: string, mime: string) => void | Promise<void>;
  /** Resolve a pending one-shot action when the scholar closes without inserting. */
  onCancel?: () => void;
  /** Primary button copy for this surface (e.g. "Show my work to the tutor"). */
  primaryLabel: string;
} | null;

/**
 * Renders the pad's current ink to a PNG and returns where it landed, or null
 * when there is no provider or nothing on the paper. Provided only while the
 * dormant host is mounted; called by a surface, never by a scholar tap.
 */
export type SilentCapture = () => Promise<{ uri: string; mime: string } | null>;

type Listener = () => void;

let target: ScratchTarget = null;
let captureProvider: SilentCapture | null = null;
let sheetSerial = 0;
const openListeners = new Set<Listener>();
const closeListeners = new Set<Listener>();
const targetListeners = new Set<Listener>();
const clearListeners = new Set<Listener>();

function cancelTarget(t?: ScratchTarget) {
  const current = target;
  if (!current || (t !== undefined && current !== t)) return;
  target = null;
  targetListeners.forEach((listener) => listener());
  current.onCancel?.();
}

export const scratchpadBus = {
  /** Front surface registers where captures go (null on blur → pure scratch). */
  setTarget(t: ScratchTarget) {
    if (target === t) return;
    target = t;
    targetListeners.forEach((l) => l());
  },
  /**
   * Deregister, but ONLY if `t` is still the live target — a screen clearing its
   * own registration, not whoever replaced it.
   *
   * Navigation runs the effects in the wrong order for an unconditional clear:
   * the incoming screen's `useFocusEffect` body fires during the same commit,
   * while the outgoing screen's cleanup is triggered by a `blur` the NAVIGATOR
   * emits from its own effect — and React flushes child effects before parents.
   * So a push runs `setTarget(next)` and only then the old screen's teardown,
   * which would null out a live destination and leave the pad's send button
   * missing on a screen that has one.
   */
  clearTarget(t: ScratchTarget) {
    if (target !== t) return;
    target = null;
    targetListeners.forEach((l) => l());
  },
  /** Cancel and clear the current one-shot destination, if any. */
  cancelTarget,
  getTarget(): ScratchTarget {
    return target;
  },
  /** Open the global pad from anywhere. */
  open() {
    openListeners.forEach((l) => l());
  },
  /** Close the host and cancel any one-shot destination waiting on it. */
  close() {
    cancelTarget();
    closeListeners.forEach((l) => l());
  },
  /**
   * A re-enabled host publishes its renderer here (and retracts it by passing
   * null plus the function it registered — compare-and-clear, for the same
   * reason `clearTarget` uses one).
   */
  setCaptureProvider(fn: SilentCapture | null, prev?: SilentCapture) {
    if (fn === null && prev !== undefined && captureProvider !== prev) return;
    captureProvider = fn;
  },
  /**
   * Snapshot whatever is on the paper right now, with no scholar interaction and
   * no visible effect on the pad. Resolves null when the pad isn't mounted, the
   * sheet is blank, or the render fails — every caller treats a capture as a
   * bonus, never as a step that can fail in front of a child.
   */
  async requestCapture(): Promise<{ uri: string; mime: string } | null> {
    const fn = captureProvider;
    if (!fn) return null;
    try {
      return await fn();
    } catch {
      return null;
    }
  },
  /**
   * Fresh paper for a re-enabled host. Its screen calls this when the thing being
   * worked on changes because the host outlives that screen.
   *
   * That isn't just clutter: `inkCropRect` crops a capture to the bounding box
   * of ALL strokes, so leftover work from earlier items would ship the tutor
   * (and the observer's vision pass) a jumble of four problems with nothing
   * marking which part answers the current one.
   */
  clearSheet() {
    sheetSerial += 1;
    clearListeners.forEach((l) => l());
  },
  /**
   * How many times fresh paper has been asked for. A monotonic counter rather
   * than an event flag so the pad can read it as a `useSyncExternalStore`
   * snapshot and can't miss a request made before it subscribed.
   */
  getSheetSerial(): number {
    return sheetSerial;
  },
  /** Current send-button copy, or null when nothing is listening for a drawing. */
  getPrimaryLabel(): string | null {
    return target?.primaryLabel ?? null;
  },
  /** GlobalScratchpad subscribes for explicit open requests. */
  subscribe(l: Listener): () => void {
    openListeners.add(l);
    return () => {
      openListeners.delete(l);
    };
  },
  /** GlobalScratchpad subscribes so its owning surface can close it too. */
  subscribeClose(l: Listener): () => void {
    closeListeners.add(l);
    return () => {
      closeListeners.delete(l);
    };
  },
  /** Observe target changes (the send button follows them). */
  subscribeTarget(l: Listener): () => void {
    targetListeners.add(l);
    return () => {
      targetListeners.delete(l);
    };
  },
  /** Observe fresh-paper requests. */
  subscribeClear(l: Listener): () => void {
    clearListeners.add(l);
    return () => {
      clearListeners.delete(l);
    };
  },
};
