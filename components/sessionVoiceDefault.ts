// Decides whether web voice mode should turn ON when the session screen
// hydrates, and which session (if any) now has its pre-reader default applied.
// Pure so the transitions can be tested without rendering SessionInterface.
//
// Mirrors native's usePreReaderVoice: a pre-reader's default is applied once
// per session, and after that nothing — neither a flicker of the read level nor
// a persisted "1" — may overwrite the scholar's in-session choice (TRA-497).
export function resolveVoiceHydration(args: {
  isPreReaderSession: boolean;
  sessionId: string;
  // The session whose pre-reader default has already been applied, if any.
  appliedFor: string | null;
  // localStorage "rabbithole.voiceMode" for non-pre-readers.
  storedOn: boolean;
}): { on: boolean; appliedFor: string | null } {
  if (args.appliedFor === args.sessionId) {
    return { on: false, appliedFor: args.appliedFor };
  }
  if (args.isPreReaderSession) {
    return { on: true, appliedFor: args.sessionId };
  }
  return { on: args.storedOn, appliedFor: args.appliedFor };
}
