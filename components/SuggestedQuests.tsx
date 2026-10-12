"use client";

/**
 * "Suggested by your teacher" card. The scholar's own Quests tab now renders
 * teacher suggestions as rows of the ONE open-items list
 * (components/QuestionQueue.tsx); this card remains for the teacher-side Home
 * mirror (components/ScholarHomeMirrorCard).
 *
 * The card is a UnitGroupCard-family card: a quiet unit-path band along the top
 * (quest identity — emoji · title · teacher · "Guided path · N activities"),
 * the same treatment a multi-activity unit in progress uses (UnitGroupBand),
 * over an invitation body + Start CTA. The band is inert identity chrome here
 * (no progress yet); the whole card starts the quest.
 */

import { UnitGroupBand } from "@/components/ui/UnitGroupCard";
import { InvitationCard } from "@/components/ui/InvitationCard";

/**
 * The presentational "Suggested by your teacher" card — a member of the
 * InvitationCard family: a quiet unit-path band (emoji · title · teacher chip ·
 * "Guided path · N activities") over an invitation body, with a `primaryAction`
 * affordance and an optional whole-card `onPress`, or a raised `secondaryAction`
 * slot. Extracted so the teacher-side Home mirror (components/ScholarHomeMirrorCard)
 * can render the SAME card the scholar sees — the scholar surface passes a Start
 * CTA + a whole-card start; the mirror passes a per-card actions menu (Retract).
 */
export function SuggestedQuestCard({
  emoji,
  title,
  teacherName,
  teacherImage,
  activityCount,
  body,
  primaryAction,
  secondaryAction,
  onPress,
  ariaLabel,
  bandAction,
}: {
  emoji: string;
  title: string;
  teacherName: string;
  teacherImage?: string | null;
  activityCount: number;
  body: string | null;
  /** The scholar's non-interactive Start CTA (sits under the full-card press). */
  primaryAction?: React.ReactNode;
  /** The mirror's raised actions menu (its own tap target, no whole-card press). */
  secondaryAction?: React.ReactNode;
  /** The scholar's whole-card start. */
  onPress?: () => void;
  ariaLabel?: string;
  bandAction?: React.ReactNode;
}) {
  const pathMeta =
    activityCount > 0
      ? `Guided path · ${activityCount} ${activityCount === 1 ? "activity" : "activities"}`
      : "Guided path";
  return (
    <InvitationCard
      band={
        <UnitGroupBand
          emoji={emoji}
          title={title}
          completedCount={null}
          activityCount={null}
          teacherName={teacherName}
          teacherImage={teacherImage ?? undefined}
          meta={pathMeta}
          action={bandAction}
        />
      }
      body={body}
      primaryAction={primaryAction}
      secondaryAction={secondaryAction}
      onPress={onPress}
      ariaLabel={ariaLabel}
    />
  );
}
