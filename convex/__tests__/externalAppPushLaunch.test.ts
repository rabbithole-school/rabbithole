// A PUSHED External App must be visible on the Apps launcher, not only on the
// FocusStrip "Right now" card — and it must be launchable from both.
//
// This is the push twin of `externalAppGrantLaunch.test.ts`. A block-scoped
// app push is the school's NORMAL way to put a managed native app in front of
// a class (the 2026-09-02 ruling: placements, not standing grants), so a push
// is an access authority in its own right. But `launcherShowsApp` took only
// `granted`, and the push term was each caller's job to remember with a local
// `||`. Three of five call sites forgot it: the launcher TILE, the web launch
// gate, and the credential autofill. Only the native launch gate had it.
//
// Observed in production 2026-09-17: Photography's Block E app push was live
// (`linkState: "live"`) and the iPad's MDM allowlist carried the Stop Motion
// bundle the whole period — but the Apps tile was gone, because the standing
// group grant that had been making it appear for an unrelated reason was
// (correctly) deleted two days earlier. The class lost its door mid-lesson.
//
// These tests pin the push authority to every surface, and pin the two
// directions that make a standing grant unnecessary: a push that is not yet
// live shows nothing, and a cleared push stops showing.
//
// Fixture people come from the documented fictional dev cast — this repo is public.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { launcherShowsApp } from "../lib/appAudiences";
import {
  seedScholarInInstitution,
  seedTestInstitution,
  seedStaffWithMembership,
} from "./institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const _makeTestClient = () => convexTest(schema, modules);
type TestClient = ReturnType<typeof _makeTestClient>;

async function withUser(t: TestClient, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    }),
  );
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

const DAY_MS = 24 * 60 * 60 * 1000;

type PushState =
  | "live"
  // Past `endsAt`, same institution day, never cleared. Deliberately STILL
  // showing — see the overrun case below.
  | "overrun"
  // `setAt` on a PREVIOUS institution day with no future `endsAt`: the day
  // boundary has passed, so it stops showing with no database write.
  | "yesterday"
  | "homework"
  | "planned"
  | "cleared";

/**
 * One school, one teacher, one app, one scholar in a group — and an app push
 * to that group in the requested lifecycle state. Deliberately NO
 * `appAudiences` grant and NO `scholarApps` row: the push must carry access on
 * its own, which is the whole point.
 */
async function seedPushedApp(
  t: TestClient,
  state: PushState = "live",
  opts: { scholarInGroup?: boolean } = {},
) {
  const institutionId = await seedTestInstitution(t, { slug: "kila" });
  const teacherId = await seedStaffWithMembership(t, {
    institutionId,
    role: "teacher",
    name: "Nalani Fisher",
    username: "nalani-pushlaunch",
  });
  const scholarId = await seedScholarInInstitution(t, {
    institutionId,
    name: "Kai Kahale",
    username: "kai-pushlaunch",
  });
  const appId = await t.run((ctx) =>
    ctx.db.insert("externalApps", {
      name: "Animation Studio",
      webUrl: "https://animation.example.com/studio",
      webAllowedHosts: ["animation.example.com"],
    }),
  );
  const groupId = await t.run((ctx) =>
    ctx.db.insert("scholarGroups", {
      teacherId,
      institutionId,
      name: "Photography",
      scholarIds: opts.scholarInGroup === false ? [] : [scholarId],
    }),
  );
  const now = Date.now();
  const pushId = await t.run((ctx) =>
    ctx.db.insert("pushes", {
      institutionId,
      target: { kind: "app", externalAppId: appId },
      audience: { kind: "group", groupId },
      pushedBy: teacherId,
      // A block-scoped focus: the placement's window.
      timing:
        state === "homework"
          ? { kind: "homework" as const, dueAt: now + 24 * 60 * 60 * 1000 }
          : state === "overrun"
            ? { kind: "focus" as const, endsAt: now - 30 * 60 * 1000 }
            : state === "yesterday"
              ? { kind: "focus" as const, endsAt: now - 2 * DAY_MS }
              : { kind: "focus" as const, endsAt: now + 60 * 60 * 1000 },
      blocking: false,
      // `setAt` stamped = live to scholars; absent = planned, agenda-only.
      ...(state === "planned"
        ? {}
        : { setAt: state === "yesterday" ? now - 2 * DAY_MS : now }),
      ...(state === "cleared"
        ? { clearedAt: now, clearedReason: "expired" as const }
        : {}),
    }),
  );
  return { institutionId, teacherId, scholarId, appId, groupId, pushId };
}

describe("pushed External Apps are on the launcher, not just the Now card", () => {
  test("a live app push with NO grant and NO row shows a tile AND opens a session", async () => {
    // The 2026-09-17 Photography regression, in one test.
    const t = convexTest(schema, modules);
    const { scholarId, appId } = await seedPushedApp(t, "live");
    const asScholar = await withUser(t, scholarId);

    const tiles = await asScholar.query(api.scholarApps.listForLauncher, {});
    expect(tiles.map((tile) => tile.appId)).toEqual([appId]);
    expect(tiles[0].scholarAppId).toBeNull();

    const { sessionId } = await asScholar.mutation(
      api.webActivitySessions.start,
      { appId },
    );
    const row = await t.run((ctx) => ctx.db.get(sessionId));
    expect(row?.appId).toBe(appId);
    expect(row?.scholarId).toBe(scholarId);
  });

  test("a live push offers the library-card autofill", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, appId } = await seedPushedApp(t, "live");
    await t.run(async (ctx) => {
      await ctx.db.patch(appId, { credentialSource: "libraryCard" });
      await ctx.db.patch(scholarId, {
        libraryCredential: { id: "29001000654321", password: "4321" },
      });
    });

    const asScholar = await withUser(t, scholarId);
    const creds = await asScholar.query(api.scholarApps.credentialsForApp, {
      appId,
    });
    expect(creds?.username).toBe("29001000654321");
    expect(creds?.password).toBe("4321");
  });

  test("a PLANNED push (never stamped live) shows nothing", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, appId } = await seedPushedApp(t, "planned");
    const asScholar = await withUser(t, scholarId);

    expect(await asScholar.query(api.scholarApps.listForLauncher, {})).toEqual(
      [],
    );
    await expect(
      asScholar.mutation(api.webActivitySessions.start, { appId }),
    ).rejects.toThrow(/not available to you/i);
    expect(
      await asScholar.query(api.scholarApps.credentialsForApp, { appId }),
    ).toBeNull();
  });

  test("a CLEARED push stops showing — this is what replaces a standing grant", async () => {
    // The property that makes the 2026-09-02 ruling safe: after the bell the
    // tile goes away on its own, so nobody needs a clockless group grant.
    const t = convexTest(schema, modules);
    const { scholarId, appId } = await seedPushedApp(t, "cleared");
    const asScholar = await withUser(t, scholarId);

    expect(await asScholar.query(api.scholarApps.listForLauncher, {})).toEqual(
      [],
    );
    await expect(
      asScholar.mutation(api.webActivitySessions.start, { appId }),
    ).rejects.toThrow(/not available to you/i);
  });

  test("a live push does not leak to a scholar outside its audience", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, appId } = await seedPushedApp(t, "live", {
      scholarInGroup: false,
    });
    const asOutsider = await withUser(t, scholarId);

    expect(await asOutsider.query(api.scholarApps.listForLauncher, {})).toEqual(
      [],
    );
    await expect(
      asOutsider.mutation(api.webActivitySessions.start, { appId }),
    ).rejects.toThrow(/not available to you/i);
  });
});

describe("the push authority's edges", () => {
  test("an OVERRUN focus (past endsAt, uncleared, same day) still shows — and every surface agrees", async () => {
    // Deliberate, and the reason the tile consults `isPushShowing` rather than
    // the window: the FocusStrip card is still rendered with Extend/Wrap
    // offered to the teacher, so a tile or gate that closed here would put a
    // visible, tappable affordance in front of a scholar and then refuse it.
    // `autoClearPush` stamping `clearedAt` is what actually ends the push.
    const t = convexTest(schema, modules);
    const { scholarId, appId } = await seedPushedApp(t, "overrun");
    const asScholar = await withUser(t, scholarId);

    const tiles = await asScholar.query(api.scholarApps.listForLauncher, {});
    expect(tiles.map((tile) => tile.appId)).toEqual([appId]);
    // The launch gate must not disagree with the tile it just rendered.
    const { sessionId } = await asScholar.mutation(
      api.webActivitySessions.start,
      { appId },
    );
    expect(await t.run((ctx) => ctx.db.get(sessionId))).not.toBeNull();
  });

  test("a push whose institution DAY has passed stops showing", async () => {
    // The boundary a reactive query cannot notice on its own — which is why
    // `listForLauncher` takes the minute-rounded `now` cache-buster. Here we
    // assert the server's verdict; the argument is what re-arms the client.
    const t = convexTest(schema, modules);
    const { scholarId, appId } = await seedPushedApp(t, "yesterday");
    const asScholar = await withUser(t, scholarId);

    expect(await asScholar.query(api.scholarApps.listForLauncher, {})).toEqual(
      [],
    );
    expect(
      await asScholar.query(api.scholarApps.listForLauncher, {
        now: Math.floor(Date.now() / 60_000) * 60_000,
      }),
    ).toEqual([]);
    await expect(
      asScholar.mutation(api.webActivitySessions.start, { appId }),
    ).rejects.toThrow(/not available to you/i);
  });

  test("a live → cleared transition removes the tile (not just a born-cleared row)", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, appId, pushId } = await seedPushedApp(t, "live");
    const asScholar = await withUser(t, scholarId);

    expect(
      (await asScholar.query(api.scholarApps.listForLauncher, {})).map(
        (tile) => tile.appId,
      ),
    ).toEqual([appId]);

    // What the bell actually does.
    await t.run((ctx) =>
      ctx.db.patch(pushId, { clearedAt: Date.now(), clearedReason: "expired" }),
    );

    expect(await asScholar.query(api.scholarApps.listForLauncher, {})).toEqual(
      [],
    );
    await expect(
      asScholar.mutation(api.webActivitySessions.start, { appId }),
    ).rejects.toThrow(/not available to you/i);
  });

  test("an ARCHIVED app shows no tile even while its push is live", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, appId } = await seedPushedApp(t, "live");
    await t.run((ctx) => ctx.db.patch(appId, { archived: true }));
    const asScholar = await withUser(t, scholarId);

    expect(await asScholar.query(api.scholarApps.listForLauncher, {})).toEqual(
      [],
    );
    await expect(
      asScholar.mutation(api.webActivitySessions.start, { appId }),
    ).rejects.toThrow(/unavailable|not available to you/i);
  });

  test("a push does not cross an institution boundary", async () => {
    // Multi-tenant deployment: isolation is enforced per-handler, so the push
    // read must be scoped by the scholar's own institution.
    const t = convexTest(schema, modules);
    const { appId } = await seedPushedApp(t, "live");
    const otherInstitutionId = await seedTestInstitution(t, { slug: "kahiko" });
    const outsiderId = await seedScholarInInstitution(t, {
      institutionId: otherInstitutionId,
      name: "Sloane Kahale",
      username: "sloane-pushlaunch",
    });
    const asOutsider = await withUser(t, outsiderId);

    expect(await asOutsider.query(api.scholarApps.listForLauncher, {})).toEqual(
      [],
    );
    await expect(
      asOutsider.mutation(api.webActivitySessions.start, { appId }),
    ).rejects.toThrow(/not available to you/i);
  });

  test("a HOMEWORK-timed app push has no window — documenting a clockless authority", async () => {
    // `isPushShowing` returns true unconditionally for homework timing ("a
    // deadline to meet, not a window that shuts"), so an app pushed as
    // homework grants the tile until someone clears it. For an ACTIVITY that
    // is right; for an APP it is a standing grant wearing a different hat —
    // the exact shape the 2026-09-02 ruling deletes. Pinned here so the
    // behaviour is a decision rather than a discovery (TRA-336).
    const t = convexTest(schema, modules);
    const { scholarId, appId } = await seedPushedApp(t, "homework");
    const asScholar = await withUser(t, scholarId);

    const tiles = await asScholar.query(api.scholarApps.listForLauncher, {});
    expect(tiles.map((tile) => tile.appId)).toEqual([appId]);
  });
});

describe("launcherShowsApp — the push term's precedence", () => {
  const nowMs = Date.parse("2026-09-28T13:30:00-10:00");

  test("a push outranks a DISABLED direct row, exactly as a grant does", () => {
    // Not a truth table: the POINT is that an authority-level "use this now"
    // beats an explicitly-disabled row, which is a product decision.
    const link = { enabled: false, source: "manual" as const };
    expect(launcherShowsApp({ link, granted: false, pushed: false, nowMs })).toBe(false);
    expect(launcherShowsApp({ link, granted: false, pushed: true, nowMs })).toBe(true);
  });

  test("a credential-parking row stays visibility-neutral without a push", () => {
    const link = { enabled: true, source: "grant" as const };
    expect(launcherShowsApp({ link, granted: false, pushed: false, nowMs })).toBe(false);
    expect(launcherShowsApp({ link, granted: false, pushed: true, nowMs })).toBe(true);
  });

  test("a direct add opened for a day grants until its end, and not from it (TRA-444)", () => {
    const link = { enabled: true, source: "manual" as const, expiresAt: nowMs + 1 };
    expect(launcherShowsApp({ link, granted: false, pushed: false, nowMs })).toBe(true);
    expect(launcherShowsApp({ link, granted: false, pushed: false, nowMs: nowMs + 1 })).toBe(false);
    // The end is the direct add's alone: a grant or a push still counts.
    expect(launcherShowsApp({ link, granted: true, pushed: false, nowMs: nowMs + 1 })).toBe(true);
    expect(launcherShowsApp({ link, granted: false, pushed: true, nowMs: nowMs + 1 })).toBe(true);
  });
});
