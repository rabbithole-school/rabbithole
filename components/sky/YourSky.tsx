"use client";

/**
 * The kid's own sky on web (TRA-699; review/quests-rebuilt-proposal.html,
 * "The Sky: a kid's own wonders", figures 9 and 9b). Drawn from
 * `skyStars.forSelf`: one small star for each wonder the kid asked, labelled
 * with their question, and the one bright star for each Quest they showed,
 * with a trail back to the wonder it grew from. A faint line joins each star
 * to its nearby ones. Nothing here is a suggestion and no number appears.
 *
 * A tap opens the drawer (StarDrawer). Every action in it returns the kid to
 * something they made: "Keep going" reopens the wonder's chat, "Open it"
 * opens the Quest, and a nearby star or "Started from" moves the sky to that
 * star. On a narrow screen the drawer is a sheet over the bottom of the sky,
 * and the sky frames the star above it, so the move happens in view (TRA-707).
 *
 * The camera, the label budget, the lines and the words live in the pure
 * shared/yourSkyModel.ts. Drag to move, wheel or pinch to zoom; reduced motion
 * turns the glide and the twinkle off.
 *
 * BunnyPad twin: native/src/app/sky.tsx.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { Box, Flex, IconButton, Spinner, Stack, Text, chakra } from "@chakra-ui/react";
import { Minus, Plus } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { SKY_LABEL } from "@/convex/lib/skyLayout";
import { BadgeArt } from "@/components/BadgeArt";
import {
  StarDrawer,
  type StarDrawerAction,
  type StarDrawerContent,
} from "@/components/sky/StarDrawer";
import { useContainedQuery } from "@/hooks/useContainedQuery";
import { useNow } from "@/hooks/useNow";
import { serverErrorMessage } from "@/lib/serverErrorMessage";
import { toaster } from "@/lib/toaster";
import {
  LABEL_FONT_PX,
  YOUR_SKY_COLORS as C,
  cameraOnStar,
  fitSkyCamera,
  labelCap,
  labelsToShow,
  nearbyPairs,
  questShownLine,
  screenLabelBox,
  sparklePath,
  toScreen,
  trailPairs,
  wonderAskedLine,
  zoomAt,
  zoomLimits,
  type SkyCamera,
  type SkyViewport,
} from "@/shared/yourSkyModel";

type SkyStar = FunctionReturnType<typeof api.skyStars.forSelf>[number];

const SKY_BG = `radial-gradient(130% 120% at 50% 35%, #1b2347 0%, ${C.space} 70%)`;
/** The drawer (size "sm", 28rem) covers this much of a wide screen. */
const DRAWER_PX = 448;
/** At this width or less the drawer is a sheet from the bottom instead… */
const SHEET_MAX_W = 640;
/** …taking at most this share of the sky's height, so the top stays in
 *  view. The sky frames a star above that most, wherever the sheet ends. */
const SHEET_SHARE = 0.6;
/** A drag shorter than this is still a tap. */
const TAP_SLOP_PX = 6;
/** Smallest tap target, in px. */
const TAP_PX = 44;
const GLIDE_MS = 420;

/** Faint background dust, fixed to the screen, the same on every render. */
const DUST = Array.from({ length: 70 }, (_, i) => {
  const h = (n: number) => {
    const x = Math.sin(i * 12.9898 + n * 78.233) * 43758.5453;
    return x - Math.floor(x);
  };
  return { x: h(1) * 100, y: h(2) * 100, r: 0.6 + h(3) * 0.8, o: 0.25 + h(4) * 0.45 };
});

const KEYFRAMES = `
@keyframes rhYourSkyGlow { 0%, 100% { opacity: .1; } 50% { opacity: .24; } }
.rh-your-sky-glow { animation: rhYourSkyGlow 4.2s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) { .rh-your-sky-glow { animation: none; } }
`;

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function YourSky() {
  const stars = useQuery(api.skyStars.forSelf, {});
  return (
    <Box position="relative" h="100%" w="100%" overflow="hidden" css={{ background: SKY_BG }}>
      <style dangerouslySetInnerHTML={{ __html: KEYFRAMES }} />
      <Dust />
      {stars === undefined ? (
        <Flex position="absolute" inset={0} align="center" justify="center">
          <Spinner color="violet.300" />
        </Flex>
      ) : stars.length === 0 ? (
        <Flex position="absolute" inset={0} align="center" justify="center" px={6}>
          <Text color={C.label} fontSize="md" textAlign="center" maxW="34ch" lineHeight="1.5">
            A question you ask in the “I wonder…” box becomes a star here.
          </Text>
        </Flex>
      ) : (
        <SkyCanvas stars={stars} />
      )}
    </Box>
  );
}

function Dust() {
  return (
    <svg
      aria-hidden
      width="100%"
      height="100%"
      style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
    >
      {DUST.map((d, i) => (
        <circle key={i} cx={`${d.x}%`} cy={`${d.y}%`} r={d.r} fill={C.dust} opacity={d.o} />
      ))}
    </svg>
  );
}

function SkyCanvas({ stars }: { stars: SkyStar[] }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [vp, setVp] = useState<SkyViewport | null>(null);
  // The kid's own camera once they move it (or a star moves it); until then
  // the fitted view, which follows resizes and new stars.
  const [userCam, setUserCam] = useState<SkyCamera | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const fit = useMemo(() => (vp ? fitSkyCamera(stars, vp) : null), [stars, vp]);
  const cam = userCam ?? fit;
  const limits = useMemo(() => zoomLimits(fit?.k ?? LABEL_FONT_PX), [fit]);
  const byId = useMemo(() => new Map(stars.map((s) => [String(s.id), s])), [stars]);

  // The latest camera and limits, for handlers outside render.
  const camRef = useRef<SkyCamera | null>(null);
  const limitsRef = useRef(limits);
  useEffect(() => {
    camRef.current = cam;
    limitsRef.current = limits;
  });

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setVp((prev) => (prev && prev.w === r.width && prev.h === r.height ? prev : { w: r.width, h: r.height }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── Moving the camera ──
  const glideRaf = useRef(0);
  const stopGlide = () => cancelAnimationFrame(glideRaf.current);
  const glideTo = useCallback((target: SkyCamera) => {
    cancelAnimationFrame(glideRaf.current);
    const from = camRef.current;
    if (!from || prefersReducedMotion()) {
      setUserCam(target);
      return;
    }
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / GLIDE_MS);
      const e = 1 - (1 - t) ** 3;
      // Zoom in log space so the glide feels even at every scale.
      const k = Math.exp(Math.log(from.k) + (Math.log(target.k) - Math.log(from.k)) * e);
      setUserCam({ k, tx: from.tx + (target.tx - from.tx) * e, ty: from.ty + (target.ty - from.ty) * e });
      if (t < 1) glideRaf.current = requestAnimationFrame(step);
    };
    glideRaf.current = requestAnimationFrame(step);
  }, []);
  useEffect(() => () => cancelAnimationFrame(glideRaf.current), []);

  // What the drawer covers: a strip on the right of a wide screen, or the
  // bottom of a narrow one, where it opens as a sheet.
  const isSheet = !!vp && vp.w <= SHEET_MAX_W;
  const drawerInset = vp && !isSheet ? DRAWER_PX : 0;
  const sheetInset = vp && isSheet ? Math.round(vp.h * SHEET_SHARE) : 0;

  /** Move the sky to a star; `always` even when it is already in view. */
  const moveTo = useCallback(
    (id: string, always: boolean) => {
      const star = byId.get(id);
      const current = camRef.current;
      if (!star || !current || !vp) return;
      if (!always) {
        const at = toScreen(star, current);
        const margin = TAP_PX;
        const inView =
          at.x > margin &&
          at.x < vp.w - drawerInset - margin &&
          at.y > margin &&
          at.y < vp.h - sheetInset - margin * 2;
        if (inView) return;
      }
      glideTo(cameraOnStar(star, current, vp, drawerInset, sheetInset));
    },
    [byId, vp, drawerInset, sheetInset, glideTo],
  );

  const select = (id: string, always: boolean) => {
    setSelectedId(id);
    moveTo(id, always);
  };

  // When the sky changes size with a star open (a resize, or a turn across
  // SHEET_MAX_W that swaps the side drawer for the sheet), frame that star
  // again in what the drawer now leaves uncovered. Otherwise the camera the
  // last move set would stay, and the sheet could cover the star. A new
  // glide replaces any glide still aimed at the old shape.
  const reframeRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    reframeRef.current = selectedId ? () => moveTo(selectedId, true) : null;
  });
  useEffect(() => {
    reframeRef.current?.();
  }, [vp]);

  // ── Drag, pinch and wheel ──
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef({ startX: 0, startY: 0, moved: false, dist: 0, midX: 0, midY: 0 });
  const local = (e: { clientX: number; clientY: number }) => {
    const r = boxRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const pinchState = () => {
    const [a, b] = [...pointers.current.values()];
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), midX: (a.x + b.x) / 2, midY: (a.y + b.y) / 2 };
  };
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    // React bubbles the drawer's events here through its portal; a press in
    // the drawer never moves the sky.
    if (!boxRef.current?.contains(e.target as Node)) return;
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    if (pointers.current.size === 1) {
      gesture.current = { ...gesture.current, startX: p.x, startY: p.y, moved: false };
    } else if (pointers.current.size === 2) {
      gesture.current = { ...gesture.current, ...pinchState(), moved: true };
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const prev = pointers.current.get(e.pointerId);
    const current = camRef.current;
    if (!prev || !current) return;
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    const g = gesture.current;
    if (pointers.current.size === 1) {
      if (!g.moved && Math.hypot(p.x - g.startX, p.y - g.startY) > TAP_SLOP_PX) {
        g.moved = true;
        boxRef.current?.setPointerCapture(e.pointerId);
      }
      if (!g.moved) return;
      stopGlide();
      // Updaters, so moves that arrive between renders all count.
      const dx = p.x - prev.x;
      const dy = p.y - prev.y;
      setUserCam((c) => {
        const base = c ?? current;
        return { ...base, tx: base.tx + dx, ty: base.ty + dy };
      });
    } else if (pointers.current.size === 2) {
      const next = pinchState();
      stopGlide();
      const factor = next.dist / (g.dist || next.dist);
      const shiftX = next.midX - g.midX;
      const shiftY = next.midY - g.midY;
      const lim = limitsRef.current;
      setUserCam((c) => {
        const zoomed = zoomAt(c ?? current, factor, next.midX, next.midY, lim);
        return { ...zoomed, tx: zoomed.tx + shiftX, ty: zoomed.ty + shiftY };
      });
      Object.assign(g, next);
    }
  };
  const onPointerEnd = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size === 2) Object.assign(gesture.current, pinchState());
  };

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const current = camRef.current;
      if (!current) return;
      e.preventDefault();
      cancelAnimationFrame(glideRaf.current);
      const r = el.getBoundingClientRect();
      // A trackpad pinch arrives as a wheel with ctrlKey and small deltas.
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      const lim = limitsRef.current;
      setUserCam((c) => zoomAt(c ?? current, factor, x, y, lim));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const zoomButton = (factor: number) => {
    if (!cam || !vp) return;
    glideTo(zoomAt(cam, factor, (vp.w - (selectedId ? drawerInset : 0)) / 2, vp.h / 2, limits));
  };

  // ── What is drawn ──
  const shownLabels = useMemo(
    () =>
      cam && vp && fit
        ? labelsToShow(stars.map(toLike), cam, vp, { cap: labelCap(cam.k, fit.k), selectedId })
        : new Set<string>(),
    [stars, cam, vp, fit, selectedId],
  );
  const nearLines = useMemo(() => nearbyPairs(stars.map(toLike)), [stars]);
  const trails = useMemo(() => trailPairs(stars.map(toLike)), [stars]);

  const selected = selectedId ? byId.get(selectedId) ?? null : null;
  const drawer = useDrawerContent(selected, byId, (id) => select(id, true));

  return (
    <Box
      ref={boxRef}
      position="absolute"
      inset={0}
      cursor="grab"
      css={{ touchAction: "none", userSelect: "none", "&:active": { cursor: "grabbing" } }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
    >
      {cam && vp && (
        <>
          <svg
            aria-hidden
            width={vp.w}
            height={vp.h}
            style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
          >
            {nearLines.map(([a, b]) => {
              const p = toScreen(byId.get(a)!, cam);
              const q = toScreen(byId.get(b)!, cam);
              return (
                <line
                  key={`n-${a}-${b}`}
                  x1={p.x}
                  y1={p.y}
                  x2={q.x}
                  y2={q.y}
                  stroke={C.nearby}
                  strokeWidth={1.2}
                  strokeDasharray="3 5"
                  opacity={0.45}
                />
              );
            })}
            {trails.map(([from, to]) => {
              const p = toScreen(byId.get(from)!, cam);
              const q = toScreen(byId.get(to)!, cam);
              // A gentle bow, so the trail reads as a path rather than a link.
              const mx = (p.x + q.x) / 2 - (q.y - p.y) * 0.15;
              const my = (p.y + q.y) / 2 + (q.x - p.x) * 0.15;
              return (
                <path
                  key={`t-${from}-${to}`}
                  d={`M${p.x} ${p.y} Q${mx} ${my} ${q.x} ${q.y}`}
                  stroke={C.trail}
                  strokeWidth={2}
                  strokeLinecap="round"
                  fill="none"
                  opacity={0.9}
                />
              );
            })}
            {stars.map((s) => {
              const p = toScreen(s, cam);
              const isSelected = String(s.id) === selectedId;
              return (
                <g key={s.id}>
                  {isSelected && (
                    <circle cx={p.x} cy={p.y} r={s.bright ? 19 : 12} fill="none" stroke={C.label} strokeOpacity={0.7} strokeWidth={1.5} />
                  )}
                  {s.kind === "quest" ? (
                    <>
                      <circle
                        className="rh-your-sky-glow"
                        cx={p.x}
                        cy={p.y}
                        r={s.bright ? 16 : 9}
                        fill={C.quest}
                      />
                      <path d={sparklePath(p.x, p.y, s.bright ? 12 : 6.5)} fill={C.quest} opacity={s.bright ? 1 : 0.75} />
                    </>
                  ) : (
                    <>
                      <circle className="rh-your-sky-glow" cx={p.x} cy={p.y} r={9} fill={C.wonder} />
                      <circle cx={p.x} cy={p.y} r={3.4} fill={C.wonder} />
                    </>
                  )}
                </g>
              );
            })}
          </svg>

          {stars.map((s) => {
            const id = String(s.id);
            const showLabel = shownLabels.has(id);
            const p = toScreen(s, cam);
            const box = screenLabelBox(toLike(s), cam);
            // The tap target: the dot and, when shown, its label; never under
            // TAP_PX square.
            const left = Math.min(p.x - TAP_PX / 2, showLabel ? box.left : Infinity);
            const right = Math.max(p.x + TAP_PX / 2, showLabel ? box.right : -Infinity);
            const top = p.y - TAP_PX / 2;
            const bottom = Math.max(p.y + TAP_PX / 2, showLabel ? box.bottom : -Infinity);
            const isQuest = s.kind === "quest";
            return (
              <chakra.button
                key={id}
                type="button"
                position="absolute"
                left={`${left}px`}
                top={`${top}px`}
                w={`${right - left}px`}
                h={`${bottom - top}px`}
                bg="transparent"
                border="none"
                p={0}
                cursor="pointer"
                borderRadius="md"
                aria-label={isQuest ? `Quest: ${s.label}` : s.label}
                aria-haspopup="dialog"
                _focusVisible={{ outline: "2px solid", outlineColor: "violet.300", outlineOffset: "2px" }}
                // Keyboard focus moves the sky to the star. A tap's focus
                // doesn't: it lands on press, and moving the star from under
                // the pointer before release would lose the tap; the tap's
                // click moves the sky instead.
                onFocus={(e) => {
                  if (e.currentTarget.matches(":focus-visible")) moveTo(id, false);
                }}
                onClick={(e) => {
                  // A drag that ends on a star isn't a tap; a key press
                  // (detail 0) always is.
                  if (e.detail !== 0 && gesture.current.moved) return;
                  select(id, false);
                }}
              >
                {showLabel && (
                  <Text
                    as="span"
                    aria-hidden
                    position="absolute"
                    left={`${box.left - left}px`}
                    top={`${p.y + (SKY_LABEL.dotEm / 2) * LABEL_FONT_PX - top}px`}
                    w={`${box.right - box.left + 12}px`}
                    ml="-6px"
                    textAlign="center"
                    fontFamily="heading"
                    fontSize={`${LABEL_FONT_PX}px`}
                    lineHeight={SKY_LABEL.lineEm}
                    fontWeight={isQuest ? 700 : 600}
                    color={isQuest ? C.quest : C.label}
                    lineClamp={SKY_LABEL.maxLines}
                    pointerEvents="none"
                    css={{ textShadow: "0 1px 4px #000, 0 0 10px #0a0e1f" }}
                  >
                    {s.label}
                  </Text>
                )}
              </chakra.button>
            );
          })}

          <Stack position="absolute" right={3} bottom={3} gap={2} zIndex={2}>
            <IconButton
              aria-label="Zoom in"
              size="md"
              variant="ghost"
              borderRadius="full"
              color={C.label}
              bg="blackAlpha.500"
              _hover={{ bg: "blackAlpha.700", color: "white" }}
              onClick={() => zoomButton(1.5)}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <Plus size={18} />
            </IconButton>
            <IconButton
              aria-label="Zoom out"
              size="md"
              variant="ghost"
              borderRadius="full"
              color={C.label}
              bg="blackAlpha.500"
              _hover={{ bg: "blackAlpha.700", color: "white" }}
              onClick={() => zoomButton(1 / 1.5)}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <Minus size={18} />
            </IconButton>
          </Stack>
        </>
      )}
      <StarDrawer
        content={drawer}
        onClose={() => setSelectedId(null)}
        sheetMaxHeight={isSheet ? sheetInset : undefined}
      />
    </Box>
  );
}

function toLike(s: SkyStar) {
  return {
    ...s,
    id: String(s.id),
    trailFromStarId: s.trailFromStarId ? String(s.trailFromStarId) : null,
    nearby: s.nearby.map(String),
  };
}

/** The drawer for the selected star (figure 9b). */
function useDrawerContent(
  star: SkyStar | null,
  byId: Map<string, SkyStar>,
  goTo: (id: string) => void,
): StarDrawerContent | null {
  const serverDay = useQuery(api.institutions.currentDayForScholar, {});
  const timeZone = serverDay?.timeZone;
  const nowMs = useNow(60 * 60_000);
  const openQuest = useOpenQuest();
  if (!star) return null;

  if (star.kind === "wonder" && star.wonder) {
    const near = star.nearby.map((id) => byId.get(String(id))).filter((s): s is SkyStar => !!s);
    return {
      id: String(star.id),
      eyebrow: wonderAskedLine(star.wonder.askedOn, star.wonder.askedAt, nowMs, timeZone),
      title: star.label,
      color: C.nearby,
      extra: (
        <Stack gap={4}>
          {star.wonder.replyExcerpt && (
            <Text fontSize="sm" color="charcoal.500" lineHeight="1.55">
              <Text as="span" fontWeight="700" color="navy.500">
                Rabbithole:
              </Text>{" "}
              {star.wonder.replyExcerpt}
            </Text>
          )}
          {near.length > 0 && (
            <Stack gap={2}>
              <DrawerEyebrow>Near this in your sky</DrawerEyebrow>
              <Flex gap={2} wrap="wrap">
                {near.map((n) => (
                  <StarLink key={n.id} onClick={() => goTo(String(n.id))}>
                    {n.label}
                  </StarLink>
                ))}
              </Flex>
            </Stack>
          )}
        </Stack>
      ),
      actions: star.sessionId
        ? [{ label: "Keep going", href: `/scholar/${star.sessionId}`, primary: true }]
        : [],
    };
  }

  if (star.kind === "quest" && star.quest) {
    const q = star.quest;
    const from = star.trailFromStarId ? byId.get(String(star.trailFromStarId)) : undefined;
    const icon = q.badge?.icon ?? q.emoji;
    return {
      id: String(star.id),
      eyebrow: questShownLine(q.kind, q.shownAt, nowMs, timeZone),
      title: star.label,
      color: C.quest,
      leading:
        q.badge?.imageUrl || icon ? (
          <BadgeArt
            imageUrl={q.badge?.imageUrl ?? null}
            emoji={icon ?? "🏅"}
            size="48px"
            rounded="lg"
            alt=""
            showGeneratingOverlay={false}
          />
        ) : undefined,
      meta: [
        ...(q.mission ? [{ label: "Mission", value: q.mission }] : []),
        ...(q.advisorName ? [{ label: "Advisor", value: q.advisorName }] : []),
      ],
      extra: from ? (
        <Flex gap={2} align="center" wrap="wrap">
          <Text fontSize="sm" color="charcoal.400">
            Started from
          </Text>
          <StarLink onClick={() => goTo(String(from.id))}>{from.label}</StarLink>
        </Flex>
      ) : undefined,
      actions: star.unitId ? [openQuest.action(star.unitId)] : [],
    };
  }
  return null;
}

/**
 * "Open it" opens a Quest the way the Quests tab's row for it does
 * (components/QuestProposals.tsx): an approved Quest opens its maker
 * activity's session (`sessions.create` finds the one already begun). An
 * older Quest, made before proposals, has no maker activity and opens its
 * unit page. The approved list is `questProposals.forSelf`, the read the
 * Quests tab holds; contained, so an error falls back to the unit page.
 */
function useOpenQuest() {
  const router = useRouter();
  const { data: proposals } = useContainedQuery(api.questProposals.forSelf, {});
  const createSession = useMutation(api.sessions.create);
  const [opening, setOpening] = useState<string | null>(null);
  return {
    action: (unitId: Id<"units">): StarDrawerAction => {
      const approved = proposals?.approved.find((q) => q.unitId === unitId);
      if (!approved) return { label: "Open it", href: `/scholar/unit/${unitId}` };
      return {
        label: "Open it",
        loading: opening === String(unitId),
        onClick: () => {
          if (opening) return;
          setOpening(String(unitId));
          createSession({ activityId: approved.activityId })
            .then(({ id }) => router.push(`/scholar/${id}`))
            .catch((error: unknown) => {
              console.error("[sky] couldn't open the Quest", error);
              toaster.error({ title: serverErrorMessage(error, "Couldn't open that Quest") });
              setOpening(null);
            });
        },
      };
    },
  };
}

function DrawerEyebrow({ children }: { children: React.ReactNode }) {
  return (
    <Text
      fontSize="11px"
      fontWeight="700"
      letterSpacing="0.08em"
      textTransform="uppercase"
      color="charcoal.400"
    >
      {children}
    </Text>
  );
}

/** Another star of the kid's, as a tap that moves the sky to it. */
function StarLink({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <chakra.button
      type="button"
      onClick={onClick}
      minH="40px"
      px={3}
      py={1.5}
      borderRadius="full"
      bg="violet.50"
      color="navy.500"
      fontSize="sm"
      fontWeight="600"
      textAlign="left"
      lineHeight="1.3"
      _hover={{ bg: "violet.100" }}
      _focusVisible={{ outline: "2px solid", outlineColor: "violet.400" }}
    >
      {children}
    </chakra.button>
  );
}
