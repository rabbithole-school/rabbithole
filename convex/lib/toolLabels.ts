import { isFailureResult, type ToolGroup } from "./toolActivityGroups";

// Curated labels allowed on scholar surfaces. Keep these concrete and
// kid-facing: unknown tools are hidden rather than humanized from an internal id.
export const SCHOLAR_TOOL_LABELS = {
  edit_document: "Working on the document",
  create_code: "Writing some code",
  generate_image: "Making a picture",
  search_image: "Finding a picture",
  charm_icon: "Making an icon",
  charm_model: "Building a 3D model",
  show_map: "Making a map",
  update_dossier: "Updating your profile",
  update_process_step: "Updating your progress",
  update_rubric_score: "Checking your work",
  mark_activity_complete: "Marking activity complete",
  start_teach_back: "Let's have you teach me",
  finish_teach_back: "Thanks for teaching me",
  share_resource: "Sharing a resource",
  run_app_action: "Setting up the app",
  open_python_bench: "Opening the Python bench",
  // The tutor's proposal card (lib/questProposalCard.ts, TRA-690).
  offer_quest_proposal: "Writing up your proposal",
  // App designer parking lot (lib/designerTools.ts). stay_silent has no label
  // on purpose: the stream never announces it (http.ts skips its toolStart).
  park_idea: "Parking an idea",
  unpark_idea: "Taking an idea off the lot",
  set_provocation: "Saving something to figure out",
  // A world question saved mid-build, and a follow-up saved in the kid's own
  // Quest (TRA-682). Both land on the kid's Quests tab.
  save_question: "Saving a question",
  save_follow_up: "Saving a follow-up",
  // Code Explorer (/meta-stream + /parent-chat-stream)
  list_rabbithole_files: "Looking through Rabbithole's code",
  read_rabbithole_file: "Reading Rabbithole's code",
  search_rabbithole_code: "Searching Rabbithole's code",
} as const satisfies Record<string, string>;

const STAFF_TOOL_LABELS: Record<string, string> = {
  // Curriculum / aide read tools
  list_scholars: "Looking up scholars",
  get_scholar_dossier: "Reading scholar profile",
  get_scholar_interests: "Reading scholar interests",
  get_scholar_documents: "Reading scholar documents",
  get_mastery_data: "Fetching mastery data",
  get_scholar_mastery: "Fetching mastery data",
  get_session_signals: "Reading session signals",
  get_scholar_signals: "Reading session signals",
  get_seeds: "Loading exploration seeds",
  get_mentava_progress: "Reading Mentava progress",
  link_mentava_student: "Linking a Mentava student",
  read_drive_link: "Reading a Google Drive file",
  search_drive: "Searching Google Drive",
  get_scholar_seeds: "Loading exploration seeds",
  get_observations: "Reading observations",
  get_scholar_observations: "Reading observations",
  get_scholar_sessions: "Reading recent sessions",
  get_session_transcript: "Reading session transcript",
  get_scholar_web_activity: "Reading external practice activity",
  get_scholar_practice: "Reading practice progress",
  get_scholar_math_checkin: "Reading the math check-in",
  get_scholar_math_plan: "Reading the Math plan",
  set_scholar_math_plan: "Updating the Math plan",
  offer_code_it_quest: "Offering a Code it Quest",
  get_attendance: "Reading attendance",
  set_attendance: "Updating attendance",
  list_units: "Loading units",
  get_unit_details: "Reading unit details",
  list_geomap_assets: "Checking the map shelf",
  move_lesson: "Moving lesson",
  // Managed-iPad operations (lib/deviceOpsTools.ts)
  list_managed_devices: "Checking iPads",
  restart_managed_device: "Restarting an iPad",
  reassign_managed_device: "Reassigning an iPad",
  set_freeze_mode: "Updating Freeze Mode",
  play_find_sound: "Sending a find sound",
  // Parent aide BunnyPad freeze (lib/parentAideTurn.ts)
  get_bunnypad_freeze_status: "Checking BunnyPad freeze",
  set_bunnypad_freeze: "Updating BunnyPad freeze",
  schedule_bunnypad_freeze: "Planning a BunnyPad freeze",
  cancel_planned_bunnypad_freeze: "Removing a planned BunnyPad freeze",
  find_bunnypad: "Sending a find sound",
  get_bunnypad_bedtime: "Checking BunnyPad bedtime",
  set_bunnypad_bedtime: "Updating BunnyPad bedtime",
  // Assignment / scheduling tools
  list_assignments: "Loading assignments",
  get_assignment: "Reading assignment",
  get_schedule: "Reading schedule",
  give: "Giving work to scholars",
  reschedule_activity: "Rescheduling activity",
  clear_activity: "Clearing activity",
  set_assignment_scholars: "Updating roster",
  add_assignment_scholars: "Adding scholars",
  remove_assignment_scholars: "Removing scholars",
  // Scholar account admin (lib/scholarWriteTools.ts)
  create_scholar_account: "Creating a scholar account",
  update_group_membership: "Updating a group",
  move_scholar_to_institution: "Moving a scholar to another school",
  set_badge: "Setting badge",
  set_activity_angle: "Setting activity angle",
  link_channel_to_group: "Linking channel",
  set_group_notify_mode: "Updating notifications",
  // External-Apps tools (add/configure launchable apps + grant/revoke access)
  list_external_apps: "Listing external apps",
  get_external_app_access: "Reading app access",
  get_audit_log: "Reading the audit log",
  get_platform_health: "Checking scheduled job health",
  find_staff_account: "Looking up a staff account",
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
  set_external_app_login: "Saving app login",
  // Unit designer tools
  read_unit_structure: "Reading unit structure",
  update_unit: "Updating unit",
  update_unit_metadata: "Updating unit details",
  create_lesson: "Creating lesson",
  update_lesson: "Updating lesson",
  delete_lesson: "Deleting lesson",
  generate_lesson_prompt: "Generating lesson prompt",
  generate_all_prompts: "Checking lessons for prompts",
  record_unit_review: "Saving unit review",
  archive_activity: "Archiving activity",
  reorder_activities: "Reordering activities",
  generate_activity_prompt: "Generating activity prompt",
  create_slides_deck: "Creating Rabbit Slides deck",
  read_deck: "Reading slide deck",
  apply_deck_edits: "Editing Rabbit Slides deck",
  edit_google_deck: "Editing Google Slides deck",
  // Curriculum building (lib/aideTools.ts, lib/activityKindTools.ts)
  create_unit: "Creating unit",
  create_scholar_quest: "Creating quest",
  delete_empty_unit: "Deleting empty unit",
  archive_unit: "Archiving or restoring unit",
  create_scholar_seed: "Creating exploration seed",
  upsert_teacher_directive: "Saving teacher directive",
  rehearse_activity: "Rehearsing activity",
  debrief_activity: "Debriefing activity",
  parent_view_link: "Linking parent view",
  offer_scholar_quest: "Offering quest",
  retract_scholar_quest: "Retracting quest",
  reopen_scholar_quest: "Reopening quest",
  award_quest_badge: "Awarding quest badge",
  tag_session: "Tagging session",
  set_aide_model: "Changing the AI model",
  send_slack_dm: "Sending Slack message",
  whisper_to_session: "Whispering to the session",
  list_activity_kind_catalog: "Checking activity catalog",
  create_game_activity: "Creating game activity",
  create_web_activity: "Creating web activity",
  create_share_back_activity: "Creating Share Back activity",
  create_problem_set: "Creating problem set",
  list_simulator_templates: "Loading simulator templates",
  create_simulator_activity: "Creating simulator activity",
  update_simulator: "Updating simulator",
  update_simulator_spec: "Updating simulator spec",
  // Assignments (lib/assignmentTools.ts)
  assign_unit: "Assigning unit",
  publish_unit: "Setting unit visibility",
  archive_assignment: "Archiving assignment",
  get_assignment_progress: "Checking assignment progress",
  get_granule_coverage: "Reading understanding coverage",
  add_activity_resource: "Adding activity resource",
  // Planning a unit across a class's days (convex/lib/classPlanTools.ts)
  get_class_days: "Reading the class's upcoming days",
  give_class_days: "Planning work across class days",
  move_class_days: "Moving planned work",
  // Master schedule (lib/masterScheduleTools.ts)
  list_terms: "Loading terms",
  get_master_schedule: "Reading the master schedule",
  create_schedule_block: "Adding schedule block",
  update_schedule_block: "Updating schedule block",
  remove_schedule_block: "Removing schedule block",
  place_class: "Placing class",
  move_class: "Moving class",
  shift_class: "Shifting class",
  update_class: "Updating class",
  remove_class: "Removing class",
  reassign_teacher: "Reassigning a teacher's classes",
  dispatch_activity: "Assigning work to a scholar",
  mark_class_activity_done: "Marking class activity done",
  dismiss_flag: "Dismissing schedule flag",
  // Scholar records (lib/scholarReadTools.ts, lib/scholarWriteTools.ts)
  add_scholar_observation: "Recording observation",
  set_scholar_goal: "Setting goal",
  record_goal_checkin: "Logging goal progress",
  get_scholar_report: "Reading course report",
  write_report: "Writing report",
  add_scholar_report: "Adding teacher report",
  update_scholar_dossier: "Updating scholar profile",
  update_scholar_profile: "Updating scholar account",
  set_scholar_reading_level: "Setting reading level",
  grant_calculator_license: "Granting Calculator License",
  revoke_calculator_license: "Revoking Calculator License",
  reset_scholar_password: "Resetting scholar PIN",
  reset_scholar_passkeys: "Resetting scholar passkeys",
  delete_scholar: "Deleting scholar",
  upload_scholar_document: "Uploading scholar document",
  add_portfolio_item: "Adding to portfolio",
  get_scholar_work_samples: "Reading work samples",
  get_school_calendar: "Reading the school calendar",
  list_scholar_groups: "Loading scholar groups",
  get_scholar_skill_tree: "Reading skill tree",
  get_scholar_spelling_evidence: "Reading spelling evidence",
  get_scholar_screen_time: "Reading screen time",
  get_scholar_emergency_info: "Reading emergency info",
  get_form_responses: "Checking form responses",
  // Practice item pool (lib/practicePoolTools.ts)
  list_practice_nodes: "Surveying practice items",
  get_practice_item_pool: "Reading practice items",
  create_practice_item: "Writing practice item",
  update_practice_item: "Updating practice item",
  delete_practice_item: "Deleting practice item",
  generate_practice_items: "Generating practice items",
  // Custom apps (lib/customAppTools.ts)
  create_custom_app: "Building custom app",
  update_custom_app: "Updating custom app",
  install_external_app: "Installing app",
  fork_activity: "Copying activity",
  make_app_a_coached_activity: "Setting up coached app activity",
  dispatch_custom_app: "Sending app to Copilot",
  // Devices (lib/deviceOpsTools.ts, lib/slackTools.ts)
  list_rabbithole_lock_devices: "Checking Rabbithole Lock",
  set_rabbithole_lock: "Updating Rabbithole Lock",
  get_device_battery_levels: "Checking iPad batteries",
  find_robotics_capture_target: "Finding capture station",
  set_robotics_capture_mode: "Updating capture mode",
  // School rooms and equipment (lib/physicalEnvTools.ts)
  list_school_equipment: "Checking school equipment",
  add_school_equipment: "Adding equipment",
  update_school_equipment: "Updating equipment",
  remove_school_equipment: "Removing equipment",
  add_school_room: "Adding room",
  // The Workshop (lib/suggestionTools.ts)
  list_scholar_suggestions: "Reading Workshop ideas",
  respond_to_suggestion: "Replying to a Workshop idea",
  start_workshop_thread: "Starting a Workshop thread",
  create_whats_new_entry: "Writing a What's new entry",
  // Code and dispatch (lib/introspectionTools.ts)
  search_code: "Searching the code",
  read_repo_file: "Reading a repo file",
  read_system_doc: "Reading a system doc",
  recent_changes: "Checking recent changes",
  dispatch_feature_proposal: "Dispatching feature proposal",
  dispatch_implementation: "Dispatching implementation",
  relay_to_agent: "Relaying to the coding agent",
  close_pull_request: "Closing pull request",
  check_dispatch_status: "Checking dispatch status",
  continue_blocked_dispatch: "Resuming a paused coding task",
  read_proposal: "Reading proposal",
  // Slack (slackBot.ts, lib/slackTools.ts)
  read_slack_link: "Reading a Slack link",
  read_slack_list: "Reading Slack list",
  add_slack_list_item: "Adding Slack list row",
  update_slack_list_item: "Updating Slack list row",
  delete_slack_list_item: "Deleting Slack list row",
  link_alerts_channel: "Linking alerts channel",
  link_bug_report_channel: "Linking bug report channel",
  link_social_channel: "Linking Marketing Studio channel",
  link_parent_message_channel: "Linking parent message channel",
  link_admissions_channel: "Linking admissions channel",
  link_finance_channel: "Linking finance channel",
  issue_parent_enroll_link: "Making parent sign-in link",
  // Google Docs (lib/googleDocsTools.ts)
  create_shared_doc: "Creating Google Doc",
  // Admissions (lib/admissionsTools.ts, lib/admissionsWriteTools.ts)
  find_candidate_or_family: "Looking up candidates",
  get_candidate_status: "Reading candidate status",
  list_needs_attention: "Checking who needs a reply",
  list_candidates: "Loading candidates",
  pipeline_status_update: "Reviewing the admissions pipeline",
  add_candidate: "Adding candidate",
  add_note: "Adding candidate note",
  set_candidate_status: "Updating candidate status",
  set_checklist_item: "Updating checklist",
  set_source: "Setting lead source",
  draft_gmail_reply: "Drafting Gmail reply",
  record_decision: "Recording admissions decision",
  set_red_flag: "Updating red flag",
  set_candidate_notes: "Updating candidate notes",
  // Finance (lib/financeTools.ts)
  get_cash_position: "Checking cash position",
  list_tuition_receivables: "Checking tuition owed",
  get_books_summary: "Reading QuickBooks summary",
  list_fees_and_deposits: "Reading Stripe payments",
  trace_family_payment: "Tracing family payment",
  list_bank_transactions: "Reading Mercury transactions",
  list_books_transactions: "Reading QuickBooks transactions",
  get_books_entry: "Reading a QuickBooks entry",
  // Finance writes (lib/financeWriteTools.ts): each only plans an entry and posts its card.
  record_deposit: "Drafting a QuickBooks deposit",
  record_received_payment: "Drafting a QuickBooks payment",
  record_expenditure: "Drafting a QuickBooks expenditure",
  record_journal_entry: "Drafting a QuickBooks journal entry",
  // Google Sheets, as the asker (lib/sheetsTools.ts)
  read_sheet: "Reading a Google Sheet",
  create_sheet: "Making a Google Sheet",
  write_sheet: "Writing to a Google Sheet",
  // Tutor tools (lib/tutorSessionTools.ts and friends). Labeled HERE, not in
  // SCHOLAR_TOOL_LABELS, so scholar surfaces keep hiding them; staff see these
  // when they read a session or build with the tutor.
  check_work: "Checking content",
  define_character: "Setting up a character",
  define_judge: "Setting up a judge",
  direct_character: "Directing the character",
  speak_as_character: "Speaking as the character",
  edit_slides: "Arranging slides",
  set_quest_mission: "Saving quest mission",
  show_manipulative: "Showing a hands-on model",
  suggest_physical_task: "Suggesting a hands-on task",
  update_world: "Updating the simulator",
  view_workbench: "Reading the simulator",
  offer_instruction: "Offering a short lesson",
  serve_practice_problem: "Serving a practice problem",
  serve_story_application_problem: "Serving a story problem",
  send_idea_to_teacher: "Sending idea to teachers",
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
  check_social_posts: "Checking social posts",
  delete_social_draft: "Deleting social draft",
  inspect_email_campaign: "Reading email campaign",
  read_campaign_brief: "Reading campaign brief",
  revise_website_pr: "Revising website PR",
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
  /** a partly-failed group counts only the calls that landed, for a tool where
   *  "Sent 3 (1 of 3 failed)" would overstate what left the building */
  countLandedOnly?: boolean;
}

const GROUP_LABELS: Record<string, ToolLabel> = {
  create_lesson: { gerund: "Creating", past: "Created", one: "lesson", many: "lessons" },
  update_lesson: { gerund: "Updating", past: "Updated", one: "lesson", many: "lessons" },
  delete_lesson: { gerund: "Deleting", past: "Deleted", one: "lesson", many: "lessons" },
  create_activity: { gerund: "Adding", past: "Added", one: "activity", many: "activities" },
  update_activity: { gerund: "Updating", past: "Updated", one: "activity", many: "activities" },
  // The aide's build chain (lib/aideTools.ts) fires these in bulk too.
  create_scholar_lesson: { gerund: "Creating", past: "Created", one: "lesson", many: "lessons" },
  create_scholar_activity: { gerund: "Adding", past: "Added", one: "activity", many: "activities" },
  delete_activity: { gerund: "Deleting", past: "Deleted", one: "activity", many: "activities" },
  generate_lesson_prompt: { gerund: "Generating", past: "Generated", one: "lesson prompt", many: "lesson prompts" },
  generate_image: { gerund: "Generating", past: "Generated", one: "image", many: "images" },
  search_image: { gerund: "Finding", past: "Found", one: "image", many: "images" },
  show_map: { gerund: "Making", past: "Made", one: "map", many: "maps" },
  edit_document: { gerund: "Editing", past: "Edited", one: "document", many: "documents" },
  // Marketing studio: these fire in bulk (one per event / per network).
  create_event_draft: { gerund: "Creating", past: "Created", one: "Eventbrite draft", many: "Eventbrite drafts" },
  // "Sent", never "Posted": this result is Postiz accepting a post or draft, not
  // the post going live, and only check_social_posts can say it did.
  generate_illustration: { gerund: "Generating", past: "Generated", one: "illustration", many: "illustrations" },
  post_to_social: { gerund: "Sending", past: "Sent", one: "social post to Postiz", many: "social posts to Postiz", countLandedOnly: true },
};

/** `create_scholar_activity` → "Create scholar activity". The sentence-case
 *  reading of a raw tool id, for a tool with no curated label (and for the MCP
 *  consent list, which names every tool by id). UI copy is sentence case. */
export function humanizeToolId(name: string): string {
  const words = name.replace(/_/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function friendlyToolName(name: string): string {
  if (hasScholarToolLabel(name)) return SCHOLAR_TOOL_LABELS[name];
  if (STAFF_TOOL_LABELS[name]) return STAFF_TOOL_LABELS[name];
  const g = GROUP_LABELS[name];
  if (g) return `${g.gerund} ${g.one}`;
  return humanizeToolId(name);
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

/** What one coalesced group of tool calls shows, on every surface. The in-app
 *  tool rows (`ToolActivityIndicator`) and Slack's task cards
 *  (`buildToolTasks`) render this same state, label and detail, each in its
 *  own look, so the two can't drift apart. */
export interface ToolGroupStatus {
  /** `running`: a call is still in flight. `done`: every call landed.
   *  `failed`: at least one call failed, was refused, or never reported. */
  state: "running" | "done" | "failed";
  /** One line. A failed group's label ends with the first failure's short
   *  reason ("Dispatching implementation — daily dispatch cap reached"), so
   *  the reason is visible without opening Slack's card or the in-app row. */
  label: string;
  /** The first failure's full reason, without its Failed:/Error:/Refused:
   *  prefix. Present only when the label had to shorten or clean it: Slack
   *  shows it in the card's collapsed details, the in-app row opens to it. */
  detail?: string;
}

export function toolGroupStatus(group: ToolGroup): ToolGroupStatus {
  if (group.status === "running") {
    return { state: "running", label: groupLabel(group).running };
  }
  const outcome = completedGroupOutcome(group);
  if (outcome.failing === 0) return { state: "done", label: outcome.done };
  // NOTHING succeeded: `outcome.done` is the tool NAME, never a past-tense
  // label that would assert work that did not happen. On a partial failure the
  // counted done label is still true of the calls that landed, so keep it and
  // say how many didn't.
  const what = outcome.allFailed
    ? outcome.done
    : `${outcome.done} (${outcome.failing} of ${outcome.total} failed)`;
  const full = outcome.failureDetail ?? "";
  const reason = shortFailureReason(full);
  return {
    state: "failed",
    label: reason ? `${what} — ${reason}` : what,
    ...(full && full !== reason ? { detail: full } : {}),
  };
}

/** Longest reason a failed row's label carries. It keeps every literal error
 *  message thrown under convex/ whole (the longest was 89 characters on
 *  2026-11-10) and leaves room under Slack's 256-character task title. */
const SHORT_REASON_MAX = 120;

/** A run of 16+ id-ish characters holding both a letter and a digit: a Convex
 *  document id, a request id, a UUID, an API key or token. No English word
 *  looks like that. */
const OPAQUE_TOKEN = /(?<![\w-])(?=[\w-]*\d)(?=[\w-]*[a-z])[\w-]{16,}/gi;

/** A failure result as a short reason that is safe to show staff in a row's
 *  title: the Failed:/Error:/Refused: prefix stripped, a Convex server error
 *  ("[CONVEX M(…)] [Request ID: …] Server Error\nUncaught Error: <message>\n
 *  at …") unwrapped to its message, only the first line (no stack trace), ids
 *  and tokens replaced with "…", cut at a word past SHORT_REASON_MAX. Empty
 *  when nothing readable is left. */
export function shortFailureReason(result: string): string {
  const reason = stripFailurePrefix(result)
    .replace(/^[\s\S]*Uncaught \w*Error:\s*/, "")
    .replace(/\[(?:CONVEX [^\]]*|Request ID:[^\]]*)\]/g, "")
    .trim()
    .split("\n")[0]
    .replace(OPAQUE_TOKEN, "…")
    .replace(/\s+/g, " ")
    .trim();
  if (reason.length <= SHORT_REASON_MAX) return reason;
  const cut = reason.slice(0, SHORT_REASON_MAX);
  const space = cut.lastIndexOf(" ");
  return `${(space > SHORT_REASON_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** A thrown error as the sentence a tool hands back to the model, which may
 *  repeat it to staff: a Convex server error's request id, "Uncaught Error:"
 *  wrapper and stack lines removed, nothing truncated. */
export function toolErrorText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e))
    .replace(/^[\s\S]*Uncaught \w*Error:\s*/, "")
    .split("\n")[0]
    .trim();
}

/** Strip a `Failed:` / `Error:` / `Refused:` prefix off a failure result,
 *  leaving the terse human reason for a failure line. Pure; exported so callers
 *  (the Slack block, the web indicator) and tests share one prefix rule. */
export function stripFailurePrefix(result: string): string {
  return result.replace(/^\s*(failed|error|refused)\s*:\s*/i, "").trim();
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
 *  when n > 1. A partly-failed `countLandedOnly` group counts only the calls
 *  that landed. */
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
    : groupLabel(
        GROUP_LABELS[group.name]?.countLandedOnly
          ? {
              ...group,
              items: group.items.filter((it) => !isFailureResult(it.result)),
            }
          : group,
      ).done;
  const failureDetail =
    failing > 0 ? stripFailurePrefix(failingItems[0].result ?? "") : null;
  return { failing, total, allFailed, done, failureDetail };
}
