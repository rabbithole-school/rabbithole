// The message-access MATRIX (TRA-388): every real messaging endpoint checked
// against ONE oracle, `convex/lib/messageAccessSpec.ts`, over a bounded but
// exhaustive fixture world.
//
//   viewers  (23) scholars own/other/guest/transferred/suspended, guardians,
//                 teachers here/elsewhere/suspended, a school admin, a platform
//                 admin, ops staff, and mentors named/unnamed × grant
//                 inst-wide/group-in/group-out/revoked/no-membership/other-school
//   threads  (12) family / mentor / workshop × subject enrolled / program
//                 guest / transferred (history at the old school) / at a
//                 suspended school
//   endpoints     scholarMessages.* and parentMessages.* reads + writes, lists,
//                 opens, "Include staff", and the delivery rows
//
// The oracle's facts are derived from the DECLARATION below, never from the
// db, so this can disagree with the product code. A cell where the code and
// the decision knowingly differ lives in KNOWN_DISCREPANCIES — asserted to
// STILL differ, so fixing the code forces removing the entry.

import { convexTest } from "convex-test";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  decideIncludable,
  decideMessageAccess,
  decideOpen,
  type MessageAccessDecision,
  type MessageAccessFacts,
  type MessageThreadKind,
  type MessageViewerRole,
} from "../lib/messageAccessSpec";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const makeT = () => convexTest(schema, modules);
type T = ReturnType<typeof makeT>;
type As = ReturnType<T["withIdentity"]>;

// ── The declared world ──────────────────────────────────────────────────

type School = "A" | "B" | "C"; // A live (primary), B SUSPENDED, C live
const LIVE: Record<School, boolean> = { A: true, B: false, C: true };

type Grant = {
  school: School;
  capability: "scholars:mentor" | "school:operations";
  group?: "in" | "out";
  revoked?: boolean;
};

type UserDecl = {
  role: Doc<"users">["role"];
  home?: School; // users.institutionId (scholars)
  guest?: boolean;
  memberships?: { school: School; role: "teacher" | "school_admin" | "staff" }[];
  grants?: Grant[];
  guardianOf?: ScholarKey[];
  isSystem?: boolean;
  viewer?: false; // seeded, but not a matrix viewer
};

const USERS = {
  sE: { role: "scholar", home: "A" },
  sG: { role: "scholar", home: "A", guest: true },
  sO: { role: "scholar", home: "A" },
  sT: { role: "scholar", home: "C" }, // moved A → C after its threads were opened
  sB: { role: "scholar", home: "B" },
  gE: { role: "parent", guardianOf: ["sE", "sG"] },
  gT: { role: "parent", guardianOf: ["sT"] },
  gB: { role: "parent", guardianOf: ["sB"] },
  tA: { role: "teacher", memberships: [{ school: "A", role: "teacher" }] },
  saA: { role: "school_admin", memberships: [{ school: "A", role: "school_admin" }] },
  tC: { role: "teacher", memberships: [{ school: "C", role: "teacher" }] },
  tB: { role: "teacher", memberships: [{ school: "B", role: "teacher" }] },
  pa: { role: "platform_admin" },
  opsA: {
    role: "staff",
    memberships: [{ school: "A", role: "staff" }],
    grants: [{ school: "A", capability: "school:operations" }],
  },
  mOps: {
    role: "staff",
    memberships: [{ school: "A", role: "staff" }],
    grants: [
      { school: "A", capability: "school:operations" },
      { school: "A", capability: "scholars:mentor" },
    ],
  },
  mInstNamed: {
    role: "staff",
    memberships: [{ school: "A", role: "staff" }],
    grants: [{ school: "A", capability: "scholars:mentor" }],
  },
  mInstUnnamed: {
    role: "staff",
    memberships: [{ school: "A", role: "staff" }],
    grants: [{ school: "A", capability: "scholars:mentor" }],
  },
  mGroupIn: {
    role: "staff",
    memberships: [{ school: "A", role: "staff" }],
    grants: [{ school: "A", capability: "scholars:mentor", group: "in" }],
  },
  mGroupOut: {
    role: "staff",
    memberships: [{ school: "A", role: "staff" }],
    grants: [{ school: "A", capability: "scholars:mentor", group: "out" }],
  },
  mRevoked: {
    role: "staff",
    memberships: [{ school: "A", role: "staff" }],
    grants: [{ school: "A", capability: "scholars:mentor", revoked: true }],
  },
  mNoMembership: {
    role: "staff",
    grants: [{ school: "A", capability: "scholars:mentor" }],
  },
  mOtherSchool: {
    role: "staff",
    memberships: [{ school: "C", role: "staff" }],
    grants: [{ school: "C", capability: "scholars:mentor" }],
  },
  mB: {
    role: "staff",
    memberships: [{ school: "B", role: "staff" }],
    grants: [{ school: "B", capability: "scholars:mentor" }],
  },
  // Not viewers: an "Add people" target, and a system teacher account.
  mSpare: {
    role: "staff",
    memberships: [{ school: "A", role: "staff" }],
    grants: [{ school: "A", capability: "scholars:mentor" }],
    viewer: false,
  },
  sysA: {
    role: "teacher",
    memberships: [{ school: "A", role: "teacher" }],
    isSystem: true,
    viewer: false,
  },
} satisfies Record<string, UserDecl>;

type UserKey = keyof typeof USERS;
type ScholarKey = "sE" | "sG" | "sO" | "sT" | "sB";
const decl = (key: UserKey): UserDecl => USERS[key] as UserDecl;
const VIEWERS = (Object.keys(USERS) as UserKey[]).filter((k) => decl(k).viewer !== false);

/** Scholars in each mentor group at A. */
const GROUPS: Record<"in" | "out", ScholarKey[]> = { in: ["sE", "sG", "sT"], out: ["sO"] };

type ThreadDecl = {
  key: string;
  kind: MessageThreadKind;
  subject: ScholarKey;
  stamp: School;
  guardian?: UserKey; // family participant
  named?: UserKey[]; // mentor staff-side participants
  idea?: boolean; // workshop with a suggestion + opening message
};

const NAMED_A: UserKey[] = [
  "tA",
  "mInstNamed",
  "mGroupIn",
  "mGroupOut",
  "mRevoked",
  "mNoMembership",
  "mOtherSchool",
];

const SUBJECTS: { subject: ScholarKey; stamp: School; guardian: UserKey; named: UserKey[] }[] = [
  { subject: "sE", stamp: "A", guardian: "gE", named: NAMED_A },
  { subject: "sG", stamp: "A", guardian: "gE", named: NAMED_A },
  { subject: "sT", stamp: "A", guardian: "gT", named: NAMED_A },
  { subject: "sB", stamp: "B", guardian: "gB", named: ["tB", "mB"] },
];

const THREADS: ThreadDecl[] = SUBJECTS.flatMap(({ subject, stamp, guardian, named }) => [
  { key: `family:${subject}`, kind: "family", subject, stamp, guardian },
  { key: `mentor:${subject}`, kind: "mentor", subject, stamp, named },
  { key: `workshop:${subject}`, kind: "workshop", subject, stamp, idea: subject === "sE" },
]);

// ── Facts from the declaration (independent of the product code) ─────────

function roleOf(key: UserKey): MessageViewerRole {
  const role = decl(key).role;
  if (role === "scholar") return "scholar";
  if (role === "parent") return "guardian";
  if (role === "platform_admin") return "platform_admin";
  return "staff";
}

function suspendedOut(key: UserKey): boolean {
  const d = decl(key);
  if (d.role === "platform_admin") return false;
  const ties = [...(d.home ? [d.home] : []), ...(d.memberships ?? []).map((m) => m.school)];
  return ties.length > 0 && ties.every((school) => !LIVE[school]);
}

function teachingTeamAt(key: UserKey, school: School): boolean {
  return (decl(key).memberships ?? []).some(
    (m) => m.school === school && (m.role === "teacher" || m.role === "school_admin"),
  );
}

function opsGrantAt(key: UserKey, school: School): boolean {
  const d = decl(key);
  return (
    (d.memberships ?? []).some((m) => m.school === school) &&
    (d.grants ?? []).some(
      (g) => g.school === school && g.capability === "school:operations" && !g.revoked,
    )
  );
}

function mentorCovers(key: UserKey, scholar: ScholarKey): boolean {
  const d = decl(key);
  const s = decl(scholar);
  const school = s.home!;
  if (s.guest || !LIVE[school]) return false;
  if (!(d.memberships ?? []).some((m) => m.school === school)) return false;
  return (d.grants ?? []).some(
    (g) =>
      g.capability === "scholars:mentor" &&
      !g.revoked &&
      g.school === school &&
      (g.group === undefined || GROUPS[g.group].includes(scholar)),
  );
}

function factsFor(viewer: UserKey, thread: ThreadDecl, impersonating = false): MessageAccessFacts {
  return {
    kind: thread.kind,
    thread: {
      stampLive: LIVE[thread.stamp],
      transferred: decl(thread.subject).home !== thread.stamp,
    },
    viewer: {
      role: roleOf(viewer),
      suspendedOut: suspendedOut(viewer),
      impersonating,
      isThreadScholar: viewer === thread.subject,
      isGuardianParticipant: thread.kind === "family" && thread.guardian === viewer,
      teachingTeamAtStamp: teachingTeamAt(viewer, thread.stamp),
      schoolOpsGrantAtStamp: opsGrantAt(viewer, thread.stamp),
      mentorCoversScholar: mentorCovers(viewer, thread.subject),
      namedOnThread: (thread.named ?? []).includes(viewer),
    },
  };
}

// ── Known code ≠ decision cells (TRA-388 spec, "discrepancies") ─────────

type Field =
  | "read"
  | "reply"
  | "list"
  | "markRead"
  | "editOwn"
  | "canReplyFlag"
  | "liveFiles"
  | "withdrawnText"
  | "withdrawnFiles"
  | "addPeople"
  | "linkPreview"
  | "withdrawnMessageFile"
  | "open"
  | "includable";

/** `${viewer}|${threadKeyOrSubject}|${field}` → the discrepancy id. */
// D-1..D-4 were fixed by TRA-401/402/403. Add an entry (with its id)
// only for a cell the product has knowingly not caught up with yet.
const KNOWN_DISCREPANCIES: Record<string, string> = {};

// ── Seeding ─────────────────────────────────────────────────────────────

type Seeded = {
  users: Record<UserKey, Id<"users">>;
  schools: Record<School, Id<"institutions">>;
  threads: Record<string, Id<"parentThreads">>;
  withdrawnMessage: Record<string, Id<"parentMessages">>;
  withdrawnAttachment: Record<string, Id<"parentMessageAttachments">>;
  /** A LIVE attachment row on a withdrawn message (e.g. the legacy
   *  `retracted: true` flag, which never touched attachments). */
  orphanedAttachment: Record<string, Id<"parentMessageAttachments">>;
  linkMessage: Record<string, Id<"parentMessages">>;
  /** A live attachment on a live message: readable exactly when the thread is. */
  liveAttachment: Record<string, Id<"parentMessageAttachments">>;
  /** `${viewer}|${thread}` → the viewer's own fresh messages there. */
  own: Record<string, { edit: Id<"parentMessages">; attach: Id<"parentMessageAttachments"> }>;
  ideaOpening: Id<"parentMessages">;
};

const LINK = "https://example.com/tank-notes";

async function seedWorld(t: T): Promise<Seeded> {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const schools = {
      A: await ctx.db.insert("institutions", { name: "Alder", slug: "alder-mx", kind: "school", isPrimary: true }),
      B: await ctx.db.insert("institutions", { name: "Birch", slug: "birch-mx", kind: "school" }),
      C: await ctx.db.insert("institutions", { name: "Cedar", slug: "cedar-mx", kind: "school" }),
    } as Record<School, Id<"institutions">>;
    const users = {} as Record<UserKey, Id<"users">>;
    for (const key of Object.keys(USERS) as UserKey[]) {
      const d = decl(key);
      // sT starts at A (its threads were opened there) and moves to C below.
      const home = key === "sT" ? "A" : d.home;
      users[key] = await ctx.db.insert("users", {
        username: `mx-${key.toLowerCase()}`,
        name: `${key} Fixture`,
        role: d.role,
        email: `${key.toLowerCase()}@fixture.test`,
        ...(home ? { institutionId: schools[home] } : {}),
        ...(d.guest ? { enrollmentStanding: "program_guest" as const } : {}),
        ...(d.isSystem ? { isSystem: true } : {}),
      });
    }
    const groups = {} as Record<"in" | "out", Id<"scholarGroups">>;
    for (const g of ["in", "out"] as const) {
      groups[g] = await ctx.db.insert("scholarGroups", {
        teacherId: users.tA,
        institutionId: schools.A,
        name: `Group ${g}`,
        scholarIds: GROUPS[g].map((s) => users[s]),
      });
    }
    for (const key of Object.keys(USERS) as UserKey[]) {
      const d = decl(key);
      for (const m of d.memberships ?? []) {
        await ctx.db.insert("memberships", { userId: users[key], role: m.role, institutionId: schools[m.school] });
      }
      for (const g of d.grants ?? []) {
        await ctx.db.insert("staffCapabilityGrants", {
          granteeUserId: users[key],
          institutionId: schools[g.school],
          capability: g.capability,
          ...(g.group ? { scholarGroupId: groups[g.group] } : {}),
          grantedBy: users.pa,
          grantedAt: 1,
          ...(g.revoked ? { revokedAt: 2, revokedBy: users.pa } : {}),
        });
      }
      for (const scholar of d.guardianOf ?? []) {
        await ctx.db.insert("guardianships", {
          parentUserId: users[key],
          scholarUserId: users[scholar],
          createdBy: users[key],
        });
      }
    }

    const storageId = await ctx.storage.store(new Blob(["png"], { type: "image/png" }));
    const threads: Record<string, Id<"parentThreads">> = {};
    const withdrawnMessage: Record<string, Id<"parentMessages">> = {};
    const withdrawnAttachment: Record<string, Id<"parentMessageAttachments">> = {};
    const orphanedAttachment: Record<string, Id<"parentMessageAttachments">> = {};
    const linkMessage: Record<string, Id<"parentMessages">> = {};
    const liveAttachment: Record<string, Id<"parentMessageAttachments">> = {};
    const own: Seeded["own"] = {};
    let ideaOpening: Id<"parentMessages"> | null = null;

    const attach = async (
      threadId: Id<"parentThreads">,
      messageId: Id<"parentMessages">,
      uploaderId: Id<"users">,
      retracted: boolean,
    ) =>
      await ctx.db.insert("parentMessageAttachments", {
        messageId,
        threadId,
        storageId,
        uploaderId,
        fileName: "tank.png",
        mimeType: "image/png",
        sizeBytes: 3,
        ...(retracted ? { retractedAt: now, retractedByUserId: uploaderId } : {}),
      });

    for (const th of THREADS) {
      const subject = users[th.subject];
      const institutionId = schools[th.stamp];
      const staffAuthor = th.stamp === "B" ? users.tB : users.tA;
      let suggestionId: Id<"scholarSuggestions"> | undefined;
      if (th.idea) {
        suggestionId = await ctx.db.insert("scholarSuggestions", {
          scholarId: subject,
          title: "Blue quest cards",
          scholarWords: "Blue quest cards please",
          createdAt: now,
          updatedAt: now,
        });
      }
      const threadId = await ctx.db.insert("parentThreads", {
        parentUserId: th.kind === "family" ? users[th.guardian!] : subject,
        scholarId: subject,
        institutionId,
        lastMessageAt: now,
        ...(th.kind === "family" ? { teacherId: staffAuthor } : { kind: th.kind, teacherId: staffAuthor }),
        ...(suggestionId ? { suggestionId } : {}),
      });
      threads[th.key] = threadId;
      if (suggestionId) {
        await ctx.db.patch(suggestionId, { threadId });
        ideaOpening = await ctx.db.insert("parentMessages", {
          threadId,
          authorType: "scholar",
          authorUserId: subject,
          body: "Blue quest cards please",
          isIdeaOpening: true,
        });
      }
      if (th.kind === "family") {
        await ctx.db.insert("parentThreadParticipants", { threadId, parentUserId: users[th.guardian!] });
      } else {
        await ctx.db.insert("parentThreadParticipants", { threadId, parentUserId: subject, side: "scholar" });
        for (const named of th.named ?? []) {
          await ctx.db.insert("parentThreadParticipants", { threadId, parentUserId: users[named], side: "staff" });
        }
      }
      // A withdrawn message (+ its withdrawn attachment) from the non-staff side.
      const withdrawnAuthor = th.kind === "family" ? users[th.guardian!] : subject;
      const wm = await ctx.db.insert("parentMessages", {
        threadId,
        authorType: th.kind === "family" ? "parent" : "scholar",
        authorUserId: withdrawnAuthor,
        body: "withdrawn words",
        retractedAt: now,
        retractedByUserId: withdrawnAuthor,
      });
      withdrawnMessage[th.key] = wm;
      withdrawnAttachment[th.key] = await attach(threadId, wm, withdrawnAuthor, true);
      const legacyWithdrawn = await ctx.db.insert("parentMessages", {
        threadId,
        authorType: th.kind === "family" ? "parent" : "scholar",
        authorUserId: withdrawnAuthor,
        body: "legacy withdrawn words",
        retracted: true,
      });
      orphanedAttachment[th.key] = await attach(threadId, legacyWithdrawn, withdrawnAuthor, false);
      linkMessage[th.key] = await ctx.db.insert("parentMessages", {
        threadId,
        authorType: "teacher",
        authorUserId: staffAuthor,
        body: LINK,
      });
      liveAttachment[th.key] = await attach(threadId, linkMessage[th.key], staffAuthor, false);
      // Each viewer's own fresh messages here (forged where the viewer could
      // never have posted — the ACCESS gate, not authorship, must refuse).
      for (const viewer of VIEWERS) {
        const role = roleOf(viewer);
        const authorType =
          role === "scholar" ? "scholar" : role === "guardian" ? "parent" : "teacher";
        const edit = await ctx.db.insert("parentMessages", {
          threadId, authorType, authorUserId: users[viewer], body: `mine ${viewer}`,
        });
        const withAttachment = await ctx.db.insert("parentMessages", {
          threadId, authorType, authorUserId: users[viewer], body: `mine+file ${viewer}`,
        });
        own[`${viewer}|${th.key}`] = {
          edit,
          attach: await attach(threadId, withAttachment, users[viewer], false),
        };
      }
    }

    // Then the world moves on: sT transfers A → C, and B is suspended.
    await ctx.db.patch(users.sT, { institutionId: schools.C });
    await ctx.db.patch(schools.B, { disabledAt: now });
    return {
      users, schools, threads, withdrawnMessage, withdrawnAttachment, orphanedAttachment,
      linkMessage, liveAttachment, own,
      ideaOpening: ideaOpening!,
    };
  });
}

async function sessionFor(t: T, userId: Id<"users">) {
  const sessionId = await t.run((ctx) =>
    ctx.db.insert("authSessions", { userId, expirationTime: Date.now() + 86_400_000 }),
  );
  return {
    sessionId,
    as: t.withIdentity({ subject: `${userId}|${sessionId}`, issuer: "https://convex.dev" }),
  };
}

async function ok(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch {
    return false;
  }
}

async function value<R>(fn: () => Promise<R>): Promise<R | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

/**
 * Every way to reach a thread: the scholar engine, and the family engine
 * through EACH `as` surface. Each is probed and judged on its own — a safe
 * answer on one surface must never hide a leak on another.
 */
type Route = { engine: "scholar" } | { engine: "family"; surface: "default" | "parent" | "staff" };
const ROUTES: Route[] = [
  { engine: "scholar" },
  { engine: "family", surface: "default" },
  { engine: "family", surface: "parent" },
  { engine: "family", surface: "staff" },
];
const routeName = (r: Route) => (r.engine === "scholar" ? "scholar" : `family:${r.surface}`);
const asArg = (r: Route) =>
  r.engine === "family" && r.surface !== "default" ? { as: r.surface } : {};

type Observed = Partial<Record<Field, boolean>>;

/** What ONE route must return for this viewer and thread. */
function expectedVia(d: MessageAccessDecision, th: ThreadDecl, route: Route): Observed {
  const engineMatches = (th.kind === "family") === (route.engine === "family");
  const ok = !engineMatches
    ? false
    : route.engine === "scholar" || route.surface === "default"
      ? d.read
      : route.surface === "parent"
        ? d.side === "guardian"
        : d.side === "staff";
  return {
    read: ok,
    canReplyFlag: d.reply,
    liveFiles: ok,
    linkPreview: ok,
    withdrawnText: ok && d.seesWithdrawnText,
    withdrawnFiles: ok && d.seesWithdrawnFiles,
    withdrawnMessageFile: ok && d.seesWithdrawnFiles,
    reply: ok && d.reply,
    markRead: ok && d.markRead,
    editOwn: ok && d.editOwn,
    addPeople: route.engine === "scholar" && ok && d.addPeople,
  };
}

// ── Probes ──────────────────────────────────────────────────────────────

async function probeReads(
  as: As,
  w: Seeded,
  th: ThreadDecl,
  viewer: UserKey,
  route: Route,
): Promise<Observed> {
  const threadId = w.threads[th.key];
  const messageId = w.linkMessage[th.key];
  type Row = { _id: Id<"parentMessageAttachments">; url: string | null };
  type Msg = { _id: Id<"parentMessages">; body: string; withdrawnOriginal: string | null };
  let detail: { messages: Msg[]; canReply?: boolean } | null;
  let files: Row[];
  let preview: unknown;
  if (route.engine === "family") {
    const via = asArg(route);
    detail = await value(() => as.query(api.parentMessages.getThread, { threadId, ...via }));
    files = (await value(() => as.query(api.parentMessages.getThreadAttachments, { threadId, ...via }))) ?? [];
    preview = await value(() =>
      as.query(api.parentMessages.getMessageLinkPreviewRequest, { messageId, url: LINK, ...via }),
    );
  } else {
    detail = await value(() => as.query(api.scholarMessages.getThread, { threadId }));
    files = (await value(() => as.query(api.scholarMessages.getThreadAttachments, { threadId }))) ?? [];
    preview = await value(() =>
      as.query(api.scholarMessages.getMessageLinkPreviewRequest, { messageId, url: LINK }),
    );
  }
  const withdrawn = detail?.messages.find((m) => m._id === w.withdrawnMessage[th.key]);
  if (withdrawn && withdrawn.body !== "") {
    throw new Error(`${viewer} ${th.key} via ${routeName(route)}: a withdrawn body left the tombstone`);
  }
  const served = (id: Id<"parentMessageAttachments">) => files.some((f) => f._id === id);
  return {
    read: detail !== null,
    ...(detail && route.engine === "scholar" ? { canReplyFlag: detail.canReply === true } : {}),
    liveFiles: files.some((f) => f._id === w.liveAttachment[th.key] && f.url !== null),
    linkPreview: preview !== null,
    withdrawnText: (withdrawn?.withdrawnOriginal ?? null) !== null,
    withdrawnFiles: served(w.withdrawnAttachment[th.key]),
    withdrawnMessageFile: served(w.orphanedAttachment[th.key]),
  };
}

/** Someone the oracle says may be named on this thread (never the caller). */
function addTarget(w: Seeded, th: ThreadDecl, viewer: UserKey): Id<"users"> {
  const school = decl(th.subject).home!;
  const pick = (["mSpare", "saA", "tA"] as UserKey[]).find(
    (c) =>
      c !== viewer &&
      decideIncludable({
        role: roleOf(c),
        isSystem: false,
        teachingTeamAtScholarSchool: teachingTeamAt(c, school),
        mentorCoversScholar: mentorCovers(c, th.subject),
      }),
  );
  return w.users[pick ?? "mSpare"];
}

/**
 * Every write, through every route, each judged on its own. Edits run for all
 * routes before any withdraw (a withdrawn message can't be edited), and a
 * repeated withdraw still passes the access gate before its idempotent no-op.
 */
async function probeWrites(
  as: As,
  w: Seeded,
  th: ThreadDecl,
  viewer: UserKey,
): Promise<Map<Route, Observed>> {
  const threadId = w.threads[th.key];
  const own = w.own[`${viewer}|${th.key}`];
  const out = new Map<Route, Observed>(ROUTES.map((r) => [r, {}]));
  const family = (r: Route) => r.engine === "family";
  for (const r of ROUTES) {
    const o = out.get(r)!;
    if (family(r)) {
      o.markRead = await ok(() => as.mutation(api.parentMessages.markThreadRead, { threadId, ...asArg(r) }));
      o.reply = await ok(() =>
        as.mutation(api.parentMessages.replyInThread, { threadId, body: "reply", ...asArg(r) }),
      );
    } else {
      o.markRead = await ok(() => as.mutation(api.scholarMessages.markRead, { threadId }));
      o.reply = await ok(() => as.mutation(api.scholarMessages.reply, { threadId, body: "reply" }));
      o.addPeople = await ok(() =>
        as.mutation(api.scholarMessages.addParticipants, { threadId, userIds: [addTarget(w, th, viewer)] }),
      );
    }
  }
  const steps: Record<string, boolean[]> = {};
  const record = (r: Route, v: boolean) => (steps[routeName(r)] ??= []).push(v);
  for (const r of ROUTES) {
    record(r, family(r)
      ? await ok(() => as.mutation(api.parentMessages.editMessage, { messageId: own.edit, body: "edited", ...asArg(r) }))
      : await ok(() => as.mutation(api.scholarMessages.editMessage, { messageId: own.edit, body: "edited" })));
  }
  for (const r of ROUTES) {
    record(r, family(r)
      ? await ok(() => as.mutation(api.parentMessages.retractMessage, { messageId: own.edit, ...asArg(r) }))
      : await ok(() => as.mutation(api.scholarMessages.retractMessage, { messageId: own.edit })));
  }
  for (const r of ROUTES) {
    record(r, family(r)
      ? await ok(() => as.mutation(api.parentMessages.retractAttachment, { attachmentId: own.attach, ...asArg(r) }))
      : await ok(() => as.mutation(api.scholarMessages.retractAttachment, { attachmentId: own.attach })));
  }
  for (const r of ROUTES) {
    const results = steps[routeName(r)];
    // All three agree, or the cell is inconsistent (undefined ≠ any expectation).
    out.get(r)!.editOwn = results.every(Boolean) ? true : results.some(Boolean) ? undefined : false;
  }
  return out;
}

function compare(
  mismatches: string[],
  viewer: UserKey,
  cell: string,
  expected: Observed,
  actual: Observed,
  reason: string,
) {
  for (const field of Object.keys(actual) as Field[]) {
    if (!(field in expected)) continue;
    const key = `${viewer}|${cell}|${field}`;
    const known = KNOWN_DISCREPANCIES[key];
    const differs = actual[field] !== expected[field];
    if (differs && !known) {
      mismatches.push(
        `${key}: expected ${expected[field]} got ${actual[field]} (oracle: ${reason})`,
      );
    } else if (!differs && known) {
      mismatches.push(`${key}: KNOWN discrepancy ${known} no longer reproduces — remove it`);
    }
  }
}

// ── The matrix ──────────────────────────────────────────────────────────

describe("message access matrix (every endpoint vs. the oracle)", () => {
  let t: T;
  let w: Seeded;
  const sessions = new Map<UserKey, As>();
  beforeAll(async () => {
    t = makeT();
    w = await seedWorld(t);
    for (const viewer of VIEWERS) sessions.set(viewer, (await sessionFor(t, w.users[viewer])).as);
  });

  // Reads + lists for EVERY viewer before any write, so a write can't change a read.
  test.each(VIEWERS)("reads and lists: %s", async (viewer) => {
    const as = sessions.get(viewer)!;
    const mismatches: string[] = [];
    const scholarList = new Set(
      ((await value(() => as.query(api.scholarMessages.listThreads, {})))?.threads ?? []).map((x) => x._id),
    );
    const familyList = new Set([
      ...((await value(() => as.query(api.parentMessages.listMyThreads, { scope: "all" }))) ?? []).map((x) => x._id),
      ...((await value(() => as.query(api.parentMessages.listMyGuardianThreads, {}))) ?? []).map((x) => x._id),
    ]);
    for (const th of THREADS) {
      const decision = decideMessageAccess(factsFor(viewer, th));
      for (const route of ROUTES) {
        const observed = await probeReads(as, w, th, viewer, route);
        compare(mismatches, viewer, `${th.key}@${routeName(route)}`, expectedVia(decision, th, route), observed, decision.reason);
      }
      const listed = (th.kind === "family" ? familyList : scholarList).has(w.threads[th.key]);
      const wrongList = (th.kind === "family" ? scholarList : familyList).has(w.threads[th.key]);
      compare(mismatches, viewer, th.key, { list: decision.list }, { list: listed || wrongList }, decision.reason);
    }
    expect(mismatches).toEqual([]);
  });

  test.each(VIEWERS)("writes: %s", async (viewer) => {
    const as = sessions.get(viewer)!;
    const mismatches: string[] = [];
    for (const th of THREADS) {
      const decision = decideMessageAccess(factsFor(viewer, th));
      for (const [route, observed] of await probeWrites(as, w, th, viewer)) {
        compare(mismatches, viewer, `${th.key}@${routeName(route)}`, expectedVia(decision, th, route), observed, decision.reason);
      }
    }
    expect(mismatches).toEqual([]);
  });

  test("an idea's opening message is never editable, even by its scholar", async () => {
    const as = sessions.get("sE")!;
    expect(decideMessageAccess(factsFor("sE", THREADS.find((x) => x.key === "workshop:sE")!)).editOwn).toBe(true);
    await expect(
      as.mutation(api.scholarMessages.editMessage, { messageId: w.ideaOpening, body: "changed" }),
    ).rejects.toThrow();
    await expect(
      as.mutation(api.scholarMessages.retractMessage, { messageId: w.ideaOpening }),
    ).rejects.toThrow();
  });

  test("the 10-minute window binds every author, on both engines", async () => {
    const eleven = Date.now() - 11 * 60 * 1000;
    const stale = await t.run(async (ctx) => ({
      teacher: await ctx.db.insert("parentMessages", {
        threadId: w.threads["mentor:sE"], authorType: "teacher", authorUserId: w.users.tA, body: "old", sentAt: eleven,
      }),
      scholar: await ctx.db.insert("parentMessages", {
        threadId: w.threads["workshop:sE"], authorType: "scholar", authorUserId: w.users.sE, body: "old", sentAt: eleven,
      }),
    }));
    await expect(
      sessions.get("tA")!.mutation(api.scholarMessages.editMessage, { messageId: stale.teacher, body: "x" }),
    ).rejects.toThrow(/10 minutes/);
    await expect(
      sessions.get("sE")!.mutation(api.scholarMessages.retractMessage, { messageId: stale.scholar }),
    ).rejects.toThrow(/10 minutes/);
    // Family: _creationTime can't be backdated in convex-test, so pin the
    // shared window through the engine's clock instead.
    const { MESSAGE_EDIT_WINDOW_MS } = await import("../../shared/messageEditWindow");
    expect(MESSAGE_EDIT_WINDOW_MS).toBe(10 * 60 * 1000);
  });
});

// ── Opening + "Include staff" ───────────────────────────────────────────

describe("opening conversations and naming staff", () => {
  let t: T;
  let w: Seeded;
  beforeAll(async () => {
    t = makeT();
    w = await seedWorld(t);
  });

  const OPEN_SUBJECTS: ScholarKey[] = ["sE", "sG", "sO", "sT", "sB"];

  test.each(VIEWERS)("open + include: %s", async (viewer) => {
    const { as } = await sessionFor(t, w.users[viewer]);
    const mismatches: string[] = [];
    for (const subject of OPEN_SUBJECTS) {
      const school = decl(subject).home!;
      const viewerFacts = {
        role: roleOf(viewer),
        suspendedOut: suspendedOut(viewer),
        impersonating: false,
        teachingTeamAtScholarSchool: teachingTeamAt(viewer, school),
        mentorCoversScholar: mentorCovers(viewer, subject),
      };
      for (const kind of ["mentor", "workshop"] as const) {
        const expected = decideOpen({ kind, scholarSchoolLive: LIVE[school], viewer: viewerFacts });
        const actual =
          kind === "mentor"
            ? await ok(() =>
                as.mutation(api.scholarMessages.startMentorThreads, { scholarIds: [w.users[subject]], body: "Aloha" }),
              )
            : await ok(() =>
                as.mutation(api.scholarMessages.startWorkshopThread, { scholarId: w.users[subject], body: "Aloha" }),
              );
        compare(mismatches, viewer, `open-${kind}:${subject}`, { open: expected.open }, { open: actual }, expected.reason);
      }
      const canOpenMentor = decideOpen({ kind: "mentor", scholarSchoolLive: LIVE[school], viewer: viewerFacts }).open;
      const expectedIncludable = canOpenMentor
        ? (Object.keys(USERS) as UserKey[])
            .filter((c) => c !== viewer)
            .filter((c) =>
              decideIncludable({
                role: roleOf(c),
                isSystem: decl(c).isSystem === true,
                teachingTeamAtScholarSchool: LIVE[school] && teachingTeamAt(c, school),
                mentorCoversScholar: mentorCovers(c, subject),
              }),
            )
            .sort()
        : [];
      const rows = (await value(() =>
        as.query(api.scholarMessages.listIncludableStaff, { scholarIds: [w.users[subject]] }),
      )) ?? [];
      const byId = new Map((Object.keys(USERS) as UserKey[]).map((k) => [w.users[k], k]));
      const actualIncludable = rows.map((r) => byId.get(r._id) ?? String(r._id)).sort();
      const key = `${viewer}|include:${subject}|includable`;
      if (JSON.stringify(actualIncludable) !== JSON.stringify(expectedIncludable) && !KNOWN_DISCREPANCIES[key]) {
        mismatches.push(`${key}: expected [${expectedIncludable}] got [${actualIncludable}]`);
      }
    }
    expect(mismatches).toEqual([]);
  });
});

// ── Delivery: who is ever sent a copy off-platform ──────────────────────

describe("delivery recipients", () => {
  let t: T;
  let w: Seeded;
  beforeAll(async () => {
    t = makeT();
    w = await seedWorld(t);
    await t.run(async (ctx) => {
      // Give the scholar every off-platform channel a guardian could have, so
      // "never a scholar row" is a real test rather than a missing address.
      for (const channel of ["sms", "whatsapp"] as const) {
        await ctx.db.insert("parentChannelIdentities", {
          parentUserId: w.users.sE, channel, identity: "+15550000001", optInAt: 1,
        });
        await ctx.db.insert("parentChannelIdentities", {
          parentUserId: w.users.gE, channel, identity: "+15550000002", optInAt: 1,
        });
      }
      // A scholar wrongly sitting on the family side of their family thread.
      await ctx.db.insert("parentThreadParticipants", {
        threadId: w.threads["family:sE"], parentUserId: w.users.sE,
      });
    });
  });

  async function offPlatformRows(messageId: Id<"parentMessages">) {
    return await t.run(async (ctx) =>
      (
        await ctx.db
          .query("messageDeliveries")
          .withIndex("by_message", (q) => q.eq("messageId", messageId))
          .collect()
      ).filter((row) => row.channel !== "portal"),
    );
  }

  const keyOf = (w: Seeded, id: Id<"users">) =>
    (Object.keys(USERS) as UserKey[]).find((k) => w.users[k] === id) ?? String(id);

  /** Named staff the oracle says get the batched email for this thread. */
  function oracleEmailees(threadKey: string): UserKey[] {
    const th = THREADS.find((x) => x.key === threadKey)!;
    return VIEWERS.filter((v) => decideMessageAccess(factsFor(v, th)).offPlatform.email).sort();
  }

  test.each(["mentor:sE", "mentor:sG", "workshop:sE", "workshop:sG"])(
    "a scholar's message in %s emails exactly the oracle's named staff — never a scholar",
    async (threadKey) => {
      const scholar = threadKey.endsWith("sE") ? "sE" : "sG";
      const { as } = await sessionFor(t, w.users[scholar]);
      const { messageId } = await as.mutation(api.scholarMessages.reply, {
        threadId: w.threads[threadKey], body: "My tank pH is 7.2",
      });
      const rows = await offPlatformRows(messageId);
      expect(rows.every((row) => row.channel === "email")).toBe(true);
      expect(rows.map((row) => keyOf(w, row.parentUserId)).sort()).toEqual(oracleEmailees(threadKey));
      expect(rows.some((row) => decl(keyOf(w, row.parentUserId) as UserKey).role === "scholar")).toBe(false);
    },
  );

  test("the batch claim re-checks reach: a grant revoked after queueing drops out", async () => {
    const threadId = w.threads["mentor:sE"];
    await t.run(async (ctx) => {
      const grant = (
        await ctx.db
          .query("staffCapabilityGrants")
          .withIndex("by_grantee_capability", (q) =>
            q.eq("granteeUserId", w.users.mInstNamed).eq("capability", "scholars:mentor"),
          )
          .collect()
      )[0];
      await ctx.db.patch(grant._id, { revokedAt: 3, revokedBy: w.users.pa });
    });
    const batch = await t.mutation(internal.scholarMessages.claimMentorEmailBatch, { threadId });
    const expected = oracleEmailees("mentor:sE")
      .filter((k) => k !== "mInstNamed")
      .map((k) => `${k.toLowerCase()}@fixture.test`)
      .sort();
    const sent = (batch?.recipients ?? []).map((r) => r.email).sort();
    for (const email of sent) expect(expected).toContain(email);
    expect(sent).not.toContain("se@fixture.test");
    expect(sent).not.toContain("minstnamed@fixture.test");
  });

  test("a staff reply in a family thread never queues a scholar row; guardians get their channels", async () => {
    const { as } = await sessionFor(t, w.users.tA);
    await as.mutation(api.parentMessages.replyInThread, {
      threadId: w.threads["family:sE"], body: "Field trip Friday", as: "staff",
    });
    const messageId = await t.run(async (ctx) =>
      (
        await ctx.db
          .query("parentMessages")
          .withIndex("by_thread", (q) => q.eq("threadId", w.threads["family:sE"]))
          .collect()
      ).find((m) => m.body === "Field trip Friday")!._id,
    );
    const rows = await offPlatformRows(messageId);
    expect(rows.filter((row) => row.parentUserId === w.users.sE)).toEqual([]);
    expect(rows.map((row) => `${keyOf(w, row.parentUserId)}:${row.channel}`).sort()).toEqual(
      ["gE:email", "gE:sms", "gE:whatsapp"],
    );
    const info = await t.query(internal.parentMessageSend.getDispatchInfo, { messageId });
    for (const delivery of info?.deliveries ?? []) {
      expect(delivery.parentEmails).not.toContain("se@fixture.test");
    }
  });
});

// ── Impersonation: reads as the target, never writes ────────────────────

describe("impersonation overlay", () => {
  let t: T;
  let w: Seeded;
  const original = process.env.IMPERSONATION_ENABLED;
  beforeAll(async () => {
    process.env.IMPERSONATION_ENABLED = "on";
    t = makeT();
    w = await seedWorld(t);
  });
  afterAll(() => {
    if (original === undefined) delete process.env.IMPERSONATION_ENABLED;
    else process.env.IMPERSONATION_ENABLED = original;
  });

  test.each(["sE", "gE", "tA", "mInstNamed", "opsA"] as UserKey[])(
    "a platform admin viewing as %s reads exactly what they can, and writes nothing",
    async (target) => {
      const { as, sessionId } = await sessionFor(t, w.users.pa);
      await t.run((ctx) =>
        ctx.db.insert("impersonationOverlays", {
          adminUserId: w.users.pa, adminSessionId: sessionId, targetUserId: w.users[target],
          startedAt: Date.now(), active: true,
        }),
      );
      const mismatches: string[] = [];
      for (const th of THREADS) {
        const decision = decideMessageAccess(factsFor(target, th, true));
        for (const route of ROUTES) {
          const reads = await probeReads(as, w, th, target, route);
          compare(mismatches, target, `impersonated:${th.key}@${routeName(route)}`, expectedVia(decision, th, route), reads, decision.reason);
        }
        for (const [route, writes] of await probeWrites(as, w, th, target)) {
          compare(mismatches, target, `impersonated:${th.key}@${routeName(route)}`, expectedVia(decision, th, route), writes, decision.reason);
        }
      }
      expect(mismatches).toEqual([]);
    },
  );
});

// ── Slack: the staff-side transport for family threads ───────────────────
// Slack is not a new audience: a Slack reply must pass the same "may reply"
// rule as the app, and a guardian's message may be mirrored only to staff who
// could read it in the app — at a first-party (primary) school, since there is
// one Slack workspace.

describe("family Slack bridge", () => {
  let t: T;
  let w: Seeded;
  let extra: { cedarFamily: Id<"parentThreads">; legacyFamily: Id<"parentThreads"> };
  const SLACK_FAMILY = ["family:sE", "family:sT", "family:sB"] as const;
  beforeAll(async () => {
    t = makeT();
    w = await seedWorld(t);
    extra = await t.run(async (ctx) => {
      for (const key of VIEWERS) {
        await ctx.db.patch(w.users[key], { slackUserId: `U-${key}` });
      }
      await ctx.db.insert("parentMessageChannel", {
        slackChannelId: "C-STAFF", linkedBy: w.users.pa, linkedAt: 1,
      });
      // A family thread at Cedar (live, NOT the primary school)…
      const cedarFamily = await ctx.db.insert("parentThreads", {
        parentUserId: w.users.gT, scholarId: w.users.sT, institutionId: w.schools.C, lastMessageAt: 1,
      });
      await ctx.db.insert("parentThreadParticipants", { threadId: cedarFamily, parentUserId: w.users.gT });
      // …and a legacy parent-only thread (no subject scholar) stamped at Alder.
      const legacyFamily = await ctx.db.insert("parentThreads", {
        parentUserId: w.users.gE, institutionId: w.schools.A, lastMessageAt: 1,
      });
      await ctx.db.insert("parentThreadParticipants", { threadId: legacyFamily, parentUserId: w.users.gE });
      for (const [i, threadId] of [
        ...SLACK_FAMILY.map((k) => w.threads[k]),
        cedarFamily,
        legacyFamily,
      ].entries()) {
        await ctx.db.insert("parentSlackThreads", {
          parentThreadId: threadId, channelId: "C-STAFF", threadTs: `ts-${i}`, lastNotifiedAt: 1,
        });
      }
      return { cedarFamily, legacyFamily };
    });
  });

  const STAFF_VIEWERS = VIEWERS.filter((v) => roleOf(v) === "staff" || roleOf(v) === "platform_admin");

  test("a Slack reply passes the same rule as an in-app reply", async () => {
    const mismatches: string[] = [];
    const cases: { cell: string; threadTs: string; expected: (v: UserKey) => boolean }[] = [
      ...SLACK_FAMILY.map((key, i) => ({
        cell: key,
        threadTs: `ts-${i}`,
        expected: (v: UserKey) =>
          decideMessageAccess(factsFor(v, THREADS.find((x) => x.key === key)!)).reply,
      })),
      {
        cell: "family:legacy@A",
        threadTs: `ts-${SLACK_FAMILY.length + 1}`,
        expected: (v: UserKey) =>
          roleOf(v) === "platform_admin" ||
          (!suspendedOut(v) && (teachingTeamAt(v, "A") || opsGrantAt(v, "A"))),
      },
    ];
    for (const c of cases) {
      for (const viewer of STAFF_VIEWERS) {
        const result = await t.mutation(internal.parentMessages.ingestInboundSlackReply, {
          channelId: "C-STAFF", threadTs: c.threadTs, slackUserId: `U-${viewer}`,
          body: `slack reply ${viewer}`, eventId: `ev-${c.cell}-${viewer}`,
        });
        compare(mismatches, viewer, `slack-reply:${c.cell}`, { reply: c.expected(viewer) }, { reply: result.ok === true }, "same rule as the app");
      }
    }
    expect(mismatches).toEqual([]);
  });

  test("a guardian's message is mirrored to Slack only where app staff could read it, at the first-party school", async () => {
    const mismatches: string[] = [];
    const cells: { cell: string; threadId: Id<"parentThreads">; guardian: UserKey; expected: boolean }[] = [
      ...SLACK_FAMILY.map((key) => {
        const th = THREADS.find((x) => x.key === key)!;
        return {
          cell: key,
          threadId: w.threads[key],
          guardian: th.guardian!,
          // Someone on Alder's staff can read it in the app, and Alder is primary.
          expected: decideMessageAccess(factsFor("tA", th)).read,
        };
      }),
      { cell: "family:sT@C", threadId: extra.cedarFamily, guardian: "gT", expected: false },
    ];
    for (const c of cells) {
      const messageId = await t.run((ctx) =>
        ctx.db.insert("parentMessages", {
          threadId: c.threadId, authorType: "parent", authorUserId: w.users[c.guardian], body: "Pickup at 3?",
        }),
      );
      const context = await t.query(internal.parentMessages.getSlackNotificationContext, { messageId });
      compare(mismatches, c.guardian, `slack-mirror:${c.cell}`, { read: c.expected }, { read: context !== null }, "mirror only what app staff at the primary school can read");
    }
    expect(mismatches).toEqual([]);
  });
});
