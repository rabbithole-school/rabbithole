import type { Doc } from "../_generated/dataModel";

type FingerprintLetter = Pick<
  Doc<"specialDeliveryLetters">,
  | "scholarId"
  | "contentFingerprint"
  | "copyVersion"
  | "factsHash"
  | "insert"
>;

export function specialDeliveryBatchFingerprint(
  letters: readonly FingerprintLetter[],
): string {
  const letterFingerprints = letters
    .map((letter) =>
      JSON.stringify({
        scholarId: String(letter.scholarId),
        contentFingerprint:
          letter.contentFingerprint ??
          `${letter.copyVersion}:${letter.factsHash}`,
        insert:
          letter.insert?.kind === "portfolio" ||
          letter.insert?.kind === "sketch"
            ? {
                kind: letter.insert.kind,
                storageId: String(letter.insert.storageId),
                mime: letter.insert.mime,
                caption: letter.insert.caption,
              }
            : null,
      }),
    )
    .sort();
  return JSON.stringify(letterFingerprints);
}
