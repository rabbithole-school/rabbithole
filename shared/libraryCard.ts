export const LIBRARY_CARD_NUMBER_MAX_LENGTH = 64;
export const LIBRARY_CARD_PIN_MAX_LENGTH = 64;

export const LIBRARY_CARD_HELPER_COPY =
  "Don’t have one yet? No worries—we’ll sign your child up when our class visits the library.";
export const LIBRARY_CARD_CARDHOLDER_COPY =
  "The card can be in your child’s name or a parent or guardian’s name.";

export type LibraryCardField = "cardNumber" | "pin";

export type LibraryCardValidationIssue = {
  kind: "library_card_validation";
  code:
    | "card_number_required"
    | "card_number_too_long"
    | "card_number_unsupported_characters"
    | "pin_required"
    | "pin_too_long"
    | "pin_unsupported_characters";
  field: LibraryCardField;
  message: string;
};

export type LibraryCardConflictError = {
  kind: "library_card_conflict";
  code: "revision_conflict";
  message: string;
};

export type LibraryCardErrorData =
  | LibraryCardValidationIssue
  | LibraryCardConflictError;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export function normalizeLibraryCardInput(
  cardNumber: string,
  pin: string,
): { cardNumber: string; pin: string } {
  return {
    cardNumber: cardNumber.trim(),
    pin: pin.trim(),
  };
}

export function libraryCardValidationIssue(
  cardNumber: string,
  pin: string,
): LibraryCardValidationIssue | null {
  const normalized = normalizeLibraryCardInput(cardNumber, pin);
  if (!normalized.cardNumber) {
    return {
      kind: "library_card_validation",
      code: "card_number_required",
      field: "cardNumber",
      message: "Enter the library card number.",
    };
  }
  if (normalized.cardNumber.length > LIBRARY_CARD_NUMBER_MAX_LENGTH) {
    return {
      kind: "library_card_validation",
      code: "card_number_too_long",
      field: "cardNumber",
      message: `Library card number must be ${LIBRARY_CARD_NUMBER_MAX_LENGTH} characters or fewer.`,
    };
  }
  if (CONTROL_CHARACTERS.test(normalized.cardNumber)) {
    return {
      kind: "library_card_validation",
      code: "card_number_unsupported_characters",
      field: "cardNumber",
      message: "Library card number contains unsupported characters.",
    };
  }
  if (!normalized.pin) {
    return {
      kind: "library_card_validation",
      code: "pin_required",
      field: "pin",
      message: "Enter the library card PIN.",
    };
  }
  if (normalized.pin.length > LIBRARY_CARD_PIN_MAX_LENGTH) {
    return {
      kind: "library_card_validation",
      code: "pin_too_long",
      field: "pin",
      message: `PIN must be ${LIBRARY_CARD_PIN_MAX_LENGTH} characters or fewer.`,
    };
  }
  if (CONTROL_CHARACTERS.test(normalized.pin)) {
    return {
      kind: "library_card_validation",
      code: "pin_unsupported_characters",
      field: "pin",
      message: "PIN contains unsupported characters.",
    };
  }
  return null;
}

export function maskLibraryCardNumber(cardNumber: string): string {
  const normalized = cardNumber.trim();
  if (normalized.length <= 4) return "••••";
  return `•••• ${normalized.slice(-4)}`;
}

export function libraryCredentialRevision(
  credential: object | null | undefined,
  persistedRevision?: number,
): number {
  if (persistedRevision !== undefined) return persistedRevision;
  return credential ? 1 : 0;
}

export function isLibraryCardErrorData(
  value: unknown,
): value is LibraryCardErrorData {
  if (!value || typeof value !== "object" || !("kind" in value)) return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === "library_card_validation" || kind === "library_card_conflict";
}
