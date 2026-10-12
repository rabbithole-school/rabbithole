import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { isProgramGuest } from "./enrollmentStanding";
import { EXTENDED_EDUCATION_LABEL } from "../../shared/scholarGroupRouting";

type ConsentCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;
type MediaConsentStatus =
  | "granted"
  | "missing_enrolled_consent"
  | "missing_visiting_student_form"
  | "missing_visiting_student_release"
  | "declined_visiting_student_release";

export function portfolioItemContainsIdentifiableMedia(
  item: Pick<Doc<"portfolioItems">, "source" | "fileMimeType">,
): boolean {
  return (
    item.source === "capture_station" ||
    item.source === "photo" ||
    item.fileMimeType?.startsWith("image/") === true ||
    item.fileMimeType?.startsWith("video/") === true ||
    item.fileMimeType?.startsWith("audio/") === true
  );
}

export async function hasSchoolMediaConsent(
  ctx: ConsentCtx,
  scholarId: Id<"users">,
): Promise<boolean> {
  return (await schoolMediaConsentStatus(ctx, scholarId)) === "granted";
}

export async function schoolMediaConsentStatus(
  ctx: ConsentCtx,
  scholarId: Id<"users">,
): Promise<MediaConsentStatus> {
  const scholar = await ctx.db.get(scholarId);
  if (!scholar || scholar.role !== "scholar") return "missing_enrolled_consent";
  if (isProgramGuest(scholar)) {
    const submission = await ctx.db
      .query("guardianFormSubmissions")
      .withIndex("by_scholar_form", (q) =>
        q
          .eq("scholarId", scholarId)
          .eq("formId", "extended_education_visiting_student"),
      )
      .unique();
    if (
      !submission ||
      submission.answers.kind !== "extended_education_visiting_student"
    ) {
      return "missing_visiting_student_form";
    }
    if (submission.answers.mediaRelease === "grant") return "granted";
    if (submission.answers.mediaRelease === "do_not_grant") {
      return "declined_visiting_student_release";
    }
    return "missing_visiting_student_release";
  }

  const record = await ctx.db
    .query("scholarHealthRecords")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .unique();
  if (
    !record?.standardProgramAcknowledgedAt ||
    !record.signerAgreement ||
    record.privateSchoolMediaOptOut === true
  ) {
    return "missing_enrolled_consent";
  }
  return "granted";
}

export async function allScholarsHaveSchoolMediaConsent(
  ctx: ConsentCtx,
  scholarIds: Id<"users">[],
): Promise<boolean> {
  if (scholarIds.length === 0) return false;
  const consent = await Promise.all(
    scholarIds.map((scholarId) => hasSchoolMediaConsent(ctx, scholarId)),
  );
  return consent.every(Boolean);
}

export async function portfolioFamilySharingEligibility(
  ctx: ConsentCtx,
  scholarIds: Id<"users">[],
  requiresMediaConsent: boolean,
): Promise<{ allowed: boolean; blocker: string | null }> {
  if (scholarIds.length === 0) {
    return { allowed: false, blocker: "Tag at least one scholar first." };
  }
  const consentStatuses = await Promise.all(
    scholarIds.map((scholarId) => schoolMediaConsentStatus(ctx, scholarId)),
  );
  if (consentStatuses.includes("missing_visiting_student_form")) {
    return {
      allowed: false,
      blocker: `An ${EXTENDED_EDUCATION_LABEL} scholar in this work has no submitted visiting-student form.`,
    };
  }
  if (!requiresMediaConsent) {
    return { allowed: true, blocker: null };
  }
  if (consentStatuses.includes("declined_visiting_student_release")) {
    return {
      allowed: false,
      blocker: `An ${EXTENDED_EDUCATION_LABEL} scholar in this work has declined the media release on the visiting-student form.`,
    };
  }
  if (consentStatuses.includes("missing_visiting_student_release")) {
    return {
      allowed: false,
      blocker: `An ${EXTENDED_EDUCATION_LABEL} scholar in this work has no media release on the visiting-student form.`,
    };
  }
  if (consentStatuses.some((status) => status !== "granted")) {
    return {
      allowed: false,
      blocker: "A scholar in this work has no signed media consent.",
    };
  }
  return { allowed: true, blocker: null };
}

/**
 * The family-facing reading of media consent, for the parent portal's course
 * view. An ENROLLED scholar's media consent rides on the annual health record,
 * which the portal already surfaces on its own card — so the course view says
 * nothing about it ("not_applicable"). A PROGRAM GUEST's consent is the media
 * release on the visiting-student form, which is exactly the thing a family can
 * act on from here, so its three states collapse to "have we got the form at
 * all" vs "did they grant".
 */
export async function familyMediaReleaseStatus(
  ctx: ConsentCtx,
  scholarId: Id<"users">,
): Promise<"not_applicable" | "granted" | "not_granted" | "form_missing"> {
  const scholar = await ctx.db.get(scholarId);
  if (!scholar || !isProgramGuest(scholar)) return "not_applicable";
  const status = await schoolMediaConsentStatus(ctx, scholarId);
  if (status === "missing_visiting_student_form") return "form_missing";
  return status === "granted" ? "granted" : "not_granted";
}

export function captureRosterName(scholar: Pick<Doc<"users">, "name">): string {
  const parts = scholar.name?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (parts.length === 0) return "Scholar";
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts.at(-1)?.[0] ?? ""}.`;
}
