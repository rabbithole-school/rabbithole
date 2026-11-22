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
 * A chat session's descriptor is conditioned on whether THIS session could
 * build a new app (lib/mission.ts mayCreateAppInSession, the gate that decides
 * whether the tutor is handed create_code): a descriptor that said "in any
 * activity the tutor can build an app" led the staff aide to call a correct
 * tutor wrong about a scholar's own Quest.
 *
 * TRA-519: there is ONE app surface. A chat session's app and an app
 * activity's app open in the same full-screen builder; `vibecode` now means
 * only that the builder is the session's primary view.
 */
export const SESSION_SURFACE: Record<
  "conversation" | "workbench" | "vibecode",
  string
> = {
  // The app half of a chat session's screen depends on the session:
  // conversationSurface() appends it. This is the part every chat shares.
  conversation:
    "A chat with the AI tutor beside the scholar's documents. A WRITING BOX is plain text on web and iPad: no formatting, no font sizes, nothing runs, and typed HTML or markdown shows literally. The tutor can read it but cannot type into it. An app is one HTML/JavaScript page, and code the tutor writes in the chat is text to read. Python runs only in the Python bench, never in the chat or a writing box.",
  vibecode:
    "The full-screen app builder as the session's primary view: an app activity (an online activity with app settings; older rows have kind 'vibecode'), an activity-less build session, or free play. The scholar directs an AI builder that writes one live HTML app. In Edit (allowed when appEditAccess is 'always' or absent, and after completion for 'afterCompletion') the scholar gets a Preview/Code toggle with editable HTML, on the web and the iPad alike; Play and a locked Edit show only the running app. In a unit, the builder is given the scholar's prior work from OTHER activities in the same unit (submitted deliverables, else what is in their writing box, else their own chat turns; about 2,500 characters in all). A chat session's app opens in this same builder.",
  workbench:
    "A simulator workbench: the scholar authors a prompt deck over code-owned physics and runs it at the bench.",
};

const APP_CARD =
  "The app shows as a card beside the chat, on web and iPad; Open takes it full screen into the same app builder an app activity uses (Preview, an editable Code view, version history).";

/**
 * The Python bench half of a chat session's descriptor (lib/pythonBench.ts),
 * conditioned on the same gate that hands the tutor open_python_bench.
 */
function pythonBenchSurface(bench: {
  offered: boolean;
  open: boolean;
  otherApp?: boolean;
}): string {
  const what =
    "the Python bench, a fixed, reviewed app where the scholar writes and runs real Python (CPython 3.14), steps through a run line by line and plots with matplotlib";
  if (bench.open) {
    return ` This session's app is ${what}. ${APP_CARD} The tutor opened it with open_python_bench, which takes no input: the tutor cannot load, write or change code in it, so every line of the program is the scholar's. The tutor reads the scholar's code, output, errors and stepping from the app's published state.`;
  }
  if (!bench.offered) return "";
  if (bench.otherApp) {
    return ` The Python bench (open_python_bench, a fixed app where the scholar writes and runs real Python) could not open in this session because it already had an app, and a session holds one; the tutor could say so and point the scholar to a new chat without an app.`;
  }
  return ` The tutor could open ${what} (open_python_bench), here as in any chat session, Quests and chats with no activity included: opening it is not building a new app. It takes no input, so the tutor cannot preload or write the scholar's code. It attaches as the session's app, so it opens only while the session has no app yet. A tutor that told the scholar Python cannot run here was wrong.`;
}

/**
 * What a chat session's screen could do with apps. `appCreationAllowed` is
 * mayCreateAppInSession for this session; `hasApp` = it has a code artifact
 * other than the Python bench; `pythonBench` = mayOpenPythonBench for this
 * session (`offered`) and whether the bench is its app (`open`).
 */
export function conversationSurface(args: {
  appCreationAllowed: boolean;
  hasApp: boolean;
  pythonBench?: { offered: boolean; open: boolean; otherApp?: boolean };
}): string {
  const base = SESSION_SURFACE.conversation;
  const bench = pythonBenchSurface(
    args.pythonBench ?? { offered: false, open: false },
  );
  if (args.appCreationAllowed && args.pythonBench?.open) {
    // The bench is the session's one app: create_code is refused beside it.
    return `${base}${bench} While the bench was open, the tutor could not build another app in this session: a session holds one app.`;
  }
  if (args.appCreationAllowed) {
    return `${base} In this session the tutor could build a LIVE APP (create_code) when the scholar wanted to make something interactive. ${APP_CARD} When the activity's work is something else (writing, slides, a map, a discussion), the app is a side project and the tutor steers back to that work.${bench}`;
  }
  const editable = args.hasApp
    ? ` This session already has an app (see documents), which the tutor could still change or fix. ${APP_CARD}`
    : "";
  return `${base} The tutor could NOT build a new app, game, or web page in this session: it had no create_code tool. New apps are built only in an app activity or an activity in a teacher's unit; never in a Quest (a scholar's own unit, including one a teacher offered: its planning chat or a non-app step) or any chat with no activity (even one inside a teacher's unit), so a tutor that told the scholar it cannot build one here was right. The remedy is a teacher's: assign the scholar an app activity, or an online activity in a teacher's unit, whose tutor can build an app.${editable}${bench}`;
}

/** whatTheScholarSees for a session, by mode; a chat is conditioned on the
 * app gates (conversationSurface). */
export function sessionSurfaceFor(
  sessionMode: "conversation" | "workbench" | "vibecode",
  app: {
    appCreationAllowed: boolean;
    hasApp: boolean;
    pythonBench?: { offered: boolean; open: boolean; otherApp?: boolean };
  },
): string {
  return sessionMode === "conversation"
    ? conversationSurface(app)
    : SESSION_SURFACE[sessionMode];
}
