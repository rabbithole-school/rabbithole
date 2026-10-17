import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

// The queue's behaviour is unit-tested in shared/__tests__/appTutorRequest;
// these guard the wiring each host screen needs and cannot be rendered here
// (the full screens need Convex, a stream, and on native a WebView).
const read = (path: string) => readFileSync(resolve(path), "utf8");

const HOSTS = {
  webSession: "components/SessionInterface.tsx",
  webWorkshop: "components/vibecode/VibecodeWorkshop.tsx",
  nativeSession: "native/src/app/session/[id].tsx",
  nativeWorkshop: "native/src/components/vibecode/VibecodeScreen.tsx",
} as const;

describe("app tutor host wiring", () => {
  test("every screen hosting an app routes updates through the one queue", () => {
    for (const path of Object.values(HOSTS)) {
      const source = read(path);
      expect(source, path).toContain("useAppTutorUpdates({");
      expect(source, path).toContain("settleAppTutorSend(");
      expect(source, path).toContain("startAppUpdateTurn");
      // held/busy come back as a returned status, not a thrown error.
      expect(source, path).toContain("appTutorSendResultFromStatus(");
      // Only the session owner's client may start tutor turns.
      expect(source, path).toContain("enabled: isSessionOwner");
      // The old drop-on-streaming / drop-before-first-turn dispatcher is gone.
      expect(source, path).not.toContain("dispatchAppTutorAsk");
      // The stream carries an ask's context only when the update has asks.
      expect(source, path).toContain("appUpdate.batch.asks.length > 0");
    }
  });

  test("character and judge turns reach the queue from every app host", () => {
    expect(read(HOSTS.webSession)).toContain(
      "onAppAiTurn={appTutorUpdates.onAppAiTurn}",
    );
    expect(read("components/ArtifactPanel.tsx")).toContain(
      "onAppAiTurn={onAppAiTurn}",
    );
    const nativeSession = read(HOSTS.nativeSession);
    expect(
      nativeSession.split("onAppAiTurn={appTutorUpdates.onAppAiTurn}").length - 1,
    ).toBe(2);
    expect(read("native/src/components/DeliverablePanel.tsx")).toContain(
      "onAppAiTurn={onAppAiTurn}",
    );
    expect(read("native/src/components/DeliverableCard.tsx")).toContain(
      "onAppAiTurn={onAppAiTurn}",
    );
    // The workshops report character turns from Play only, not Edit previews
    // (and from any side app too: it has no designer, TRA-519), and a
    // character turn retires the tutor's strip line (it must not come back
    // after the update turn ends in silence).
    for (const path of [HOSTS.webWorkshop, HOSTS.nativeWorkshop]) {
      const source = read(path);
      expect(source, path).toMatch(
        /onAppAiTurn=\{\s*tutorVoice \? handleAppAiTurn : undefined\s*\}/,
      );
      expect(source, path).toContain(
        'const tutorVoice = !builderStance || mode === "play";',
      );
    }
    for (const path of [HOSTS.webWorkshop, HOSTS.nativeWorkshop]) {
      const source = read(path);
      const handler = source.slice(
        source.indexOf("const handleAppAiTurn = "),
        source.indexOf("};", source.indexOf("const handleAppAiTurn = ")),
      );
      expect(handler, path).toContain("tutorLine.markRead();");
      expect(handler, path).toContain("appTutorUpdates.onAppAiTurn();");
    }
  });

  test("only the session owner's app reaches the character and judges", () => {
    for (const path of [HOSTS.webWorkshop, HOSTS.nativeWorkshop]) {
      expect(read(path), path).toContain("appAiEnabled={isSessionOwner}");
    }
    expect(read("components/ArtifactPanel.tsx")).toContain(
      "appAiEnabled={!mapReadOnly}",
    );
    expect(read(HOSTS.nativeSession).split("appAiEnabled={isSessionOwner}").length - 1).toBe(2);
    expect(read("native/src/components/DeliverablePanel.tsx").split("appAiEnabled={appAiEnabled}").length - 1).toBe(1);
    // The panel hands the flag to the app card, which hands it to the host.
    expect(read("native/src/components/AppCard.tsx")).toContain("appAiEnabled={appAiEnabled}");
    expect(read("native/src/components/DeliverableCard.tsx")).toContain(
      "appAiEnabled={appAiEnabled}",
    );
  });

  test("an app update never consumes the scholar's composer", () => {
    const session = read(HOSTS.webSession);
    const start = session.indexOf("const handleSend = async (");
    const appBranch = session.indexOf("if (appUpdate) {", start);
    const clear = session.indexOf(
      "composerAfterPersistedSend(composer, { directText, isAppRequest })",
      start,
    );
    expect(start).toBeGreaterThan(-1);
    // The composer is cleared only by a send that read it; an app update
    // (isAppRequest) never does (TRA-527 made this explicit).
    expect(appBranch).toBeGreaterThan(start);
    expect(clear).toBeGreaterThan(appBranch);
    expect(session).toContain("if (!isAppRequest && pendingImage)");

    const nativeSession = read(HOSTS.nativeSession);
    expect(nativeSession).toContain(
      "const imageId = isAppRequest ? null : image.imageId;",
    );
    expect(nativeSession).toContain("if (!isAppRequest) image.clear();");
    expect(nativeSession).toContain("if (!usingOverride && !isAppRequest) {");
  });

  test("a typed turn retires a queued character update on every host", () => {
    for (const path of Object.values(HOSTS)) {
      expect(read(path), path).toContain("clearAppAi()");
    }
  });

  test("every host keys its queue on the session and sends no snapshot for a character-only update", () => {
    for (const path of Object.values(HOSTS)) {
      const source = read(path);
      expect(source, path).toMatch(/useAppTutorUpdates\(\{\s*sessionId,/);
      expect(source, path).toContain(
        "!appUpdate || appUpdate.batch.asks.length > 0",
      );
    }
  });

  test("the native workshop's app update holds a claim a typed send waits out", () => {
    const workshop = read(HOSTS.nativeWorkshop);
    expect(workshop).toContain(
      "if (!appUpdate && appUpdateClaimRef.current.isLocked()) return false;",
    );
    expect(workshop).toContain("appUpdateClaimRef.current.acquire()");
    expect(workshop).toContain("appUpdateClaimRef.current.release();");
  });

  test("both workshops tell an Edit-mode builder where hint replies go", () => {
    for (const path of [HOSTS.webWorkshop, HOSTS.nativeWorkshop]) {
      const source = read(path);
      const handler = source.slice(
        source.indexOf("const handleAppTutorAsk = "),
        source.indexOf("};", source.indexOf("const handleAppTutorAsk = ")),
      );
      // The ask is still delivered, and the notice is shown in the builder
      // stance's Edit only — never for a side app, whose chat is the tutor's.
      expect(handler, path).toContain("appTutorUpdates.onAskTutor(request);");
      expect(handler, path).toMatch(/builderStance &&\s+mode === "edit"/);
      expect(handler, path).toContain("EDIT_MODE_ASK_NOTICE");
    }
  });
});
