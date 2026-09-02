"use client";

import { Button } from "@chakra-ui/react";
import { BookmarkSimple } from "@phosphor-icons/react";

const FOCUS_RING = {
  outline: "2px solid",
  outlineColor: "violet.400",
  outlineOffset: "2px",
} as const;

export function TakeHomePinButton({
  pinned,
  busy = false,
  onToggle,
  subject,
}: {
  pinned: boolean;
  busy?: boolean;
  onToggle: () => void | Promise<unknown>;
  subject: string;
}) {
  const label = pinned ? "Added" : "Add";
  return (
    <Button
      size="sm"
      minH="44px"
      w="88px"
      variant={pinned ? "subtle" : "outline"}
      colorPalette="violet"
      aria-label={`${pinned ? "Remove" : "Add"} ${subject} ${pinned ? "from" : "to"} take-home list`}
      aria-pressed={pinned}
      disabled={busy}
      onClick={onToggle}
      _focusVisible={FOCUS_RING}
    >
      <BookmarkSimple aria-hidden="true" size={16} weight={pinned ? "fill" : "regular"} />
      {label}
    </Button>
  );
}
