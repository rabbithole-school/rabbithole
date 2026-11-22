/**
 * The scholar's "write to a teacher" compose, worded once for web
 * (components/messaging/WriteToTeacherDialog.tsx) and the BunnyPad
 * (native/src/components/messages/WriteToTeacherSheet.tsx). The server half
 * is `scholarMessages.startConversationWithTeacher`.
 *
 * Pure. Shared by web and native (native reads it via native/vendor: re-run
 * `npm run sync:vendor` in native/ after editing).
 */

export const WRITE_TO_TEACHER_COPY = {
  /** The Messages header button and the dialog title. */
  button: "New message",
  title: "Write to a teacher",
  toLabel: "To",
  messageLabel: "Message",
  placeholder: "Write your message…",
  /** Under the message box: the open door, said plainly. */
  note: "Your teachers can read this conversation.",
  noTeachers: "No teachers to message right now.",
  send: "Send",
  cancel: "Cancel",
  chooseFirst: "Choose a teacher first.",
  writeFirst: "Write a message first.",
  failed: "Couldn't send this message.",
} as const;
