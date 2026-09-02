"use client";

import { Box, HStack, Text } from "@chakra-ui/react";
import Link from "next/link";
import { Avatar } from "@/components/Avatar";

interface PersonCellProps {
  name: string;
  image?: string | null;
  /** When set, the whole avatar+name unit becomes a link (cross-nav). */
  href?: string;
  title?: string;
  /** Small by default — these live inside compact directory rows. */
  size?: "2xs" | "xs";
  /** Stable key for the initials-fallback color (e.g. a user id). */
  colorKey?: string;
}

/**
 * The canonical "a person appears in a list" unit for the /school/directory
 * surfaces: a small Avatar (real photo, or initials fallback) beside the
 * person's name in normal text. This is the single, IDENTICAL treatment used
 * for scholars, guardians, and staff wherever a user is referenced — replacing
 * the old violet Tag chips. When `href` is set the unit is a link with a
 * subtle hover tint (not a tag / not a button).
 */
export function PersonCell({
  name,
  image,
  href,
  title,
  size = "2xs",
  colorKey,
}: PersonCellProps) {
  const unit = (
    <HStack gap={2} align="center" minW={0}>
      <Avatar name={name} src={image ?? undefined} size={size} colorKey={colorKey} />
      <Text
        fontFamily="body"
        fontSize="sm"
        fontWeight="500"
        color="charcoal.600"
        overflowWrap="anywhere"
      >
        {name}
      </Text>
    </HStack>
  );

  if (!href) return unit;

  return (
    <Box
      asChild
      display="inline-flex"
      maxW="full"
      px={1.5}
      py={0.5}
      mx={-1.5}
      borderRadius="md"
      transition="background 0.12s"
      _hover={{
        bg: "violet.50",
        textDecoration: "none",
        "& .person-cell-name": { textDecoration: "underline" },
      }}
    >
      <Link href={href} title={title}>
        <HStack gap={2} align="center" minW={0}>
          <Avatar name={name} src={image ?? undefined} size={size} colorKey={colorKey} />
          <Text
            className="person-cell-name"
            fontFamily="body"
            fontSize="sm"
            fontWeight="500"
            color="charcoal.600"
            overflowWrap="anywhere"
          >
            {name}
          </Text>
        </HStack>
      </Link>
    </Box>
  );
}
