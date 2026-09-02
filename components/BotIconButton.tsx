"use client";

import { IconButton, Portal, Tooltip } from "@chakra-ui/react";
import { Robot } from "@phosphor-icons/react";

interface BotIconButtonProps {
  onClick: () => void;
  /** Aria-label for the underlying IconButton. Defaults to a generic open
   *  label. Override when the button toggles (e.g., "Close Curriculum Bot"
   *  when the panel is already open). */
  ariaLabel?: string;
  /** Tooltip text shown on hover. Defaults to the aria-label. */
  tooltipText?: string;
  /** Icon color. Defaults to violet.500 (matches the curriculum-bot
   *  identity in the unit designer). */
  color?: string;
  /** Hover background. Defaults to gray.100. The Test Drive cyan banner
   *  passes "white" so the icon hover stays readable against `cyan.50`. */
  hoverBg?: string;
  /** Toggle mode: when defined, the button renders as a pressed/unpressed
   *  toggle (aria-pressed + a violet.50 active tint), matching the teacher
   *  header's aide Robot. Leave undefined for plain one-shot triggers. */
  active?: boolean;
}

/**
 * The single Curriculum Bot trigger affordance — a duotone Robot icon
 * inside a violet IconButton wrapped in a Chakra Tooltip. Used in the
 * unit designer header (toggles the chat pane), the project header
 * (remote-mode bot trigger), the Test Drive cyan banner, and (in toggle
 * mode via `active`) the parent portal header's aide-dock toggle.
 *
 * Keeping all three call sites on one component prevents visual drift
 * (icon weight, color, size) when one site is updated and others
 * aren't. The Robot icon plus violet color is the canonical "the bot"
 * affordance across the app.
 */
export function BotIconButton({
  onClick,
  ariaLabel = "Open Curriculum Bot",
  tooltipText,
  color = "violet.500",
  hoverBg = "gray.100",
  active,
}: BotIconButtonProps) {
  const tip = tooltipText ?? ariaLabel;
  return (
    <Tooltip.Root openDelay={300} closeDelay={0}>
      <Tooltip.Trigger asChild>
        <IconButton
          aria-label={ariaLabel}
          aria-pressed={active}
          size="sm"
          variant="ghost"
          color={active ? "violet.600" : color}
          bg={active ? "violet.50" : undefined}
          _hover={{ bg: active === undefined ? hoverBg : "violet.50", color: active === undefined ? undefined : "violet.600" }}
          onClick={onClick}
          flexShrink={0}
        >
          <Robot size={18} weight="duotone" />
        </IconButton>
      </Tooltip.Trigger>
      <Portal>
        <Tooltip.Positioner>
          <Tooltip.Content>{tip}</Tooltip.Content>
        </Tooltip.Positioner>
      </Portal>
    </Tooltip.Root>
  );
}
