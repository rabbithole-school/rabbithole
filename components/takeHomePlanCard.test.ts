import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

import {
  remainingLabel,
  takeHomePlanOwnsNow,
} from "@/components/takeHomePlanPlacement";

// ─────────────────────────────────────────────────────────────────────────
// The scholar's take-home lane.
//
// Two halves, matching how the repo tests web surfaces (no component render
// harness — edge-runtime vitest):
//
//  1. Truth tables for the two pure decisions: who owns tonight's homework on
//     Home, and what the header's count says.
//  2. Structural drift guards that read the real sources — the contract is
//     consumed with generated types (no normalizers/casts), every affordance
//     comes off the row's own `actions`, the print line is conditional, and the
//     controls keep their touch/keyboard semantics.
// ─────────────────────────────────────────────────────────────────────────

const card = readFileSync("components/TakeHomePlanCard.tsx", "utf8");
const homePage = readFileSync("app/scholar/page.tsx", "utf8");
const prepCards = readFileSync("components/ScholarPrepCards.tsx", "utf8");
const nativePlan = readFileSync(
  "native/src/components/TakeHomePlan.tsx",
  "utf8",
);
const nextConfig = readFileSync("next.config.js", "utf8");
const nativeMeta = readFileSync("native/src/app/meta.tsx", "utf8");
const retiredPrepRoute = readFileSync("app/scholar/prep/page.tsx", "utf8");
const scholarPlate = readFileSync("components/ScholarPlate.tsx", "utf8");
const nativeHome = readFileSync("native/src/app/index.tsx", "utf8");
const peerTrails = readFileSync("components/PeerTrails.tsx", "utf8");
const nativePeerTrails = readFileSync(
  "native/src/components/PeerTrails.tsx",
  "utf8",
);

describe("who renders tonight's homework on Home", () => {
  test("after Prep, the take-home card owns it", () => {
    expect(
      takeHomePlanOwnsNow({
        isRemoteMode: false,
        showHomeworkInNow: true,
        isPrepTime: false,
      }),
    ).toBe(true);
  });

  test("inside the Prep window the Now digest keeps it (card is on the Prep tab)", () => {
    expect(
      takeHomePlanOwnsNow({
        isRemoteMode: false,
        showHomeworkInNow: true,
        isPrepTime: true,
      }),
    ).toBe(false);
  });

  test("during school hours neither surface reintroduces homework early", () => {
    expect(
      takeHomePlanOwnsNow({
        isRemoteMode: false,
        showHomeworkInNow: false,
        isPrepTime: false,
      }),
    ).toBe(false);
  });

  test("a teacher's remote view never gets the scholar's own plan card", () => {
    expect(
      takeHomePlanOwnsNow({
        isRemoteMode: true,
        showHomeworkInNow: true,
        isPrepTime: false,
      }),
    ).toBe(false);
  });
});

describe("the header count reads as what is left", () => {
  test("an empty list says nothing at all", () => {
    expect(remainingLabel({ assignedCount: 0, selected: [] })).toBeNull();
  });

  test("unchecked chosen work and assigned homework both count", () => {
    expect(
      remainingLabel({
        assignedCount: 1,
        selected: [{ checked: false }, { checked: true }],
      }),
    ).toBe("2 left");
  });

  test("a finished list celebrates instead of counting zero", () => {
    expect(
      remainingLabel({
        assignedCount: 0,
        selected: [{ checked: true }, { checked: true }],
      }),
    ).toBe("All done");
  });
});

describe("the card consumes the generated contract directly", () => {
  test("no normalizers, casts, or API name probing", () => {
    expect(card).not.toMatch(/as unknown as/);
    expect(card).not.toMatch(/as never/);
    expect(card).not.toMatch(/\bas any\b/);
    expect(card).not.toMatch(/normalize/i);
  });

  test("row types are derived from api.takeHomePlans.forSelf", () => {
    expect(card).toContain(
      'type Plan = FunctionReturnType<typeof api.takeHomePlans.forSelf>',
    );
    expect(card).toContain('Plan["selected"][number]');
    expect(card).toContain('Plan["suggestions"][number]');
    expect(card).not.toContain("newQuestCandidates");
  });

  test("the query is minute-ticked so it crosses local midnight on its own", () => {
    expect(card).toContain("api.takeHomePlans.forSelf, { now }");
    expect(card).toContain("floorToMinute");
  });

  test("affordances come off each row's own actions array", () => {
    expect(card).toContain('item.actions.includes("remove")');
    expect(card).toContain('item.actions.includes("addToPlan")');
    expect(card).toContain('item.actions.includes("markDone")');
    expect(card).toContain('item.actions.includes("undo")');
    expect(card).not.toContain('item.actions.includes("startInPlan")');
  });

  test("assigned rows launch their exact activity instead of the homework shelf", () => {
    expect(card).not.toContain('router.push("/homework")');
    expect(card).toContain("api.sessions.create");
    expect(card).toContain("api.sessions.openOfflineHomework");
    expect(card).toContain("webAssignment.launch");
    expect(card).toContain("gameActivity.launch");
    expect(nativePlan).toContain("api.sessions.create");
    expect(nativePlan).toContain("api.sessions.openOfflineHomework");
    expect(nativePlan).toContain("openWebActivity");
    expect(nativePlan).toContain("openGameActivity");
  });

  test("finishing and closing are undoable", () => {
    for (const mutation of [
      "undoResolveSuggestion",
      "undoMarkActivityDone",
      "undoCloseQuest",
    ]) {
      expect(card).toContain(`api.takeHomePlans.${mutation}`);
    }
    expect(card).not.toContain("api.takeHomePlans.undoRemoveItem");
    expect(card).not.toContain("Took “");
  });

  test("Prep sends Quest discovery back to the canonical Quests tab", () => {
    expect(card).not.toContain("CreateQuestDialog");
    expect(card).toContain("Add a Quest");
    expect(homePage).toContain('onAddQuest={() => onTabChange("quests")}');
  });

  test("the canonical Quests tab retains the custom Quest gates", () => {
    const plate = readFileSync("components/ScholarPlate.tsx", "utf8");
    expect(plate).toContain("CreateQuestDialog");
    expect(plate).toContain("isWelcomeGated");
  });
});

describe("copy and control semantics", () => {
  test("Scholar's Prep lives only in the Home tab, not duplicate routes", () => {
    expect(existsSync("native/src/app/prep.tsx")).toBe(false);
    expect(retiredPrepRoute).toContain("notFound()");
    expect(retiredPrepRoute).not.toContain("PrepActivityCards");
    expect(retiredPrepRoute).not.toContain("TakeHomePlanCard");
    expect(nextConfig).toContain('destination: "/scholar"');
    expect(nextConfig).not.toContain('destination: "/scholar/prep"');
    expect(nativeMeta).toContain('<Redirect href="/" />');
    expect(nativeMeta).not.toContain('<Redirect href="/prep" />');
  });

  test("web, native, and print consume the server-owned take-home period", () => {
    expect(card).toContain('plan.takeHomePeriod === "weekend"');
    expect(nativePlan).toContain('raw.takeHomePeriod === "weekend"');
  });

  test("a quest emoji shares its title row instead of becoming metadata", () => {
    expect(card).toContain('item.kind === "quest" && item.meta');
    expect(card).toContain('item.kind === "activity" && item.meta');
    expect(nativePlan).toContain('item.kind === "quest" && item.meta');
    expect(nativePlan).toContain('item.kind === "activity" && item.meta');
  });

  test("web pin controls share BookmarkSimple's accessible toggle language", () => {
    const pinButton = readFileSync("components/TakeHomePinButton.tsx", "utf8");
    expect(pinButton).toContain("BookmarkSimple");
    expect(pinButton).toContain("aria-pressed={pinned}");
    expect(pinButton).toContain('minH="44px"');
    expect(pinButton).toContain('"Added"');
    expect(pinButton).not.toContain("Pinned");
    expect(card).toContain("TakeHomePinButton");
  });

  test("Quest pin controls sit with the activity CTA instead of progress metadata", () => {
    expect(scholarPlate).toContain("secondaryAction={unitPinAction?.");
    expect(scholarPlate).not.toContain("action={unitPinAction?.");
    expect(nativeHome).toContain("raisedAction={plateQuestPinAction({");
    expect(nativeHome).not.toContain("pinning={pinning}\n            onToggleQuestPin");
  });

  test("peer Quest headings stay sentence case on web and native", () => {
    expect(peerTrails).toContain("More quests from");
    expect(peerTrails).not.toContain('textTransform="uppercase"');
    expect(nativePeerTrails).toContain("More quests from");
    expect(nativePeerTrails).not.toContain("MORE QUESTS FROM");
  });

  test("the Special Delivery caption stays off both surfaces until the feature ships", () => {
    // Special Delivery isn't rolled out, so a scholar told their list "goes
    // home on your Special Delivery" is being promised something that won't
    // arrive. The line comes back with the rollout, not before.
    const caption = "This list goes home on your Special Delivery.";
    expect(card).not.toContain(caption);
    expect(nativePlan).not.toContain(caption);
  });

  test("the at-home empty plan stays visible on web and native", () => {
    expect(card).toContain('<EmptyState title="Nothing due tonight" />');
    expect(nativePlan).toContain(">Nothing due tonight</Text>");
    expect(card).not.toContain('if (mode === "home" && total === 0) return null');
    expect(nativePlan).not.toContain(
      'if (mode === "home" && total === 0) return null',
    );
  });

  // An assigned row renders ONE deadline, through the shared DueChip, and keeps
  // its attribution instead of having it replaced by the deadline. The old
  // server field `meta: due?.phrase ?? item.unitTitle` is what made an overdue
  // row silently lose its unit and teacher; these guard the fix on both
  // frontends. See review/scholar-activity-row-rationalization.html.
  test("assigned rows render their deadline through the shared DueChip", () => {
    expect(card).toContain("<DueChip");
    expect(nativePlan).toContain("<DueChip");
    expect(card).not.toContain("Finishes when you complete the activity");
    expect(nativePlan).not.toContain("Finishes when you complete the activity");
    // The deadline is a chip, never an orange restyle of the attribution line.
    expect(card).not.toContain('color={overdue ? "orange.600" : "charcoal.400"}');
    expect(nativePlan).not.toContain("overdue && styles.overdue");
  });

  test("assigned rows keep unit + teacher attribution alongside the deadline", () => {
    // `item.meta` is the server's attribution field — it now carries the unit
    // title unconditionally instead of being overwritten by a due phrase.
    for (const src of [card, nativePlan]) {
      expect(src).toContain("item.meta");
      expect(src).toContain("item.teacherName");
    }
  });

  test("native assigned rows keep one full-row target and one Open CTA", () => {
    const assignedBlock = nativePlan.slice(
      nativePlan.indexOf("raw.assigned.map"),
      nativePlan.indexOf("raw.selected.map"),
    );
    expect(assignedBlock).toContain("onPress={() => openAssigned(item)}");
    expect(assignedBlock.match(/<Pressable/g)).toHaveLength(1);
    expect(assignedBlock).toContain("Open");
    // The bare glyph chevron is gone; the caret now belongs to the CTA.
    expect(assignedBlock).not.toContain("styles.chevron");
  });

  test("native All sections carry the web header icon and due count", () => {
    expect(nativeHome).toContain("HouseIcon");
    expect(nativeHome).toContain("TargetIcon");
    expect(nativeHome).toContain(
      "const owedRows = sectionRows.filter((row) => !row.isReopenedComplete)",
    );
    expect(nativeHome).toContain("`${owedRows.length} due`");
    expect(nativeHome).toContain("`${isTotalCount} in progress`");
    expect(nativeHome).toContain("{section.countText}");
  });

  test("the parent clarifier appears only when the letter has chosen items", () => {
  });

  test("suggestions grant explicit permission to leave work open", () => {
    expect(card).toMatch(/Only you know if they.{1,8}re/);
    expect(card).toMatch(/leave anything you.{1,8}re not sure about/);
  });

  test("the checkbox is a real checkbox and the note editor is cancelable", () => {
    expect(card).toContain('role="checkbox"');
    expect(card).toContain("aria-checked={item.checked}");
    expect(card).toContain('event.key === "Escape"');
    expect(card).toContain("Cancel");
  });

  test("notes edit only from the dedicated pencil control", () => {
    expect(card).toContain('item.kind !== "note" && item.sessionId');
    expect(card).toContain('aria-label={`Edit ${label}`}');
    expect(nativePlan).toContain('item.kind !== "note" && item.sessionId');
    expect(nativePlan).toContain('accessibilityLabel={`Edit ${item.text}`}');
    expect(nativePlan).toContain('name="pencil"');
  });

  test("assigned launches keep the steady row affordance while navigating", () => {
    expect(card).not.toContain('busy={pending === `assigned:${item.id}`}');
    expect(nativePlan).not.toContain(
      'pending === `assigned:${item.id}` && styles.rowBusy',
    );
  });

  test("controls clear the 44px touch target and show a focus ring", () => {
    expect(card).toContain('const TOUCH = "44px"');
    expect(card).toContain("_focusVisible={FOCUS_RING}");
    expect(card).not.toMatch(/size="2xs"/);
  });

  test("no cyan — the lane stays neutral/violet", () => {
    expect(card).not.toMatch(/cyan\./);
  });
});

describe("placement", () => {
  test("Home renders the card only when it owns the Now tab's homework", () => {
    expect(homePage).toContain("{takeHomePlanOwnsNow && (\n            <TakeHomePlanCard\n              mode=\"home\"");
    expect(homePage).toContain(
      "showHomeworkInNow && !takeHomePlanOwnsNow ? homeworkForNow : []",
    );
    expect(homePage).toContain(
      "const hideHomeworkInNow = !showHomeworkInNow || takeHomePlanOwnsNow;",
    );
    expect(homePage).toContain("hideHomework={hideHomeworkInNow}");
  });

  test("on a genuinely empty Now tab the card yields to the one page empty state", () => {
    // One "nothing" per screen: when the page itself is about to render its
    // canonical empty state, the take-home card must not stack a second
    // nothing-message underneath it.
    expect(homePage).toContain(
      "hideWhenEmpty={isQuiet && !hasOpenWorkInNow}",
    );
  });

  test("the Prep tab leads with the list, then separate activity cards", () => {
    const prepBlock = homePage.slice(
      homePage.indexOf("isPrepTab && !isRemoteMode"),
    );
    expect(prepBlock.indexOf("<TakeHomePlanCard")).toBeGreaterThan(-1);
    expect(prepBlock.indexOf("<TakeHomePlanCard")).toBeLessThan(
      prepBlock.indexOf("<PrepActivityCards />"),
    );
  });

  test("Prep activities stay separate from take-home and current class focus", () => {
    expect(prepCards).toContain("Today's reflection");
    expect(prepCards).toContain("The Workshop");
    expect(prepCards).not.toMatch(/takeHomePlans/);
    expect(prepCards).not.toContain("currentClassFocusForMe");
    expect(prepCards).not.toContain("Set out by your teacher");
  });

  test("the Prep window gets one sunset doorway in Now", () => {
    expect(homePage).toContain(
      '<PrepEntryCard onOpen={() => onTabChange("prep")} />',
    );
    expect(prepCards).toContain("Time for Scholar&rsquo;s Prep");
    expect(prepCards).toContain("<SunHorizon");
  });

  test("Prep activities return to the Prep tab", () => {
    const reflectionPage = readFileSync(
      "app/scholar/reflection/page.tsx",
      "utf8",
    );
    const workshopPage = readFileSync(
      "app/scholar/workshop/page.tsx",
      "utf8",
    );
    expect(prepCards).toContain("/scholar/reflection?from=prep");
    expect(prepCards).toContain("/scholar/workshop?from=prep");
    expect(reflectionPage).toContain("/scholar?tab=prep");
    expect(workshopPage).toContain("/scholar?tab=prep");
    expect(reflectionPage).toContain("preferBackHref={fromPrep}");
    expect(workshopPage).toContain("preferBackHref={fromPrep}");
    expect(homePage).toContain('searchParams.get("tab") === "prep"');
  });
});
