"use client";

import { FLAIR_MOTION } from "@/shared/flairMotion";

/**
 * The web half of the earned-flair arrival choreography: three keyframes and the
 * reduced-motion reset, following the repo's existing self-injected-`<style>`
 * idiom (`components/practice/VerdictStemCard.tsx`). The durations that both
 * frontends must agree on come from `shared/flairMotion.ts`; only the curves,
 * which have no native counterpart (native uses a spring), live here.
 *
 * Reduced motion is pure CSS on purpose. Killing the animation also kills its
 * delay and its `both` fill mode, so the element's resting `opacity: 1` applies
 * on the very first frame — nothing is hidden while waiting, and no JavaScript
 * reads the setting, so there is nothing to keep in sync.
 */

/**
 * Web has no spring engine; this bezier mirrors the native spring's ~2.4%
 * overshoot so the two surfaces read as the same event.
 */
export const FLAIR_CHIP_ENTER_MS = 320;

export const FLAIR_MOTION_CSS = `
@keyframes rhFlairNoticeRise { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
@keyframes rhFlairNoticeEmoji { 0% { transform: scale(0.82); } 62% { transform: scale(1.04); } 100% { transform: scale(1); } }
@keyframes rhFlairChipIn { from { opacity: 0; transform: translateY(6px) scale(0.88); } to { opacity: 1; transform: none; } }
.rh-flair-notice { animation: rhFlairNoticeRise ${FLAIR_MOTION.noticeRiseMs}ms cubic-bezier(0.22,1,0.36,1) both; }
.rh-flair-notice-emoji { animation: rhFlairNoticeEmoji ${FLAIR_MOTION.noticeEmojiMs}ms cubic-bezier(0.34,1.4,0.64,1) both; }
.rh-flair-chip { animation: rhFlairChipIn ${FLAIR_CHIP_ENTER_MS}ms cubic-bezier(0.2,1.25,0.4,1) both; }
@media (prefers-reduced-motion: reduce) {
  .rh-flair-notice, .rh-flair-notice-emoji, .rh-flair-chip {
    animation: none !important;
    opacity: 1 !important;
    transform: none !important;
  }
}
`;
