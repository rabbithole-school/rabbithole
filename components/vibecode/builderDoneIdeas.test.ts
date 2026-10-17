import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// TRA-519 B2: an app activity's done state is the builder, not the chat
// completion card, so the builder's Workshop strip must carry the same
// done-screen actions (Build it now + Make it a Quest per idea) once the
// activity is complete. Neither builder has a render harness, so this pins the
// wiring against the source on web and iPad: the strip gets the shared hook's
// per-idea actions only in the done state, and the hook draws the shared
// labels.
const root = resolve(__dirname, "../..");
const read = (file: string) => readFileSync(resolve(root, file), "utf8");

describe.each([
  {
    builder: "components/vibecode/VibecodeWorkshop.tsx",
    hook: "components/SavedForLaterBlock.tsx",
  },
  {
    builder: "native/src/components/vibecode/VibecodeScreen.tsx",
    hook: "native/src/components/MissionDoneBlocks.tsx",
  },
])("$builder done-state ideas", ({ builder, hook }) => {
  const builderSource = read(builder);
  const hookSource = read(hook);

  it("passes the shared per-idea actions to the strip only when done", () => {
    expect(builderSource).toContain("useSavedForLaterActions({");
    expect(builderSource).toMatch(
      /renderActions=\{\s*builderDone \? doneIdeaActions\.renderActions : undefined\s*\}/,
    );
    expect(builderSource).toMatch(/builderDone \? doneIdeaActions\.dialog : null/);
  });

  it("the hook draws Build it now and Make it a Quest from the shared copy", () => {
    const start = hookSource.indexOf("export function useSavedForLaterActions");
    expect(start).toBeGreaterThan(-1);
    const body = hookSource.slice(start);
    expect(body).toContain("MISSION_COPY.buildItNow");
    expect(body).toContain("MISSION_COPY.makeItAQuest");
  });
});
