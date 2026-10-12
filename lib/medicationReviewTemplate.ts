// The guardian-facing note template staff see pre-filled when they choose
// "Needs replacement" on the Medication Authorization staff review. Pure and
// UI-free so it's cheaply testable: given the per-medication expiry rows the
// reviewer has transcribed, it auto-fills each expiration date and leaves the
// remaining-doses count as an explicit fill-in placeholder — nothing in the
// record tracks how many doses are left, only a reviewer holding the
// medication does. Reviewers are free to edit every word; this only saves
// them the boilerplate.

export type MedicationExpiryDraftRow = { name: string; date: string };

const DOSES_PLACEHOLDER = "___";

function formatExpiryDate(date: string): string {
  const ms = Date.parse(`${date}T00:00:00.000Z`);
  if (Number.isNaN(ms)) return date;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date(ms));
}

export function medicationReplacementNoteTemplate(
  expirations: MedicationExpiryDraftRow[],
): string {
  const named = expirations.filter((row) => row.name.trim().length > 0);
  const rows = named.length > 0 ? named : [{ name: "", date: "" }];
  const lines = rows.map((row) => {
    const label = row.name.trim() || "[medication name]";
    const expiry = row.date ? formatExpiryDate(row.date) : "[expiration date]";
    return `- ${label}: expires ${expiry}, approximately ${DOSES_PLACEHOLDER} doses remaining`;
  });

  return [
    "Hi,",
    "",
    "Our records show your child's medication authorization on file needs to be renewed:",
    "",
    ...lines,
    "",
    "Please ask your child's physician to complete a new Medication Authorization form and send it to the school before the medication runs out or the authorization expires, whichever comes first.",
    "",
    "Thank you!",
  ].join("\n");
}
