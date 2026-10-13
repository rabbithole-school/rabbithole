/**
 * The scholar composer's mic affordance, styled once. The main chat
 * (SessionInterface) and the app workshop's tutor composer
 * (vibecode/VibecodeWorkshop) both spread these onto a Chakra IconButton so
 * the mic reads the same everywhere a scholar can talk to the tutor.
 */

/** The idle mic: a solid violet circle where Send sits on an empty box. */
export const composerMicButtonStyle = {
  variant: "solid",
  bg: "violet.500",
  color: "white",
  _hover: { bg: "violet.600" },
  _disabled: { opacity: 0.5, cursor: "not-allowed" },
  borderRadius: "full",
  size: "lg",
} as const;

/**
 * Stop-and-send while recording: red once speech is heard, grey before
 * (nothing worth sending yet).
 */
export function composerStopRecordingStyle(hasSpeech: boolean) {
  return {
    bg: hasSpeech ? "red.500" : "charcoal.300",
    color: "white",
    _hover: { bg: hasSpeech ? "red.600" : "charcoal.400" },
    borderRadius: "full",
    size: "lg",
  } as const;
}
