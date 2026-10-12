import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ─────────────────────────────────────────────────────────────────────────
// TRA-290: the two other native scholar-message senders carry the narrow
// version of the duplicate-send window the session screen closed in #3808.
// Both clear the composer synchronously, so only the React commit gap is
// left: until `setInput("")` lands, the already-rendered submit handler
// still closes over the old text. Neither screen has a render harness, so
// this pins the wiring against the source, the way sendLock.test.ts does
// for the session screen: the stamp comparison sits before the turn is
// claimed, the stamp is written synchronously next to the clear (a setState
// there would land on the same later task and guard nothing), and typing
// clears it.
// ─────────────────────────────────────────────────────────────────────────

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

const SENDERS = [
  "native/src/components/vibecode/VibecodeScreen.tsx",
  "native/src/components/workbench/SidelineTutorSheet.tsx",
];

describe.each(SENDERS)("%s composer snapshot wiring", (file) => {
  const source = readFileSync(resolve(repoRoot, file), "utf8");
  const start = source.indexOf(
    file.endsWith("VibecodeScreen.tsx")
      ? "const sendTutorTurn = async ("
      : "const handleSend = async () => {",
  );
  const end = source.indexOf("\n  };\n", start);
  const handleSend = source.slice(start, end);

  it("refuses a stale-closure resubmit before claiming a turn", () => {
    expect(start).toBeGreaterThan(-1);
    const guard = handleSend.indexOf(
      "sentComposerRef.current === composerSnapshot",
    );
    const claim = handleSend.indexOf("++turnSeqRef.current");
    expect(guard).toBeGreaterThan(-1);
    expect(claim).toBeGreaterThan(guard);
  });

  it("stamps the dispatched text synchronously, next to the clear, before the mutation", () => {
    const clear = handleSend.indexOf('setInput("");');
    const stamp = handleSend.indexOf("sentComposerRef.current = composerSnapshot;");
    const mutation = handleSend.indexOf("await sendMessage(");
    expect(clear).toBeGreaterThan(-1);
    expect(stamp).toBeGreaterThan(clear);
    expect(mutation).toBeGreaterThan(stamp);
  });

  it("clears the stamp on any composer edit", () => {
    expect(source).toContain("onChangeText={onChangeInput}");
    expect(source).not.toContain("onChangeText={setInput}");
    const edit = source.indexOf("const onChangeInput = ");
    expect(edit).toBeGreaterThan(-1);
    expect(source.indexOf("sentComposerRef.current = null;", edit)).toBeGreaterThan(edit);
  });
});
