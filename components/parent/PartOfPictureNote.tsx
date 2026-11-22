"use client";

import Link from "next/link";
import { Box, Text } from "@chakra-ui/react";

/**
 * The parent portal's standing note that these pages are only part of the
 * child's picture: what Rabbithole holds is the work done in it and what
 * teachers have added, while much of school happens on paper, out loud and
 * with hands-on materials. Shown, in the same words, on the Home, Progress,
 * Portfolio and Math tabs (components/ParentDashboard.tsx). Quiet and not
 * dismissible. Names no teacher; the link goes to the portal's Messages tab.
 */

/** The note's words for one child, by first name, with no pronouns. */
export function pictureNoteCopy(firstName: string) {
  return {
    heading: `This is part of ${firstName}'s picture.`,
    body: `These pages show the work ${firstName} does in Rabbithole and the pieces teachers have added so far. A lot of school happens on paper, out loud and with hands-on materials, and we are still adding that work here. For the whole picture, `,
    linkText: `ask ${firstName}'s teachers`,
  };
}

export function PartOfPictureNote({
  childName,
  messagesHref,
}: {
  /** The child's display name; the note uses the first name. */
  childName: string;
  /** The portal's Messages tab, carrying the page's `?child=` query. */
  messagesHref: string;
}) {
  const firstName = childName.trim().split(/\s+/)[0] || "your child";
  const copy = pictureNoteCopy(firstName);
  return (
    <Box borderWidth="1px" borderColor="border.default" borderRadius="lg" bg="bg.default" px={4} py={3}>
      <Text fontFamily="body" fontSize="sm" color="charcoal.600" lineHeight="1.6">
        <Text as="span" fontWeight="600" color="charcoal.700">
          {copy.heading}
        </Text>{" "}
        {copy.body}
        <Link href={messagesHref} style={{ color: "var(--chakra-colors-violet-600)", textDecoration: "underline" }}>
          {copy.linkText}
        </Link>
        .
      </Text>
    </Box>
  );
}
