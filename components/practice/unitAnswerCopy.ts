/**
 * The unit-nudge copy seam for the web practice surfaces (drill, placement,
 * in-chat item). The words themselves live in the cross-surface core so web
 * and native can't drift on them; this file only re-exports the seam the
 * components already import.
 */
export {
  UNIT_MISSING_NUDGE,
  UNIT_WRONG_NUDGE,
  unitOutcomeNudge,
} from "@/shared/practiceLoop";
