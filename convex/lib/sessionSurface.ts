/**
 * What the scholar's screen looked like in a session, by `sessionMode`, so a
 * staff aide reading a transcript can say what the scholar could and could not
 * do instead of guessing ("is there a code editor here?", "can the tutor build
 * the game?", "will the builder see their design?"). Facts about the runtime:
 * returned by the transcript read (scholarReads.readSessionTranscript) and
 * quoted by the app-activity create-tool description (aideTools). Update this
 * when a surface changes — the tutor prompt (sessionHelpers.buildArtifactSection,
 * prompts.buildToolsSection / buildSideAppSection), shared/appSurface.ts and
 * priorUnitWork are where the behavior lives.
 *
 * TRA-519: there is ONE app surface. A chat session's app and an app
 * activity's app open in the same full-screen builder; `vibecode` now means
 * only that the builder is the session's primary view.
 */
export const SESSION_SURFACE: Record<
  "conversation" | "workbench" | "vibecode",
  string
> = {
  conversation:
    "A chat with the AI tutor beside the scholar's documents. A WRITING BOX is plain text on web and iPad: no formatting, no font sizes, nothing runs, and typed HTML or markdown shows literally. The tutor can read it but cannot type into it. In any activity the tutor can also build a LIVE APP (create_code) when the scholar wants to make something interactive. The app shows as a card beside the chat, on web and iPad; Open takes it full screen into the same app builder an app activity uses (Preview, an editable Code view, version history). When the activity's work is something else (writing, slides, a map, a discussion), the app is a side project and the tutor steers back to that work; with no other work (an open chat), the tutor takes the app-builder stance.",
  vibecode:
    "The full-screen app builder as the session's primary view: an app activity (an online activity with app settings; older rows have kind 'vibecode'), an activity-less build session, or free play. The scholar directs an AI builder that writes one live HTML app. In Edit (allowed when appEditAccess is 'always' or absent, and after completion for 'afterCompletion') the scholar gets a Preview/Code toggle with editable HTML, on the web and the iPad alike; Play and a locked Edit show only the running app. In a unit, the builder is given the scholar's prior work from OTHER activities in the same unit (submitted deliverables, else what is in their writing box, else their own chat turns; about 2,500 characters in all). A chat session's app opens in this same builder.",
  workbench:
    "A simulator workbench: the scholar authors a prompt deck over code-owned physics and runs it at the bench.",
};
