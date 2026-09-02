export const MIN_PASSWORD_LENGTH = 4;

export type PasswordAuthFlow = "signIn" | "signUp";

/** Password credentials ignore accidental whitespace at either edge. */
export function normalizePassword(password: string): string {
  return password.trim();
}

export function passwordsMatch(password: string, confirmation: string): boolean {
  return normalizePassword(password) === normalizePassword(confirmation);
}

export function passwordAuthParams<TFlow extends PasswordAuthFlow>(
  password: string,
  flow: TFlow,
): { password: string; flow: TFlow } {
  // The provider normalizes new credentials itself. Preserve the entered value
  // here so it can authenticate hashes made before normalization was introduced.
  return { password, flow };
}
