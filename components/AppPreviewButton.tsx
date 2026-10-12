"use client";

/**
 * The "Preview" affordance on the teacher Apps tab — opens an External App's
 * scholar launch URL in a NEW TAB so a teacher can see the app exactly as a
 * scholar does, without switching accounts. Never renders the app inside the
 * dashboard.
 *
 * A quiet ghost icon button: on a row it sits before "Make focus" and stays
 * visually subordinate to it (Make focus is the headline action). It reuses the
 * same catalog `webUrl` the scholar launcher opens (`useExternalApp`), via the
 * one `appPreviewTarget` helper — no second URL is hand-built. When an app
 * can't be previewed the button is disabled with a tooltip saying why.
 */

import { Portal, Tooltip, chakra } from "@chakra-ui/react";
import { Eye } from "@phosphor-icons/react";
import { appPreviewTarget, type AppPreviewInput } from "@/shared/appPreview";

export function AppPreviewButton({
  app,
  size = 28,
}: {
  app: AppPreviewInput & { name: string };
  /** Square button size in px (row + drawer both use the quiet 28px form). */
  size?: number;
}) {
  const { href, disabledReason } = appPreviewTarget(app);
  const label = `Preview ${app.name}`;
  const tip = disabledReason ?? "Open as a scholar sees it";

  const trigger =
    href !== null ? (
      <chakra.a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        display="flex"
        alignItems="center"
        justifyContent="center"
        borderRadius="md"
        w={`${size}px`}
        h={`${size}px`}
        color="charcoal.300"
        cursor="pointer"
        _hover={{ color: "violet.500", bg: "violet.50" }}
        _focusVisible={{
          outline: "2px solid",
          outlineColor: "violet.400",
          outlineOffset: "2px",
        }}
        aria-label={label}
        onClick={(e) => e.stopPropagation()}
      >
        <Eye size={16} weight="bold" />
      </chakra.a>
    ) : (
      <chakra.span
        display="flex"
        alignItems="center"
        justifyContent="center"
        borderRadius="md"
        w={`${size}px`}
        h={`${size}px`}
        color="charcoal.200"
        cursor="not-allowed"
        role="button"
        tabIndex={0}
        aria-label={label}
        aria-disabled="true"
        onClick={(e) => e.stopPropagation()}
      >
        <Eye size={16} weight="bold" />
      </chakra.span>
    );

  return (
    <Tooltip.Root openDelay={300} closeDelay={0}>
      <Tooltip.Trigger asChild>{trigger}</Tooltip.Trigger>
      <Portal>
        <Tooltip.Positioner>
          <Tooltip.Content
            maxW="220px"
            fontFamily="heading"
            fontSize="xs"
          >
            {tip}
          </Tooltip.Content>
        </Tooltip.Positioner>
      </Portal>
    </Tooltip.Root>
  );
}
