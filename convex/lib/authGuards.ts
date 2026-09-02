/**
 * Auth guard helpers shared by the @convex-dev/auth callbacks in
 * convex/auth.ts. Extracted here so the security-critical logic — the
 * self-migrating passwordless gate and magic-link account resolution — is
 * unit-testable (the callbacks themselves run inside the convexAuth closure
 * and can't be called directly). See convex/__tests__/authGuards.test.ts.
 */
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { ROLES, canUsePassword, isPasskeyRole } from "./roles";
import { normalizeEmail, isValidEmail } from "./email";

/**
 * Refuse to sign in to (or bootstrap credentials onto) a non-human SERVICE
 * account. Such accounts (e.g. the onboarding owner "rabbithole-guide") are
 * hard-coded, passwordless, and never enroll a passkey — without this gate
 * their seeded row would be a standing account-takeover claim via the password
 * sign-up path. Used by BOTH the password callback (convex/auth.ts) and the
 * magic-link resolver below.
 */
export function assertNotSystemAccount(
  user: { isSystem?: boolean } | null | undefined,
): void {
  if (user?.isSystem) {
    throw new Error("This account can't be signed in to.");
  }
}

/**
 * Refuse to bootstrap a PASSWORD onto an account that is still awaiting
 * passwordless enrollment (an invite-created staff account — see
 * `users.pendingEnrollment`). Such an account has no credential yet; without
 * this gate the password sign-up path would happily bind a password to it, so
 * an abandoned invite would leave a school_admin row anyone who guesses the
 * username could claim. The account's only sign-in path is the passkey
 * enrollment link that created it (the passkey ceremony clears this flag).
 * Mirrors `assertNotSystemAccount`.
 */
export function assertNotPendingEnrollment(
  user: { pendingEnrollment?: boolean } | null | undefined,
): void {
  if (user?.pendingEnrollment) {
    throw new Error(
      "This account is finishing setup — use the enrollment link you were sent.",
    );
  }
}

/**
 * How long a granted password-bind stays usable. Only has to cover one
 * `createAccount` round-trip inside a single action, so it is deliberately
 * tight — a grant that outlives its request is just a wider window.
 */
export const PASSWORD_BIND_GRANT_MS = 60 * 1000; // 60 seconds

/**
 * Refuse to bind a password onto an existing SCHOLAR row through the public
 * password sign-up path — the "username coupon" hole (TODO #scholar-self-claim).
 *
 * A scholar's username is not a secret: it is on the staff roster, printed on
 * emergency one-pagers, and spoken aloud in class. Until this gate, a scholar
 * who had no password credential yet (every seeded scholar, and every real one
 * who had not redeemed an enroll link) could be CLAIMED by anyone who knew that
 * username — `flow: "signUp"` would land in the adopt-existing-row branch of
 * `createOrUpdateUser` and bind an attacker-chosen password to a real child's
 * account. The sibling guards covered service accounts
 * (`assertNotSystemAccount`), invite-pending staff
 * (`assertNotPendingEnrollment`) and passkey'd staff
 * (`blockPasswordIfPasskeyEnrolled`) — scholars fell through all three.
 *
 * The legitimate ways a scholar gets a credential both stamp a short-lived
 * `passwordBindAllowedUntil` grant first: redeeming a one-time enroll link
 * (the token proves it — `enrollment.prepareScholarForEnroll`) and changing
 * their own password while signed in (their session proves it —
 * `accountPassword.setMyPassword`). Everything else is refused.
 *
 * The grant is consumed here, so it is single-use: a second sign-up racing the
 * same window finds it already cleared. It could not be carried in the account
 * `profile` instead — @convex-dev/auth types that to the `users` schema, so an
 * arbitrary marker key does not compile.
 *
 * DELIBERATELY SCOPED TO SCHOLARS. A staff account with neither a passkey nor a
 * password is adoptable by the same path, but that is the documented
 * self-migration ramp in `.claude/rules/rabbithole-passkeys.md` ("a staffer with
 * zero passkeys can still password-login once, and is immediately forced into
 * enrollment"), and closing it would strand any legacy staffer mid-migration.
 * That residual is narrower (staff are few, known, and mostly migrated) and is
 * a separate call — not something to widen silently under a scholar fix.
 */
export async function assertScholarAdoptionAuthorized(
  ctx: MutationCtx,
  user: { _id: Id<"users">; role?: string; passwordBindAllowedUntil?: number },
): Promise<void> {
  if (user.role !== ROLES.SCHOLAR) return;
  const grantedUntil = user.passwordBindAllowedUntil ?? 0;
  if (grantedUntil > Date.now()) {
    // Consume it — one grant, one bind.
    await ctx.db.patch(user._id, { passwordBindAllowedUntil: undefined });
    return;
  }
  throw new Error("Ask your teacher for a sign-in link to set your password.");
}

/**
 * Open a {@link PASSWORD_BIND_GRANT_MS} window in which this scholar's row may
 * receive a password through the auth callback. Callers MUST have proven
 * authorization first — a valid one-time enroll token, or the user's own
 * authenticated session.
 */
export async function grantPasswordBind(
  ctx: MutationCtx,
  userId: Id<"users">,
): Promise<void> {
  await ctx.db.patch(userId, {
    passwordBindAllowedUntil: Date.now() + PASSWORD_BIND_GRANT_MS,
  });
}

/**
 * Resolve a magic-link sign-in to a pre-provisioned account that has a real
 * email on file. Magic-link NEVER creates accounts — it only resolves an
 * existing one — and it's capability-based, not role-based: any user type
 * (staff, parent, OR scholar) that has set an email can use it. There is no
 * role allowlist; auth method follows the credential the account has. The
 * `isValidEmail` guard rejects the synthetic `username@local` Password
 * address (no dot in the domain), so a password-only account can't be
 * magic-linked into. `sendVerificationRequest` also pre-checks eligibility
 * so we don't email a link to a non-account.
 */
export async function resolveMagicLinkUser(
  ctx: MutationCtx,
  args: {
    existingUserId: Id<"users"> | null;
    profile: { email?: string; emailVerified?: boolean };
  },
): Promise<Id<"users">> {
  const existing = args.existingUserId
    ? await ctx.db.get(args.existingUserId)
    : null;
  const email = normalizeEmail(args.profile.email ?? "");
  const user =
    existing ??
    (email
      ? await ctx.db
          .query("users")
          .withIndex("by_email", (q) => q.eq("email", email))
          .unique()
      : null);

  if (!user || !isValidEmail(user.email ?? "")) {
    throw new Error("This email is not authorized for sign-in");
  }
  // Non-human service accounts are never sign-in-able (defense in depth — the
  // onboarding owner has no email so it can't be resolved here anyway, but
  // never let one be claimed even if an email is ever set on it).
  assertNotSystemAccount(user);
  // Only the VERIFY leg proves inbox control. This callback also runs during
  // magic-link REQUEST, before anything has been proven; stamping that leg
  // would let anyone who knows an address mark its account email as verified.
  // Trusted-entry mutations may already have stamped it, so never overwrite.
  if (args.profile.emailVerified === true && !user.emailVerificationTime) {
    await ctx.db.patch(user._id, { emailVerificationTime: Date.now() });
  }
  // Deliberately DO NOT clear `pendingEnrollment` here. In @convex-dev/auth
  // (v0.0.94) the custom `createOrUpdateUser` callback — and therefore this
  // resolver — runs inside `upsertUserAndAccount`, which is invoked at magic-
  // link REQUEST time (createVerificationCode, before any email is sent), NOT
  // only at click/verify time (verifyCodeAndSignIn). So an UNAUTHENTICATED
  // caller doing `signIn("magic-link", { email: <victim> })` reaches this code
  // WITHOUT ever receiving the link. Clearing the flag here would let an
  // attacker remotely un-gate a pending school-admin account and then claim its
  // username via password sign-up (the very takeover pendingEnrollment exists
  // to prevent). The flag is therefore cleared ONLY by the passkey enrollment
  // ceremony (passkeys.insertCredential), which requires possession of the
  // one-time enroll link. A staff account that only ever uses magic-link simply
  // stays pending forever — harmless by design: `pendingEnrollment` blocks only
  // password-BINDING, and magic-link sign-in still works for them (this resolver
  // returns their id below regardless of the flag).
  return user._id;
}

/**
 * Self-migrating passwordless rule: a passkey-eligible account (any staff
 * role OR parent) that already has a passkey may NOT sign in with a
 * password (they're passwordless). Such accounts with zero passkeys can
 * still password-login once — the frontend then forces them into passkey
 * enrollment, after which this guard retires their password automatically.
 * No env flag needed. Keyed on `isPasskeyRole` (not `isStaffRole`) so the
 * rule covers parents too, not just staff. Scholars are deliberately
 * excluded: a scholar's passkey is additive, so their password keeps
 * working (no lockout risk).
 */
export async function blockPasswordIfPasskeyEnrolled(
  ctx: MutationCtx,
  userId: Id<"users">,
): Promise<void> {
  const user = await ctx.db.get(userId);
  if (!user || !isPasskeyRole(user.role)) return;
  const passkey = await ctx.db
    .query("passkeys")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
  if (!canUsePassword(user.role, passkey !== null)) {
    throw new Error("This account signs in with a passkey");
  }
}
