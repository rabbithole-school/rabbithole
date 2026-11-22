"use client";

import { Button } from "@chakra-ui/react";
import { CheckCircle, PaperPlaneTilt } from "@phosphor-icons/react";

/**
 * The session header's hand-it-to-the-teacher pill, the web twin of native
 * `HeaderPillButton` with `TEACHER_HANDOFF_ICON`: a paper plane and a short
 * label, or a checkmark once it is done. It only opens its caller's pop-up.
 * Homework's "I'm done with this" and a Quest's "I'm ready to show" (TRA-720)
 * draw it, so the two read as the same button.
 */
export function TeacherHandoffPill({
  done,
  label,
  ariaLabel,
  onClick,
}: {
  done: boolean;
  label: string;
  /** Defaults to `label`. */
  ariaLabel?: string;
  onClick: () => void;
}) {
  return (
    <Button
      size="sm"
      variant="outline"
      borderRadius="full"
      fontFamily="heading"
      fontWeight="600"
      color="violet.600"
      borderColor="gray.300"
      flexShrink={0}
      aria-label={ariaLabel ?? label}
      onClick={onClick}
    >
      {done ? <CheckCircle size={16} weight="fill" /> : <PaperPlaneTilt size={16} />}
      {label}
    </Button>
  );
}
