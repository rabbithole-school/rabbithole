// Pure helpers behind the scholar password affordance (ScholarSignInLink.tsx +
// the add-scholar success state + ScholarProfile's Account card). Extracted so
// the "can we issue a link, or do we need a username first" decision and the
// Create-vs-Reset label are unit-testable without a DOM harness.
//
// NOMENCLATURE: this secret is a PASSWORD, not a PIN. It's the Convex Auth
// `password` provider's secret for the synthetic `<username>@local` account,
// validated only on length (≥4 chars, any characters — see
// convex/enrollment.ts redeemScholarEnrollToken). "PIN" was inherited from the
// dead 4-digit `users.resetScholarPassword` temp-PIN flow and outlived it; it
// also collides with two secrets that ARE numeric PINs — the library-card PIN
// (users.libraryCredential) and the ASAM parent gate. Both sign-in forms
// (components/AuthForm.tsx, native/src/components/SignIn.tsx) already say
// "Password", so this naming keeps the whole ceremony on one noun.

// Not an error: "Add scholar" leaves the username optional because a school
// iPad signs in through device setup. A password is the one thing that needs it.
export const NO_USERNAME_GUIDANCE =
  "A password needs a username first. Add one in their Account details, then create the password there. School iPads sign in without one.";

// A missing username is caught before a link is requested, so a failure here
// is something else — prod redacts the server's reason, so just offer a retry.
export const ISSUE_FAILED_GUIDANCE = "Couldn't create the link. Try again.";

/**
 * The single name for this affordance: "Create password" when the scholar has
 * never had one, "Reset password" once one exists. `hasCredential` comes from
 * the roster/profile query (`scholarHasPasswordCredential` server-side). A
 * brand-new scholar (undefined or false) must read "Create password", never
 * "Reset password" — the safe default.
 */
export function passwordActionLabel(
  hasCredential: boolean | undefined,
): "Create password" | "Reset password" {
  return hasCredential ? "Reset password" : "Create password";
}

/**
 * A scholar signs in with a username + password, and the one-time /enroll link
 * keys off the username — so a link can only be issued once a (non-blank)
 * username exists. Mirrors the server guard in `mintScholarPinToken`.
 */
export function canIssueSignInLink(
  username: string | null | undefined,
): boolean {
  return typeof username === "string" && username.trim().length > 0;
}
