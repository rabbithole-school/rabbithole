"use client";

import { Box } from "@chakra-ui/react";

import {
  RECOVERY_ARC_DRAW_MS,
  RECOVERY_ARC_MOTES,
  RECOVERY_ARC_MOTE_MS,
  RECOVERY_ARC_PATH,
  RECOVERY_ARC_VIEWBOX,
} from "@/shared/recoveryCharm";

const RECOVERY_ARC_CSS = `
@keyframes rhRecoveryArcDraw {
  from { stroke-dashoffset: 1; }
  to { stroke-dashoffset: 0; }
}
@keyframes rhRecoveryMote {
  from { opacity: 0; transform: scale(0.35); }
  to { opacity: 1; transform: scale(1); }
}
.rh-recovery-arc {
  stroke-dasharray: 1;
  stroke-dashoffset: 1;
  animation: rhRecoveryArcDraw ${RECOVERY_ARC_DRAW_MS}ms cubic-bezier(0.22, 1, 0.36, 1) both;
}
.rh-recovery-mote {
  opacity: 0;
  transform-box: fill-box;
  transform-origin: center;
  animation: rhRecoveryMote ${RECOVERY_ARC_MOTE_MS}ms ease-out both;
}
@media (prefers-reduced-motion: reduce) {
  .rh-recovery-arc { animation: none; stroke-dashoffset: 0; }
  .rh-recovery-mote { animation: none; opacity: 1; transform: none; }
}
`;

export function RecoveryArc() {
  return (
    <Box aria-hidden="true" w="100%" maxW="420px" h="140px" mb={-3}>
      <style dangerouslySetInnerHTML={{ __html: RECOVERY_ARC_CSS }} />
      <svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${RECOVERY_ARC_VIEWBOX.width} ${RECOVERY_ARC_VIEWBOX.height}`}
        fill="none"
      >
        <defs>
          <linearGradient id="recovery-arc-gradient" x1="22" y1="120" x2="398" y2="74">
            <stop offset="0" stopColor="#16707e" />
            <stop offset="1" stopColor="#6d5bd0" />
          </linearGradient>
        </defs>
        <path
          className="rh-recovery-arc"
          d={RECOVERY_ARC_PATH}
          pathLength="1"
          stroke="url(#recovery-arc-gradient)"
          strokeWidth="8"
          strokeLinecap="round"
        />
        {RECOVERY_ARC_MOTES.map((mote) => (
          <circle
            key={`${mote.x}:${mote.y}`}
            className="rh-recovery-mote"
            cx={mote.x}
            cy={mote.y}
            r={mote.r}
            fill={mote.x < RECOVERY_ARC_VIEWBOX.width / 2 ? "#16707e" : "#6d5bd0"}
            style={{ animationDelay: `${mote.delayMs}ms` }}
          />
        ))}
      </svg>
    </Box>
  );
}
