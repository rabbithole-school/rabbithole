/**
 * What the scholar's screen looked like in a session, by `sessionMode`, so a
 * staff aide reading a transcript can say what the scholar could and could not
 * do instead of guessing ("is there a code editor here?", "can the tutor build
 * the game?", "will the builder see their design?"). Facts about the runtime:
 * returned by the transcript read (scholarReads.readSessionTranscript) and
 * quoted by the vibecode create-tool description (aideTools). Update this when
 * a surface changes — the tutor prompt (sessionHelpers.buildArtifactSection,
 * prompts.buildToolsSection) and priorUnitWork are where the behavior lives.
 */
export const SESSION_SURFACE: Record<
  "conversation" | "workbench" | "vibecode",
  string
> = {
  conversation:
    "A chat with the AI tutor beside the scholar's documents. A WRITING BOX is plain text on web and iPad: no formatting, no font sizes, nothing runs, and typed HTML or markdown shows literally. The tutor can read it but cannot type into it. The tutor can also build a LIVE APP here (create_code) when the scholar wants to make something interactive, in any activity: its own tab with Preview and an editable Code view, on web and iPad. This is not the full-screen app-builder workshop, which is a separate vibecode activity a teacher creates.",
  vibecode:
    "The full-screen app-builder workshop: the scholar directs an AI builder that writes one live HTML app. In Edit (allowed when appEditAccess is 'always' or absent, and after completion for 'afterCompletion') the scholar gets a Preview/Code toggle with editable HTML, on the web and the iPad alike; Play and a locked Edit show only the running app. The builder is given the scholar's prior work from OTHER activities in the same unit (submitted deliverables, else what is in their writing box, else their own chat turns; about 2,500 characters in all).",
  workbench:
    "A simulator workbench: the scholar authors a prompt deck over code-owned physics and runs it at the bench.",
};
