// THE message-access spec, as a pure decision function (the oracle).
//
// Who may read, reply to, list, open, and add people to a `parentThreads`
// conversation of each kind — and who is ever sent a copy off-platform. The
// prose twin is the decision table in TRA-388; this module is the executable
// form that `convex/__tests__/messageAccessMatrix.test.ts` checks EVERY real
// messaging endpoint against. It encodes the product decisions, not the code:
// where the code disagrees, the matrix test names the cell in its
// KNOWN_DISCREPANCIES list rather than bending this file to match.
//
// Pure on purpose: no ctx, no db. The caller resolves the facts (who the
// viewer is relative to THIS thread) and asks. Deliberately NOT imported by
// product code — enforcement lives in lib/scholarThreadAccess.ts and
// parentMessages.ts, and an oracle that shares code with what it checks can
// only ever agree with it.
//
//   kind      who                                   read  reply  add people
//   family    guardian participants                  ✓     ✓      —
//             live school:operations at the school   ✓     ✓      —
//               (teachers, school admins, platform
//                admins, base staff with the grant)
//             scholars, mentors (w/o ops)            ✗     ✗      —
//   mentor    the thread's own scholar               ✓     ✓      ✗ (never opens one)
//             teaching team at the school + platform ✓     ✓      ✓ ("open door")
//             admins
//             a mentor whose live grant covers the   ✓     ✓      ✓
//               scholar AND who is NAMED on it
//             unnamed / uncovered / revoked mentors, ✗     ✗      ✗
//               guardians, ops-only staff
//   workshop  the thread's own scholar               ✓     ✓      ✗
//             teaching team + platform admins        ✓     ✓      ✗
//             everyone else                          ✗     ✗      ✗
//
// Transferred-school history (stamp ≠ the scholar's current school): read-only
// for the teaching team at the STAMPED school + platform admins; nobody writes;
// the scholar no longer sees it; mentors never.
//
// Delivery: scholars in-app only, always. A family guardian is eligible for
// email/SMS/WhatsApp per their own channel settings; a NAMED staff member who
// can still reach a mentor thread gets the batched email; nobody is emailed
// about a workshop thread (Slack #workshop only).
//
// Withdrawn messages/attachments: staff readers see the original; scholars and
// guardians see only the tombstone. Every author gets the same 10-minute
// edit/withdraw window; an idea's opening message is never editable.
//
// An impersonation overlay reads exactly as its target and can never write.

export type MessageThreadKind = "family" | "mentor" | "workshop";

export type MessageViewerRole = "scholar" | "guardian" | "staff" | "platform_admin";

export type MessageAccessFacts = {
  kind: MessageThreadKind;
  thread: {
    /** The institution the thread is stamped with is live (not suspended). */
    stampLive: boolean;
    /** The stamp is no longer the subject scholar's current school. */
    transferred: boolean;
  };
  viewer: {
    role: MessageViewerRole;
    /** Every institution tie of the viewer is suspended (sign-in refuses). */
    suspendedOut: boolean;
    /** A read-only "view as" overlay is active; the facts are the target's. */
    impersonating: boolean;
    /** Scholar viewer: this thread is about them. */
    isThreadScholar: boolean;
    /** A family-side participant row on this thread (a guardian). */
    isGuardianParticipant: boolean;
    /** Teacher or school_admin membership at the thread's stamped school. */
    teachingTeamAtStamp: boolean;
    /** Base staff holding a live `school:operations` grant at the stamp. */
    schoolOpsGrantAtStamp: boolean;
    /** A live `scholars:mentor` grant covers the subject scholar right now
     *  (enrolled scholar, active staff membership, inst-wide or group-in). */
    mentorCoversScholar: boolean;
    /** A staff-side participant row on this thread. */
    namedOnThread: boolean;
  };
};

export type MessageAccessDecision = {
  read: boolean;
  /** Which side of the conversation the viewer reads as — decides the
   *  payload shape (a guardian's view vs. the staff view) and, on the family
   *  engine, the only `as` surface that may answer. Null when denied. */
  side: "scholar" | "guardian" | "staff" | null;
  reply: boolean;
  /** Appears in the viewer's thread list for this kind. */
  list: boolean;
  markRead: boolean;
  /** Edit/withdraw their OWN message inside the 10-minute window (never an
   *  idea's opening message — see `mayEditMessage`). */
  editOwn: boolean;
  /** Sees the original TEXT of a withdrawn message (others get a tombstone). */
  seesWithdrawnText: boolean;
  /** Is served withdrawn FILES: attachments withdrawn themselves, or
   *  attached to a withdrawn message. Live files follow `read`. */
  seesWithdrawnFiles: boolean;
  /** Name more adults on this thread. */
  addPeople: boolean;
  /** Eligible to be sent off-platform copies (still subject to their own
   *  notification settings / opted-in channels). */
  offPlatform: { email: boolean; sms: boolean; whatsapp: boolean };
  /** One-line why, for readable test failures. */
  reason: string;
};

const NONE = { email: false, sms: false, whatsapp: false };

function deny(reason: string): MessageAccessDecision {
  return {
    read: false,
    side: null,
    reply: false,
    list: false,
    markRead: false,
    editOwn: false,
    seesWithdrawnText: false,
    seesWithdrawnFiles: false,
    addPeople: false,
    offPlatform: NONE,
    reason,
  };
}

function grant(
  f: MessageAccessFacts,
  reason: string,
  opts: {
    write: boolean;
    side: "scholar" | "guardian" | "staff";
    addPeople?: boolean;
    offPlatform?: MessageAccessDecision["offPlatform"];
  },
): MessageAccessDecision {
  // An impersonation overlay reads as its target and never writes.
  const write = opts.write && !f.viewer.impersonating;
  return {
    read: true,
    side: opts.side,
    reply: write,
    list: true,
    markRead: !f.viewer.impersonating,
    editOwn: write,
    // The open door: adults on the staff side see what was withdrawn.
    seesWithdrawnText: opts.side === "staff",
    seesWithdrawnFiles: opts.side === "staff",
    addPeople: write && opts.addPeople === true,
    offPlatform: opts.offPlatform ?? NONE,
    reason,
  };
}

/** Teaching team at the stamped school, or a platform admin. */
function isTeam(v: MessageAccessFacts["viewer"]): boolean {
  return v.role === "platform_admin" || (v.role === "staff" && v.teachingTeamAtStamp);
}

export function decideMessageAccess(f: MessageAccessFacts): MessageAccessDecision {
  const v = f.viewer;
  if (v.suspendedOut) return deny("viewer's school is suspended (sign-in refused)");

  if (f.kind === "family") {
    if (v.role === "scholar") return deny("scholars never see family threads");
    // A guardian's own conversation stays theirs even when the school is
    // suspended or the scholar has moved (OPEN — see the spec's discrepancy
    // list; the decisions are silent, this is the code's behavior).
    if (v.isGuardianParticipant) {
      return grant(f, "guardian participant", {
        write: true,
        side: "guardian",
        offPlatform: { email: true, sms: true, whatsapp: true },
      });
    }
    if (!f.thread.stampLive) return deny("family thread at a suspended school");
    // A family thread follows the scholar: once they have moved, no school's
    // staff reach it (OPEN — see the spec's discrepancy list).
    if (f.thread.transferred) return deny("family thread of a transferred scholar");
    const ops =
      v.role === "platform_admin" ||
      (v.role === "staff" && (v.teachingTeamAtStamp || v.schoolOpsGrantAtStamp));
    return ops
      ? grant(f, "live school:operations at the school", { write: true, side: "staff" })
      : deny("no school:operations at the thread's school");
  }

  // mentor / workshop
  if (!f.thread.stampLive) return deny("scholar thread at a suspended school");
  if (v.role === "guardian") return deny("guardians never see scholar threads");

  if (f.thread.transferred) {
    if (v.role === "scholar") return deny("history from a school the scholar left");
    return isTeam(v)
      ? grant(f, "teaching team at the stamped school: read-only history", {
          write: false,
          side: "staff",
        })
      : deny("history: teaching team at the stamped school only");
  }

  if (v.role === "scholar") {
    return v.isThreadScholar
      ? grant(f, "the thread's own scholar", { write: true, side: "scholar" })
      : deny("another scholar's thread");
  }
  if (isTeam(v)) {
    return grant(f, "teaching team / platform admin (open door)", {
      write: true,
      side: "staff",
      addPeople: f.kind === "mentor",
      offPlatform: { ...NONE, email: v.namedOnThread && f.kind === "mentor" },
    });
  }
  if (f.kind === "mentor" && v.mentorCoversScholar && v.namedOnThread) {
    return grant(f, "named mentor with a covering grant", {
      write: true,
      side: "staff",
      addPeople: true,
      offPlatform: { ...NONE, email: true },
    });
  }
  if (f.kind === "mentor" && v.mentorCoversScholar) {
    return deny("covering mentor, but not named on this thread");
  }
  return deny("no standing on this scholar thread");
}

/** Own-message edit/withdraw: the thread decision, the window, and the idea rule. */
export function mayEditMessage(
  decision: MessageAccessDecision,
  message: { ownMessage: boolean; withinWindow: boolean; isIdeaOpening: boolean },
): boolean {
  return (
    decision.editOwn &&
    message.ownMessage &&
    message.withinWindow &&
    !message.isIdeaOpening
  );
}

// ── Opening a conversation ──────────────────────────────────────────────

export type MessageOpenFacts = {
  kind: "mentor" | "workshop";
  /** The scholar's current school is live. */
  scholarSchoolLive: boolean;
  viewer: {
    role: MessageViewerRole;
    suspendedOut: boolean;
    impersonating: boolean;
    /** Teacher or school_admin membership at the scholar's CURRENT school. */
    teachingTeamAtScholarSchool: boolean;
    mentorCoversScholar: boolean;
  };
};

/** May the viewer open a NEW conversation of `kind` with this scholar? */
export function decideOpen(f: MessageOpenFacts): { open: boolean; reason: string } {
  const v = f.viewer;
  if (v.suspendedOut) return { open: false, reason: "viewer suspended" };
  if (v.impersonating) return { open: false, reason: "impersonation is read-only" };
  if (!f.scholarSchoolLive) return { open: false, reason: "scholar's school suspended" };
  if (v.role === "scholar") return { open: false, reason: "scholars never open threads" };
  if (v.role === "guardian") {
    return { open: false, reason: "guardians never open scholar threads" };
  }
  const team =
    v.role === "platform_admin" || (v.role === "staff" && v.teachingTeamAtScholarSchool);
  if (team) return { open: true, reason: "teaching team / platform admin" };
  if (f.kind === "mentor" && v.mentorCoversScholar) {
    return { open: true, reason: "mentor grant covers the scholar" };
  }
  return { open: false, reason: "no standing with this scholar" };
}

/**
 * May `candidate` be NAMED on a mentor thread with this scholar (compose's
 * "Include staff", "Add people")? The teaching team at the scholar's school or
 * a mentor whose grant covers them — never a scholar, a guardian, a system
 * account, ops-only staff, or a platform admin with no membership there.
 */
export function decideIncludable(candidate: {
  role: MessageViewerRole;
  isSystem: boolean;
  teachingTeamAtScholarSchool: boolean;
  mentorCoversScholar: boolean;
}): boolean {
  if (candidate.isSystem) return false;
  if (candidate.role === "scholar" || candidate.role === "guardian") return false;
  return candidate.teachingTeamAtScholarSchool || candidate.mentorCoversScholar;
}
