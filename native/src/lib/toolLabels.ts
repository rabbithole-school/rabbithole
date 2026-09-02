/**
 * Kid-facing labels for the tools the native chats surface in their live
 * "activity" row (see `components/ChatActivityRow.tsx`) — so a running tool
 * reads like "Reading Rabbithole's code…", never a raw id like
 * "read rabbithole file".
 *
 * MIRRORS the web/backend source of truth in `convex/lib/toolLabels.ts`
 * (`SCHOLAR_TOOL_LABELS`). It's kept native-local — rather than imported — because
 * the native bundle must not import across the project root: Metro would then
 * crawl outside it and Release builds break (the same reason the Convex API and
 * brand tokens are vendored; see `native/metro.config.js`). Keep the entries
 * here in sync with the shared map by hand.
 */

export const SCHOLAR_TOOL_LABELS: Readonly<Record<string, string>> = {
  // Workshop Code Explorer (/meta-stream)
  list_rabbithole_files: "Looking through Rabbithole's code",
  read_rabbithole_file: "Reading Rabbithole's code",
  search_rabbithole_code: "Searching Rabbithole's code",
  // Scholar tutor tools (/project-stream). `generate_image` is intentionally
  // absent — image generation has its own dedicated activity state.
  create_code: "Writing some code",
  edit_document: "Working on the document",
  update_rubric_score: "Checking your work",
  mark_activity_complete: "Marking activity complete",
  update_process_step: "Updating your progress",
  update_dossier: "Updating your profile",
  start_teach_back: "Let's have you teach me",
  finish_teach_back: "Thanks for teaching me",
  share_resource: "Sharing a resource",
  run_app_action: "Setting up the app",
};

/** A tool id → its kid-facing gerund label. Unknown ids get neutral copy rather
 * than exposing a newly-added internal identifier before it is curated. */
export function friendlyToolName(name: string): string {
  return SCHOLAR_TOOL_LABELS[name] ?? "Working";
}
