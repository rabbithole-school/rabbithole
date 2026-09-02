/**
 * The bridge — the sandbox's half of the conversation with its host.
 *
 * Everything that crosses here is slow-path: level changes, saves, artwork
 * URLs, and the model round-trip when the deterministic fixer gives up. The
 * fast loop — keystroke, Run, redraw — never touches this, which is the entire
 * reason the editor and the canvas ship as one document.
 *
 * We use the existing `rabbithole:app-state` bridge rather than inventing a
 * second WebView protocol. It is nonce-checked, size-capped, vendored to native
 * and already covered by tests, and its 250ms write debounce is irrelevant to
 * traffic that is measured in seconds.
 *
 * `window.rabbithole` is injected by the host. When it is absent — the document
 * opened directly in a browser during development — every call below quietly
 * no-ops and the Studio still runs completely. That is deliberate: being able
 * to open the built HTML and look at it is worth more than a loud failure.
 */
import type {
  StudioBridgeDoc,
  StudioFixRequest,
  StudioFixResult,
  StudioRollRequest,
  StudioRunResult,
  StudioWorldSeed,
} from "../../shared/studioContract";
import { STUDIO_ACTIONS } from "../../shared/studioContract";

interface RabbitholeSdk {
  getState: () => Record<string, unknown>;
  setState: (patch: Record<string, unknown>) => void;
  subscribe: (cb: (doc: Record<string, unknown>) => void) => () => void;
  registerAction: (
    name: string,
    description: string,
    fn: (args: unknown) => unknown,
  ) => () => void;
}

const sdk = (): RabbitholeSdk | null =>
  (window as unknown as { rabbithole?: RabbitholeSdk }).rabbithole ?? null;

export const hasHost = () => sdk() != null;

export interface HostHandlers {
  /** The rail picked a level. `source` is the scholar's saved work, if any. */
  setLevel: (levelId: string, source: string | undefined, seed: StudioWorldSeed) => void;
  /** "Change the world" — roll a fresh world for the current level. */
  rollWorld: (seed: StudioWorldSeed) => void;
  /** Artwork arrived: cache key -> URL. */
  setCharms: (urls: Record<string, string>) => void;
  /** The model's repair came back. */
  applyFix: (requestId: string, result: StudioFixResult) => void;
}

export function connect(handlers: HostHandlers) {
  const rh = sdk();
  if (!rh) return;

  const arg = (a: unknown) => (a && typeof a === "object" ? (a as Record<string, unknown>) : {});

  rh.registerAction(STUDIO_ACTIONS.setLevel, "Open a level in the Studio.", (a) => {
    const o = arg(a);
    if (
      typeof o.levelId !== "string" ||
      (typeof o.seed !== "string" && typeof o.seed !== "number")
    ) {
      return { ok: false };
    }
    handlers.setLevel(
      o.levelId,
      typeof o.source === "string" ? o.source : undefined,
      o.seed,
    );
    return { ok: true };
  });

  rh.registerAction(STUDIO_ACTIONS.rollWorld, "Roll a fresh world for this level.", (a) => {
    const o = arg(a);
    if (typeof o.seed !== "string" && typeof o.seed !== "number") return { ok: false };
    handlers.rollWorld(o.seed);
    return { ok: true };
  });

  rh.registerAction(STUDIO_ACTIONS.setCharms, "Supply artwork URLs for the world.", (a) => {
    const o = arg(a);
    const urls = o.urls;
    if (!urls || typeof urls !== "object") return { ok: false };
    handlers.setCharms(urls as Record<string, string>);
    return { ok: true };
  });

  rh.registerAction(STUDIO_ACTIONS.applyFix, "Deliver a repaired program.", (a) => {
    const o = arg(a);
    const result = o.result as StudioFixResult | undefined;
    if (typeof o.requestId !== "string" || !result || typeof result.source !== "string") {
      return { ok: false };
    }
    handlers.applyFix(o.requestId, {
      source: result.source,
      fixes: Array.isArray(result.fixes) ? result.fixes : [],
      ok: !!result.ok,
    });
    return { ok: true };
  });
}

function patch(next: Partial<StudioBridgeDoc>) {
  sdk()?.setState(next as Record<string, unknown>);
}

/**
 * The host debounces the write, so this may be called as often as is
 * convenient — but not on every keystroke. The caller idles first.
 */
export const publishSource = (levelId: string, source: string) =>
  patch({ levelId, source });

export const publishRun = (lastRun: StudioRunResult) => patch({ lastRun });

export const publishFixRequest = (fixRequest: StudioFixRequest) => patch({ fixRequest });

export const publishRollRequest = (rollRequest: StudioRollRequest) => patch({ rollRequest });
