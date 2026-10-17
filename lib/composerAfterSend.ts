/**
 * What the chat composer should hold once a tutor turn has been persisted.
 *
 * Only a send that READ the composer may clear it. The web session page sends
 * other turns through the same `handleSend`: the hidden `<start>` opener the
 * page fires on load, a dictated take, an app update. None of those came from
 * the box, so clearing it after they persist erases whatever the scholar has
 * typed in the meantime.
 *
 * TRA-527: a scholar typed their first question while a new quest chat's
 * `<start>` opener was still being persisted. Their Enter was refused by the
 * send lock the opener held, which left the text in the box — and then the
 * opener's success cleared the box, so the question was never sent, never
 * stored, and gone from the screen.
 *
 * Native's session screen applies the same rule inline
 * (`native/src/app/session/[id].tsx`: only `!usingOverride && !isAppRequest`
 * clears the input).
 */
export function composerAfterPersistedSend(
  composer: string,
  send: { directText?: string; isAppRequest?: boolean },
): string {
  // Mirrors handleSend's choice of text: blank direct text falls back to the
  // composer, so that send read it and clears it.
  const readTheComposer = !send.isAppRequest && !send.directText?.trim();
  return readTheComposer ? "" : composer;
}
