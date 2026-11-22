/**
 * Words for recording a talk (slides or an app) and for audience mode, the
 * BunnyPad at the back of the room. One place, so the presenter, the review
 * and the back device say the same thing.
 */
export const TALK_COPY = {
  // Presenter
  start: "Start",
  record: "Record",
  finish: "Finish",
  stop: "Stop",
  starting: "Starting…",
  saving: "Saving…",
  readyToRehearse: "Ready to rehearse",
  recordingClock: (clock: string) => `Recording ${clock}`,
  watching: (name: string) => `${name} is watching from the back`,
  disconnect: "Disconnect",
  howToWatch:
    "A friend can watch from the back of the room: Decibel meter, in their account menu.",

  // How to present
  chooseMessage:
    "Rehearse to practice. Your BunnyPad records you so you can play it back, and a friend can watch from the back of the room.",
  rehearse: "Rehearse",

  // Audience mode (the back device)
  audienceTitle: "Decibel meter",
  audienceMenuItem: "Decibel meter",
  pickHeading: "Who are you watching?",
  nobodyPresenting:
    "Nobody at your school is presenting right now. Someone shows up here as soon as they tap Present or Rehearse.",
  presentingRow: (title: string) => `Presenting “${title}”`,
  rehearsingRow: (title: string) => `Rehearsing “${title}”`,
  someoneWatching: "Someone is already watching",
  noSchool: "Audience mode works for scholars and staff at a school.",
  recordingName: (name: string) => `Recording ${name}`,
  aimCamera: (name: string) => `Point this BunnyPad at ${name}`,
  waitingForStart: (name: string) =>
    `When ${name} starts recording, this screen turns green while the back of the room can hear them. A quiet moment before the talk helps it learn what the room sounds like.`,
  sending: (name: string, pct: number | null) =>
    pct === null ? `Sending the video to ${name}…` : `Sending the video to ${name}… ${pct}%`,
  sent: (name: string) => `Sent to ${name}. Waiting for the next take.`,
  sendFailed: (name: string) => `The video didn't reach ${name}.`,
  stopWatching: "Stop watching",
  disconnected: (name: string) => `This BunnyPad isn't watching ${name} any more.`,
  finished: (name: string) => `${name} has finished presenting.`,
  done: "Done",
  needsCamera:
    "Watching from the back needs the camera and microphone, which are turned off for Rabbithole.",
  listenAlone: "Listen without a presenter",
  linkPresentation: "Link to presentation",
  recordingHere: "Recording",
  backReviewTitle: "From the back of the room",
  recordAgain: "Record again",
  filmFailed: "The camera didn't record that take.",
  needsMic:
    "Listening from the back needs the microphone, which is turned off for Rabbithole.",

  // Saving a take filmed with nobody linked (decibelMeter.ts)
  savingTake: (pct: number | null) => (pct === null ? "Saving…" : `Saving… ${pct}%`),
  savedForTeacher: "Saved. A teacher will file it.",
  savedTo: (name: string) => `Saved to ${name}’s work.`,
  saveFailed: "This take didn't save.",
  tryAgain: "Try again",
  whoseTalk: "Whose talk is this?",
  changeSpeaker: "Change",
  speakerSearch: "Search names",
  leaveForTeacher: "Leave it for a teacher",
  cancel: "Cancel",
  filedByTeacher: "A teacher has filed this take.",
  discard: "Discard",
  discardTitle: "Discard this take?",
  discardBody: "It's deleted from this BunnyPad and from your teachers' inbox.",
  keepIt: "Keep it",
  discardFailed: "This take couldn't be discarded.",
  transcriptHeading: "What was said",
  transcriptPending: "Writing out what was said…",
  transcriptFailed: "The words couldn't be written out for this take.",
  transcriptEmpty: "No words were heard in this take.",
  pace: (wordsPerMinute: number, fillers: number) =>
    `${wordsPerMinute} words a minute · ${fillers} ${fillers === 1 ? "um or uh" : "ums and uhs"}`,

  // Review
  soundFrom: "Sound from",
  soundBack: "Back of the room",
  soundMine: "Your BunnyPad",
  backOnItsWay: "The video from the back of the room is on its way…",
  backDidntArrive: "The video from the back of the room didn't arrive.",
  watchSlide: (n: number) => `Watch slide ${n}`,
  listenSlide: (n: number) => `Listen to slide ${n}`,
  watchAt: (clock: string) => `Watch ${clock}`,
  listenAt: (clock: string) => `Listen from ${clock}`,
  yourRecording: "Your recording",
  timelineHeard: "Heard",
  headDirection: "Head direction",
  meterLayouts: { both: "Face & voice", voice: "Voice only", face: "Face only" },
  headWord: {
    none: "No face in view",
    facing: "Facing the room",
    turned: "Turned away",
    down: "Looking down",
    up: "Looking up",
  },

  headAngles: (turnDeg: number, chinDeg: number) =>
    `turned ${turnDeg}°, ${chinDeg === 0 ? "chin level" : `chin ${Math.abs(chinDeg)}° ${chinDeg > 0 ? "down" : "up"}`}`,
  presentAgain: "Present again",
  rehearseAgain: "Rehearse again",
} as const;
