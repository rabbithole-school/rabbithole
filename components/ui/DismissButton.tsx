"use client";

/**
 * DismissButton — the quiet × on a Scholar's Prep row that dismisses it for
 * good: a Keep going row (components/QuestionQueue, its top-right corner) and
 * a wonder row (components/ui/ListRow, after the verb). One look and one
 * accessible name ("Dismiss <title>") for both. Native twin:
 * native/src/components/ui/DismissButton.tsx.
 *
 * Home's session rows use the same × to archive (`action` = "Archive"), so
 * every scholar list clears a row the same way.
 */

import { IconButton } from "@chakra-ui/react";
import { X } from "@phosphor-icons/react";
import { QUESTION_QUEUE_COPY } from "@/shared/questionQueue";

export function DismissButton({
  label,
  onPress,
  disabled = false,
  action = QUESTION_QUEUE_COPY.dismiss,
}: {
  /** The row's title, for the accessible name. */
  label: string;
  /** The verb in the accessible name ("Dismiss", or Home's "Archive"). */
  action?: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <IconButton
      size="sm"
      variant="ghost"
      colorPalette="gray"
      color="charcoal.400"
      aria-label={`${action} ${label}`}
      title={action}
      disabled={disabled}
      onClick={onPress}
      _focusVisible={{ outline: "2px solid", outlineColor: "violet.400", outlineOffset: "2px" }}
    >
      <X aria-hidden="true" />
    </IconButton>
  );
}
