"use client";

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";

const COLORS = ["#AD60BF", "#9148a3", "#222656", "#f4c44c", "#ffffff"];
const PARTICLE_COUNT = 72;

type Particle = {
  id: number;
  left: number;
  delay: number;
  duration: number;
  size: number;
  color: string;
  rotation: number;
};

// Under the per-user query-cache prefix, so sign-out clears it (see
// clearCachedQueries) and a second scholar on a shared browser keeps their own.
function storageKey(userId: string) {
  return `rh.cache.v1.birthday-confetti.${userId}`;
}

function buildParticles(): Particle[] {
  return Array.from({ length: PARTICLE_COUNT }, (_, id) => ({
    id,
    left: Math.random() * 100,
    delay: Math.random() * 0.45,
    duration: 2.2 + Math.random() * 1.1,
    size: 6 + Math.random() * 8,
    color: COLORS[id % COLORS.length],
    rotation: Math.random() * 360,
  }));
}

export function BirthdayConfetti({
  active,
  dayKey,
  userId,
}: {
  active: boolean;
  dayKey: string | null | undefined;
  userId: string | null | undefined;
}) {
  const [particles, setParticles] = useState<Particle[]>([]);

  // Fire once per scholar per day. The seen flag is written when the burst
  // actually starts, inside the timer, so a Strict Mode effect replay (which
  // cancels the first timer) schedules it again instead of skipping it.
  useEffect(() => {
    if (!active || !dayKey || !userId) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const key = storageKey(userId);
    try {
      if (window.localStorage.getItem(key) === dayKey) return;
    } catch {
      // Storage unavailable: fire anyway; a replay is harmless.
    }
    const start = window.setTimeout(() => {
      try {
        window.localStorage.setItem(key, dayKey);
      } catch {
        // Best-effort only.
      }
      setParticles(buildParticles());
    }, 0);
    return () => window.clearTimeout(start);
  }, [active, dayKey, userId]);

  // Clear the burst after it falls, driven by the particles themselves so no
  // replay of the effect above can strand them on screen.
  useEffect(() => {
    if (particles.length === 0) return;
    const clear = window.setTimeout(() => setParticles([]), 3600);
    return () => window.clearTimeout(clear);
  }, [particles]);

  if (particles.length === 0) return null;

  return (
    <div aria-hidden="true" className="birthday-confetti">
      <style>{`
        .birthday-confetti {
          position: fixed;
          inset: 0;
          overflow: hidden;
          pointer-events: none;
          z-index: 50;
        }
        .birthday-confetti__piece {
          position: absolute;
          top: -16px;
          border-radius: 3px;
          opacity: 0.95;
          animation-name: birthday-confetti-fall;
          animation-timing-function: cubic-bezier(.16,.84,.44,1);
          animation-fill-mode: forwards;
        }
        @keyframes birthday-confetti-fall {
          0% { transform: translate3d(0, -24px, 0) rotate(0deg); }
          100% { transform: translate3d(var(--drift), 110vh, 0) rotate(var(--spin)); }
        }
        @media (prefers-reduced-motion: reduce) {
          .birthday-confetti { display: none; }
        }
      `}</style>
      {particles.map((particle) => (
        <span
          key={particle.id}
          className="birthday-confetti__piece"
          style={{
            left: `${particle.left}%`,
            width: `${particle.size}px`,
            height: `${particle.size * 0.7}px`,
            backgroundColor: particle.color,
            animationDelay: `${particle.delay}s`,
            animationDuration: `${particle.duration}s`,
            transform: `rotate(${particle.rotation}deg)`,
            ["--drift" as string]: `${(particle.left - 50) * -0.55}px`,
            ["--spin" as string]: `${particle.rotation + 540}deg`,
          } as CSSProperties}
        />
      ))}
    </div>
  );
}
