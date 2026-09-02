import { isFailureResult, type ToolGroup } from "./toolActivityGroups";

// Curated labels allowed on scholar surfaces. Keep these concrete and
// kid-facing: unknown tools are hidden rather than humanized from an internal id.
export const SCHOLAR_TOOL_LABELS = {
  edit_document: "Working on the document",
  create_code: "Writing some code",
  generate_image: "Making a picture",
  search_image: "Finding a picture",
  show_map: "Making a map",
  update_dossier: "Updating your profile",
  update_process_step: "Updating your progress",
  update_rubric_score: "Checking your work",
  mark_activity_complete: "Marking activity complete",
  start_teach_back: "Let's have you teach me",
  finish_teach_back: "Thanks for teaching me",
  share_resource: "Sharing a resource",
  run_app_action: "Setting up the app",
  // Workshop Code Explorer (/meta-stream)
  list_rabbithole_files: "Looking through Rabbithole's code",
  read_rabbithole_file: "Reading Rabbithole's code",
  search_rabbithole_code: "Searching Rabbithole's code",
} as const satisfies Record<string, string>;

const STAFF_TOOL_LABELS: Record<string, string> = {
  // Curriculum / aide read tools
  list_scholars: "Looking up scholars",
  get_scholar_dossier: "Reading scholar profile",
  get_scholar_documents: "Reading scholar documents",
  get_mastery_data: "Fetching mastery data",
  get_scholar_mastery: "Fetching mastery data",
  get_session_signals: "Reading session signals",
  get_scholar_signals: "Reading session signals",
  get_seeds: "Loading exploration seeds",
  get_scholar_seeds: "Loading exploration seeds",
  get_observations: "Reading observations",
  get_scholar_observations: "Reading observations",
  get_scholar_sessions: "Reading recent sessions",
  get_session_transcript: "Reading session transcript",
  get_scholar_web_activity: "Reading external practice activity",
  get_scholar_practice: "Reading practice progress",
  get_scholar_math_checkin: "Reading the math check-in",
  get_attendance: "Reading attendance",
  set_attendance: "Updating attendance",
  list_units: "Loading units",
  get_unit_details: "Reading unit details",
  list_geomap_assets: "Checking the map shelf",
  move_lesson: "Moving lesson",
  // Assignment / scheduling tools
  list_assignments: "Loading assignments",
  get_assignment: "Reading assignment",
  get_schedule: "Reading schedule",
  schedule_activity: "Scheduling activity",
  reschedule_activity: "Rescheduling activity",
  clear_activity: "Clearing activity",
  push_activity_now: "Pushing activity live",
  assign_activity_now: "Starting activity for scholars",
  set_assignment_scholars: "Updating roster",
  add_assignment_scholars: "Adding scholars",
  set_badge: "Setting badge",
  set_activity_angle: "Setting activity angle",
  link_channel_to_group: "Linking channel",
  set_group_notify_mode: "Updating notifications",
  // External-Apps tools (add/configure launchable apps + grant/revoke access)
  list_external_apps: "Listing external apps",
  get_external_app_access: "Reading app access",
  create_external_app: "Creating external app",
  update_external_app: "Updating external app",
  archive_external_app: "Archiving external app",
  unarchive_external_app: "Restoring external app",
  enable_app_for_group: "Granting app to group",
  disable_app_for_group: "Revoking app from group",
  enable_app_for_institution: "Granting app to school",
  disable_app_for_institution: "Revoking app from school",
  enable_app_for_scholar: "Granting app to scholar",
  disable_app_for_scholar: "Revoking app from scholar",
  // Unit designer tools
  read_unit_structure: "Reading unit structure",
  update_unit: "Updating unit",
  update_unit_metadata: "Updating unit details",
  create_lesson: "Creating lesson",
  update_lesson: "Updating lesson",
  delete_lesson: "Deleting lesson",
  generate_lesson_prompt: "Generating lesson prompt",
  generate_all_prompts: "Checking lessons for prompts",
  // Web tools (Anthropic server tools)
  web_search: "Searching the web",
  web_fetch: "Reading a web page",
  // Marketing studio tools
  draft_blog_post: "Drafting blog post",
  draft_email_campaign: "Drafting email campaign",
  propose_website_change: "Opening website PR",
  check_website_change: "Checking website preview",
  list_events: "Loading Eventbrite events",
  publish_campaign_brief: "Publishing campaign brief",
  list_recent_social_posts: "Reading recent posts",
};

function hasScholarToolLabel(
  name: string,
): name is keyof typeof SCHOLAR_TOOL_LABELS {
  return Object.prototype.hasOwnProperty.call(SCHOLAR_TOOL_LABELS, name);
}

// Count-aware labels for the tools that fire in *bulk* during a build, so a
// coalesced group can read "Adding activities… (7)" / "✓ Added 7 activities".
// Tools NOT listed here are treated as singletons: the running flash uses
// `friendlyToolName`, and a finished group shows the call's own result string.
interface ToolLabel {
  /** present-tense gerund verb: "Adding", "Creating" */
  gerund: string;
  /** past-tense verb: "Added", "Created" */
  past: string;
  /** singular noun: "activity", "lesson" */
  one: string;
  /** plural noun: "activities", "lessons" */
  many: string;
}

const GROUP_LABELS: Record<string, ToolLabel> = {
  create_lesson: { gerund: "Creating", past: "Created", one: "lesson", many: "lessons" },
  update_lesson: { gerund: "Updating", past: "Updated", one: "lesson", many: "lessons" },
  delete_lesson: { gerund: "Deleting", past: "Deleted", one: "lesson", many: "lessons" },
  create_activity: { gerund: "Adding", past: "Added", one: "activity", many: "activities" },
  delete_activity: { gerund: "Deleting", past: "Deleted", one: "activity", many: "activities" },
  generate_lesson_prompt: { gerund: "Generating", past: "Generated", one: "lesson prompt", many: "lesson prompts" },
  generate_image: { gerund: "Generating", past: "Generated", one: "image", many: "images" },
  search_image: { gerund: "Finding", past: "Found", one: "image", many: "images" },
  show_map: { gerund: "Making", past: "Made", one: "map", many: "maps" },
  edit_document: { gerund: "Editing", past: "Edited", one: "document", many: "documents" },
  // Marketing studio: these fire in bulk (one per event / per network).
  create_event_draft: { gerund: "Creating", past: "Created", one: "Eventbrite draft", many: "Eventbrite drafts" },
  post_to_social: { gerund: "Posting", past: "Posted", one: "social post", many: "social posts" },
  generate_brand_image: { gerund: "Generating", past: "Generated", one: "image", many: "images" },
};

export function friendlyToolName(name: string): string {
  if (hasScholarToolLabel(name)) return SCHOLAR_TOOL_LABELS[name];
  if (STAFF_TOOL_LABELS[name]) return STAFF_TOOL_LABELS[name];
  const g = GROUP_LABELS[name];
  if (g) return `${g.gerund} ${g.one}`;
  return name.replace(/_/g, " ");
}

/**
 * Scholar chat shows only curated in-progress activity. A completion result is
 * tool protocol output for the model/staff debugger, not learner-facing copy.
 */
export function isScholarToolActivityVisible(
  group: Pick<ToolGroup, "name" | "status">,
): boolean {
  return group.status === "running" && hasScholarToolLabel(group.name);
}

/**
 * Render a coalesced group as a `{ running, done }` label pair.
 * - running, count 1: "Adding activity…"; count n: "Adding activities… (n)"
 * - done, count 1: prefer the single call's friendly result ("Added \"X\" to
 *   \"Y\""), else "Added activity"; count n: "Added n activities"
 * Unmapped / singleton tools fall back to `friendlyToolName` + the result.
 */
export function groupLabel(group: ToolGroup): { running: string; done: string } {
  const n = group.items.length;
  const firstResult = group.items[0]?.result;
  const rich = GROUP_LABELS[group.name];

  if (rich) {
    const running =
      n === 1
        ? `${rich.gerund} ${rich.one}…`
        : `${rich.gerund} ${rich.many}… (${n})`;
    const done =
      n === 1
        ? (firstResult ?? `${rich.past} ${rich.one}`)
        : `${rich.past} ${n} ${rich.many}`;
    return { running, done };
  }

  const base = friendlyToolName(group.name);
  const running = n === 1 ? `${base}…` : `${base}… (${n})`;
  const done = n === 1 ? (firstResult ?? base) : `${base} (${n})`;
  return { running, done };
}

/** Strip a `Failed:` / `Error:` prefix off a failure result, leaving the terse
 *  human reason for a failure line. Pure; exported so callers (the Slack block,
 *  the web indicator) and tests share one prefix rule. */
export function stripFailurePrefix(result: string): string {
  return result.replace(/^\s*(failed|error)\s*:\s*/i, "").trim();
}

/** How a COMPLETED group's calls turned out, and the label its row should show.
 *  Shared by the Slack context block and the web tool-activity indicator so both
 *  surfaces classify failure identically.
 *
 *  `done` is `groupLabel(group).done` in every case EXCEPT when every call
 *  failed. That label can't be trusted then: for one call it IS the raw failure
 *  string ("Failed: …", with no hint which tool ran), and for many it asserts
 *  work that did not happen ("Created 3 lessons" when all 3 failed). So an
 *  all-failed group uses `friendlyToolName(group.name)` instead, plus ` (n)`
 *  when n > 1. */
export function completedGroupOutcome(group: ToolGroup): {
  /** how many of the group's calls carry a failure result */
  failing: number;
  total: number;
  /** true when NO call in the group succeeded */
  allFailed: boolean;
  /** the row's label (see the note above on why it isn't always groupLabel().done) */
  done: string;
  /** the first failure's reason with its `Failed:`/`Error:` prefix stripped and
   *  trimmed; null when nothing failed. */
  failureDetail: string | null;
} {
  const total = group.items.length;
  const failingItems = group.items.filter((it) => isFailureResult(it.result));
  const failing = failingItems.length;
  const allFailed = failing > 0 && failing === total;
  const done = allFailed
    ? `${friendlyToolName(group.name)}${total > 1 ? ` (${total})` : ""}`
    : groupLabel(group).done;
  const failureDetail =
    failing > 0 ? stripFailurePrefix(failingItems[0].result ?? "") : null;
  return { failing, total, allFailed, done, failureDetail };
}
