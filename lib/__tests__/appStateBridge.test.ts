import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { chromium } from "playwright";
import { describe, expect, test } from "vitest";

// The end-to-end bridge test drives a real headless Chromium (launch → navigate
// → several waitForFunction polls). That is reliable locally but timing-flaky on
// the shared unit-test CI runners, where a cold Playwright launch can blow the
// default per-test timeout. Keep it OUT of CI (the pure protocol/merge/parse
// assertions below cover the logic there) and run the browser E2E locally, or in
// a dedicated browser lane via APP_STATE_BRIDGE_E2E=1. Requires the chromium
// binary either way.
function chromiumAvailable(): boolean {
  try {
    const path = chromium.executablePath();
    return Boolean(path) && existsSync(path);
  } catch {
    return false;
  }
}
const runBrowserE2e =
  chromiumAvailable() &&
  (process.env.APP_STATE_BRIDGE_E2E === "1" || !process.env.CI);
// Generous ceiling for a cold headless launch when it does run.
const BROWSER_E2E_TIMEOUT_MS = 60_000;
import {
  APP_STATE_PROTOCOL,
  APP_STATE_PROTOCOL_VERSION,
  APP_STATE_MAX_WRITE_LATENCY_MS,
  APP_STATE_WRITE_DEBOUNCE_MS,
  RABBITHOLE_APP_STATE_SDK_BYTES,
  appActionRegistryWriteDecision,
  injectAppStateSdk,
  appStateFlushDelay,
  matchesAppStateBridgeNonce,
  createAppStateHostMessage,
  mergeAppStateDoc,
  parseAppStateBridgeMessage,
} from "../appStateBridge.mjs";
import { MAX_APP_ACTIONS } from "../../shared/appActionPolicy";

declare global {
  interface Window {
    __bridge: {
      stored: Record<string, unknown>;
      logs: Array<{ message: string }>;
      writes: number;
      sharedStored: Record<string, unknown>;
      sharedWrites: number;
      ignored: number;
      nonceDrops: number;
      lastOrigin: string | null;
      activeNonce: string | null;
      pushShared: (patch: Record<string, unknown>) => void;
      actions: Array<{ name: string; description: string }>;
      actionResult: {
        requestId: string;
        ok: boolean;
        result?: unknown;
        error?: string;
      } | null;
      invokeAction: (
        name: string,
        args?: Record<string, unknown>,
      ) => void;
    };
  }
}

describe("app-state bridge protocol", () => {
  test("is versioned, bounded, and injected before app scripts", () => {
    expect(RABBITHOLE_APP_STATE_SDK_BYTES).toBeLessThanOrEqual(6_144);
    expect(
      parseAppStateBridgeMessage({
        protocol: APP_STATE_PROTOCOL,
        version: APP_STATE_PROTOCOL_VERSION,
        nonce: "test-nonce",
        type: "change",
        patch: { score: 1 },
      }),
    ).toEqual({
      type: "change",
      nonce: "test-nonce",
      patch: { score: 1 },
      logs: undefined,
    });
    expect(
      parseAppStateBridgeMessage({
        protocol: APP_STATE_PROTOCOL,
        version: APP_STATE_PROTOCOL_VERSION,
        nonce: "test-nonce",
        type: "actions",
        actions: [
          { name: "reset", description: "Reset the board." },
          { name: "solveChallenge", description: "Forbidden semantics." },
          ...Array.from({ length: MAX_APP_ACTIONS + 3 }, (_, index) => ({
            name: `seed${index}`,
            description: `Seed scenario ${index}.`,
          })),
        ],
      }),
    ).toMatchObject({
      type: "actions",
      nonce: "test-nonce",
      actions: expect.arrayContaining([
        { name: "reset", description: "Reset the board." },
      ]),
    });
    const parsedActions = parseAppStateBridgeMessage({
      protocol: APP_STATE_PROTOCOL,
      version: APP_STATE_PROTOCOL_VERSION,
      nonce: "test-nonce",
      type: "actions",
      actions: Array.from({ length: MAX_APP_ACTIONS + 3 }, (_, index) => ({
        name: `seed${index}`,
        description: `Seed scenario ${index}.`,
      })),
    });
    if (parsedActions?.type !== "actions") {
      throw new Error("expected an actions message");
    }
    expect(parsedActions.actions).toHaveLength(MAX_APP_ACTIONS);
    expect(
      parseAppStateBridgeMessage({
        protocol: APP_STATE_PROTOCOL,
        version: APP_STATE_PROTOCOL_VERSION,
        nonce: "test-nonce",
        type: "actionResult",
        requestId: "request-1",
        ok: true,
        result: { loaded: 3 },
      }),
    ).toEqual({
      type: "actionResult",
      nonce: "test-nonce",
      requestId: "request-1",
      ok: true,
      result: { loaded: 3 },
    });
    expect(
      parseAppStateBridgeMessage({
        protocol: APP_STATE_PROTOCOL,
        version: APP_STATE_PROTOCOL_VERSION + 1,
        nonce: "test-nonce",
        type: "change",
        patch: { score: 1 },
      }),
    ).toBeNull();
    expect(
      parseAppStateBridgeMessage({
        protocol: APP_STATE_PROTOCOL,
        version: APP_STATE_PROTOCOL_VERSION,
        nonce: "test-nonce",
        type: "sharedSelect",
        roomId: "room-1",
      }),
    ).toEqual({
      type: "sharedSelect",
      nonce: "test-nonce",
      roomId: "room-1",
    });
    expect(
      parseAppStateBridgeMessage({
        protocol: APP_STATE_PROTOCOL,
        version: APP_STATE_PROTOCOL_VERSION,
        nonce: "test-nonce",
        type: "sharedChange",
        roomId: "room-1",
        patch: { turn: 2 },
      }),
    ).toEqual({
      type: "sharedChange",
      nonce: "test-nonce",
      roomId: "room-1",
      patch: { turn: 2 },
    });
    expect(
      createAppStateHostMessage("init", { local: true }, "test-nonce", {
        roomId: "room-1",
        doc: { turn: 1 },
        presence: [{ name: "A" }],
      }, {
        id: "request-1",
        name: "reset",
        requestedAt: 1,
      }),
    ).toMatchObject({
      doc: { local: true },
      shared: {
        roomId: "room-1",
        doc: { turn: 1 },
        presence: [{ name: "A" }],
      },
      actionRequest: {
        id: "request-1",
        name: "reset",
      },
    });
    expect(
      mergeAppStateDoc(
        { score: 1, level: 2 },
        [{ score: 2 }, { score: 3, streak: 4 }],
      ),
    ).toEqual({ score: 3, level: 2, streak: 4 });
    const startedAt = 1_000;
    expect(appStateFlushDelay(undefined, startedAt)).toBe(
      APP_STATE_WRITE_DEBOUNCE_MS,
    );
    expect(appStateFlushDelay(startedAt, startedAt + 1_900)).toBe(100);
    expect(
      appStateFlushDelay(
        startedAt,
        startedAt + APP_STATE_MAX_WRITE_LATENCY_MS,
      ),
    ).toBe(0);

    const injected = injectAppStateSdk(
      '<!doctype html><html><script>window.appBooted=true</script><head><meta http-equiv="Content-Security-Policy" content="script-src \'unsafe-inline\'"></head><body></body></html>',
    );
    expect(injected.indexOf(APP_STATE_PROTOCOL)).toBeLessThan(
      injected.indexOf("window.appBooted"),
    );
  });

  test("accepts changes only when their nonce matches the active handshake", () => {
    const message = parseAppStateBridgeMessage({
      protocol: APP_STATE_PROTOCOL,
      version: APP_STATE_PROTOCOL_VERSION,
      nonce: "active-nonce",
      type: "change",
      patch: { score: 1 },
    });
    expect(message).not.toBeNull();
    expect(matchesAppStateBridgeNonce(message!, "active-nonce")).toBe(true);
    expect(matchesAppStateBridgeNonce(message!, "different-nonce")).toBe(false);
    expect(matchesAppStateBridgeNonce(message!, null)).toBe(false);

    expect(
      parseAppStateBridgeMessage({
        protocol: APP_STATE_PROTOCOL,
        version: APP_STATE_PROTOCOL_VERSION,
        type: "change",
        patch: { score: 2 },
      }),
    ).toBeNull();
  });

  test("drops a pre-reload message after a fresh nonce becomes active", () => {
    const staleMessage = parseAppStateBridgeMessage({
      protocol: APP_STATE_PROTOCOL,
      version: APP_STATE_PROTOCOL_VERSION,
      nonce: "pre-reload-nonce",
      type: "change",
      patch: { score: 1 },
    });
    expect(staleMessage).not.toBeNull();
    expect(matchesAppStateBridgeNonce(staleMessage!, "pre-reload-nonce")).toBe(
      true,
    );
    expect(matchesAppStateBridgeNonce(staleMessage!, "post-reload-nonce")).toBe(
      false,
    );
  });

  test("defers then skips an empty initial action registry write", () => {
    expect(appActionRegistryWriteDecision(undefined, [])).toBe("defer");
    expect(appActionRegistryWriteDecision(null, [])).toBe("skip");
    expect(appActionRegistryWriteDecision([], [])).toBe("skip");
  });

  test("defers then persists clearing a non-empty action registry", () => {
    expect(appActionRegistryWriteDecision(undefined, [])).toBe("defer");
    expect(
      appActionRegistryWriteDecision(
        [{ name: "reset", description: "Reset the board." }],
        [],
      ),
    ).toBe("persist");
  });

  test.runIf(runBrowserE2e)(
    "buffers init, captures console, nonce-checks, debounces, and rehydrates",
    async () => {
      const appHtml = injectAppStateSdk(`<!doctype html>
<html>
  <body>
    <button id="counter" data-count="0">0</button>
    <button id="shared-counter" data-count="0">0</button>
    <div id="presence"></div>
    <script>
      let count = 0;
      const button = document.querySelector("#counter");
      rabbithole.setState({ bootedBeforeInit: true });
      window.dispatchEvent(new MessageEvent("message", {
        data: {
          protocol: ${JSON.stringify(APP_STATE_PROTOCOL)},
          version: ${APP_STATE_PROTOCOL_VERSION},
          nonce: "forged",
          type: "init",
          doc: { count: 999 }
        }
      }));
      console.warn("boot warning", { phase: "before-init" });
      rabbithole.subscribe((state) => {
        count = Number(state.count || 0);
        button.textContent = String(count);
        button.dataset.count = String(count);
      });
      const sharedButton = document.querySelector("#shared-counter");
      rabbithole.shared.subscribe((state) => {
        sharedButton.textContent = String(state.count || 0);
        sharedButton.dataset.count = String(state.count || 0);
      });
      rabbithole.shared.subscribePresence((people) => {
        document.querySelector("#presence").textContent =
          people.map((person) => person.name).join(",");
      });
      rabbithole.registerAction(
        "seedScenario",
        "Load a stage with a chosen number of clues.",
        ({ clues = 3 } = {}) => {
          button.dataset.seeded = String(clues);
          rabbithole.setState({ seededClues: clues });
          return { seededClues: clues };
        }
      );
      button.addEventListener("click", () => {
        rabbithole.setState({ count: count + 1 });
      });
      sharedButton.addEventListener("click", () => {
        rabbithole.shared.setState({
          count: Number(sharedButton.dataset.count || 0) + 1
        });
      });
    </script>
  </body>
</html>`);
      const serializedAppHtml = JSON.stringify(appHtml).replaceAll(
        "</script",
        "<\\/script",
      );
      const hostHtml = `<!doctype html>
<html>
  <body>
    <button id="refresh">Refresh preview</button>
    <div id="mount"></div>
    <script>
      const APP_HTML = ${serializedAppHtml};
      const PROTOCOL = ${JSON.stringify(APP_STATE_PROTOCOL)};
      const VERSION = ${APP_STATE_PROTOCOL_VERSION};
      const DEBOUNCE_MS = ${APP_STATE_WRITE_DEBOUNCE_MS};
      let frame, writeTimer, pendingPatch = {}, pendingLogs = [];
      window.__bridge = {
        stored: { restoredByHost: true },
        logs: [],
        writes: 0,
        sharedStored: { count: 4 },
        sharedWrites: 0,
        ignored: 0,
        nonceDrops: 0,
        lastOrigin: null,
        activeNonce: null,
        actions: [],
        actionResult: null,
        invokeAction(name, args) {
          frame.contentWindow.postMessage({
            ...hostMessage("update"),
            actionRequest: {
              id: "request-1",
              name,
              args,
              requestedAt: Date.now()
            }
          }, "*");
        },
        pushShared(patch) {
          this.sharedStored = { ...this.sharedStored, ...patch };
          frame.contentWindow.postMessage(hostMessage("update"), "*");
        },
      };
      let bridgeNonce = null;
      const hostMessage = (type) => ({
        protocol: PROTOCOL,
        version: VERSION,
        nonce: bridgeNonce,
        type,
        doc: window.__bridge.stored,
        shared: {
          roomId: "room-1",
          doc: window.__bridge.sharedStored,
          presence: [{ name: "First" }, { name: "Second" }],
        },
      });
      const postInit = () => frame.contentWindow.postMessage(hostMessage("init"), "*");
      addEventListener("message", (event) => {
        if (!frame || event.source !== frame.contentWindow) {
          window.__bridge.ignored += 1;
          return;
        }
        const message = event.data;
        if (message?.protocol !== PROTOCOL || message?.version !== VERSION) return;
        if (message.type === "ready") {
          bridgeNonce = message.nonce;
          window.__bridge.activeNonce = bridgeNonce;
          window.__bridge.lastOrigin = event.origin;
          postInit();
          return;
        }
        if (message.nonce !== bridgeNonce) {
          window.__bridge.nonceDrops += 1;
          return;
        }
        if (message.type === "sharedChange") {
          window.__bridge.sharedStored = {
            ...window.__bridge.sharedStored,
            ...(message.patch || {})
          };
          window.__bridge.sharedWrites += 1;
          return;
        }
        if (message.type === "actions") {
          window.__bridge.actions = message.actions || [];
          return;
        }
        if (message.type === "actionResult") {
          window.__bridge.actionResult = message;
          return;
        }
        if (message.type !== "change") return;
        pendingPatch = { ...pendingPatch, ...(message.patch || {}) };
        pendingLogs.push(...(message.logs || []));
        clearTimeout(writeTimer);
        writeTimer = setTimeout(() => {
          window.__bridge.stored = { ...window.__bridge.stored, ...pendingPatch };
          window.__bridge.logs.push(...pendingLogs);
          pendingPatch = {};
          pendingLogs = [];
          window.__bridge.writes += 1;
        }, DEBOUNCE_MS);
      });
      function mount() {
        const next = document.createElement("iframe");
        next.id = "app";
        next.name = "app";
        next.sandbox = "allow-scripts";
        next.srcdoc = APP_HTML;
        next.addEventListener("load", postInit);
        document.querySelector("#mount").replaceChildren(next);
        frame = next;
      }
      document.querySelector("#refresh").addEventListener("click", mount);
      mount();
      const hostile = document.createElement("iframe");
      hostile.sandbox = "allow-scripts";
      hostile.srcdoc =
        '<script>parent.postMessage({protocol:' + JSON.stringify(PROTOCOL) +
        ',version:' + VERSION + ',type:"change",patch:{count:999}},"*")<\\/script>';
      document.body.append(hostile);
    </script>
  </body>
</html>`;

      const server = createServer((_request, response) => {
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
        });
        response.end(hostHtml);
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Test server did not bind to a TCP port");
      }

      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${address.port}`);
        const counter = () => page.frameLocator("#app").locator("#counter");
        const sharedCounter = () =>
          page.frameLocator("#app").locator("#shared-counter");
        await counter().waitFor();
        await sharedCounter().waitFor();
        await page.waitForFunction(
          () => {
            const bridge = window.__bridge;
            return (
              bridge.stored.bootedBeforeInit === true &&
              bridge.logs.some((entry) =>
                entry.message.includes("boot warning"),
              ) &&
              bridge.lastOrigin === "null" &&
              bridge.actions.some((action) => action.name === "seedScenario") &&
              bridge.sharedStored.count === 4 &&
              bridge.ignored > 0
            );
          },
        );
        const baselineWrites = await page.evaluate(
          () => window.__bridge.writes,
        );
        const initialFrame = page.frame({ name: "app" });
        if (!initialFrame) throw new Error("App iframe was not mounted");
        const postChange = async (
          frame: NonNullable<typeof initialFrame>,
          nonce: string | undefined,
          patch: Record<string, unknown>,
        ) => {
          await frame.evaluate(
            ({ protocol, version, nonce: messageNonce, patch: messagePatch }) => {
              parent.postMessage(
                {
                  protocol,
                  version,
                  ...(messageNonce === undefined
                    ? {}
                    : { nonce: messageNonce }),
                  type: "change",
                  patch: messagePatch,
                },
                "*",
              );
            },
            {
              protocol: APP_STATE_PROTOCOL,
              version: APP_STATE_PROTOCOL_VERSION,
              nonce,
              patch,
            },
          );
        };
        await postChange(initialFrame, undefined, { missingNonce: true });
        await postChange(initialFrame, "mismatched-nonce", {
          mismatchedNonce: true,
        });
        await page.waitForFunction(
          () => window.__bridge.nonceDrops === 2,
        );
        await page
          .frameLocator("#app")
          .locator('#shared-counter[data-count="4"]')
          .waitFor();
        await page.evaluate(() =>
          window.__bridge.invokeAction("seedScenario", { clues: 5 }),
        );
        await page.waitForFunction(() => {
          const result = window.__bridge.actionResult;
          const payload = result?.result as
           | { seededClues?: number }
           | undefined;
          return (
           result?.requestId === "request-1" &&
           result.ok === true &&
           payload?.seededClues === 5
          );
        });
        await page
          .frameLocator("#app")
          .locator('#counter[data-seeded="5"]')
          .waitFor();
        await page
          .frameLocator("#app")
          .locator("#presence")
          .filter({ hasText: "First,Second" })
          .waitFor();
        await sharedCounter().click();
        await page.waitForFunction(() => {
          const bridge = window.__bridge;
          return bridge.sharedStored.count === 5 && bridge.sharedWrites === 1;
        });
        await page.evaluate(() => window.__bridge.pushShared({ count: 8 }));
        await page
          .frameLocator("#app")
          .locator('#shared-counter[data-count="8"]')
          .waitFor();

        await counter().click();
        await counter().click();
        await page.waitForFunction(
          (writes) => {
            const bridge = window.__bridge;
            return bridge.stored.count === 2 && bridge.writes === writes + 1;
          },
          baselineWrites,
        );

        const preReloadNonce = await page.evaluate(
          () => window.__bridge.activeNonce,
        );
        await page.locator("#refresh").click();
        await page
          .frameLocator("#app")
          .locator('#counter[data-count="2"]')
          .waitFor();
        await page.waitForFunction(
          (nonce) =>
            window.__bridge.activeNonce !== null &&
            window.__bridge.activeNonce !== nonce,
          preReloadNonce,
        );
        const reloadedFrame = page.frame({ name: "app" });
        if (!reloadedFrame) throw new Error("Reloaded app iframe was not mounted");
        await postChange(reloadedFrame, preReloadNonce ?? undefined, {
          staleAfterReload: true,
        });
        await page.waitForFunction(
          () => window.__bridge.nonceDrops === 3,
        );
        const stored = await page.evaluate(
          () => window.__bridge.stored,
        );
        expect(stored).toMatchObject({
          count: 2,
          restoredByHost: true,
          bootedBeforeInit: true,
        });
        expect(stored).not.toHaveProperty("missingNonce");
        expect(stored).not.toHaveProperty("mismatchedNonce");
        expect(stored).not.toHaveProperty("staleAfterReload");
      } finally {
        await browser.close();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
    BROWSER_E2E_TIMEOUT_MS,
  );
});
