import { convexTest } from "convex-test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import {
  MAX_PATCH_LANDING_MS,
  freshDeviceOwner,
  grantedManagedAppKeysForScholar,
  pushedManagedAppKeysForScholar,
} from "../lib/deviceAppProjection";
import { MANAGED_NATIVE_APPS, type ManagedNativeAppKey } from "../lib/managedNativeApps";
import { isPushShowing } from "../lib/pushes";
import { simpleMdmRetryPolicy } from "../lib/simpleMdmClient";
import { APP_PLACEMENT_GRACE_MS, APP_PLACEMENT_LEAD_MS } from "../masterSchedule";
import { dayKeyForTimezone } from "../../shared/institutionDay";
import { WRAPPED, type ProjectionArgs, type ProjectionWatcher } from "./appAccessSequences.mocks";

// ─────────────────────────────────────────────────────────────────────────
// Sequence explorer for the claim–unlock model (model-checking proposal 1,
// step 2): does revocation converge, and does every unlock row finish?
//
// appAccessAgreement.explore.test.ts asks whether the readers agree in one
// moment; this file adds time and order. It replays short sequences of real
// events against one bound iPad:
//   • a teacher's grant, direct link, focus push, archive, scheme change and
//     roster edit, the schedule placement's activation and auto-clear, and
//     the console's "Open all day today" and its expiry job (TRA-444);
//   • staff reassigning, rotating, disabling ("Disable device" →
//     decommissionManagedClaim), removing and unpairing the iPad, the iPad
//     exchanging its claim token, and an admin deleting the scholar;
//   • the lease ceremony (requestUnlock, markReturned), a reconciler pass
//     (the cron's entry point), and ticks past an operation's lease, the
//     verify barrier, an idle lease and midnight.
// A fake SimpleMDM holds the profile's live allowlist and answers each PATCH
// ok, fail, late (the caller's transport gave up; SimpleMDM applies it later,
// in any order, within MAX_PATCH_LANDING_MS), hang (in flight while other
// events run; a tick kills the action) or die (the action dies once it has
// sent: SimpleMDM applies the PATCH later, like a late one, and nothing ever
// records it). The answer is part of the event alphabet, so every
// interleaving of a revocation with an in-flight write is on the table
// (spec §7).
//
// The revocation cases in deviceAppUnlockRevocation.test.ts ("Hole 1–4",
// "second/final/fifth review, Finding N") were found one review round at a
// time. They are one class — a revocation racing a kick, the clock or an
// in-flight write — and this explorer finds it mechanically: with the fix for
// Hole 1, 2 or 3, round 5's Finding 1, the fifth review's Finding 2 or the
// final gate's Finding 3 re-introduced by hand, it fails.
//
// Search: breadth-first from four seeds, one per route to the app (a direct
// link, a group grant, a focus push, a schedule placement still to go live),
// each starting from a device the real reconciler has already projected.
// convex-test has no snapshot, so every edge is replayed from a fresh
// convexTest. States are pruned by an abstract hash (claim, unlock row,
// projection, grants, pushes, app flags, the fake's live profile and in-flight
// writes, a clock bucket), so each counterexample is a shortest trace in the
// model. Every new state is
// probed on its own replay: a pass, a pass one recheck interval later, then a
// drain past every lease. A state whose device the staff console cannot show
// also gets a drain under persistent MDM failure.
//
// Layout: this module is the whole explorer. Each seed's search is its own
// spec, appAccessSequences.<seed>.explore.test.ts, so vitest spreads the four
// across workers (and CI shards) instead of running one long file; the link
// spec also runs the checks on the harness itself. A spec installs the two
// module wrappers in appAccessSequences.mocks.ts with vi.mock, which also
// routes it to the isolated vitest project (vitest.config.ts), and its first
// test proves it did.
//
// Depth 3 runs in CI. APP_ACCESS_SEQ_DEPTH=5 goes deeper;
// APP_ACCESS_SEQ_VERBOSE=1 prints each check with its shortest trace (=shapes:
// every distinct shape); APP_ACCESS_SEQ_KICKS=off deletes the latency kicks
// (spec §6: L1–L3 must hold without them, and they do). All four seeds:
//   APP_ACCESS_SEQ_DEPTH=5 npx vitest run convex/__tests__/appAccessSequences
//
// The checks carry review/claim-unlock-model-spec.html's names. "Authorized"
// means the device's fresh owner is granted or pushed the managed key now,
// read through the projection's own helpers (step 1 pins them to the rule).
//   S1  The relock gate closes a stale lease and keeps a fresh one, and the
//       projector never derives a set from a lease minted under an older
//       claim generation (after the claim changes hands, the old lease
//       authorizes nothing; this is where order dependence shows).
//   S2  A boundary move bumps the generation by one; nothing else touches it.
//   S3  A revoked claim's old token never signs in.
//   S4  Every exchanged session is tagged with its claim and generation.
//   S6  Every PATCH is the row's durable intent, sent under a live token; a
//       relock's intent (locked, unaccepted) is durable before it.
//   S7  One row per claim; no PATCH overtakes a ceremony PATCH in its lease.
//   S8  Once a binding is deleted, the profile holds only its baseline.
//   S9  Every PATCH keeps the full baseline. (Plus: a PATCH never adds an app
//       the fresh owner may not open.)
//   L1, L2  A revoking writer marks the device for the next pass; one marked,
//       quiescent pass leaves nothing unauthorized exposed; one recheck
//       interval later no stale lease is open; a drain settles every row,
//       trusted, with the profile exactly what the owner may open.
//   L3  A removed iPad's teardown ends with both rows gone, or stops within
//       MAX_TEARDOWN_ATTEMPTS with an audit row (#4041); any other row that
//       keeps failing surfaces on the staff device console.
// Not checked, and why: S5 and L4 are obsolete (TRA-366 removed the hold).
// "Two clocks in one gate" is unobservable (one frozen fake clock per
// mutation) and concerned the hold. S7's CAS half is exercised by every late
// or hung record but not asserted on its own. ManualPair, SweepBindings,
// Attach and a second claim or device are not in the alphabet: one device
// keeps a replay cheap enough for CI.
// ─────────────────────────────────────────────────────────────────────────

const KICKS_OFF = process.env.APP_ACCESS_SEQ_KICKS === "off";

// Function modules only: a replay never calls into a test file, and the module
// map is rebuilt for every fresh convexTest.
const modules = (
  import.meta as ImportMeta & {
    glob: (patterns: string[]) => Record<string, () => Promise<unknown>>;
  }
).glob(["../**/*.ts", "!../**/__tests__/**", "!../**/*.test.ts"]);

// convex-test reads a schema only through `schemaValidation` and each table's
// `export()`. Exporting the 233 tables once, instead of on every fresh
// convexTest, cuts a replay's fixed cost from 1.6 ms to 0.3 ms (with the
// narrowed glob above), and replays are the whole cost of the search.
const EXPORTED = Object.fromEntries(
  Object.entries(schema.tables).map(([name, table]) => [name, (table as unknown as { export(): unknown }).export()]),
);
const replaySchema = {
  schemaValidation: (schema as unknown as { schemaValidation: boolean }).schemaValidation,
  tables: Object.fromEntries(Object.keys(EXPORTED).map((name) => [name, { export: () => EXPORTED[name] }])),
} as unknown as typeof schema;

const _makeTestClient = () => convexTest(schema, modules);
type TestClient = ReturnType<typeof _makeTestClient>;
type AsUser = ReturnType<TestClient["withIdentity"]>;

// ─── The clock ───────────────────────────────────────────────────────────

const TZ = "Pacific/Honolulu"; // no DST, so every anchor below is exact
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const hst = (local: string) => Date.parse(`${local}-10:00`);

// Monday 2026-09-28: Robotics, 13:00–14:00, placed with LEGO SPIKE.
const BLOCK_END = hst("2026-09-28T14:00:00");
const WINDOW_OPENS = hst("2026-09-28T13:00:00") - APP_PLACEMENT_LEAD_MS;
const WINDOW_CLOSES = BLOCK_END + APP_PLACEMENT_GRACE_MS;
const OCCURRENCE_DATE = "2026-09-28";
const WORLD_BUILT_AT = hst("2026-09-28T12:30:00");
const EXPLORE_STARTS_AT = hst("2026-09-28T13:20:00");
const NEXT_MORNING = hst("2026-09-29T07:00:00");

// Module-private in convex/deviceAppUnlock.ts. `the mirrored constants match
// the rows the real writers leave` pins each one to real behavior.
const OPERATION_TIMEOUT_MS = 2 * MINUTE;
const RECHECK_INTERVAL_MS = 5 * MINUTE;
const RECHECK_AFTER_INFLIGHT_MS = OPERATION_TIMEOUT_MS + 5 * SECOND;
const LOCK_RETRY_DELAY_MS = 5 * MINUTE;
const ACTIVE_SESSION_FAILSAFE_MS = 8 * HOUR;
const IDLE_LEASE_DURATION_MS = HOUR;
const MAX_TEARDOWN_ATTEMPTS = 12;
const TEARDOWN_STOPPED_RETRY_AT = Number.MAX_SAFE_INTEGER;

// ─── The world ───────────────────────────────────────────────────────────

const APP_NAME = "LEGO SPIKE";
const APP_KEY: ManagedNativeAppKey = "lego-spike";
const RESCHEMED_KEY: ManagedNativeAppKey = "google-sheets";
const SERIAL = "DMPSEQ00001";
const DEVICE_ID = "ipad-kai-sequences";
const PROFILE_ID = "424242";
const SMDM_DEVICE_ID = "9001";
const BASELINE = ["com.apple.Preferences", "school.rabbithole.canary"];
const LEASE_TOKEN = "lease-sequences";
const PAYLOAD_ID = "school.rabbithole.app-access";

const KEY_BY_BUNDLE = new Map<string, ManagedNativeAppKey>(
  (Object.entries(MANAGED_NATIVE_APPS) as [ManagedNativeAppKey, { bundleId: string }][]).map(
    ([key, app]) => [app.bundleId, key],
  ),
);
const managedKeys = (bundles: readonly string[]): ManagedNativeAppKey[] =>
  bundles.flatMap((b) => (KEY_BY_BUNDLE.has(b) ? [KEY_BY_BUNDLE.get(b)!] : [])).sort();

/** A dedicated profile shaped like the fleet's: one app-access payload in a
 *  Configuration profile. The projector adds its Home Screen payload on the
 *  first write, exactly as it does in production. */
function profileXml(bundles: readonly string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadType</key><string>com.apple.applicationaccess</string>
      <key>PayloadIdentifier</key><string>${PAYLOAD_ID}.restrictions</string>
      <key>PayloadUUID</key><string>11111111-1111-1111-1111-111111111111</string>
      <key>allowListedAppBundleIDs</key>
      <array>
${bundles.map((b) => `        <string>${b}</string>`).join("\n")}
      </array>
    </dict>
  </array>
  <key>PayloadIdentifier</key><string>${PAYLOAD_ID}</string>
  <key>PayloadUUID</key><string>22222222-2222-2222-2222-222222222222</string>
  <key>PayloadType</key><string>Configuration</string>
</dict>
</plist>`;
}

function allowlistOf(xml: string): string[] {
  const match = /<key>allowListedAppBundleIDs<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml);
  if (!match) throw new Error("fake SimpleMDM: a profile without an allowlist");
  return [...match[1].matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]).sort();
}

// ─── The fake SimpleMDM ──────────────────────────────────────────────────
//
// One dedicated profile on one enrolled iPad. Reads always succeed (the
// client retries reads on its own); only a PATCH's answer is modelled.
// `liveXml` is the ground truth the iPad enforces.

type Answer = "ok" | "fail" | "late" | "hang" | "die";
type Settle = Exclude<Answer, "hang" | "die">;
type Sent = { at: number; bundles: string[]; writer: "ceremony" | "projection" | "none" };

class FakeSimpleMdm {
  liveXml = profileXml(BASELINE);
  answer: Answer = "ok";
  sent: Sent[] = [];
  /** Accepted after the caller's transport gave up, or after its action died.
   *  Each lands on a `land` event (oldest or newest first), or at the latest
   *  when the clock passes its send time + MAX_PATCH_LANDING_MS (the window
   *  the verify barrier assumes). */
  late: { xml: string; sent: Sent }[] = [];
  hung: { xml: string; sent: Sent; release: (answer: Settle) => void } | null = null;
  onHang: (() => void) | null = null;
  onDie: (() => void) | null = null;
  beforeSend: ((sent: Sent, liveBefore: string[]) => Promise<void>) | null = null;

  live(): string[] {
    return allowlistOf(this.liveXml);
  }

  /** PATCHes SimpleMDM may still apply: the one in flight and the late ones. */
  inFlight(): Sent[] {
    return [...(this.hung ? [this.hung.sent] : []), ...this.late.map((l) => l.sent)];
  }

  land(which: "oldest" | "newest"): void {
    const next = which === "oldest" ? this.late.shift() : this.late.pop();
    if (next) this.liveXml = next.xml;
  }

  landDue(until: number): void {
    while (this.late.length > 0 && this.late[0].sent.at + MAX_PATCH_LANDING_MS <= until) this.land("oldest");
  }

  settle(answer: Settle): void {
    const hung = this.hung!;
    this.hung = null;
    this.answer = answer;
    hung.release(answer);
  }

  /** The action holding the hung PATCH died; SimpleMDM never received it. */
  abandon(): void {
    this.hung = null;
  }

  async handle(url: string, init?: RequestInit): Promise<Response> {
    const method = init?.method ?? "GET";
    if (method === "PATCH" && url.endsWith(`/custom_configuration_profiles/${PROFILE_ID}`)) {
      const xml = await ((init!.body as FormData).get("mobileconfig") as Blob).text();
      const sent: Sent = { at: Date.now(), bundles: allowlistOf(xml), writer: "none" };
      const liveBefore = this.live();
      await this.beforeSend?.(sent, liveBefore);
      this.sent.push(sent);
      let answer: Answer = this.answer;
      if (answer === "die") {
        // SimpleMDM has the body; the action waiting on it never resumes.
        this.late.push({ xml, sent });
        this.onDie?.();
        return await new Promise<never>(() => {});
      }
      if (answer === "hang") {
        answer = await new Promise<Settle>((release) => {
          this.hung = { xml, sent, release };
          this.onHang?.();
        });
      }
      if (answer === "ok") {
        this.liveXml = xml;
        return new Response("{}", { status: 200 });
      }
      if (answer === "fail") return new Response("{}", { status: 500 });
      this.late.push({ xml, sent });
      throw new TypeError("fetch failed");
    }
    if (method !== "GET") throw new Error(`fake SimpleMDM: unexpected ${method} ${url}`);
    if (url.includes(`/custom_configuration_profiles/${PROFILE_ID}/download`)) {
      return new Response(this.liveXml);
    }
    if (url.includes("/devices?")) {
      return Response.json({
        data: [{ id: Number(SMDM_DEVICE_ID), attributes: { serial_number: SERIAL } }],
        meta: { has_more: false },
      });
    }
    if (url.includes(`/devices/${SMDM_DEVICE_ID}/profiles`)) {
      return Response.json({ data: [{ id: Number(PROFILE_ID) }], meta: { has_more: false } });
    }
    if (url.includes("/profiles?")) {
      return Response.json({
        data: [
          {
            id: Number(PROFILE_ID),
            attributes: { name: "Rabbithole app access", group_count: 0, device_count: 1 },
          },
        ],
        meta: { has_more: false },
      });
    }
    throw new Error(`fake SimpleMDM: unexpected GET ${url}`);
  }
}

// ─── Seeding ─────────────────────────────────────────────────────────────

const SEEDS = ["link", "grant", "focus", "placement"] as const;
type Seed = (typeof SEEDS)[number];

const SEED_LABEL: Record<Seed, string> = {
  link: "Kai holds a direct link to LEGO SPIKE",
  grant: "Robotics holds a group grant",
  focus: "a teacher's focus push to Robotics is live",
  placement: "LEGO SPIKE is placed in Robotics' block, not yet live",
};

type World = {
  institutionId: Id<"institutions">;
  teacherId: Id<"users">;
  opsId: Id<"users">;
  adminId: Id<"users">;
  scholarId: Id<"users">;
  otherScholarId: Id<"users">;
  groupId: Id<"scholarGroups">;
  appId: Id<"externalApps">;
  claimId: Id<"managedDeviceClaims">;
  placement: { placementId: Id<"schedulePlacements">; pushId: Id<"pushes"> } | null;
  sessions: Record<"teacher" | "ops" | "admin" | "kai" | "lani", Id<"authSessions">>;
};

const as = (t: TestClient, userId: Id<"users">, sessionId: Id<"authSessions">): AsUser =>
  t.withIdentity({ subject: `${userId}|${sessionId}`, issuer: "https://convex.dev" });

/**
 * The fixed world, in one transaction. The rows are the ones the real writers
 * leave (the fidelity checks at the bottom run them and compare): the claim,
 * pairing and binding of register → assign → exchange →
 * configureDedicatedProfile, and the seed's one route to the app. People are
 * the fictional dev cast. Both scholars are in Robotics, so a group route
 * reaches whoever holds the iPad after a reassignment; only Kai holds a link.
 */
async function seedWorld(t: TestClient, seed: Seed): Promise<World> {
  const now = Date.now();
  return await t.run(async (ctx) => {
    const institutionId = await ctx.db.insert("institutions", {
      name: "Moli School",
      slug: "moli",
      kind: "school",
      isPrimary: true,
      timeZone: TZ,
    });
    const teacherId = await ctx.db.insert("users", { name: "Lehua Torres", username: "lehua-seq", role: "teacher" });
    await ctx.db.insert("memberships", { userId: teacherId, role: "teacher", institutionId });
    const opsId = await ctx.db.insert("users", { name: "Sloane Kahale", username: "sloane-seq", role: "staff" });
    await ctx.db.insert("memberships", { userId: opsId, role: "staff", institutionId });
    await ctx.db.insert("staffCapabilityGrants", {
      granteeUserId: opsId,
      institutionId,
      capability: "school:operations",
      grantedBy: opsId,
      grantedAt: now,
    });
    const adminId = await ctx.db.insert("users", { name: "Hoku Makani", username: "hoku-seq", role: "platform_admin" });
    const scholarId = await ctx.db.insert("users", {
      name: "Kai Kahale",
      username: "kai-seq",
      role: "scholar",
      institutionId,
    });
    const otherScholarId = await ctx.db.insert("users", {
      name: "Lani Kahale",
      username: "lani-seq",
      role: "scholar",
      institutionId,
    });
    const session = (userId: Id<"users">) => ctx.db.insert("authSessions", { userId, expirationTime: now + 30 * DAY });
    const sessions = {
      teacher: await session(teacherId),
      ops: await session(opsId),
      admin: await session(adminId),
      kai: await session(scholarId),
      lani: await session(otherScholarId),
    };
    const appId = await ctx.db.insert("externalApps", {
      name: APP_NAME,
      webUrl: "https://spike.example.com",
      nativeUrlScheme: MANAGED_NATIVE_APPS[APP_KEY].nativeUrlScheme!,
      createdBy: teacherId,
    });
    const groupId = await ctx.db.insert("scholarGroups", {
      teacherId,
      institutionId,
      name: "Robotics",
      scholarIds: [scholarId, otherScholarId],
    });
    const claimId = await ctx.db.insert("managedDeviceClaims", {
      institutionId,
      serial: SERIAL,
      scholarId,
      claimTokenHash: "0".repeat(64),
      claimState: "claimed",
      createdBy: opsId,
      createdAt: now,
      updatedAt: now,
      claimIssuedAt: now,
      rotationCount: 1,
      claimCount: 1,
      firstClaimedAt: now,
      lastClaimedAt: now,
      lastDeviceId: DEVICE_ID,
      claimGeneration: 1,
    });
    await ctx.db.insert("pairedDevices", {
      institutionId,
      scholarId,
      deviceId: DEVICE_ID,
      pairedAt: now,
      pairedBy: opsId,
      managedDeviceClaimId: claimId,
    });
    await ctx.db.insert("deviceAppUnlockBindings", {
      institutionId,
      managedDeviceClaimId: claimId,
      serial: SERIAL,
      simpleMdmProfileId: PROFILE_ID,
      baselineBundleIds: [...BASELINE],
      baselineProfileXml: profileXml(BASELINE),
      profilePayloadIdentifier: PAYLOAD_ID,
      profilePayloadUuid: "11111111-1111-1111-1111-111111111111",
      profileUuid: "22222222-2222-2222-2222-222222222222",
      configuredAt: now,
      configuredBy: opsId,
    });
    if (seed === "link") {
      await ctx.db.insert("scholarApps", { scholarId, appId, enabled: true, source: "manual", addedBy: teacherId });
    }
    if (seed === "grant") {
      await ctx.db.insert("appAudiences", {
        appId,
        audienceKind: "group",
        audienceId: String(groupId),
        enabled: true,
        addedBy: teacherId,
      });
    }
    if (seed === "focus") {
      // As pushes.makeFocus leaves it, ten minutes before exploration starts.
      const setAt = EXPLORE_STARTS_AT - 10 * MINUTE;
      await ctx.db.insert("pushes", {
        institutionId,
        target: { kind: "app", externalAppId: appId },
        audience: { kind: "group", groupId },
        timing: { kind: "focus", endsAt: setAt + HOUR },
        blocking: false,
        setAt,
        pushedBy: teacherId,
      });
    }
    let placement: World["placement"] = null;
    if (seed === "placement") {
      // As masterSchedule.placeClass leaves it before the block: planned for
      // today's window, whose lead-in has opened by EXPLORE_STARTS_AT; the
      // `place+` event is the activation job (step 1's fidelity check pins
      // this row to placeClass, and activation to activatePlacementAppPush).
      const periodId = await ctx.db.insert("reportingPeriods", {
        label: "Fall 2026",
        startsAt: now - 30 * DAY,
        endsAt: now + 90 * DAY,
        status: "open",
        institutionId,
      });
      const blockId = await ctx.db.insert("scheduleBlocks", {
        periodId,
        key: "block.robotics",
        label: "Block R",
        startLocal: "13:00",
        endLocal: "14:00",
        weekdays: [1],
        order: 0,
        kind: "class",
      });
      const placementId = await ctx.db.insert("schedulePlacements", {
        periodId,
        groupId,
        weekday: 1,
        blockId,
        subject: "Robotics",
        teacherId,
        externalAppId: appId,
      });
      const pushId = await ctx.db.insert("pushes", {
        institutionId,
        target: { kind: "app", externalAppId: appId },
        audience: { kind: "group", groupId },
        timing: { kind: "focus", endsAt: WINDOW_CLOSES },
        blocking: false,
        startsAt: WINDOW_OPENS,
        pushedBy: teacherId,
        schedulePlacementId: placementId,
        occurrenceDate: OCCURRENCE_DATE,
      });
      placement = { placementId, pushId };
    }
    return {
      institutionId,
      teacherId,
      opsId,
      adminId,
      scholarId,
      otherScholarId,
      groupId,
      appId,
      claimId,
      placement,
      sessions,
    };
  });
}

/**
 * The device as the real reconciler leaves it after its first pass over the
 * seed: the state row it creates and the profile it writes. Captured once per
 * seed from a real pass, then re-inserted on every replay (replays are the
 * whole cost of the search, and this pass is the same every time).
 */
type Converged = { row: Omit<Doc<"deviceAppUnlockStates">, "_id" | "_creationTime">; liveXml: string };
const CONVERGED = new Map<Seed, Converged>();

// ─── A replay ────────────────────────────────────────────────────────────

type Run = {
  t: TestClient;
  w: World;
  mdm: FakeSimpleMdm;
  asTeacher: AsUser;
  asOps: AsUser;
  asAdmin: AsUser;
  /** An action suspended on a hung PATCH. */
  hung: { kind: "unlock" | "reconcile"; done: Promise<void> } | null;
  /** The raw token the latest mint issued (the iPad exchanges it). */
  claimToken: string | null;
  /** Where the in-flight checks report, or null while replaying a known prefix. */
  armed: string[] | null;
  findings: Findings;
};

/** A broken harness (a missing function, bad arguments) or a crash in the
 *  product, as opposed to a refusal the product meant. */
const isHarnessOrCrash = (error: unknown) =>
  /Expected (a Convex function|an? (query|mutation|action) function)|Could not find module|ArgumentValidationError|TypeError|ReferenceError/.test(
    error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  );

/** Swallow a refusal: an event the product refuses is a legal no-op here. */
async function attempt(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (isHarnessOrCrash(error)) throw error;
    // The refusal is the behavior under test; the next snapshot shows it.
  }
}

let current: Run | null = null;

async function startRun(seed: Seed, findings: Findings): Promise<Run> {
  vi.clearAllTimers();
  vi.setSystemTime(WORLD_BUILT_AT);
  const mdm = new FakeSimpleMdm();
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) =>
    await mdm.handle(String(url), init)) as typeof fetch;
  const t = convexTest(replaySchema, modules);
  const w = await seedWorld(t, seed);
  const r: Run = {
    t,
    w,
    mdm,
    asTeacher: as(t, w.teacherId, w.sessions.teacher),
    asOps: as(t, w.opsId, w.sessions.ops),
    asAdmin: as(t, w.adminId, w.sessions.admin),
    hung: null,
    claimToken: null,
    armed: null,
    findings,
  };
  current = r;
  mdm.beforeSend = (sent, liveBefore) => checkSend(r, sent, liveBefore);
  vi.setSystemTime(EXPLORE_STARTS_AT);
  const converged = CONVERGED.get(seed);
  if (converged) {
    await t.run(async (ctx) => {
      await ctx.db.insert("deviceAppUnlockStates", {
        ...converged.row,
        institutionId: w.institutionId,
        managedDeviceClaimId: w.claimId,
        requestedBy: w.opsId,
      });
    });
    mdm.liveXml = converged.liveXml;
  } else {
    await t.action(internal.deviceAppUnlock.reconcileActiveUnlocks, {});
    const row = await t.run((ctx) => ctx.db.query("deviceAppUnlockStates").unique());
    if (!row) throw new Error(`the ${seed} seed never projected`);
    const { _id, _creationTime, ...fields } = row;
    void _id;
    void _creationTime;
    CONVERGED.set(seed, { row: fields, liveXml: mdm.liveXml });
  }
  return r;
}

async function replay(seed: Seed, path: readonly string[], findings: Findings): Promise<Run> {
  const r = await startRun(seed, findings);
  for (const label of path) await fire(r, label);
  return r;
}

// ─── The event alphabet ──────────────────────────────────────────────────

type EventDef = {
  /** Reads the snapshot: is the event meaningful here? */
  enabled: (s: Snapshot) => boolean;
  run: (r: Run, answer: Answer) => Promise<void>;
  /** A writer that can remove authority, so its kick must mark the device:
   *  a catalog edit (archive, rescheme) or any other writer. */
  kicks?: "catalog" | "other";
  /** A PATCHing event: its label carries the fake's answer (`name!fail`). */
  answers?: readonly Answer[];
};

async function linkRow(r: Run): Promise<Doc<"scholarApps"> | null> {
  return await r.t.run((ctx) =>
    ctx.db
      .query("scholarApps")
      .withIndex("by_scholar_app", (q) => q.eq("scholarId", r.w.scholarId).eq("appId", r.w.appId))
      .first(),
  );
}

async function openPush(r: Run, placement: boolean): Promise<Doc<"pushes"> | null> {
  const rows = await r.t.run((ctx) => ctx.db.query("pushes").collect());
  return rows.find((p) => p.clearedAt === undefined && (p.schedulePlacementId !== undefined) === placement) ?? null;
}

/** Whoever the claim names drives the iPad's ceremony. */
async function deviceHolder(r: Run): Promise<AsUser> {
  const claim = await r.t.run((ctx) => ctx.db.get(r.w.claimId));
  const kai = claim?.scholarId === r.w.scholarId;
  return as(r.t, kai ? r.w.scholarId : r.w.otherScholarId, kai ? r.w.sessions.kai : r.w.sessions.lani);
}

async function mint(r: Run, run: () => Promise<{ claimToken?: string }>): Promise<void> {
  await attempt(async () => {
    const minted = await run();
    r.claimToken = minted.claimToken ?? null;
  });
}

/** Run an action that may park on a hung PATCH or die on a sent one; returns
 *  once it finished, parked or died. */
async function runAction(r: Run, kind: "unlock" | "reconcile", start: () => Promise<unknown>): Promise<void> {
  let parked = false;
  const stopped = new Promise<void>((resolve) => {
    r.mdm.onHang = () => {
      parked = true;
      resolve();
    };
    r.mdm.onDie = resolve;
  });
  const done = start().then(
    () => undefined,
    (error: unknown) => {
      if (isHarnessOrCrash(error)) throw error;
    },
  );
  await Promise.race([done, stopped]);
  r.mdm.onHang = null;
  r.mdm.onDie = null;
  if (parked) r.hung = { kind, done };
}

async function tickTo(r: Run, to: number): Promise<void> {
  // A PATCH still hanging when the clock moves past its request deadline
  // belongs to an action that died: nothing will ever record it.
  if (r.hung) {
    r.mdm.abandon();
    r.hung = null;
  }
  r.mdm.landDue(to);
  vi.setSystemTime(to);
}

const PATCHING: readonly Answer[] = ["ok", "fail", "late", "hang", "die"];

const EVENTS: Record<string, EventDef> = {
  // ── Authority, as a teacher ──
  "link+": {
    enabled: (s) => s.scholar && s.link !== "on",
    run: async (r) => {
      const link = await linkRow(r);
      await attempt(() =>
        link
          ? r.asTeacher.mutation(api.scholarApps.setEnabled, { scholarAppId: link._id, enabled: true })
          : r.asTeacher.mutation(api.scholarApps.addToScholar, { scholarId: r.w.scholarId, appId: r.w.appId }),
      );
    },
  },
  "link-": {
    kicks: "other",
    enabled: (s) => s.link === "on",
    run: async (r) => {
      const link = await linkRow(r);
      await attempt(() =>
        r.asTeacher.mutation(api.scholarApps.setEnabled, { scholarAppId: link!._id, enabled: false }),
      );
    },
  },
  // The device console's "Open all day today" (TRA-444): a direct add that
  // ends at the school's midnight. Its revocation is the clock's, so no
  // writer's kick marks the device then; every probe's drain runs past that
  // midnight, so the drain is where an iPad that kept the app would show.
  "open+": {
    enabled: (s) => s.scholar && s.link !== "open",
    run: async (r) =>
      await attempt(() =>
        r.asTeacher.mutation(api.scholarApps.openForScholar, { scholarId: r.w.scholarId, appId: r.w.appId }),
      ),
  },
  // Its expiry job (scholarApps.expireDirectGrant), once the add has ended.
  // The authority ended with the clock; the job removes the row and marks the
  // iPad, which only moves the next pass sooner.
  "open-": {
    enabled: (s) => s.link === "ended",
    run: async (r) => {
      const link = await linkRow(r);
      await attempt(() =>
        r.t.mutation(internal.scholarApps.expireDirectGrant, {
          scholarAppId: link!._id,
          expiresAt: link!.expiresAt!,
        }),
      );
    },
  },
  "grant+": {
    enabled: (s) => s.grant !== "on",
    run: async (r) =>
      await attempt(() =>
        r.asTeacher.mutation(api.appAudiences.assignToAudience, {
          appId: r.w.appId,
          audienceKind: "group",
          audienceId: String(r.w.groupId),
        }),
      ),
  },
  "grant-": {
    kicks: "other",
    enabled: (s) => s.grant !== "none",
    run: async (r) =>
      await attempt(() =>
        r.asTeacher.mutation(api.appAudiences.unassignAudience, {
          appId: r.w.appId,
          audienceKind: "group",
          audienceId: String(r.w.groupId),
        }),
      ),
  },
  "focus+": {
    enabled: (s) => s.focus === "none" || s.focus === "cleared",
    run: async (r) =>
      await attempt(() =>
        r.asTeacher.mutation(api.pushes.makeFocus, {
          groupId: r.w.groupId,
          target: { kind: "app", externalAppId: r.w.appId },
        }),
      ),
  },
  "focus-": {
    kicks: "other",
    enabled: (s) => s.focus === "showing" || s.focus === "hidden",
    run: async (r) => {
      const push = await openPush(r, false);
      await attempt(() => r.asTeacher.mutation(api.pushes.clearPush, { pushId: push!._id }));
    },
  },
  // The placement push's activation job, inside its window.
  "place+": {
    enabled: (s) => s.placement === "planned" && s.clock === "block",
    run: async (r) =>
      await attempt(() => r.t.mutation(internal.masterSchedule.activatePlacementAppPush, r.w.placement!)),
  },
  // The placement push's scheduled auto-clear, once its window has closed.
  "place-": {
    kicks: "other",
    enabled: (s) => (s.placement === "showing" || s.placement === "hidden") && s.clock !== "block",
    run: async (r) => {
      const push = await openPush(r, true);
      await attempt(() => r.t.mutation(internal.pushes.autoClearPush, { pushId: push!._id }));
    },
  },
  archive: {
    kicks: "catalog",
    enabled: (s) => !s.archived,
    run: async (r) =>
      await attempt(() =>
        r.asTeacher.mutation(api.externalApps.setCatalogAppArchived, { appId: r.w.appId, archived: true }),
      ),
  },
  // A teacher repoints the tile at another managed app's scheme.
  rescheme: {
    kicks: "catalog",
    enabled: (s) => s.scheme === APP_KEY,
    run: async (r) =>
      await attempt(() =>
        r.asTeacher.mutation(api.externalApps.updateCatalogApp, {
          appId: r.w.appId,
          nativeUrlScheme: MANAGED_NATIVE_APPS[RESCHEMED_KEY].nativeUrlScheme!,
        }),
      ),
  },
  ungroup: {
    kicks: "other",
    enabled: (s) => s.inGroup,
    run: async (r) =>
      await attempt(() =>
        r.asTeacher.mutation(api.scholarGroups.removeScholar, { groupId: r.w.groupId, scholarId: r.w.scholarId }),
      ),
  },
  // ── The device's lifecycle, as school operations staff (and an admin) ──
  reassign: {
    kicks: "other",
    enabled: (s) => s.claim !== null && s.claim.scholar !== "Lani",
    run: async (r) =>
      await mint(r, () =>
        r.asOps.mutation(api.managedDeviceClaims.assignScholarToManagedDevice, {
          managedDeviceId: r.w.claimId,
          scholarId: r.w.otherScholarId,
        }),
      ),
  },
  // A same-scholar credential rotation ("the token may have leaked").
  rotate: {
    kicks: "other",
    enabled: (s) => s.claim !== null && (s.claim.scholar === "Kai" || s.claim.scholar === "Lani"),
    run: async (r) =>
      await mint(r, () =>
        r.asOps.mutation(api.managedDeviceClaims.rotateManagedDeviceClaim, { managedDeviceId: r.w.claimId }),
      ),
  },
  // The iPad presents the latest minted token. On a revoked claim this is
  // S3's probe: the old credential must not sign in again.
  exchange: {
    enabled: (s) => s.tokenInHand && (s.claim?.state === "unclaimed" || s.claim?.state === "revoked"),
    run: async (r) =>
      await attempt(() =>
        r.t.mutation(internal.managedDeviceClaims.consumeManagedClaim, {
          claimToken: r.claimToken!,
          deviceId: DEVICE_ID,
          serial: SERIAL,
        }),
      ),
  },
  // "Disable device": revokeManagedDeviceClaim → decommissionManagedClaim.
  // (The drawer's "Force sign out" is manual-pairing only: revokeDeviceSession
  // refuses a managed iPad and points at this action.)
  decommission: {
    kicks: "other",
    enabled: (s) => s.claim !== null && s.claim.state !== "revoked" && s.claim.state !== "unassigned",
    run: async (r) =>
      await attempt(() =>
        r.asOps.mutation(api.managedDeviceClaims.revokeManagedDeviceClaim, { managedDeviceId: r.w.claimId }),
      ),
  },
  remove: {
    kicks: "other",
    enabled: (s) => s.claim !== null,
    run: async (r) =>
      await attempt(() => r.asOps.mutation(api.managedDeviceClaims.removeManagedDevice, { managedDeviceId: r.w.claimId })),
  },
  unpair: {
    kicks: "other",
    enabled: (s) => s.pairing !== "none",
    run: async (r) => {
      const pairing = await r.t.run((ctx) =>
        ctx.db
          .query("pairedDevices")
          .withIndex("by_device", (q) => q.eq("institutionId", r.w.institutionId).eq("deviceId", DEVICE_ID))
          .unique(),
      );
      await attempt(() => r.asOps.mutation(api.devicePairing.unpairDevice, { pairedDeviceId: pairing!._id }));
    },
  },
  deleteKai: {
    kicks: "other",
    enabled: (s) => s.scholar,
    run: async (r) => await attempt(() => r.asAdmin.mutation(api.users.deleteUser, { userId: r.w.scholarId })),
  },
  // ── The lease ceremony, driven by whoever holds the iPad ──
  unlock: {
    answers: PATCHING,
    enabled: (s) => s.holderMayOpenApp && s.hung === null,
    run: async (r) => {
      const holder = await deviceHolder(r);
      await runAction(r, "unlock", () =>
        holder.action(api.deviceAppUnlock.requestUnlock, {
          deviceId: DEVICE_ID,
          externalAppId: r.w.appId,
          leaseToken: LEASE_TOKEN,
        }),
      );
    },
  },
  return: {
    enabled: (s) => s.row?.desired === "unlocked" && s.row.handoff && s.claim?.state === "claimed",
    run: async (r) => {
      const holder = await deviceHolder(r);
      await attempt(() =>
        holder.mutation(api.deviceAppUnlock.markReturned, { deviceId: DEVICE_ID, leaseToken: LEASE_TOKEN }),
      );
    },
  },
  // ── The fate of what SimpleMDM holds in flight ──
  settle: {
    answers: ["ok", "fail", "late"],
    enabled: (s) => s.hung !== null,
    run: async (r, answer) => {
      const hung = r.hung!;
      r.hung = null;
      r.mdm.settle(answer as Settle);
      await hung.done;
    },
  },
  land: { enabled: (s) => s.late.length > 0, run: async (r) => r.mdm.land("oldest") },
  // The spec's MDM is a bag: a newer late write may land before an older one.
  "land:newest": { enabled: (s) => s.late.length > 1, run: async (r) => r.mdm.land("newest") },
  // ── The cron's entry point ──
  reconcile: {
    answers: PATCHING,
    enabled: () => true,
    run: async (r) =>
      await runAction(r, "reconcile", () => r.t.action(internal.deviceAppUnlock.reconcileActiveUnlocks, {})),
  },
  // ── Time ──
  // Past an operation's lease, short of RECHECK_AFTER_INFLIGHT_MS.
  "tick:2m": { enabled: () => true, run: async (r) => await tickTo(r, Date.now() + OPERATION_TIMEOUT_MS + SECOND) },
  // Past the cron interval, a lock's retry backoff and the verify barrier.
  "tick:10m": { enabled: () => true, run: async (r) => await tickTo(r, Date.now() + MAX_PATCH_LANDING_MS + SECOND) },
  // Past an idle lease, a focus window and the placement window's close.
  "tick:1h": { enabled: () => true, run: async (r) => await tickTo(r, Date.now() + IDLE_LEASE_DURATION_MS + SECOND) },
  // Past midnight (isPushShowing's day clause) and today's leases' failsafe.
  "tick:day": { enabled: (s) => s.clock !== "tomorrow", run: async (r) => await tickTo(r, NEXT_MORNING) },
};

/** Every label enabled in `s`, in a fixed order; an answer variant follows its base. */
function labelsFor(s: Snapshot): string[] {
  const labels: string[] = [];
  for (const [name, def] of Object.entries(EVENTS)) {
    if (!def.enabled(s)) continue;
    for (const answer of def.answers ?? ["ok"]) {
      if (answer === "hang" && s.hung !== null) continue;
      labels.push(answer === "ok" ? name : `${name}!${answer}`);
    }
  }
  return labels;
}

const splitLabel = (label: string) => {
  const [name, answer = "ok"] = label.split("!");
  return { name, answer: answer as Answer };
};

/** Fire one labelled event; returns how many PATCHes it sent. */
async function fire(r: Run, label: string): Promise<number> {
  const { name, answer } = splitLabel(label);
  const def = EVENTS[name];
  if (!def) throw new Error(`unknown event ${label}`);
  const before = r.mdm.sent.length;
  r.mdm.answer = name === "settle" ? "ok" : answer;
  await def.run(r, answer);
  r.mdm.answer = "ok";
  return r.mdm.sent.length - before;
}

// ─── Observing: the abstract state ───────────────────────────────────────

type Who = "Kai" | "Lani" | "gone" | "none";

type RowFacts = {
  desired: "locked" | "unlocked";
  appKey: ManagedNativeAppKey | null;
  accepted: boolean;
  lease: "none" | "live" | "expired";
  idle: boolean;
  handoff: boolean;
  /** A live token blocks or yields; an expired one is an action that died. */
  token: "none" | "ceremony" | "projection" | "expired";
  gen: "current" | "stale" | "orphan";
  recheck: "none" | "due" | "later";
  retry: "none" | "due" | "later" | "stopped";
  projection: "due" | "later";
  trust: "trusted" | "untrusted" | "barrier";
  intent: ManagedNativeAppKey[] | null;
  applied: ManagedNativeAppKey[] | null;
  cleanup: boolean;
  attempts: number;
  mdmError: boolean;
  projectionError: boolean;
};

/** The claim's raw identity, for S2 (not hashed). */
type ClaimIdentity = {
  scholarId?: Id<"users">;
  tokenHash?: string;
  lastDeviceId?: string;
  state: Doc<"managedDeviceClaims">["claimState"];
  gen: number;
};

type Snapshot = {
  key: string;
  // the world
  scholar: boolean;
  inGroup: boolean;
  /** "open": switched on with an end still ahead (TRA-444); "ended": its end
   *  has passed and its expiry job has not removed the row yet. */
  link: "none" | "on" | "off" | "open" | "ended";
  grant: "none" | "on" | "off";
  focus: "none" | "planned" | "showing" | "hidden" | "cleared";
  placement: "none" | "planned" | "showing" | "hidden" | "cleared";
  archived: boolean;
  scheme: ManagedNativeAppKey | "web";
  claim: null | { state: Doc<"managedDeviceClaims">["claimState"]; scholar: Who; device: boolean };
  tokenInHand: boolean;
  pairing: Who;
  binding: boolean;
  // the rule
  owner: Who;
  authorized: ManagedNativeAppKey[];
  /** Keys a push is the owner's only route to. */
  pushedOnly: ManagedNativeAppKey[];
  /** Whoever holds the iPad may open the app's tile (the ceremony's gate). */
  holderMayOpenApp: boolean;
  /** The staff device console lists this claim under its scholar or as a
   *  spare, so an error on it surfaces. It lists a deleted scholar's claim
   *  too, as unassigned (TRA-434), but that reads false here so the explorer
   *  keeps fail-draining the shape: its error must surface on that row. */
  visible: boolean;
  // the device
  rows: number;
  row: RowFacts | null;
  live: ManagedNativeAppKey[];
  late: ManagedNativeAppKey[][];
  hung: null | { kind: "unlock" | "reconcile"; keys: ManagedNativeAppKey[] };
  clock: "block" | "afternoon" | "tomorrow";
  // not hashed
  identity: ClaimIdentity | null;
  retryAt: number | null;
};

const whoOf = (w: World, id: Id<"users"> | undefined, exists: (id: Id<"users">) => boolean): Who =>
  id === undefined
    ? "none"
    : !exists(id)
      ? "gone"
      : id === w.scholarId
        ? "Kai"
        : id === w.otherScholarId
          ? "Lani"
          : "none";

/** The rule: the device's fresh owner and the managed keys they may open now. */
async function authorityOver(
  ctx: Pick<QueryCtx, "db">,
  claimId: Id<"managedDeviceClaims">,
): Promise<{ owner: Doc<"users"> | null; keys: ManagedNativeAppKey[]; pushedOnly: ManagedNativeAppKey[] }> {
  const claim = await ctx.db.get(claimId);
  const binding = await ctx.db
    .query("deviceAppUnlockBindings")
    .withIndex("by_managed_device", (q) => q.eq("managedDeviceClaimId", claimId))
    .unique();
  const owner = await freshDeviceOwner(ctx as QueryCtx, { claim, binding });
  if (!owner) return { owner: null, keys: [], pushedOnly: [] };
  const granted = await grantedManagedAppKeysForScholar(ctx as QueryCtx, owner._id);
  const pushed = await pushedManagedAppKeysForScholar(ctx as QueryCtx, owner._id);
  return {
    owner,
    keys: [...new Set([...granted, ...pushed])].sort(),
    pushedOnly: [...pushed].filter((k) => !granted.has(k)).sort(),
  };
}

const schemeKey = (app: Doc<"externalApps"> | null): ManagedNativeAppKey | undefined =>
  app
    ? (Object.entries(MANAGED_NATIVE_APPS) as [ManagedNativeAppKey, { nativeUrlScheme: string | null }][]).find(
        ([, a]) => a.nativeUrlScheme === app.nativeUrlScheme,
      )?.[0]
    : undefined;

async function claimIdentity(r: Run): Promise<ClaimIdentity | null> {
  const claim = await r.t.run((ctx) => ctx.db.get(r.w.claimId));
  return (
    claim && {
      scholarId: claim.scholarId,
      tokenHash: claim.claimTokenHash,
      lastDeviceId: claim.lastDeviceId,
      state: claim.claimState,
      gen: claim.claimGeneration ?? 0,
    }
  );
}

async function snapshot(r: Run): Promise<Snapshot> {
  const now = Date.now();
  const { w } = r;
  const db = await r.t.run(async (ctx) => {
    const exists: string[] = [];
    for (const id of [w.scholarId, w.otherScholarId]) if (await ctx.db.get(id)) exists.push(String(id));
    const pairing = await ctx.db
      .query("pairedDevices")
      .withIndex("by_device", (q) => q.eq("institutionId", w.institutionId).eq("deviceId", DEVICE_ID))
      .unique();
    return {
      exists,
      claim: await ctx.db.get(w.claimId),
      binding: await ctx.db
        .query("deviceAppUnlockBindings")
        .withIndex("by_managed_device", (q) => q.eq("managedDeviceClaimId", w.claimId))
        .unique(),
      rows: await ctx.db
        .query("deviceAppUnlockStates")
        .withIndex("by_managed_device", (q) => q.eq("managedDeviceClaimId", w.claimId))
        .collect(),
      pairingScholar: pairing?.scholarId,
      group: await ctx.db.get(w.groupId),
      app: await ctx.db.get(w.appId),
      link: await ctx.db
        .query("scholarApps")
        .withIndex("by_scholar_app", (q) => q.eq("scholarId", w.scholarId).eq("appId", w.appId))
        .first(),
      grant: (await ctx.db.query("appAudiences").collect()).find((g) => g.appId === w.appId) ?? null,
      pushes: await ctx.db.query("pushes").collect(),
      authority: await authorityOver(ctx, w.claimId),
    };
  });
  const exists = (id: Id<"users">) => db.exists.includes(String(id));
  const clock = { nowMs: now, todayDayKey: dayKeyForTimezone(now, TZ), timeZone: TZ };
  const pushState = (placement: boolean): Snapshot["focus"] => {
    const p = db.pushes.filter((push) => (push.schedulePlacementId !== undefined) === placement).at(-1);
    if (!p) return "none";
    if (p.clearedAt !== undefined) return "cleared";
    if (p.setAt === undefined) return "planned";
    return isPushShowing(p, clock) ? "showing" : "hidden";
  };
  const appKey = schemeKey(db.app);
  const claim = db.claim;
  const row = db.rows[0] ?? null;
  const facts: RowFacts | null = row && {
    desired: row.desiredState,
    appKey: row.appKey ?? null,
    accepted: row.mdmAcceptedAt !== undefined,
    lease:
      row.desiredState !== "unlocked" || !row.appKey
        ? "none"
        : row.expiresAt !== undefined && row.expiresAt <= now
          ? "expired"
          : "live",
    idle: row.idleSince !== undefined,
    handoff: row.activeLeaseToken !== undefined,
    token:
      row.operationToken === undefined
        ? "none"
        : (row.operationStartedAt ?? 0) + OPERATION_TIMEOUT_MS <= now
          ? "expired"
          : row.tokenKind === "projection"
            ? "projection"
            : "ceremony",
    gen: !claim ? "orphan" : (row.claimGeneration ?? 0) === (claim.claimGeneration ?? 0) ? "current" : "stale",
    recheck:
      row.desiredState !== "unlocked"
        ? "none"
        : row.nextRecheckAt === undefined || row.nextRecheckAt <= now
          ? "due"
          : "later",
    retry:
      row.pendingLockRetryAt === undefined
        ? "none"
        : row.pendingLockRetryAt === TEARDOWN_STOPPED_RETRY_AT
          ? "stopped"
          : row.pendingLockRetryAt <= now
            ? "due"
            : "later",
    projection: (row.projectionDueAt ?? 0) <= now ? "due" : "later",
    trust:
      row.projectionVerifyBarrierAt !== undefined && row.projectionVerifyBarrierAt >= now
        ? "barrier"
        : row.projectionVerifyNeeded === true || row.projectionVerifiedAt === undefined
          ? "untrusted"
          : "trusted",
    intent: row.desiredBundleIds ? managedKeys(row.desiredBundleIds) : null,
    applied: row.appliedBundleIds ? managedKeys(row.appliedBundleIds) : null,
    cleanup: row.cleanupAfterLockIntent === true,
    attempts: row.cleanupAttempts ?? 0,
    mdmError: row.lastMdmError !== undefined,
    projectionError: row.projectionError !== undefined,
  };
  const s: Omit<Snapshot, "key" | "identity" | "retryAt"> = {
    scholar: exists(w.scholarId),
    inGroup: db.group?.scholarIds.includes(w.scholarId) ?? false,
    link: !db.link
      ? "none"
      : !db.link.enabled
        ? "off"
        : db.link.expiresAt === undefined
          ? "on"
          : db.link.expiresAt > now
            ? "open"
            : "ended",
    grant: !db.grant ? "none" : db.grant.enabled ? "on" : "off",
    focus: pushState(false),
    placement: pushState(true),
    archived: db.app?.archived === true,
    scheme: appKey ?? "web",
    claim: claim && {
      state: claim.claimState,
      scholar: whoOf(w, claim.scholarId, exists),
      device: claim.lastDeviceId !== undefined,
    },
    tokenInHand: r.claimToken !== null,
    pairing: db.pairingScholar ? whoOf(w, db.pairingScholar, exists) : "none",
    binding: db.binding !== null,
    owner: db.authority.owner ? whoOf(w, db.authority.owner._id, exists) : "none",
    authorized: db.authority.keys,
    pushedOnly: db.authority.pushedOnly,
    holderMayOpenApp:
      !!appKey && !db.app?.archived && db.authority.keys.includes(appKey) && claim?.claimState === "claimed",
    visible: claim !== null && (claim.scholarId === undefined || exists(claim.scholarId)),
    rows: db.rows.length,
    row: facts,
    live: managedKeys(r.mdm.live()),
    late: r.mdm.late.map((l) => managedKeys(l.sent.bundles)),
    hung: r.hung && { kind: r.hung.kind, keys: managedKeys(r.mdm.hung?.sent.bundles ?? []) },
    clock: now >= NEXT_MORNING ? "tomorrow" : now >= WINDOW_CLOSES ? "afternoon" : "block",
  };
  return {
    ...s,
    key: JSON.stringify(s),
    identity: claim && {
      scholarId: claim.scholarId,
      tokenHash: claim.claimTokenHash,
      lastDeviceId: claim.lastDeviceId,
      state: claim.claimState,
      gen: claim.claimGeneration ?? 0,
    },
    retryAt: row?.pendingLockRetryAt ?? null,
  };
}

// ─── The checks, by the spec's names ─────────────────────────────────────

const CHECK_NAMES = [
  // Safety
  "S1_gateClosesStaleLeases",
  "S1_gateKeepsFreshLeases",
  "S1_staleLeaseNeverProjected",
  "S2_boundaryChangesBumpTheGeneration",
  "S3_revokedClaimNeverSignsIn",
  "S4_everyManagedSessionIsTagged",
  "S6_lockIntentIsDurableBeforeTheNetwork",
  "S7_oneWriterPerRow",
  "S8_cleanupWaitsForASafeLock",
  "S9_everyPatchKeepsTheBaseline",
  "patchNeverAddsAnUngrantedApp",
  // Liveness
  "L1L2_revocationMarksTheDevice",
  "L1L2_catalogRevocationMarksTheDevice",
  "L1L2_oneMarkedPassConverges",
  "L1_staleUnlocksCloseWithinAnInterval",
  "L1L2L3_drainSettlesEveryRow",
  "L3_teardownStopsWithinBudget",
  "persistentFailureSurfaces",
] as const;
type CheckName = (typeof CHECK_NAMES)[number];

/** Checks that lean on the kicks: with APP_ACCESS_SEQ_KICKS=off they must
 *  fail. The two "marks" checks test the kicks themselves (the positive
 *  control); every other check must hold without them. The projector's half
 *  of S1 once leaned on a generation bump's kick to make the relock gate run
 *  before the projector (tick:10m → unlock → reassign → pass); since TRA-433
 *  the projector reads no lease, so it holds either way. */
const KICK_CHECKS: readonly CheckName[] = [
  "L1L2_revocationMarksTheDevice",
  "L1L2_catalogRevocationMarksTheDevice",
];

type Shape = { count: number; trace: string[]; detail: string };
type Finding = Shape & { shapes: Map<string, Shape> };
type Findings = {
  /** Violations a KNOWN entry explains (by entry id), and violations nothing
   *  explains (by check). */
  known: Map<string, Finding>;
  fresh: Map<string, Finding>;
  /** How often each check's precondition held, so none passes vacuously. */
  exercised: Map<CheckName, number>;
};

const newFindings = (): Findings => ({ known: new Map(), fresh: new Map(), exercised: new Map() });

function exercise(f: Findings, name: CheckName): void {
  f.exercised.set(name, (f.exercised.get(name) ?? 0) + 1);
}

/** The last event of a trace (probe and drain steps are not events). */
const lastEventOf = (trace: readonly string[]) =>
  splitLabel([...trace].reverse().find((step) => !step.startsWith("↳") && !step.startsWith("seed:")) ?? "").name;

/** Files a violation under the KNOWN entry that explains it, or as new,
 *  keeping the shortest trace per entry (or check) and per distinct shape
 *  (seed, last event and detail) for APP_ACCESS_SEQ_VERBOSE=shapes. */
function violate(f: Findings, name: CheckName, trace: readonly string[], detail: string): void {
  const entry = KNOWN.find((k) => k.check === name && k.explains(trace, detail));
  const book = entry ? f.known : f.fresh;
  const bookKey = entry ? entry.id : name;
  let v = book.get(bookKey);
  if (!v) {
    v = { count: 0, trace: [...trace], detail, shapes: new Map() };
    book.set(bookKey, v);
  }
  v.count += 1;
  if (trace.length < v.trace.length) {
    v.trace = [...trace];
    v.detail = detail;
  }
  const key = `${trace[0]} :: ${lastEventOf(trace)} :: ${detail}`;
  const shape = v.shapes.get(key);
  if (!shape) v.shapes.set(key, { count: 1, trace: [...trace], detail });
  else {
    shape.count += 1;
    if (trace.length < shape.trace.length) shape.trace = [...trace];
  }
}

/** Every managed key the device is still exposed to: the live profile, the
 *  lease, and what the row believes it applied and last intended. A teardown
 *  row's `applied` is excluded: recordMdmPatch parks it without updating the
 *  hint, nothing reads it again, and the live profile is the authority. */
function exposure(s: Snapshot): ManagedNativeAppKey[] {
  const keys = new Set<ManagedNativeAppKey>([...s.live, ...(s.row?.intent ?? [])]);
  if (!s.row?.cleanup) for (const k of s.row?.applied ?? []) keys.add(k);
  if (s.row?.desired === "unlocked" && s.row.appKey) keys.add(s.row.appKey);
  return [...keys].sort();
}

function describeDevice(s: Snapshot): string {
  const r = s.row;
  return (
    `live [${s.live.join(",")}]; ` +
    (r
      ? `row ${r.desired}${r.appKey ? ` (${r.appKey} lease, ${r.gen} generation)` : ""}, applied [${r.applied?.join(",") ?? "–"}], intent [${r.intent?.join(",") ?? "–"}]`
      : s.binding
        ? "no row"
        : "no row, no binding") +
    `; owner ${s.owner}, authorized [${s.authorized.join(",")}]`
  );
}

/**
 * What a kick promises (markClaimUnlockDueNow): "Mark one claim's projection
 * dirty (and, if it holds a live lease, its lease recheck too)", so the very
 * next reconciler pass reaches the device. A stopped teardown is in no scan.
 */
function markedForNextPass(s: Snapshot): boolean {
  if (!s.binding) return false;
  if (!s.row) return true;
  if (s.row.cleanup) return s.row.retry !== "stopped";
  if (s.row.projection !== "due") return false;
  return s.row.desired !== "unlocked" || s.row.recheck === "due";
}

/** The documented reasons a marked device may wait past the next pass. */
function exemptFromNextPass(s: Snapshot): boolean {
  return (
    s.hung !== null || // a PATCH is in flight
    s.row?.token === "ceremony" || // a ceremony operation holds its lease (Hole 1)
    // a projection holds its lease (its action may have died after sending)
    // and only the projector, which never races it, has work on the row
    (s.row?.token === "projection" && s.row.desired === "locked" && s.row.accepted) ||
    (s.row?.desired === "locked" && !s.row.accepted && s.row.retry === "later") // a failed lock backs off
  );
}

/** L1/L2, prompt half: a writer that removes authority marks the device for
 *  the next pass. (A device whose binding went with it is S8's.) */
function checkMarks(f: Findings, name: CheckName, trace: readonly string[], before: Snapshot, after: Snapshot): void {
  const stranded = before.authorized.filter((k) => !after.authorized.includes(k) && exposure(after).includes(k));
  if (stranded.length === 0 || !after.binding) return;
  exercise(f, name);
  if (markedForNextPass(after)) return;
  const route = stranded.every((k) => before.pushedOnly.includes(k)) ? "its only route was a push" : "it had a standing route";
  violate(
    f,
    name,
    trace,
    `${stranded.join(", ")} lost authority (${route}) but no pass is due to remove it (projection ${after.row?.projection ?? "–"}, ` +
      `recheck ${after.row?.recheck ?? "–"}): ${describeDevice(after)}`,
  );
}

/** L1/L2: one pass with MDM ok, from a marked and quiescent device, leaves it
 *  exposed to nothing its owner may not open. */
function checkOnePass(f: Findings, trace: readonly string[], before: Snapshot, after: Snapshot): void {
  if (!markedForNextPass(before) || exemptFromNextPass(before)) return;
  exercise(f, "L1L2_oneMarkedPassConverges");
  const left = exposure(after).filter((k) => !after.authorized.includes(k));
  if (left.length > 0) {
    violate(
      f,
      "L1L2_oneMarkedPassConverges",
      trace,
      `one pass later the device is still exposed to ${left.join(", ")}: ${describeDevice(after)}`,
    );
  }
}

/** S1: the relock gate's verdict, on every pass that evaluated the lease —
 *  it closes a stale lease and keeps a fresh one (spec §7, "Reassign vs. a
 *  scheduled reconcile"). */
function checkGate(f: Findings, trace: readonly string[], before: Snapshot, after: Snapshot): void {
  const row = before.row;
  if (!row || row.desired !== "unlocked" || row.recheck !== "due" || row.token === "ceremony") return;
  const kept = after.row?.desired === "unlocked";
  const fresh =
    row.gen === "current" && before.owner !== "none" && row.lease === "live" && before.authorized.includes(row.appKey!);
  exercise(f, fresh ? "S1_gateKeepsFreshLeases" : "S1_gateClosesStaleLeases");
  if (fresh && !kept) violate(f, "S1_gateKeepsFreshLeases", trace, "the gate closed a current-generation lease its owner may open");
  if (!fresh && kept) {
    violate(
      f,
      "S1_gateClosesStaleLeases",
      trace,
      `the gate kept a ${row.gen}-generation ${row.appKey} lease (lease ${row.lease}, owner ${before.owner}, authorized [${before.authorized.join(",")}])`,
    );
  }
}

/** S2: a move that changes the scholar, the credential or the physical
 *  device, or that unassigns or revokes, bumps the generation by one; any
 *  other move leaves it alone. */
function checkGeneration(f: Findings, trace: readonly string[], a: ClaimIdentity | null, b: ClaimIdentity | null): void {
  if (!a || !b) return;
  exercise(f, "S2_boundaryChangesBumpTheGeneration");
  const boundary =
    a.scholarId !== b.scholarId ||
    a.tokenHash !== b.tokenHash ||
    (a.lastDeviceId !== undefined && b.lastDeviceId !== undefined && a.lastDeviceId !== b.lastDeviceId) ||
    (a.state !== b.state && (b.state === "unassigned" || b.state === "revoked"));
  const expected = a.gen + (boundary ? 1 : 0);
  if (b.gen !== expected) {
    violate(
      f,
      "S2_boundaryChangesBumpTheGeneration",
      trace,
      `${boundary ? "a boundary change" : "a non-boundary move"} took the generation ${a.gen} → ${b.gen} (claim ${a.state} → ${b.state})`,
    );
  }
}

/** S3 and S4, after an exchange. */
async function checkExchange(r: Run, trace: readonly string[], before: Snapshot, after: Snapshot): Promise<void> {
  const f = r.findings;
  if (before.claim?.state === "revoked") {
    exercise(f, "S3_revokedClaimNeverSignsIn");
    const identity = await r.t.run(async (ctx) => {
      const claim = await ctx.db.get(r.w.claimId);
      return { state: claim?.claimState, hash: claim?.claimTokenHash, pending: claim?.pendingClaimTokenHash };
    });
    if (after.claim?.state !== "revoked" || !identity.hash?.startsWith("revoked:") || identity.pending !== undefined) {
      violate(f, "S3_revokedClaimNeverSignsIn", trace, `a revoked claim is now ${after.claim?.state} (token ${identity.hash?.slice(0, 8)}…)`);
    }
    return;
  }
  if (after.claim?.state !== "claimed") return;
  exercise(f, "S4_everyManagedSessionIsTagged");
  const tag = await r.t.run(async (ctx) => {
    const claim = await ctx.db.get(r.w.claimId);
    const pairing = await ctx.db
      .query("pairedDevices")
      .withIndex("by_device", (q) => q.eq("institutionId", r.w.institutionId).eq("deviceId", DEVICE_ID))
      .unique();
    const tags = pairing?.authSessionId
      ? await ctx.db
          .query("pairedDeviceAuthSessions")
          .withIndex("by_session", (q) => q.eq("authSessionId", pairing.authSessionId!))
          .collect()
      : [];
    return { gen: claim?.claimGeneration ?? 0, session: pairing?.authSessionId, tags };
  });
  const tagged = tag.tags.some((t) => t.managedDeviceClaimId === r.w.claimId && (t.claimGeneration ?? 0) === tag.gen);
  if (!tag.session || !tagged) {
    violate(f, "S4_everyManagedSessionIsTagged", trace, `the exchanged session carries no tag for this claim at generation ${tag.gen}`);
  }
}

/**
 * Checks run inside the fake SimpleMDM, before it answers a PATCH:
 *   S6 — the row holds a live operation token and its `desiredBundleIds` IS
 *     the set being sent; a ceremony-token PATCH on a locked row (a relock)
 *     also needs `desired = locked ∧ ¬mdmAccepted` already durable;
 *   S7 — one unlock row per claim, and no PATCH overtakes a ceremony PATCH
 *     still inside its operation lease ("prevents a transport that times out
 *     locally from being immediately overtaken by a second whole-profile
 *     PATCH");
 *   S9 — every target set holds the full baseline and nothing outside
 *     baseline ∪ the managed apps;
 *   patchNeverAddsAnUngrantedApp — a PATCH only adds a bundle the device's
 *     fresh owner may open right now.
 */
async function checkSend(r: Run, sent: Sent, liveBefore: string[]): Promise<void> {
  const now = Date.now();
  const facts = await r.t.run(async (ctx) => ({
    rows: await ctx.db
      .query("deviceAppUnlockStates")
      .withIndex("by_managed_device", (q) => q.eq("managedDeviceClaimId", r.w.claimId))
      .collect(),
    binding: await ctx.db
      .query("deviceAppUnlockBindings")
      .withIndex("by_managed_device", (q) => q.eq("managedDeviceClaimId", r.w.claimId))
      .unique(),
    claim: await ctx.db.get(r.w.claimId),
    authority: await authorityOver(ctx, r.w.claimId),
  }));
  const row = facts.rows[0] ?? null;
  const live = row?.operationToken !== undefined && (row.operationStartedAt ?? 0) + OPERATION_TIMEOUT_MS > now;
  sent.writer = !live ? "none" : row!.tokenKind === "projection" ? "projection" : "ceremony";
  const trace = r.armed;
  if (!trace) return;
  const f = r.findings;

  exercise(f, "S6_lockIntentIsDurableBeforeTheNetwork");
  const intent = [...(row?.desiredBundleIds ?? [])].sort();
  if (!facts.binding) {
    violate(f, "S6_lockIntentIsDurableBeforeTheNetwork", trace, "a PATCH for a device whose binding is gone");
  } else if (!live) {
    violate(f, "S6_lockIntentIsDurableBeforeTheNetwork", trace, "a PATCH sent while the row holds no live operation token");
  } else if (intent.join() !== sent.bundles.join()) {
    violate(
      f,
      "S6_lockIntentIsDurableBeforeTheNetwork",
      trace,
      `a PATCH for [${managedKeys(sent.bundles)}] while the row's durable intent is [${managedKeys(intent)}]`,
    );
  } else if (sent.writer === "ceremony" && row!.desiredState === "locked" && row!.mdmAcceptedAt !== undefined) {
    violate(f, "S6_lockIntentIsDurableBeforeTheNetwork", trace, "a relock PATCH for a row already marked accepted");
  }

  exercise(f, "S7_oneWriterPerRow");
  if (facts.rows.length > 1) violate(f, "S7_oneWriterPerRow", trace, `${facts.rows.length} unlock rows for one claim`);
  if (r.mdm.inFlight().some((o) => o.writer === "ceremony" && o.at + OPERATION_TIMEOUT_MS > now)) {
    violate(f, "S7_oneWriterPerRow", trace, `a ${sent.writer} PATCH overtook a ceremony PATCH still inside its operation lease`);
  }

  exercise(f, "S9_everyPatchKeepsTheBaseline");
  const outside = sent.bundles.filter((b) => !BASELINE.includes(b) && !KEY_BY_BUNDLE.has(b));
  const missing = BASELINE.filter((b) => !sent.bundles.includes(b));
  if (outside.length > 0 || missing.length > 0) {
    violate(f, "S9_everyPatchKeepsTheBaseline", trace, `a PATCH missing [${missing}] or adding [${outside}]`);
  }

  const added = managedKeys(sent.bundles).filter((k) => !managedKeys(liveBefore).includes(k));
  if (added.length > 0) exercise(f, "patchNeverAddsAnUngrantedApp");
  const unjustified = added.filter((k) => !facts.authority.keys.includes(k));
  if (unjustified.length > 0) {
    violate(
      f,
      "patchNeverAddsAnUngrantedApp",
      trace,
      `a ${sent.writer} PATCH adds ${unjustified.join(", ")} for owner ${facts.authority.owner?.username ?? "none"} ` +
        `(authorized [${facts.authority.keys.join(",")}]); the row ${row?.desiredState === "unlocked" ? `holds a ${row.appKey} lease at generation ${row.claimGeneration ?? 0}` : "holds no lease"}, ` +
        `the claim is at generation ${facts.claim?.claimGeneration ?? "–"} (${facts.claim?.claimState ?? "deleted"})`,
    );
  }
}

/**
 * S1 extended to the projector: after the claim changes hands, the old lease
 * authorizes nothing. Exercised by every derivation made while the device's
 * row still holds an open lease minted under an older claim generation (the
 * relock gate has not closed it yet); a set that holds that lease's app when
 * the device's fresh owner may not open it is the stale lease authorizing
 * something. projectedBundleIdsForClaim reads no lease since TRA-433, so this
 * guards against one creeping back in.
 */
async function watchProjection(ctx: Pick<QueryCtx, "db">, args: ProjectionArgs, bundles: string[]): Promise<void> {
  const r = current;
  if (!r?.armed) return;
  const lease = await ctx.db
    .query("deviceAppUnlockStates")
    .withIndex("by_managed_device", (q) => q.eq("managedDeviceClaimId", args.binding.managedDeviceClaimId))
    .unique();
  if (!lease || lease.desiredState !== "unlocked" || !lease.appKey) return;
  if (args.claim && (args.claim.claimGeneration ?? 0) === (lease.claimGeneration ?? 0)) return;
  exercise(r.findings, "S1_staleLeaseNeverProjected");
  if (!bundles.includes(MANAGED_NATIVE_APPS[lease.appKey].bundleId)) return;
  const authority = await authorityOver(ctx, lease.managedDeviceClaimId);
  if (authority.keys.includes(lease.appKey)) return;
  violate(
    r.findings,
    "S1_staleLeaseNeverProjected",
    r.armed,
    `the projector derived [${managedKeys(bundles)}] from a ${lease.appKey} lease minted at generation ${lease.claimGeneration ?? 0} ` +
      `(claim at ${args.claim?.claimGeneration ?? "–"}, ${args.claim?.claimState ?? "deleted"}; owner ${authority.owner?.username ?? "none"}, ` +
      `authorized [${authority.keys.join(",")}]) before the relock gate closed it`,
  );
}
(globalThis as { __appAccessProjectionWatcher?: ProjectionWatcher }).__appAccessProjectionWatcher = watchProjection;


/** Would removeManagedDeviceRow call this row settled (isUnlockStateSettled)? */
const settledLease = (row: RowFacts | null) =>
  !row || (row.desired === "locked" && row.accepted && row.token === "none" && row.retry === "none");

/**
 * S8, as its physical consequence: the teardown's "DELETION REQUIRES A
 * PROVABLE BASELINE". Once a device's binding is deleted nothing can ever
 * correct its profile, so at that moment it must hold only its baseline,
 * with no write still able to land. `before` is the device as the deleting
 * move found it.
 */
function checkTeardown(f: Findings, trace: readonly string[], before: Snapshot, after: Snapshot): void {
  if (!before.binding || after.binding) return;
  exercise(f, "S8_cleanupWaitsForASafeLock");
  if (after.live.length > 0 || after.late.length > 0 || after.hung) {
    violate(
      f,
      "S8_cleanupWaitsForASafeLock",
      trace,
      `the binding is gone but the profile holds [${after.live}]` +
        `${after.late.length > 0 || after.hung ? " with a write still in flight" : ""}; ` +
        `the row was ${settledLease(before.row) ? "settled" : "owing work"} when its binding went`,
    );
  }
}

/** L1–L3, eventual half: every unlock row locked, accepted and trusted (or
 *  deleted), nothing in flight, and the live profile exactly what the
 *  device's fresh owner may open. */
function settledProblems(s: Snapshot): string[] {
  const r = s.row;
  const problems: string[] = [];
  if (r) {
    if (r.desired !== "locked" || !r.accepted || r.token !== "none" || r.retry !== "none" || r.cleanup) {
      problems.push(`the row is not settled (${r.desired}, accepted ${r.accepted}, token ${r.token}, retry ${r.retry}, cleanup ${r.cleanup})`);
    }
    if (r.trust !== "trusted") problems.push(`the row is ${r.trust}`);
    if (r.applied?.join() !== s.live.join()) problems.push(`the row believes [${r.applied}] but the profile holds [${s.live}]`);
  }
  if (s.late.length > 0 || s.hung) problems.push("a PATCH is still in flight");
  // L3: a removed claim's teardown ends with both rows gone.
  if (!s.claim && (r || s.binding)) problems.push("the claim is gone but its unlock row or binding is left behind");
  if (s.binding && s.live.join() !== s.authorized.join()) {
    problems.push(`the profile holds [${s.live}] but the owner (${s.owner}) may open [${s.authorized}]`);
  }
  return problems;
}

// ─── Probes ──────────────────────────────────────────────────────────────

const DRAIN_PASSES = 4;
/** Past every lease's failsafe and today's pushes, whatever the clock says. */
const drainStart = () => Math.max(NEXT_MORNING, Date.now() + ACTIVE_SESSION_FAILSAFE_MS + SECOND);

/** One pass (the prompt half), then the ok-drain (the eventual half). */
async function probe(r: Run, trace: readonly string[], s: Snapshot): Promise<void> {
  const f = r.findings;
  const passTrace = [...trace, "↳ probe: reconcile"];
  r.armed = passTrace;
  await fire(r, "reconcile");
  const after = await snapshot(r);
  checkOnePass(f, passTrace, s, after);
  checkGate(f, passTrace, s, after);
  checkTeardown(f, passTrace, s, after);
  // L1, bounded: every writer stamps an unlocked row's recheck at most one
  // interval ahead (an unlock, a kept lease, a kick, Hole 1's in-flight
  // deferral), so one interval and a pass later no stale lease is left open.
  r.armed = [...trace, "↳ probe: one recheck interval later, reconcile"];
  await tickTo(r, Date.now() + RECHECK_INTERVAL_MS + SECOND);
  await fire(r, "reconcile");
  const later = await snapshot(r);
  if (later.row?.desired === "unlocked") {
    exercise(f, "L1_staleUnlocksCloseWithinAnInterval");
    const row = later.row;
    const fresh = row.gen === "current" && later.owner !== "none" && row.lease === "live" && later.authorized.includes(row.appKey!);
    if (!fresh) {
      violate(
        f,
        "L1_staleUnlocksCloseWithinAnInterval",
        r.armed,
        `a ${row.gen}-generation ${row.appKey} lease is still open (lease ${row.lease}, owner ${later.owner}, authorized [${later.authorized.join(",")}], recheck ${row.recheck})`,
      );
    }
  }
  r.armed = [...trace, "↳ drain: past every lease, then (reconcile, tick:10m) until settled"];
  await tickTo(r, drainStart());
  let end = await snapshot(r);
  let problems: string[] = [];
  for (let i = 0; i < DRAIN_PASSES; i++) {
    await fire(r, "reconcile");
    await tickTo(r, Date.now() + MAX_PATCH_LANDING_MS + SECOND);
    end = await snapshot(r);
    problems = settledProblems(end);
    if (problems.length === 0) break;
  }
  exercise(f, "L1L2L3_drainSettlesEveryRow");
  if (problems.length > 0) violate(f, "L1L2L3_drainSettlesEveryRow", r.armed, problems.join("; "));
  checkTeardown(f, r.armed, after, end);
  r.armed = null;
}

const FAIL_DRAIN_ROUNDS = MAX_TEARDOWN_ATTEMPTS + 4;

/**
 * Persistent MDM failure, from a state whose device the console cannot show.
 * L3 (with #4041's end state): a teardown finishes, or STOPS within
 * MAX_TEARDOWN_ATTEMPTS attempts with a `teardown-stopped` audit row, the
 * only surface a removed serial has. Any other row keeps retrying by design
 * (it is the backstop for an iPad a scholar holds), so it must surface on the
 * staff device console with its error.
 */
async function failDrain(seed: Seed, path: readonly string[], trace: readonly string[], findings: Findings): Promise<void> {
  const r = await replay(seed, path, findings);
  r.armed = [...trace, "↳ fail-drain: past every lease, then reconcile!fail at each retry until it stops"];
  await tickTo(r, drainStart());
  let s = await snapshot(r);
  const teardown = s.row?.cleanup === true;
  for (let i = 0; i < (teardown ? FAIL_DRAIN_ROUNDS : 3); i++) {
    await fire(r, "reconcile!fail");
    s = await snapshot(r);
    if (!s.row || s.row.retry === "stopped") break;
    const retryAt = s.retryAt ?? 0;
    await tickTo(r, Math.max(Date.now() + MAX_PATCH_LANDING_MS + SECOND, retryAt < TEARDOWN_STOPPED_RETRY_AT ? retryAt + SECOND : 0));
  }
  if (teardown) {
    exercise(findings, "L3_teardownStopsWithinBudget");
    const stops = await r.t.run(async (ctx) =>
      (await ctx.db.query("auditLog").collect()).filter((a) => a.action === "device.app-unlock.teardown-stopped").length,
    );
    const row = s.row;
    if (row && (row.retry !== "stopped" || row.attempts > MAX_TEARDOWN_ATTEMPTS || stops === 0)) {
      violate(
        findings,
        "L3_teardownStopsWithinBudget",
        r.armed,
        `the teardown is ${row.retry} after ${row.attempts} attempts with ${stops} stop audit rows`,
      );
    }
    return;
  }
  const row = s.row;
  if (!row || (row.desired === "locked" && row.accepted && !row.projectionError)) return;
  exercise(findings, "persistentFailureSurfaces");
  const devices = await r.asOps.query(api.managedDeviceClaims.listManagedDevices, {});
  const listed = devices.find((d) => d._id === r.w.claimId);
  if (listed?.appAccessProjection?.lastError) return;
  violate(
    findings,
    "persistentFailureSurfaces",
    r.armed,
    `the row retries forever (${row.desired}, retry ${row.retry}) ` +
      (listed
        ? "but the device console shows no error"
        : `and the device console hides the device (claim ${s.claim?.state ?? "deleted"}, scholar ${s.claim?.scholar ?? "–"})`),
  );
}

// ─── The explorer ────────────────────────────────────────────────────────

type Node = { seed: Seed; path: string[]; snap: Snapshot };
type Exploration = {
  states: number;
  edges: number;
  elapsedMs: number;
  depth: number;
  findings: Findings;
  /** Per event: how often it fired, and how often that changed the state. */
  fired: Map<string, number>;
  changed: Map<string, number>;
};

/** Events whose enabling state lies deeper than the shallowest runs reach:
 *  two late writes in flight need link-, reconcile!late, tick:2m,
 *  reconcile!late first. */
const FIRST_ENABLED_AT: Record<string, number> = { "land:newest": 5 };

const traceOf = (seed: Seed, path: readonly string[]) => [`seed: ${SEED_LABEL[seed]}`, ...path];

/** Fire one event on a replay and run every edge check on it. Returns the
 *  new snapshot and how many PATCHes the event sent. */
async function step(r: Run, trace: readonly string[], label: string, before: Snapshot): Promise<{ after: Snapshot; patched: number }> {
  const f = r.findings;
  const { name, answer } = splitLabel(label);
  r.armed = [...trace];
  // Read on THIS replay: every mint draws a fresh random token.
  const identity = await claimIdentity(r);
  const patched = await fire(r, label);
  const after = await snapshot(r);
  const kicks = EVENTS[name].kicks;
  if (kicks) {
    checkMarks(f, kicks === "catalog" ? "L1L2_catalogRevocationMarksTheDevice" : "L1L2_revocationMarksTheDevice", trace, before, after);
  }
  if (name === "reconcile") {
    if (answer === "ok") checkOnePass(f, trace, before, after);
    checkGate(f, trace, before, after);
  }
  if (name === "exchange") await checkExchange(r, trace, before, after);
  checkGeneration(f, trace, identity, after.identity);
  checkTeardown(f, trace, before, after);
  r.armed = null;
  return { after, patched };
}

/** Fake clock, fake SimpleMDM, and the key the client insists on. */
async function withHarness<T>(run: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  simpleMdmRetryPolicy.baseDelayMs = 0;
  process.env.SIMPLEMDM_API_KEY = "fake-simplemdm-key";
  try {
    return await run();
  } finally {
    current = null;
    vi.clearAllTimers();
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
    delete process.env.SIMPLEMDM_API_KEY;
  }
}

async function explore(seeds: readonly Seed[], maxDepth: number): Promise<Exploration> {
  const started = performance.now();
  const findings = newFindings();
  const seen = new Set<string>();
  // One persistent-failure drain per shape of invisibility is enough to show it.
  const failDrained = new Set<string>();
  let frontier: Node[] = [];
  let edges = 0;
  const fired = new Map<string, number>();
  const changed = new Map<string, number>();
  await withHarness(async () => {
    const visit = async (r: Run, seed: Seed, path: string[], snap: Snapshot) => {
      if (seen.has(snap.key)) return;
      seen.add(snap.key);
      if (path.length < maxDepth) frontier.push({ seed, path, snap }); // the last layer is never expanded
      const trace = traceOf(seed, path);
      await probe(r, trace, snap);
      const invisible = JSON.stringify([snap.claim, snap.row?.desired, snap.row?.accepted, snap.row?.cleanup, snap.binding]);
      if (!snap.visible && (snap.row !== null || snap.binding) && !failDrained.has(invisible)) {
        failDrained.add(invisible);
        await failDrain(seed, path, trace, findings);
      }
    };
    for (const seed of seeds) {
      const r = await replay(seed, [], findings);
      await visit(r, seed, [], await snapshot(r));
      // persistentFailureSurfaces' positive control: a visible device surfaces.
      await failDrain(seed, [], traceOf(seed, []), findings);
    }
    for (let depth = 0; depth < maxDepth; depth++) {
      const layer = frontier;
      frontier = [];
      for (const node of layer) {
        const quiet = new Set<string>(); // PATCHing events whose ok run sent nothing
        for (const label of labelsFor(node.snap)) {
          const { name, answer } = splitLabel(label);
          if (answer !== "ok" && quiet.has(name)) continue;
          const r = await replay(node.seed, node.path, findings);
          const { after, patched } = await step(r, [...traceOf(node.seed, node.path), label], label, node.snap);
          if (answer === "ok" && name !== "settle" && EVENTS[name].answers && patched === 0) quiet.add(name);
          edges += 1;
          fired.set(name, (fired.get(name) ?? 0) + 1);
          if (after.key !== node.snap.key) changed.set(name, (changed.get(name) ?? 0) + 1);
          await visit(r, node.seed, [...node.path, label], after);
        }
      }
    }
  });
  return { states: seen.size, edges, elapsedMs: performance.now() - started, depth: maxDepth, findings, fired, changed };
}

/** One exact trace, with every check the explorer would run along it. */
async function checkTrace(seed: Seed, path: readonly string[]): Promise<Findings> {
  const findings = newFindings();
  await withHarness(async () => {
    const r = await replay(seed, [], findings);
    let before = await snapshot(r);
    for (let i = 0; i < path.length; i++) {
      before = (await step(r, traceOf(seed, path.slice(0, i + 1)), path[i], before)).after;
    }
    await probe(r, traceOf(seed, path), before);
  });
  return findings;
}

// ─── The ledger ──────────────────────────────────────────────────────────

type Known = {
  /** The check it violates, and a short name for the finding. */
  check: CheckName;
  id: string;
  /** The Linear issue tracking it. */
  cite: string;
  /** The shortest counterexample: a seed and the events after it. */
  shortest: { seed: Seed; path: string[] };
  /** Which violations of the check this finding explains. Anything else is a
   *  NEW violation and fails, so a known finding cannot mask a regression of
   *  the same check. */
  explains: (trace: readonly string[], detail: string) => boolean;
};

/**
 * Findings on master, each tracked in Linear. An entry gets `it.fails` on the
 * violations it explains, in the spec of the seed its shortest trace starts
 * from, so CI stays green and flips red the day the fix lands: whichever of
 * the fix and this PR merges second removes the entry. A violation no entry
 * explains still fails, in every spec.
 *
 * The first entry here was TRA-427 (removing an iPad whose unlock state was
 * settled left its granted apps on the profile; shortest trace link: remove).
 * #4049 fixed it, the entry flipped red, and S8 now holds on that trace. A
 * fixed entry whose trace is deeper than CI explores moves to FIXED, below,
 * where that trace keeps running.
 */
const KNOWN: readonly Known[] = [
  // TRA-435: archive or rescheme doesn't re-mark push-only scholars.
  // coreSetArchived and coreUpdateApp choose whom to kick with
  // liveReachOfExternalApp: direct links and audience grants, not pushes. A
  // scholar whose only route is a live push is not kicked, so the iPad keeps
  // the app, and any lease on it stays open, until a later cron pass finds
  // the device due (5-minute cadence).
  {
    check: "L1L2_catalogRevocationMarksTheDevice",
    id: "a push-only catalog revocation",
    cite: "TRA-435",
    shortest: { seed: "focus", path: ["archive"] },
    explains: (_trace, detail) => detail.includes("its only route was a push"),
  },
];

type Fixed = { check: CheckName; cite: string; shortest: { seed: Seed; path: string[] } };

/**
 * Fixed findings whose shortest trace is deeper than CI explores. Each is
 * replayed as its exact trace with every check, and must hold there with its
 * check exercised, so a check CI depth cannot otherwise reach (S1's projector
 * half needs four events from any seed) does not go vacuous once its KNOWN
 * entry is gone.
 */
const FIXED: readonly Fixed[] = [
  // TRA-433: the in-flight window. A pass that finds a ceremony PATCH in
  // flight defers the relock gate past the operation window, so once the
  // ceremony records, the next pass reaches the projector with the old
  // owner's lease still open on the reassigned iPad.
  {
    check: "S1_staleLeaseNeverProjected",
    cite: "TRA-433",
    shortest: { seed: "link", path: ["unlock!hang", "reassign", "reconcile", "settle"] },
  },
  // TRA-433: a revocation that marks nothing (the catalog gap above) while a
  // projection mark is pending. Once the hung unlock's token expires, a pass
  // reaches the projector before the gate has rechecked the lease, whose app
  // is archived.
  {
    check: "patchNeverAddsAnUngrantedApp",
    cite: "TRA-433",
    shortest: { seed: "placement", path: ["focus+", "unlock!hang", "archive", "tick:2m"] },
  },
  // TRA-436: removing an iPad while a relock is in flight. The relock was
  // projected before the removal, so it still carries Kai's app and matches
  // the row's revision and token. Its acceptance must owe the relock again,
  // not close the teardown; the probe's pass then sends the bare baseline,
  // and that deletes the binding.
  {
    check: "S8_cleanupWaitsForASafeLock",
    cite: "TRA-436",
    shortest: { seed: "link", path: ["unlock", "tick:day", "reconcile!hang", "remove", "settle"] },
  },
  // TRA-442: a write whose action dies once it has sent. Its lease expires,
  // the next writer takes its token over, and a teardown closed on a relock
  // of the bare baseline with no landing barrier, so the dead write, which
  // carried Kai's app, landed after the binding was gone. The shortest trace
  // (unlock!die → remove; the placement seed needs its app live first) is
  // within CI depth and goes through the relock gate's takeover. These two
  // reach the other takeovers:
  // a relock that dies once the gate has closed an expired lease (the
  // issue's trace; preparePendingLock takes it over), and an unlock that
  // dies before a second one (the ceremony takes it over).
  {
    check: "S8_cleanupWaitsForASafeLock",
    cite: "TRA-442",
    shortest: { seed: "link", path: ["unlock", "tick:day", "reconcile!die", "remove"] },
  },
  {
    check: "S8_cleanupWaitsForASafeLock",
    cite: "TRA-442",
    shortest: { seed: "link", path: ["unlock!die", "tick:2m", "unlock", "remove"] },
  },
];

const CI_DEPTH = 3;
const SEQ_DEPTH = Number(process.env.APP_ACCESS_SEQ_DEPTH ?? CI_DEPTH);
// Wall-clock guard on one seed's search, generous on purpose: it exists to
// catch an alphabet or state blow-up, not to benchmark a loaded CI host. The
// slowest seed took 18 s at CI depth on an M-series Mac with all four specs
// running at once (2026-09-27), and the die answer (TRA-442) added about a
// fifth to every seed; the merge gate's slowest worker is about 2.7× slower
// than that class of machine, and this leaves 2.5× on top.
const SEQ_BUDGET_MS = SEQ_DEPTH <= CI_DEPTH ? 150_000 : 6 * 60 * 60_000;

/**
 * What one seed's search cannot reach at CI depth, so its tests do not demand
 * it there. Only the placement seed places the app, so only it fires place±.
 * The link seed starts from a STANDING direct add, and opening for a day never
 * shortens one (TRA-444), so an ended add is four events away there (remove,
 * open, midnight, its expiry); the other seeds open from no add and reach it
 * in three. S1's projector half needs four events from any seed, and CI checks
 * it through TRA-433's exact-trace replay (FIXED). `every event and check is
 * in reach of some seed` keeps the four searches, together, covering the whole
 * alphabet.
 */
type Reach = { events: readonly string[]; checks: readonly CheckName[] };
const NO_PLACEMENT: Reach = { events: ["place+", "place-"], checks: ["S1_staleLeaseNeverProjected"] };
const OUT_OF_REACH: Record<Seed, Reach> = {
  link: { ...NO_PLACEMENT, events: [...NO_PLACEMENT.events, "open-"] },
  grant: NO_PLACEMENT,
  focus: NO_PLACEMENT,
  placement: { events: [], checks: ["S1_staleLeaseNeverProjected"] },
};

const report = (name: CheckName, v: Finding | undefined, shapes: boolean): string =>
  !v
    ? ""
    : `${name}: ${v.count}×; shortest:\n  ${v.trace.join("\n  ")}\n  → ${v.detail}` +
      (shapes
        ? [...v.shapes.values()]
            .sort((a, b) => a.trace.length - b.trace.length)
            .map((s) => `\n    [${s.count}×] ${s.trace.join(" / ")}\n        → ${s.detail}`)
            .join("")
        : "");

/**
 * One seed's search, with every check and the KNOWN findings whose shortest
 * trace starts from this seed (deeper ones replayed as exact traces).
 */
export function describeSeedExploration(seed: Seed): void {
  describe(`claim–unlock model from the ${seed} seed: event sequences to depth ${SEQ_DEPTH}${KICKS_OFF ? ", kicks deleted" : ""}`, () => {
    let result: Exploration;

    afterEach(() => {
      vi.useRealTimers();
    });

    beforeAll(async () => {
      result = await explore([seed], SEQ_DEPTH);
      if (process.env.APP_ACCESS_SEQ_VERBOSE) {
        const shapes = process.env.APP_ACCESS_SEQ_VERBOSE === "shapes";
        console.info(
          `[appAccessSequences:${seed}] depth ${result.depth}: ${result.states} states, ${result.edges} edges in ${Math.round(result.elapsedMs)}ms`,
        );
        for (const name of CHECK_NAMES) {
          const known = KNOWN.filter((k) => k.check === name && result.findings.known.has(k.id));
          const fresh = result.findings.fresh.get(name);
          console.info(
            `${name}: exercised ${result.findings.exercised.get(name) ?? 0}×` +
              known.map((k) => `\n KNOWN (${k.cite}, ${k.id}) ${report(name, result.findings.known.get(k.id), shapes)}`).join("") +
              (fresh ? `\n NEW ${report(name, fresh, shapes)}` : "") +
              (known.length > 0 || fresh ? "" : ", holds"),
          );
        }
      }
    }, 6 * 60 * 60_000);

    it("runs with both module wrappers installed (appAccessSequences.mocks.ts)", async () => {
      const projection = await import("../lib/deviceAppProjection");
      const scheduling = await import("../lib/deviceAppUnlockScheduling");
      expect(WRAPPED in projection, 'vi.mock("../lib/deviceAppProjection") with watchProjections').toBe(true);
      expect(WRAPPED in scheduling, 'vi.mock("../lib/deviceAppUnlockScheduling") with kicksUnlessOff').toBe(true);
    });

    it("explores a non-trivial space inside its budget", () => {
      expect(result.states).toBeGreaterThan(200);
      expect(result.elapsedMs).toBeLessThan(SEQ_BUDGET_MS);
    });

    // Coverage is asserted from the CI depth up: below it, some events and
    // checks (place- needs place+ → tick:1h, S3 a mint → decommission) are
    // simply out of reach.
    const coverage = SEQ_DEPTH >= CI_DEPTH ? it : it.skip;

    coverage("every event in reach fires and changes the state (none is a silent no-op)", () => {
      const silent = Object.keys(EVENTS)
        .filter((name) => (FIRST_ENABLED_AT[name] ?? 0) <= SEQ_DEPTH && !OUT_OF_REACH[seed].events.includes(name))
        .filter((name) => (result.changed.get(name) ?? 0) === 0)
        .map((name) => `${name} (fired ${result.fired.get(name) ?? 0}×, never changed the state)`);
      expect(silent).toEqual([]);
    });

    coverage("every check in reach has its precondition hold (no check is vacuous)", () => {
      const vacuous = CHECK_NAMES.filter(
        (name) => !OUT_OF_REACH[seed].checks.includes(name) && (result.findings.exercised.get(name) ?? 0) === 0,
      );
      expect(vacuous).toEqual([]);
    });

    for (const name of CHECK_NAMES) {
      const kickCheck = KICKS_OFF && KICK_CHECKS.includes(name);
      (kickCheck ? it.fails : it)(`${kickCheck ? "fails with the kicks deleted" : "no new violation"}: ${name}`, () => {
        const v = result.findings.fresh.get(name);
        expect(v?.count ?? 0, report(name, v, false)).toBe(0);
      });
      for (const known of KNOWN.filter((k) => k.check === name && k.shortest.seed === seed && k.shortest.path.length <= SEQ_DEPTH)) {
        it.fails(`KNOWN VIOLATION (${known.cite}): ${name}, ${known.id}`, () => {
          const v = result.findings.known.get(known.id);
          expect(v?.count ?? 0, report(name, v, false)).toBe(0);
        });
      }
    }

    // A finding whose shortest trace is deeper than CI explores still runs,
    // as its exact trace, with every check the explorer would apply along it.
    const deep = KNOWN.filter((k) => k.shortest.seed === seed && k.shortest.path.length > SEQ_DEPTH);
    if (deep.length > 0 && !KICKS_OFF) {
      describe("known findings deeper than this run, replayed as exact traces", () => {
        const replayed = new Map<string, Findings>();
        beforeAll(async () => {
          for (const known of deep) replayed.set(known.id, await checkTrace(known.shortest.seed, known.shortest.path));
        }, 5 * 60_000);
        for (const known of deep) {
          const trace = `${known.shortest.seed}: ${known.shortest.path.join(" → ")}`;
          it(`no new violation along ${trace}`, () => {
            const fresh = replayed.get(known.id)!.fresh;
            expect([...fresh.keys()], [...fresh].map(([n, v]) => report(n as CheckName, v, false)).join("\n")).toEqual([]);
          });
          it.fails(`KNOWN VIOLATION (${known.cite}): ${known.check}, ${known.id}, along ${trace}`, () => {
            const v = replayed.get(known.id)!.known.get(known.id);
            expect(v?.count ?? 0, report(known.check, v, false)).toBe(0);
          });
        }
      });
    }

    const fixed = FIXED.filter((f) => f.shortest.seed === seed && f.shortest.path.length > SEQ_DEPTH);
    if (fixed.length > 0 && !KICKS_OFF) {
      describe("fixed findings deeper than this run, replayed as exact traces", () => {
        const replayed = new Map<Fixed, Findings>();
        beforeAll(async () => {
          for (const f of fixed) replayed.set(f, await checkTrace(f.shortest.seed, f.shortest.path));
        }, 5 * 60_000);
        for (const f of fixed) {
          const trace = `${f.shortest.seed}: ${f.shortest.path.join(" → ")}`;
          it(`FIXED (${f.cite}): no violation along ${trace}, where ${f.check} runs`, () => {
            const found = replayed.get(f)!;
            expect([...found.fresh.keys()], [...found.fresh].map(([n, v]) => report(n as CheckName, v, false)).join("\n")).toEqual([]);
            expect(found.exercised.get(f.check) ?? 0, `${f.check} never ran along ${trace}`).toBeGreaterThan(0);
          });
        }
      });
    }
  });
}

// ─── Fidelity: the seeded device and the mirrored constants ──────────────

async function deviceRows(t: TestClient, claimId: Id<"managedDeviceClaims">) {
  return await t.run(async (ctx) => {
    const claim = (await ctx.db.get(claimId))!;
    const pairing = (await ctx.db
      .query("pairedDevices")
      .withIndex("by_device", (q) => q.eq("institutionId", claim.institutionId).eq("deviceId", DEVICE_ID))
      .unique())!;
    const binding = (await ctx.db
      .query("deviceAppUnlockBindings")
      .withIndex("by_managed_device", (q) => q.eq("managedDeviceClaimId", claimId))
      .unique())!;
    return {
      claim: {
        serial: claim.serial,
        scholarId: claim.scholarId,
        claimState: claim.claimState,
        lastDeviceId: claim.lastDeviceId,
        claimGeneration: claim.claimGeneration,
        rotationCount: claim.rotationCount,
        claimCount: claim.claimCount,
      },
      pairing: {
        scholarId: pairing.scholarId,
        deviceId: pairing.deviceId,
        ofThisClaim: pairing.managedDeviceClaimId === claimId,
      },
      binding: {
        serial: binding.serial,
        simpleMdmProfileId: binding.simpleMdmProfileId,
        baselineBundleIds: binding.baselineBundleIds,
        baselineProfileXml: binding.baselineProfileXml,
        profilePayloadIdentifier: binding.profilePayloadIdentifier,
        profilePayloadUuid: binding.profilePayloadUuid,
        profileUuid: binding.profileUuid,
      },
    };
  });
}

async function unlockRow(r: Run): Promise<Doc<"deviceAppUnlockStates">> {
  return (await r.t.run((ctx) =>
    ctx.db
      .query("deviceAppUnlockStates")
      .withIndex("by_managed_device", (q) => q.eq("managedDeviceClaimId", r.w.claimId))
      .unique(),
  ))!;
}

/**
 * Checks on the harness itself, run once (by the link spec): the four
 * searches together cover the alphabet, and the seeded device and the
 * mirrored constants match the real writers. The fidelity sequences lean on
 * the kicks, so they run with them on.
 */
export function describeHarnessChecks(): void {
describe("the four seeds' searches together", () => {
  it("every event and check is in reach of some seed at CI depth, or replayed as an exact trace", () => {
    const events = Object.keys(EVENTS).filter(
      (name) => (FIRST_ENABLED_AT[name] ?? 0) <= CI_DEPTH && SEEDS.every((seed) => OUT_OF_REACH[seed].events.includes(name)),
    );
    const checks = CHECK_NAMES.filter(
      (name) =>
        SEEDS.every((seed) => OUT_OF_REACH[seed].checks.includes(name)) &&
        ![...KNOWN, ...FIXED].some((k) => k.check === name && k.shortest.path.length > CI_DEPTH),
    );
    expect({ events, checks }).toEqual({ events: [], checks: [] });
  });
});

describe.skipIf(KICKS_OFF)("fidelity: the seeded device and the mirrored constants match the real writers", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("register → assign → exchange → configureDedicatedProfile leave the rows seedWorld writes", async () => {
    await withHarness(async () => {
      const r = await startRun("link", newFindings());
      const seeded = await deviceRows(r.t, r.w.claimId);
      await r.t.run(async (ctx) => {
        for (const table of ["deviceAppUnlockStates", "deviceAppUnlockBindings", "pairedDevices", "managedDeviceClaims"] as const) {
          for (const row of await ctx.db.query(table).collect()) await ctx.db.delete(row._id);
        }
      });
      // Provisioning configures a freshly uploaded profile at its baseline.
      r.mdm.liveXml = profileXml(BASELINE);
      await r.asOps.mutation(api.managedDeviceClaims.registerManagedDeviceSerials, { serials: [SERIAL] });
      const claimId = (await r.t.run((ctx) =>
        ctx.db
          .query("managedDeviceClaims")
          .withIndex("by_serial", (q) => q.eq("serial", SERIAL))
          .unique(),
      ))!._id;
      const minted = await r.asOps.mutation(api.managedDeviceClaims.assignScholarToManagedDevice, {
        managedDeviceId: claimId,
        scholarId: r.w.scholarId,
      });
      await r.t.mutation(internal.managedDeviceClaims.consumeManagedClaim, {
        claimToken: minted.claimToken!,
        deviceId: DEVICE_ID,
        serial: SERIAL,
      });
      await r.asOps.action(api.deviceAppUnlock.configureDedicatedProfile, {
        managedDeviceClaimId: claimId,
        simpleMdmProfileId: PROFILE_ID,
        baselineBundleIds: BASELINE,
      });
      expect(await deviceRows(r.t, claimId)).toEqual(seeded);
    });
  });

  it("the mirrored constants match the rows the real writers leave", async () => {
    await withHarness(async () => {
      // A fresh lease: its recheck and its failsafe; then a return's idle expiry.
      let r = await replay("link", [], newFindings());
      const start = Date.now();
      await fire(r, "unlock");
      let row = await unlockRow(r);
      expect(row.nextRecheckAt! - start).toBe(RECHECK_INTERVAL_MS);
      expect(row.expiresAt! - start).toBe(ACTIVE_SESSION_FAILSAFE_MS);
      await fire(r, "return");
      expect((await unlockRow(r)).expiresAt! - start).toBe(IDLE_LEASE_DURATION_MS);

      // A failed unlock holds its token for the operation's lease.
      r = await replay("link", ["unlock!fail"], newFindings());
      row = await unlockRow(r);
      expect(row.pendingLockRetryAt! - row.operationStartedAt!).toBe(OPERATION_TIMEOUT_MS);

      // The gate defers a lease whose ceremony is in flight (Hole 1).
      r = await replay("link", ["unlock!hang", "link-", "reconcile"], newFindings());
      row = await unlockRow(r);
      expect(row.nextRecheckAt! - row.operationStartedAt!).toBe(RECHECK_AFTER_INFLIGHT_MS);

      // A failed relock backs off.
      r = await replay("link", ["unlock", "link-"], newFindings());
      const failedAt = Date.now();
      await fire(r, "reconcile!fail");
      expect((await unlockRow(r)).pendingLockRetryAt! - failedAt).toBe(LOCK_RETRY_DELAY_MS);

      // A removed iPad's teardown stops after its attempt budget (#4041).
      r = await replay("link", ["unlock", "remove"], newFindings());
      for (let i = 0; i < FAIL_DRAIN_ROUNDS; i++) {
        await fire(r, "reconcile!fail");
        row = await unlockRow(r);
        if (row.pendingLockRetryAt === TEARDOWN_STOPPED_RETRY_AT) break;
        await tickTo(r, Math.max(Date.now() + MINUTE, (row.pendingLockRetryAt ?? 0) + SECOND));
      }
      expect(row.cleanupAttempts).toBe(MAX_TEARDOWN_ATTEMPTS);
      expect(row.pendingLockRetryAt).toBe(TEARDOWN_STOPPED_RETRY_AT);
    });
  });
});
}
