export const SERIAL_PREVIEW_LIMIT = 8;

type RegistrationResult = {
  serial: string;
  ok: boolean;
  skipped?: boolean;
};

export function registrationFeedback(results: RegistrationResult[]) {
  const added = results.filter((result) => result.ok).length;
  const skipped = results.filter((result) => result.skipped).length;
  const invalid = results.filter(
    (result) => !result.ok && !result.skipped,
  ).length;
  const problemParts: string[] = [];
  if (skipped > 0) problemParts.push(`${skipped} skipped`);
  if (invalid > 0) problemParts.push(`${invalid} invalid`);
  const failedSerials = results
    .filter((result) => !result.ok)
    .map((result) => result.serial || "Invalid serial");
  const uniqueFailedSerials = [...new Set(failedSerials)];
  const serialPreview = uniqueFailedSerials.slice(0, SERIAL_PREVIEW_LIMIT);
  const remainingSerials = uniqueFailedSerials.length - serialPreview.length;
  const problemDescription =
    problemParts.length > 0
      ? `${problemParts.join(" · ")} — ${serialPreview.join(", ")}${
          remainingSerials > 0 ? `, +${remainingSerials} more` : ""
        }`
      : "";

  if (added === 0) {
    return {
      status: "error" as const,
      title: "No devices added",
      description:
        problemDescription
          ? `${problemDescription}. Review the serials below.`
          : "Review the serials below and try again.",
      added,
    };
  }

  return {
    status: "success" as const,
    title: `${added} device${added === 1 ? "" : "s"} added`,
    description:
      problemDescription
        ? `${problemDescription} need attention.`
        : "Assign scholars from the roster when you're ready.",
    added,
  };
}
