export const GOOGLE_DRIVE_COMMENT_CREATED_EVENT =
  "google.workspace.drive.comment.v3.created";
export const GOOGLE_DRIVE_REPLY_CREATED_EVENT =
  "google.workspace.drive.reply.v3.created";
export const GOOGLE_DOCS_EVENT_TYPES = [
  GOOGLE_DRIVE_COMMENT_CREATED_EVENT,
  GOOGLE_DRIVE_REPLY_CREATED_EVENT,
] as const;

export const GOOGLE_DOCS_SUBSCRIPTION_RENEWAL_WINDOW_MS = 30 * 60 * 1000;
export const GOOGLE_DOCS_SUBSCRIPTION_MAX_FAILURES = 5;
