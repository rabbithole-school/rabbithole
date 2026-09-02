/**
 * Copy + affordance derivation for the parent "Current physical" card. Kept
 * pure so the four states (nothing on file / awaiting review / accepted /
 * needs replacement) can be asserted without rendering, and so the date
 * formatting stays the caller's business (locale differs per browser).
 */

export type PhysicalExamDocument = {
  fileName: string;
  uploadedAt: number;
  url: string | null;
  reviewStatus: "accepted" | "needs_replacement" | null;
  reviewNote: string | null;
  uploadedByStaff: boolean;
};

export type PhysicalExamCardState = {
  /** Renders the completed-form treatment (green check chip), like a signed form. */
  complete: boolean;
  subtitle: string;
  /** The school's note about why a new document is needed, if they left one. */
  note: string | null;
  actionLabel: string;
  actionVariant: "solid" | "ghost";
};

export function describePhysicalExam(
  document: PhysicalExamDocument | null,
  formatDate: (uploadedAt: number) => string,
): PhysicalExamCardState {
  if (!document) {
    return {
      complete: false,
      subtitle: "Not uploaded.",
      note: null,
      actionLabel: "Upload document",
      actionVariant: "solid",
    };
  }

  if (document.reviewStatus === "needs_replacement") {
    return {
      complete: false,
      subtitle: "The school asked for a new document.",
      note: document.reviewNote ? `School note: ${document.reviewNote}` : null,
      actionLabel: "Upload a new document",
      actionVariant: "solid",
    };
  }

  const uploaded = document.uploadedByStaff
    ? `Uploaded by the school ${formatDate(document.uploadedAt)}.`
    : `Uploaded ${formatDate(document.uploadedAt)}.`;

  return {
    complete: document.reviewStatus === "accepted",
    subtitle:
      document.reviewStatus === "accepted"
        ? uploaded
        : `${uploaded} The school is reviewing it.`,
    note: null,
    actionLabel: "Replace document",
    actionVariant: "ghost",
  };
}
