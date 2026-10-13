import { describe, expect, test } from "vitest";

import {
  defaultChatOpen,
  defaultWorkshopMode,
  editControlFor,
  effectiveWorkshopMode,
  formatClockTime,
  formatSavedAt,
  isPlayOnlyApp,
  messageThread,
  messageVisibleInMode,
  playSurfaceFor,
  resolveWorkshopMode,
  switchToPlayMode,
  threadForMode,
  WORKSHOP_MODE_PARAM,
} from "./workshopMode";

describe("defaultWorkshopMode", () => {
  test("a teacher build session defaults to edit", () => {
    expect(
      defaultWorkshopMode({ teacherBuildKickoff: true, hasAppRequest: true }),
    ).toBe("edit");
  });

  test("a scholar coached session (app request, no build) defaults to play", () => {
    expect(
      defaultWorkshopMode({ teacherBuildKickoff: false, hasAppRequest: true }),
    ).toBe("play");
  });

  test("a server Play default wins (a teacher rehearsing a Play-only app)", () => {
    expect(defaultWorkshopMode({ serverDefault: "play" })).toBe("play");
    // A server Edit default still lets a scholar-facing app character open
    // the scholar in Play.
    expect(
      defaultWorkshopMode({ serverDefault: "edit", hasAppRequest: true }),
    ).toBe("play");
  });

  test("a scholar vibecode / blank session defaults to edit", () => {
    expect(defaultWorkshopMode({})).toBe("edit");
    expect(
      defaultWorkshopMode({ teacherBuildKickoff: false, hasAppRequest: false }),
    ).toBe("edit");
  });
});

describe("threadForMode", () => {
  test("play talks to the tutor", () => {
    expect(threadForMode("play")).toBe("tutor");
  });

  test("edit talks to the designer", () => {
    expect(threadForMode("edit")).toBe("designer");
  });
});

describe("messageThread", () => {
  test("a stamped message returns its own thread", () => {
    expect(messageThread({ thread: "tutor" })).toBe("tutor");
    expect(messageThread({ thread: "designer" })).toBe("designer");
  });

  test("an absent thread reads as designer (pre-field messages)", () => {
    expect(messageThread({})).toBe("designer");
    expect(messageThread({ thread: null })).toBe("designer");
  });
});

describe("messageVisibleInMode", () => {
  test("a designer turn shows in Edit, not in Play", () => {
    expect(messageVisibleInMode({ thread: "designer" }, "edit")).toBe(true);
    expect(messageVisibleInMode({ thread: "designer" }, "play")).toBe(false);
  });

  test("a tutor turn shows in Play, not in Edit", () => {
    expect(messageVisibleInMode({ thread: "tutor" }, "play")).toBe(true);
    expect(messageVisibleInMode({ thread: "tutor" }, "edit")).toBe(false);
  });

  test("an unstamped (legacy) turn stays visible in BOTH modes", () => {
    expect(messageVisibleInMode({}, "edit")).toBe(true);
    expect(messageVisibleInMode({}, "play")).toBe(true);
    expect(messageVisibleInMode({ thread: null }, "edit")).toBe(true);
    expect(messageVisibleInMode({ thread: null }, "play")).toBe(true);
  });
});

describe("effectiveWorkshopMode", () => {
  test("an edit request is honored only when access is allowed", () => {
    expect(effectiveWorkshopMode("edit", "allowed")).toBe("edit");
    expect(effectiveWorkshopMode("edit", "locked")).toBe("play");
    expect(effectiveWorkshopMode("edit", "hidden")).toBe("play");
  });

  test("a play request always runs as play, regardless of access", () => {
    expect(effectiveWorkshopMode("play", "allowed")).toBe("play");
    expect(effectiveWorkshopMode("play", "locked")).toBe("play");
    expect(effectiveWorkshopMode("play", "hidden")).toBe("play");
  });
});

describe("editControlFor", () => {
  test("allowed shows the control with Edit unlocked", () => {
    expect(editControlFor("allowed")).toEqual({
      showControl: true,
      editUnlocked: true,
    });
  });

  test("locked shows the control with Edit locked", () => {
    expect(editControlFor("locked")).toEqual({
      showControl: true,
      editUnlocked: false,
    });
  });

  test("hidden renders no control at all", () => {
    expect(editControlFor("hidden")).toEqual({
      showControl: false,
      editUnlocked: false,
    });
  });
});

describe("resolveWorkshopMode", () => {
  test("uses the fallback when the param is missing or garbage", () => {
    expect(resolveWorkshopMode({ param: null, fallback: "edit" })).toBe("edit");
    expect(resolveWorkshopMode({ param: undefined, fallback: "play" })).toBe(
      "play",
    );
    expect(resolveWorkshopMode({ param: "nonsense", fallback: "play" })).toBe(
      "play",
    );
  });

  test("a valid param overrides the default (URL persistence)", () => {
    expect(resolveWorkshopMode({ param: "play", fallback: "edit" })).toBe(
      "play",
    );
    expect(resolveWorkshopMode({ param: "edit", fallback: "play" })).toBe(
      "edit",
    );
  });

  test("an edit request falls back to play when Edit is unavailable", () => {
    expect(
      resolveWorkshopMode({
        param: "edit",
        fallback: "edit",
        editSelectable: false,
      }),
    ).toBe("play");
  });

  test("the param key is the stable string", () => {
    expect(WORKSHOP_MODE_PARAM).toBe("mode");
  });
});

describe("formatSavedAt", () => {
  const now = new Date("2026-09-15T14:30:00").getTime();

  test("reads 'not saved yet' before the first save", () => {
    expect(formatSavedAt(null, now)).toBe("not saved yet");
    expect(formatSavedAt(undefined, now)).toBe("not saved yet");
  });

  test("reads 'Saved just now' under a minute old", () => {
    expect(formatSavedAt(now - 5_000, now)).toBe("Saved just now");
    expect(formatSavedAt(now, now)).toBe("Saved just now");
  });

  test("reads a wall-clock time for older saves", () => {
    const savedAt = new Date("2026-09-15T14:14:00").getTime();
    expect(formatSavedAt(savedAt, now)).toBe("Saved 2:14 pm");
  });

  test("formats midnight and noon without a leading zero", () => {
    const noon = new Date("2026-09-15T12:05:00").getTime();
    const midnight = new Date("2026-09-15T00:09:00").getTime();
    const later = new Date("2026-09-16T00:00:00").getTime();
    expect(formatSavedAt(noon, later)).toBe("Saved 12:05 pm");
    expect(formatSavedAt(midnight, later)).toBe("Saved 12:09 am");
  });
});

describe("switchToPlayMode", () => {
  test("enters Play only after a successful flush", async () => {
    let played = false;
    let error: unknown = "unset";
    await switchToPlayMode({
      flush: async () => undefined,
      setPlay: () => {
        played = true;
      },
      onFlushError: (e) => {
        error = e;
      },
    });
    expect(played).toBe(true);
    expect(error).toBe("unset");
  });

  test("a rejected flush stays in Edit and surfaces the error", async () => {
    // The pre-Play flush rejects (an unresolved conflict). The mode must stay
    // in Edit — `setPlay` is never called, so the CodeArtifactViewer never goes
    // read-only and the pending draft is left intact — and the error surfaces.
    let played = false;
    const failure = new Error("This code changed in Rabbithole.");
    let surfaced: unknown = null;
    await switchToPlayMode({
      flush: async () => {
        throw failure;
      },
      setPlay: () => {
        played = true;
      },
      onFlushError: (e) => {
        surfaced = e;
      },
    });
    expect(played).toBe(false);
    expect(surfaced).toBe(failure);
  });
});

describe("formatClockTime", () => {
  test("prints h:mm with a lowercase meridiem and no leading zero", () => {
    expect(formatClockTime(new Date("2026-09-15T14:14:00").getTime())).toBe(
      "2:14 pm",
    );
    expect(formatClockTime(new Date("2026-09-15T09:05:00").getTime())).toBe(
      "9:05 am",
    );
  });

  test("noon and midnight read as 12", () => {
    expect(formatClockTime(new Date("2026-09-15T12:00:00").getTime())).toBe(
      "12:00 pm",
    );
    expect(formatClockTime(new Date("2026-09-15T00:30:00").getTime())).toBe(
      "12:30 am",
    );
  });

  test("is the clock formatSavedAt prints", () => {
    const savedAt = new Date("2026-09-15T14:14:00").getTime();
    const later = savedAt + 3_600_000;
    expect(formatSavedAt(savedAt, later)).toBe(
      `Saved ${formatClockTime(savedAt)}`,
    );
  });
});

describe("playSurfaceFor", () => {
  const scholarPlaying = {
    mode: "play" as const,
    isStaff: false,
    isSessionOwner: true,
  };

  test("a scholar playing a Play-only app sees the app only", () => {
    expect(playSurfaceFor({ ...scholarPlaying, access: "hidden" })).toEqual({
      showResetAppState: false,
      showViewerChrome: false,
    });
  });

  test("a scholar with Edit locked until completion sees the app only", () => {
    expect(playSurfaceFor({ ...scholarPlaying, access: "locked" })).toEqual({
      showResetAppState: false,
      showViewerChrome: false,
    });
  });

  test("a scholar playing their own build keeps Reset and the chrome", () => {
    expect(playSurfaceFor({ ...scholarPlaying, access: "allowed" })).toEqual({
      showResetAppState: true,
      showViewerChrome: true,
    });
  });

  test("a teacher rehearsing a Play-only app keeps Reset and the chrome", () => {
    expect(
      playSurfaceFor({ ...scholarPlaying, isStaff: true, access: "allowed" }),
    ).toEqual({ showResetAppState: true, showViewerChrome: true });
  });

  test("staff watching a scholar's session see no Reset (owner-gated)", () => {
    expect(
      playSurfaceFor({
        mode: "play",
        access: "hidden",
        isStaff: true,
        isSessionOwner: false,
      }).showResetAppState,
    ).toBe(false);
  });

  test("Edit never shows Reset but always shows the chrome", () => {
    expect(
      playSurfaceFor({ ...scholarPlaying, mode: "edit", access: "allowed" }),
    ).toEqual({ showResetAppState: false, showViewerChrome: true });
  });
});

describe("isPlayOnlyApp", () => {
  test("a starter app scholars never edit is Play-only", () => {
    expect(isPlayOnlyApp({ hasStarter: true, editAccess: "never" })).toBe(true);
  });

  test("a build activity is not Play-only", () => {
    expect(isPlayOnlyApp({ hasStarter: true, editAccess: "always" })).toBe(false);
    expect(isPlayOnlyApp({ hasStarter: true })).toBe(false);
    expect(
      isPlayOnlyApp({ hasStarter: true, editAccess: "afterCompletion" }),
    ).toBe(false);
  });

  test("no starter means nothing to play", () => {
    expect(isPlayOnlyApp({ hasStarter: false, editAccess: "never" })).toBe(false);
  });
});

describe("defaultChatOpen", () => {
  const playOnlyCharacter = {
    access: "hidden" as const,
    hasAppCharacter: true,
    isSessionOwner: true,
    isTestDrive: false,
  };

  test("a scholar playing their own Play-only character app opens the chat", () => {
    expect(defaultChatOpen(playOnlyCharacter)).toBe(true);
  });

  test("an app without a character keeps the chat closed", () => {
    expect(
      defaultChatOpen({ ...playOnlyCharacter, hasAppCharacter: false }),
    ).toBe(false);
  });

  test("a Build app (allowed) or a locked app keeps the chat closed", () => {
    expect(defaultChatOpen({ ...playOnlyCharacter, access: "allowed" })).toBe(
      false,
    );
    expect(defaultChatOpen({ ...playOnlyCharacter, access: "locked" })).toBe(
      false,
    );
  });

  test("a teacher rehearsal keeps the chat closed", () => {
    expect(defaultChatOpen({ ...playOnlyCharacter, isTestDrive: true })).toBe(
      false,
    );
  });

  test("someone else viewing the scholar's session keeps the chat closed", () => {
    expect(
      defaultChatOpen({ ...playOnlyCharacter, isSessionOwner: false }),
    ).toBe(false);
  });
});
