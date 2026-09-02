"use client";

import Link from "next/link";
import { useQuery } from "convex/react";
import { Badge, Flex, Text } from "@chakra-ui/react";
import { GraduationCap, Books, UsersThree } from "@phosphor-icons/react";
import { curriculumUnitHref } from "@/lib/curriculumHref";
import { scholarSlug } from "@/convex/lib/channels";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

/**
 * The "scope" of an aide chat — which scholar and/or unit it's about — as a
 * chip. One primitive so scope reads the same everywhere it appears:
 *   - each scoped robot pane's header (the pane's own identity), and
 *   - the global Chat tab thread header (what an out-of-context session is
 *     about + a link back to that scholar/unit).
 *
 * `asLink` (default true) makes the chip a jump to the scholar/unit. In a
 * pane header you're already IN that scope, so the pane passes
 * `asLink={false}` and the chip is a plain label — same look, no navigation.
 *
 * `showGlobal` renders a neutral "All scholars" chip when there's no
 * scholar/unit scope, so a global chat still shows its scope in the family
 * style. Off by default (a global chat usually needs no label).
 *
 * `chatId`, when given, rides on the links so a click lands on the
 * scholar/unit with THIS session open in its pane (Chat tab → click scope →
 * same thread in context). Panes that don't read `?chat=` ignore it.
 */
export function ScopeChip({
  scholarId,
  unitId,
  chatId,
  asLink = true,
  showGlobal = false,
}: {
  scholarId?: Id<"users"> | null;
  unitId?: Id<"units"> | null;
  chatId?: Id<"chats"> | string | null;
  asLink?: boolean;
  showGlobal?: boolean;
}) {
  const scholar = useQuery(
    api.scholars.getProfile,
    scholarId ? { scholarId } : "skip",
  );
  const unit = useQuery(api.units.get, unitId ? { id: unitId } : "skip");

  const chip = {
    fontFamily: "heading",
    fontSize: "2xs",
    px: 2,
    py: 0.5,
    borderRadius: "md",
    display: "inline-flex",
    alignItems: "center",
    gap: 1,
    maxW: "100%",
    overflow: "hidden",
    whiteSpace: "nowrap",
    userSelect: "none",
  } as const;

  // A chip is a bare Badge in a pane (asLink=false) or a Link-wrapped Badge
  // in the Chat tab. The visual is identical either way.
  const wrap = (key: string, href: string, badge: React.ReactNode) =>
    asLink ? (
      <Link key={key} href={href} style={{ textDecoration: "none", minWidth: 0 }}>
        {badge}
      </Link>
    ) : (
      badge
    );

  if (!scholarId && !unitId) {
    if (!showGlobal) return null;
    return (
      <Badge {...chip} bg="gray.100" color="charcoal.500">
        <UsersThree size={11} weight="fill" />
        All scholars
      </Badge>
    );
  }

  const chatQs = chatId ? `?chat=${String(chatId)}` : "";

  return (
    <>
      {scholarId &&
        wrap(
          "scholar",
          `/teacher/scholars/${scholarSlug(scholar?.scholar?.username, scholarId)}${chatQs}`,
          <Badge
            {...chip}
            bg="violet.100"
            color="violet.700"
            _hover={asLink ? { bg: "violet.200" } : undefined}
            cursor={asLink ? "pointer" : "default"}
            title={asLink ? "Open this scholar" : undefined}
          >
            <GraduationCap size={11} weight="fill" />
            {scholar?.scholar?.name ?? "Scholar"}
          </Badge>,
        )}
      {unitId &&
        wrap(
          "unit",
          `${curriculumUnitHref(unitId)}${chatQs}`,
          <Badge
            {...chip}
            bg="orange.100"
            color="orange.700"
            _hover={asLink ? { bg: "orange.200" } : undefined}
            cursor={asLink ? "pointer" : "default"}
            title={asLink ? "Open this unit" : undefined}
          >
            <Books size={11} weight="fill" />
            {unit?.title ?? "Unit"}
          </Badge>,
        )}
    </>
  );
}

/**
 * The consistent identity row for a robot pane's header: the ScopeChip (as a
 * non-link tag) + the active thread title. Shared by the scholar pane and the
 * unit designer's Curriculum Bot so both read the same — a scope tag + a
 * thread name — instead of bespoke "Ask AI" / "Curriculum Bot" titles.
 *
 * Deliberately NO robot icon here: the page-level pane toggle (the Robot
 * button in the view's top-right header) already owns the robot identity, so
 * repeating it in the pane header just put two robots side by side.
 */
export function AideScopeLabel({
  scholarId,
  unitId,
  sessionTitle,
}: {
  scholarId?: Id<"users"> | null;
  unitId?: Id<"units"> | null;
  sessionTitle?: string | null;
}) {
  return (
    <Flex align="center" gap={2} flex={1} minW={0}>
      <ScopeChip scholarId={scholarId} unitId={unitId} asLink={false} showGlobal />
      <Text
        fontFamily="heading"
        fontSize="sm"
        fontWeight="600"
        color={sessionTitle ? "navy.500" : "charcoal.300"}
        truncate
      >
        {sessionTitle || "New chat"}
      </Text>
    </Flex>
  );
}
