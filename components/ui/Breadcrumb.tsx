"use client";

/**
 * DRY teacher-UI breadcrumb (Chakra v3 Breadcrumb + next/link).
 *
 * Pass an ordered list of crumbs; the LAST one renders as the current page
 * (no link), earlier ones with an `href` are real links (cmd/middle-click,
 * copy-link preserved). Use for scholar-first drill-ins, e.g.
 *   All scholars › Emma Higa › Whole Child
 */
import { Fragment } from "react";
import NextLink from "next/link";
import { Breadcrumb as CB } from "@chakra-ui/react";

export type Crumb = { label: string; href?: string };

export function Breadcrumb({ items }: { items: Crumb[] }) {
  return (
    <CB.Root fontFamily="heading" fontSize="sm" userSelect="none">
      <CB.List>
        {items.map((c, i) => {
          const isLast = i === items.length - 1;
          return (
            <Fragment key={`${c.label}-${i}`}>
              <CB.Item>
                {c.href && !isLast ? (
                  <CB.Link asChild color="charcoal.400" fontWeight="600" _hover={{ color: "violet.600" }}>
                    <NextLink href={c.href}>{c.label}</NextLink>
                  </CB.Link>
                ) : (
                  <CB.CurrentLink color="navy.600" fontWeight="700">
                    {c.label}
                  </CB.CurrentLink>
                )}
              </CB.Item>
              {!isLast && <CB.Separator color="charcoal.300" />}
            </Fragment>
          );
        })}
      </CB.List>
    </CB.Root>
  );
}
