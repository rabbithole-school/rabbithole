/**
 * Guarded group checkpoint actions, driven for real. A group write is one
 * policy row for every member at once, so the claims worth testing are the ones
 * a source read cannot settle: that the FIRST click writes nothing, that a
 * confirmation sends EXACTLY one group mutation carrying the exact band, that
 * the words state the server's member total rather than the filtered column
 * count on screen, and that a blocked or cancelled request never reaches the
 * server at all.
 *
 * Rendered in jsdom (react-dom/client + ChakraProvider, the harness the other
 * Math Skills tests use). The harness below mirrors how `MathSkillsMasteryView`
 * wires the control to the dialog — one request state, one write — so the
 * round trip is exercised rather than asserted about.
 */
// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChakraProvider } from "@chakra-ui/react";

const convex = vi.hoisted(() => ({
  calls: [] as { fn: string; args: Record<string, unknown> }[],
  reject: null as string | null,
}));

vi.mock("convex/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("convex/react")>();
  return {
    ...actual,
    useQuery: () => undefined,
    useMutation: () => async (args: Record<string, unknown>) => {
      convex.calls.push({ fn: "mutation", args });
      if (convex.reject) throw new Error(convex.reject);
      return undefined;
    },
  };
});

import { system } from "@/lib/theme";
import { GroupCheckpointBandControl } from "../GroupCheckpointBandControl";
import {
  ConfirmGroupCheckpointDialog,
  type GroupCheckpointMembersPreview,
} from "../ConfirmGroupCheckpointDialog";
import {
  groupCheckpointActionLabel,
  groupCheckpointIntent,
  sameCheckpointBand,
  scholarCountLabel,
  type GroupCheckpointIntent,
  type MathPlanCheckpoint,
} from "../mathPlanProjection";

const BAND: MathPlanCheckpoint = {
  domain: "geometry-measurement",
  grade: "7",
  strand: "angle",
};

function members(
  overrides: Partial<GroupCheckpointMembersPreview> = {},
): GroupCheckpointMembersPreview {
  return {
    total: 4,
    following: 3,
    keepingOwn: 1,
    none: 0,
    blockedByScope: [],
    blockedByGroup: [],
    ...overrides,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
// The control that raised the open request. The view keeps this outside the
// request state for the same reason: the dialog asks where focus should return
// while it is closing, by which point the request is already gone.
let lastTrigger: HTMLElement | null = null;

/**
 * The view's wiring, in miniature: the control raises a request, the dialog is
 * the only thing that can answer it, and the single write lives behind the
 * confirm. Everything the real view owns that matters here — request state,
 * saving, error, one mutation — is reproduced.
 */
function Harness(props: {
  memberTotal?: number;
  current?: MathPlanCheckpoint | null;
  currentRevision?: number | null;
  liveRevision?: number | null;
  band?: MathPlanCheckpoint | null;
  preview?: GroupCheckpointMembersPreview | undefined;
  previewReady?: boolean;
  /** Records/reads the control that opened the dialog. Held by the test rather
   *  than the component so the harness stays a pure function of its props. */
  onTrigger: (el: HTMLElement | null) => void;
  getTrigger: () => HTMLElement | null;
  write: (
    fn: "setGroupCheckpoint" | "clearGroupCheckpoint",
    args: Record<string, unknown>,
  ) => Promise<void>;
}): ReactNode {
  const band = props.band === undefined ? BAND : props.band;
  const current = props.current ?? null;
  const [request, setRequest] = useState<{
    intent: GroupCheckpointIntent;
    target: MathPlanCheckpoint | null;
    expectedUpdatedAt: number | null;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return createElement(
    "div",
    null,
    createElement(GroupCheckpointBandControl, {
      groupName: "Angle crew",
      memberTotal: props.memberTotal ?? 4,
      band,
      bandLabel: band ? "Angle · grade 7" : null,
      bandSkillCount: 5,
      currentLabel: current ? "Chance · grade 6" : null,
      isCurrent: sameCheckpointBand(current, band),
      onRequest: (intent, target, triggerEl) => {
        setError(null);
        props.onTrigger(triggerEl);
        setRequest({
          intent:
            intent === "clear"
              ? "clear"
              : groupCheckpointIntent(current, target!),
          target: intent === "clear" ? null : target,
          expectedUpdatedAt: props.currentRevision ?? null,
        });
      },
    }),
    createElement(ConfirmGroupCheckpointDialog, {
      open: !!request,
      intent: request?.intent ?? "set",
      groupName: "Angle crew",
      targetLabel: request?.target ? "Angle · grade 7" : null,
      targetChipLabel: request?.target ? "G7" : null,
      currentLabel: current ? "Chance · grade 6" : null,
      expectedUpdatedAt: request?.expectedUpdatedAt,
      checkpointRevision:
        props.previewReady === false
          ? undefined
          : (props.liveRevision ?? props.currentRevision ?? null),
      members: props.previewReady === false ? undefined : props.preview ?? members(),
      saving,
      error,
      onConfirm: () => {
        void (async () => {
          if (!request) return;
          setSaving(true);
          try {
            if (request.target === null) {
              await props.write("clearGroupCheckpoint", {
                groupId: "group-1",
                expectedUpdatedAt: request.expectedUpdatedAt,
              });
            } else {
              await props.write("setGroupCheckpoint", {
                groupId: "group-1",
                ...request.target,
                expectedUpdatedAt: request.expectedUpdatedAt,
              });
            }
            setRequest(null);
          } catch (caught) {
            setError(caught instanceof Error ? caught.message : "failed");
          } finally {
            setSaving(false);
          }
        })();
      },
      onCancel: () => {
        setRequest(null);
        setError(null);
      },
      finalFocusEl: () => props.getTrigger(),
    }),
  );
}

const writes: { fn: string; args: Record<string, unknown> }[] = [];
let writeFails: string | null = null;

async function write(fn: string, args: Record<string, unknown>) {
  writes.push({ fn, args });
  if (writeFails) throw new Error(writeFails);
}

async function render(props: Record<string, unknown> = {}) {
  await act(async () => {
    root!.render(
      // eslint-disable-next-line react/no-children-prop -- Chakra's createElement type requires children in the props object
      createElement(ChakraProvider, {
        value: system,
        children: createElement(Harness, {
          write,
          onTrigger: (el: HTMLElement | null) => {
            lastTrigger = el;
          },
          getTrigger: () => lastTrigger,
          ...props,
        } as never),
      }),
    );
  });
}

/** The dialog on its own, for the states the control cannot reach. */
async function renderDialog(overrides: Record<string, unknown> = {}) {
  await act(async () => {
    root!.render(
      // eslint-disable-next-line react/no-children-prop -- Chakra's createElement type requires children in the props object
      createElement(ChakraProvider, {
        value: system,
        children: createElement(ConfirmGroupCheckpointDialog, {
          open: true,
          intent: "set",
          groupName: "Angle crew",
          targetLabel: "Angle · grade 7",
          targetChipLabel: "G7",
          currentLabel: null,
          members: members(),
          saving: false,
          error: null,
          onConfirm: () => {},
          onCancel: () => {},
          ...overrides,
        } as never),
      }),
    );
  });
}

function pick(testId: string) {
  return document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

const action = () => pick("group-checkpoint-band-action") as HTMLButtonElement;
/** The dialog only counts as present while it is OPEN — Chakra keeps a closed
 *  dialog's subtree mounted until its exit animation ends, which never happens
 *  in jsdom. */
const dialog = () => {
  const el = pick("group-checkpoint-dialog");
  return el && el.getAttribute("data-state") === "open" ? el : null;
};
const confirm = () => pick("group-checkpoint-confirm") as HTMLButtonElement;
const cancel = () => pick("group-checkpoint-cancel") as HTMLButtonElement;

async function press(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await nextFrame();
  });
}

async function escape() {
  await act(async () => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await nextFrame();
  });
}

function nextFrame() {
  return new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => resolve());
    } else {
      queueMicrotask(resolve);
    }
  });
}

async function waitForDialogToClose() {
  // Ark closes and restores focus after its layer lifecycle, not on a guessed
  // timeout. Advance frames only while the dialog still reports itself open.
  for (let frame = 0; frame < 3 && dialog(); frame += 1) {
    await act(async () => {
      await nextFrame();
    });
  }
  expect(dialog()).toBeNull();
}

/**
 * jsdom lays nothing out, so every element reports a zero-size box — and the
 * focus trap behind Ark's dialog decides an element is unfocusable when it has
 * no client rects. Without this shim the trap finds no candidates and parks
 * focus on the dialog container, which would make the focus claims below
 * vacuously fail. Giving elements a box is the smallest lie that lets the REAL
 * focus behaviour run.
 */
function giveElementsABox() {
  const rect = {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 100,
    bottom: 40,
    width: 100,
    height: 40,
    toJSON: () => ({}),
  } as DOMRect;
  const list = Object.assign([rect], { item: () => rect }) as unknown as DOMRectList;
  const proto = window.HTMLElement.prototype;
  vi.spyOn(proto, "getClientRects").mockReturnValue(list);
  vi.spyOn(proto, "getBoundingClientRect").mockReturnValue(rect);
  Object.defineProperty(proto, "offsetParent", {
    configurable: true,
    get() {
      return this.parentElement;
    },
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  giveElementsABox();
  convex.calls = [];
  convex.reject = null;
  writes.length = 0;
  writeFails = null;
  lastTrigger = null;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("the group checkpoint action", () => {
  it("names the group's exact server total, not what the matrix is showing", async () => {
    // The label is rendered from the SERVER member total. A filtered matrix
    // showing two columns must not shrink the number of children it reaches.
    await render({ memberTotal: 4 });
    expect(action().textContent).toContain("Set checkpoint for 4 scholars");
    expect(action().textContent).not.toContain("2 scholars");
  });

  it("says move, not set, when the group already holds another band", async () => {
    await render({ current: { domain: "probability", grade: "6" } });
    expect(action().textContent).toContain("Move checkpoint for 4 scholars");
  });

  it("offers clear when this band already IS the group's checkpoint", async () => {
    await render({ current: BAND });
    expect(action().textContent).toContain("Clear checkpoint for 4 scholars");
    expect(pick("group-checkpoint-current-pill")).toBeTruthy();
  });

  it("states the band cannot be authored when the skill has no grade", async () => {
    await render({ band: null });
    expect(action().disabled).toBe(true);
    expect(action().textContent).toContain("No band");
  });

  it("opens the confirmation and writes NOTHING on the first click", async () => {
    await render();
    await waitForDialogToClose();
    await press(action());
    expect(dialog()).toBeTruthy();
    expect(writes).toEqual([]);
  });
});

describe("the confirmation", () => {
  it("sends exactly one group mutation carrying the exact band", async () => {
    await render();
    await press(action());
    await press(confirm());
    expect(writes).toEqual([
      {
        fn: "setGroupCheckpoint",
        args: {
          groupId: "group-1",
          domain: "geometry-measurement",
          expectedUpdatedAt: null,
          grade: "7",
          strand: "angle",
        },
      },
    ]);
    // One write at group altitude — never one per member.
    expect(writes).toHaveLength(1);
    expect(dialog()).toBeNull();
  });

  it("sends the revision captured when the confirmation opened", async () => {
    await render({ currentRevision: 10, liveRevision: 10 });
    await press(action());
    await press(confirm());

    expect(writes[0]?.args.expectedUpdatedAt).toBe(10);
  });

  it("sends exactly one clear when the band is already the checkpoint", async () => {
    await render({ current: BAND });
    await press(action());
    await press(confirm());
    expect(writes).toEqual([
      {
        fn: "clearGroupCheckpoint",
        args: { groupId: "group-1", expectedUpdatedAt: null },
      },
    ]);
  });

  it("says this changes group policy while individual exceptions stay", async () => {
    await render();
    await press(action());
    expect(pick("group-checkpoint-title")!.textContent).toBe(
      "Set checkpoint for 4 scholars",
    );
    expect(pick("group-checkpoint-policy-note")!.textContent).toContain(
      "all 4 scholars in this math group",
    );
    expect(pick("group-checkpoint-policy-note")!.textContent).toContain(
      "Individual checkpoint exceptions stay in place",
    );
  });

  it("frames a clear as removing the group's policy, not anyone's own", async () => {
    await renderDialog({ intent: "clear", targetLabel: null, targetChipLabel: null });
    expect(pick("group-checkpoint-policy-note")!.textContent).toContain(
      "scholars with their own checkpoint keep it",
    );
    expect(confirm().textContent).toContain("Clear checkpoint");
  });

  it("shows the exception split truthfully and drops only zero rows", async () => {
    await renderDialog({ members: members({ following: 3, keepingOwn: 1, none: 0 }) });
    expect(pick("group-checkpoint-members-following")!.textContent).toContain(
      "3 following the group checkpoint",
    );
    expect(pick("group-checkpoint-members-keepingOwn")!.textContent).toContain(
      "1 keeping their own checkpoint instead",
    );
    // A zero row is noise, not information.
    expect(pick("group-checkpoint-members-none")).toBeNull();
  });

  it("never hides a nonzero exception", async () => {
    await renderDialog({ members: members({ following: 1, keepingOwn: 1, none: 2 }) });
    expect(pick("group-checkpoint-members-none")!.textContent).toContain(
      "2 with no checkpoint at all",
    );
  });

  it("names blockers, disables confirm, and says what to do next", async () => {
    await renderDialog({
      members: members({
        blockedByGroup: [
          { scholarId: "s1", name: "Nalu", groupName: "Fractions crew" },
        ],
        blockedByScope: [{ scholarId: "s2", name: "Kai" }],
      }),
    });
    const blockers = pick("group-checkpoint-blockers")!;
    expect(blockers.textContent).toContain("Nalu (Fractions crew)");
    expect(blockers.textContent).toContain("Remove them from that group first");
    expect(blockers.textContent).toContain("Kai");
    expect(blockers.textContent).toContain("Widen it in their math plan");
    expect(confirm().disabled).toBe(true);
    expect(
      pick("group-checkpoint-members-after-blockers")!.textContent,
    ).toContain("If these blockers are resolved");
  });

  it("does not block a clear on membership conflicts the server ignores", async () => {
    await renderDialog({
      intent: "clear",
      targetLabel: null,
      targetChipLabel: null,
      members: members({
        blockedByGroup: [
          { scholarId: "s1", name: "Nalu", groupName: "Fractions crew" },
        ],
      }),
    });
    expect(pick("group-checkpoint-blockers")).toBeNull();
    expect(confirm().disabled).toBe(false);
  });

  it("waits, rather than guessing, while the preview is still loading", async () => {
    await renderDialog({ members: undefined });
    expect(pick("group-checkpoint-loading")).toBeTruthy();
    expect(pick("group-checkpoint-members")).toBeNull();
    expect(confirm().disabled).toBe(true);
    expect(pick("group-checkpoint-title")!.textContent).toBe("Checking this group…");
  });

  it.each([
    {
      name: "a row appearing",
      initial: { current: null, currentRevision: null },
      updated: { current: BAND, currentRevision: 10, liveRevision: 10 },
    },
    {
      name: "a checkpoint moving",
      initial: { current: BAND, currentRevision: 10 },
      updated: {
        current: { ...BAND, grade: "8" },
        currentRevision: 20,
        liveRevision: 20,
      },
    },
    {
      name: "a row clearing",
      initial: { current: BAND, currentRevision: 10 },
      updated: { current: null, currentRevision: null, liveRevision: null },
    },
  ])("blocks a confirm after $name while it is open", async ({ initial, updated }) => {
    await render(initial);
    await press(action());
    await render(updated);

    expect(pick("group-checkpoint-stale")!.textContent).toContain(
      "changed while this confirmation was open",
    );
    expect(confirm().disabled).toBe(true);
    await press(confirm());
    expect(writes).toEqual([]);
  });

  it("does not stale on a reactive member-count update with the same revision", async () => {
    await render({ currentRevision: 10, liveRevision: 10 });
    await press(action());
    await render({
      currentRevision: 10,
      liveRevision: 10,
      preview: members({ following: 2, keepingOwn: 2 }),
    });

    expect(pick("group-checkpoint-stale")).toBeNull();
    expect(confirm().disabled).toBe(false);
  });

  it("does not call a loading preview stale", async () => {
    await render({ currentRevision: 10, liveRevision: 10, previewReady: false });
    await press(action());

    expect(pick("group-checkpoint-stale")).toBeNull();
    expect(confirm().disabled).toBe(true);
  });

  it("keeps the dialog open and shows the server's words when a write fails", async () => {
    writeFails = "Kai\u2019s practice scope excludes grade 7.";
    await render();
    await press(action());
    await press(confirm());
    expect(dialog()).toBeTruthy();
    expect(pick("group-checkpoint-error")!.textContent).toContain(
      "Kai\u2019s practice scope excludes grade 7.",
    );
    expect(writes).toHaveLength(1);
  });

  it("writes nothing on cancel", async () => {
    await render();
    await press(action());
    await press(cancel());
    expect(writes).toEqual([]);
    await waitForDialogToClose();
  });

  it("writes nothing on Escape", async () => {
    await render();
    await press(action());
    await escape();
    expect(writes).toEqual([]);
    await waitForDialogToClose();
  });

  it("starts focus on the safe exit, never on the write", async () => {
    await render();
    await press(action());
    // A stray Enter must not author group policy.
    expect(document.activeElement).toBe(cancel());
  });

  it("returns focus to the control that opened it", async () => {
    await render();
    const trigger = action();
    await press(trigger);
    await press(cancel());
    await waitForDialogToClose();
    expect(document.activeElement).toBe(trigger);
  });
});

describe("the words the two surfaces share", () => {
  it("counts one scholar without pluralising", () => {
    expect(scholarCountLabel(1)).toBe("1 scholar");
    expect(scholarCountLabel(4)).toBe("4 scholars");
  });

  it("reads set/move/clear off the group's stored band", () => {
    expect(groupCheckpointIntent(null, BAND)).toBe("set");
    expect(groupCheckpointIntent(BAND, BAND)).toBe("set");
    expect(
      groupCheckpointIntent({ domain: "probability", grade: "6" }, BAND),
    ).toBe("move");
    expect(groupCheckpointActionLabel("move", 4)).toBe(
      "Move checkpoint for 4 scholars",
    );
    expect(groupCheckpointActionLabel("clear", 1)).toBe(
      "Clear checkpoint for 1 scholar",
    );
  });

  it("treats a whole-domain band as a different band from a stranded one", () => {
    expect(
      sameCheckpointBand(
        { domain: "geometry-measurement", grade: "7" },
        BAND,
      ),
    ).toBe(false);
    expect(sameCheckpointBand(null, null)).toBe(true);
    expect(sameCheckpointBand(null, BAND)).toBe(false);
  });
});

/**
 * The claims below are about what the wiring may NOT contain — a second
 * confirmation component, a second write path, a pill that mutates on click.
 * Absence is the shape a rendered test cannot prove, so these read the source.
 */
describe("the wiring in the view", () => {
  // Resolved from the repo root: under jsdom `import.meta.url` is rewritten to
  // a browser-ish base that node:fs cannot open.
  const read = (name: string) =>
    readFileSync(join(process.cwd(), "components/practice", name), "utf8");
  const view = read("MathSkillsMasteryView.tsx");
  const heading = read("StrandHeading.tsx");
  const control = read("GroupCheckpointBandControl.tsx");
  const dialog = read("ConfirmGroupCheckpointDialog.tsx");

  it("keeps exactly one group write of each kind, both behind the confirm", () => {
    expect(view.match(/await setGroupCheckpoint\(/g)).toHaveLength(1);
    expect(view.match(/await clearGroupCheckpoint\(/g)).toHaveLength(1);
    // Both live in the confirmation handler, nowhere else.
    const confirmHandler = view.slice(
      view.indexOf("const confirmCheckpointRequest ="),
      view.indexOf("// One scholar's plan, stated in words"),
    );
    expect(confirmHandler).toContain("await setGroupCheckpoint(");
    expect(confirmHandler).toContain("await clearGroupCheckpoint(");
  });

  it("routes the heading grade pill through the same confirmation", () => {
    // The pill raises requests; it no longer reaches a mutation.
    expect(view).toContain("onSetGrade={(grade, trigger) =>");
    expect(view).toContain("requestBandCheckpoint(grade, undefined, trigger)");
    expect(view).toContain("onClear={(trigger) => requestClearBandCheckpoint(trigger)}");
    expect(view).not.toContain("handleSetBandCheckpoint");
    expect(view).not.toContain("handleClearBandCheckpoint");
    // …and the pill itself has never held one.
    expect(heading).not.toContain("useMutation");
    expect(heading).toContain("onSetGrade(grade, triggerRef.current)");
    expect(heading).toContain("onClear(triggerRef.current)");
  });

  it("mounts exactly one confirmation component", () => {
    expect(view.match(/<ConfirmGroupCheckpointDialog/g)).toHaveLength(1);
    expect(view.match(/\{checkpointConfirmDialog\}/g)).toHaveLength(1);
  });

  it("waits for the checkpoint preview before mounting the panel action", () => {
    // `groupCheckpointEditable` is the scope test: a real group id, and nobody
    // focused. `effectiveNode` is the skill. The count comes from the server
    // query, not a participation-filtered shell count.
    expect(view).toContain(
      "const groupCheckpointEditable = !!checkpointGroupId && !effectiveScholarId;",
    );
    expect(view).toContain("const checkpointGroupId = scopeGroupId ?? null;");
    expect(view).toMatch(
      /checkpointForGroupState === undefined/,
    );
    expect(view).toContain("Checking group checkpoint…");
    expect(view).toContain("checkpointForGroupState.members.total > 0");
    expect(view).toContain(
      "checkpointForGroupState?.groupName ?? scopeGroupName ??",
    );
    expect(view).not.toContain("scopeGroupMemberTotal");
  });

  it("does not call two missing bands a current group checkpoint", () => {
    expect(view).toContain(
      "skillBand !== null && sameCheckpointBand(groupCheckpoint, skillBand)",
    );
  });

  it("does not send the synthetic strandless bucket to the preview query", () => {
    expect(view).toContain(
      'const checkpointStrand =\n                          strand === "other" ? undefined : strand;',
    );
    expect(view).toContain(
      "groupCheckpointEditable &&\n                            checkpointStrand !== undefined",
    );
    expect(view).toContain(
      '"Strandless skills use the domain checkpoint."',
    );
    expect(view).not.toContain(
      "requestBandCheckpoint(grade, strand, trigger)",
    );
  });

  it("hands the control only to the desktop detail frame", () => {
    expect(view.match(/groupCheckpointControl=\{groupCheckpointControl\}/g)).toHaveLength(1);
  });

  it("previews the proposed target for a set, and the group as-is for a clear", () => {
    const preview = view.slice(
      view.indexOf("const checkpointPreview = useQuery("),
      view.indexOf("// Which grade the header pill shows as current"),
    );
    expect(preview).toContain("checkpointRequest.target");
    expect(preview).toContain("{ target: checkpointRequest.target }");
  });

  it("snapshots the revision at request time and sends that snapshot", () => {
    const confirmHandler = view.slice(
      view.indexOf("const confirmCheckpointRequest ="),
      view.indexOf("// One scholar's plan, stated in words"),
    );
    expect(confirmHandler.match(/expectedUpdatedAt:/g)).toHaveLength(2);
    expect(confirmHandler).toContain("expectedUpdatedAt: checkpointRequest.expectedUpdatedAt");
    expect(view).toContain("expectedUpdatedAt: groupCheckpoint?.updatedAt ?? null");
    expect(view).toContain("checkpointRevision={");
  });

  it("never lets the two authored surfaces mutate on their own", () => {
    for (const source of [control, dialog]) {
      expect(source).not.toContain("useMutation");
      expect(source).not.toContain("setGroupCheckpoint(");
      expect(source).not.toContain("clearGroupCheckpoint(");
    }
  });

  it("paints nothing optimistically — the label comes from the server total", () => {
    expect(control).toContain("groupCheckpointActionLabel(intent, memberTotal)");
    expect(control).not.toContain("useState");
  });
});
