import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// ─────────────────────────────────────────────────────────────────────────
// The activity-completion card is hand-written twice — Chakra in
// `SessionInterface.tsx`, React Native in `native/src/app/session/[id].tsx` —
// so its copy can drift between the two frontends without anything failing.
//
// It also used to make a claim it could not support. Both cards derived a
// `unitComplete` flag from `activities.listByUnitPublic`, which returns only
// the activities THIS assignment made live. A homework session carrying one
// activity out of a multi-lesson unit therefore satisfied
// `completedCount >= activityTotal` the moment the scholar marked that one
// activity done, and announced "Unit complete! You finished every activity in
// this unit." to a scholar who had barely started — with the teacher watching
// the same banner in Remote Mode.
//
// The claim is retired rather than recalibrated: the card now says only what
// it knows, and Home owns the unit picture. This test guards both halves of
// that — the claim stays gone, and the two frontends keep saying the same
// words.
// ─────────────────────────────────────────────────────────────────────────

const root = resolve(__dirname, "..");
/** Comments still quote the retired banner as history — the assertions below
 *  are about what the card RENDERS, so strip them first. */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const read = (path: string) =>
  stripComments(readFileSync(resolve(root, path), "utf8"));

const WEB = "components/SessionInterface.tsx";
const NATIVE = "native/src/app/session/[id].tsx";

const TITLE = "Nice work — this one's done!";
const HANDOFF_BODY = "Head back when you're ready.";
const EARLIER_HOLE_BODY = "This part is done — head home to see what is left.";
const HOME_ACTION = "Back to home";

describe("activity-completion card", () => {
  it("makes no unit-completion claim on either frontend", () => {
    for (const file of [WEB, NATIVE]) {
      const source = read(file);
      expect(source).not.toContain("Unit complete");
      expect(source).not.toContain("You finished every activity in this unit");
    }
  });

  // The homework footer already shows `Done — your teacher can see it.` right
  // below this card, so the card repeating it would say the same thing twice
  // on one screen. The footer owns the teacher-visibility receipt; the card
  // body owns navigation.
  it("leaves the teacher-visibility receipt to the homework footer", () => {
    for (const file of [WEB, NATIVE]) {
      expect(read(file)).not.toContain("Your teacher can see it");
    }
  });

  it("uses the same copy on web and native", () => {
    for (const file of [WEB, NATIVE]) {
      const source = read(file);
      expect(source).toContain(TITLE);
      expect(source).toContain(HANDOFF_BODY);
      expect(source).toContain(EARLIER_HOLE_BODY);
      expect(source).toContain(HOME_ACTION);
    }
  });

  it("hands off to Home on 'no forward next' alone, never on a count comparison", () => {
    // The retired derivation compared completed-vs-total over an
    // assignment-scoped list. Nothing about the card's terminal state may
    // depend on that comparison again; `earlierHole` may still use it, since
    // "some visible activity is still incomplete" is a claim the list DOES
    // support.
    expect(read(WEB)).toContain("const completionHandsOffToHome =");
    expect(read(WEB)).not.toContain(
      "activityNav.unitCompletedOnlineCount >= activityNav.unitOnlineActivityCount",
    );
    expect(read(NATIVE)).toContain("const handsOffToHome =");
    expect(read(NATIVE)).not.toContain(
      "progress.completedCount >= progress.activityTotal",
    );
  });
});
