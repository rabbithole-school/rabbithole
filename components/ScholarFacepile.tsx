"use client";

/**
 * ScholarFacepile — compact overlapping-avatars row used wherever we
 * want to show "who's in this cohort" without spelling out the count.
 * Stacks up to N avatars with a light white ring + negative margin so
 * they overlap. Any extras roll up into a "+M" badge.
 *
 *   <ScholarFacepile scholars={data.facepile} total={data.scholarCount} />
 *
 * Keep it DRY — every Assignments-tab surface should use this same
 * component instead of rendering "N scholars" text.
 */
import { Box, HStack, Text } from "@chakra-ui/react";
import { Avatar } from "@/components/Avatar";

export interface FacepileScholar {
  _id: string;
  name?: string | null;
  image?: string | null;
  username?: string | null;
}

export function ScholarFacepile({
  scholars,
  total,
  size = "xs",
  max = 4,
  showCountFallback = false,
  showOverflow = true,
}: {
  /** Pre-loaded slice of scholars to render (typically the first N
   *  from the server). */
  scholars: FacepileScholar[];
  /** Full count — drives the "+M" overflow badge. Falls back to
   *  scholars.length when not supplied. */
  total?: number;
  size?: "2xs" | "xs" | "sm" | "md";
  /** How many avatars to render inline before collapsing to "+M". */
  max?: number;
  /** When true, show "N scholar(s)" as plain text alongside the
   *  facepile — handy in headers where the count needs spelling. */
  showCountFallback?: boolean;
  /** When false, hide the "+M" overflow badge — use when the caller
   *  spells the full count out separately (e.g. "Enabled for 23
   *  scholars") so the badge isn't redundant. */
  showOverflow?: boolean;
}) {
  const count = total ?? scholars.length;
  if (count === 0) {
    return (
      <Text fontSize="2xs" color="charcoal.400" fontFamily="heading">
        No scholars
      </Text>
    );
  }
  const visible = scholars.slice(0, max);
  const overflow = count - visible.length;
  const ringPx = size === "md" ? 2 : 1.5;
  const overlap = size === "md" ? -2 : size === "sm" ? -1.5 : -1;
  return (
    <HStack gap={1.5} align="center">
      <HStack gap={0} align="center">
        {visible.map((s, i) => (
          <Box
            key={s._id}
            // Negative margin produces the overlap; first chip has no
            // overlap so the leftmost avatar starts flush.
            ml={i === 0 ? 0 : overlap}
            // White ring separates overlapping avatars without a
            // shadow.
            borderRadius="full"
            boxShadow={`0 0 0 ${ringPx}px white`}
          >
            <Avatar
              size={size}
              name={s.name ?? undefined}
              src={s.image ?? undefined}
              colorKey={s._id}
            />
          </Box>
        ))}
      </HStack>
      {showOverflow && overflow > 0 && (
        <Text
          fontSize="2xs"
          color="charcoal.500"
          fontFamily="heading"
          fontWeight="600"
        >
          +{overflow}
        </Text>
      )}
      {showCountFallback && (
        <Text fontSize="xs" color="charcoal.500" fontFamily="heading">
          {count} scholar{count === 1 ? "" : "s"}
        </Text>
      )}
    </HStack>
  );
}
