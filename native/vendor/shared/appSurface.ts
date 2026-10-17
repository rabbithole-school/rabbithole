// One app surface (TRA-519). The single derivation of how a session relates to
// an app, shared by the Convex stream (prompt assembly, tool offering, runtime
// gates), the web client, and the native client (vendored — see
// native/scripts/sync-vendor.js), so the three can never disagree.
//
// Vocabulary:
//   • An APP ACTIVITY is an online activity whose work is building or using an
//     app. It is stored as { kind: "online", appActivity: true }; rows written
//     before the fold still carry the legacy kind "vibecode" and read the same.
//   • BUILDER-PRIMARY: the session's primary view is the full-screen builder
//     (sessionMode "vibecode": app activities, activity-less builder sessions,
//     free play). Every other session is chat-primary and opens the builder on
//     demand for its app.
//   • ROLE: "work" when the app IS the work (an app activity, an app
//     deliverable, or no other deliverable to do); "side" when the activity has
//     other work (a written deliverable, slides, a map, a discussion rubric) and
//     the app is a side project.
//   • BUILDER FEATURES (History, render check, the big build budget, app
//     pictures, app actions, prior work) follow any session that has an app.
//   • BUILDER STANCE (the "scholar directs, AI builds" lead-in, the designer
//     thread, Edit/Play, contract steering) is only for role "work"; a side app
//     keeps the tutor's stance and its focus on the activity's work.

export type AppRole = "work" | "side";

/** The activity fields this module reads. Structural so server rows, client
 * projections and test fixtures all fit. */
export type AppActivityShape = {
  kind: string;
  appActivity?: boolean | null;
  deliverable?: { kind?: string | null } | null;
  advanceRubric?: unknown;
};

/** An app activity, in either the folded or the legacy shape. Behavior that
 * cares whether an activity is an app reads this, never `kind` directly. */
export function isAppActivity(
  a: Pick<AppActivityShape, "kind" | "appActivity"> | null | undefined,
): boolean {
  if (!a) return false;
  return a.kind === "vibecode" || (a.kind === "online" && a.appActivity === true);
}

/**
 * The kind behavior keys on: "vibecode" for any app activity (both shapes),
 * otherwise the stored kind. Keeping the legacy token as the effective kind
 * keeps every existing `kind === "online"` gate meaning exactly what it meant
 * before the fold, and lets projections hand older clients the kind they
 * already route on.
 */
export function effectiveActivityKind<K extends string>(a: {
  kind: K;
  appActivity?: boolean | null;
}): K | "vibecode" {
  return isAppActivity(a) ? "vibecode" : a.kind;
}

/** Whether the app is the session's work or a side project. Depends only on
 * the activity, so it can be computed without reading artifacts. */
export function appRoleFor(activity: AppActivityShape | null | undefined): AppRole {
  if (!activity) return "work";
  if (isAppActivity(activity)) return "work";
  if (activity.deliverable?.kind === "artifact") return "work";
  if (activity.deliverable || activity.advanceRubric) return "side";
  return "work";
}

export type SessionAppContext = {
  /** sessionMode "vibecode": the builder is the primary view. */
  builderPrimary: boolean;
  /** The session has at least one code artifact. */
  hasApp: boolean;
  role: AppRole;
  /** History, render check, big budget, app pictures, app actions, prior work. */
  builderFeatures: boolean;
  /** APP BUILDER MODE lead-in, designer thread, Edit/Play, contract steering. */
  builderStance: boolean;
};

export function sessionAppContextFor(args: {
  sessionMode?: string | null;
  role: AppRole;
  hasApp: boolean;
}): SessionAppContext {
  const builderPrimary = args.sessionMode === "vibecode";
  const builderFeatures = args.hasApp || builderPrimary;
  return {
    builderPrimary,
    hasApp: args.hasApp,
    role: args.role,
    builderFeatures,
    builderStance: builderFeatures && args.role === "work",
  };
}

// ── Copy shared by web and native (byte-identical by construction) ──────────

export const APP_SURFACE_COPY = {
  open: "Open",
  backToChat: "Back to chat",
  yourWork: "Your work",
  version: (n: number) => `Version ${n}`,
  // Present mode: the live app alone on the screen, so a scholar can show it
  // to the class (on the iPad, through Screen Mirroring to the classroom TV).
  present: "Present",
  presentAccessibility: "Present this app full screen",
  stopPresenting: "Done",
} as const;

/** What the scholar's own work is called, by deliverable kind. */
export const YOUR_WORK_LABEL: Record<string, string> = {
  text: "Your writing",
  slides: "Your slides",
  map: "Your map",
  photo: "Your photo",
  audio: "Your recording",
  artifact: "Your app",
};

export type DeliverableStatus = "not started" | "in progress" | "done";

export function deliverableStatusFor(args: {
  completed: boolean;
  hasWork: boolean;
}): DeliverableStatus {
  if (args.completed) return "done";
  return args.hasWork ? "in progress" : "not started";
}
