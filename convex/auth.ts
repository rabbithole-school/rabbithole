import { convexAuth } from "@convex-dev/auth/server";
import { Password } from "@convex-dev/auth/providers/Password";
import { ConvexCredentials } from "@convex-dev/auth/providers/ConvexCredentials";
import { Email } from "@convex-dev/auth/providers/Email";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
} from "@simplewebauthn/server";
import { getPasskeyConfig } from "./lib/passkeyConfig";
import {
  sha256Hex,
  pkceChallengeFromVerifier,
  isValidPkceVerifier,
} from "./lib/oauthCrypto";
import { normalizeEmail } from "./lib/email";
import {
  resolveMagicLinkUser,
  blockPasswordIfPasskeyEnrolled,
  assertNotSystemAccount,
  assertNotPendingEnrollment,
  assertScholarAdoptionAuthorized,
} from "./lib/authGuards";
import { sendMagicLinkEmail } from "./lib/magicLinkEmail";
import { MAGIC_LINK_PROVIDER_ID } from "./lib/authConstants";
import { passwordCrypto } from "./lib/passwordCrypto";
import { isPublicProductionDeployment } from "./lib/deploymentSafety";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import {
  MIN_PASSWORD_LENGTH,
  normalizePassword,
} from "../shared/password";

// Magic-link provider id is shared with the client via lib/authConstants.
// Hyphen is fine — we read the Resend key from `AUTH_RESEND_KEY` directly,
// not the provider's default `AUTH_<ID>_KEY` convention.
const MAGIC_LINK_TTL_SECONDS = 15 * 60; // 15 minutes


export const { auth, signIn, signOut, store } = convexAuth({
  providers: [
    // ── Password (scholars; staff during rollout until passwordless) ────
    Password({
      validatePasswordRequirements: (password: string) => {
        if (normalizePassword(password).length < MIN_PASSWORD_LENGTH) {
          throw new Error(
            `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
          );
        }
      },
      crypto: passwordCrypto,
    }),

    // ── Passkey (passwordless sign-in for staff) ────────────────────────
    // Two-step ceremony: the client first calls
    // `passkeys.startAuthentication` (gets options + challengeId), runs the
    // browser ceremony, then calls signIn("passkey", { response,
    // challengeId }). We verify the assertion here and return the matched
    // userId, which mints the Convex Auth session. No password involved.
    ConvexCredentials({
      id: "passkey",
      authorize: async (
        credentials,
        ctx,
      ): Promise<{ userId: Id<"users"> } | null> => {
        const responseRaw = credentials.response;
        const challengeId = credentials.challengeId;
        if (typeof responseRaw !== "string" || typeof challengeId !== "string") {
          return null;
        }

        // Consume the one-shot challenge (anti-replay).
        const taken = await ctx.runMutation(internal.passkeys.takeChallenge, {
          challengeId: challengeId as Id<"webauthnChallenges">,
          type: "authentication",
        });
        if (!taken) return null;

        let response: AuthenticationResponseJSON;
        try {
          response = JSON.parse(responseRaw) as AuthenticationResponseJSON;
        } catch {
          return null;
        }

        // Find the credential the assertion was signed with.
        const passkey = await ctx.runQuery(
          internal.passkeys.getByCredentialId,
          { credentialId: response.id },
        );
        if (!passkey) return null;

        const { rpID, origins } = getPasskeyConfig();
        let verification;
        try {
          verification = await verifyAuthenticationResponse({
            response,
            expectedChallenge: taken.challenge,
            expectedOrigin: origins,
            expectedRPID: rpID,
            requireUserVerification: false,
            credential: {
              id: passkey.credentialId,
              publicKey: isoBase64URL.toBuffer(passkey.publicKey),
              counter: passkey.counter,
              transports: passkey.transports as
                | AuthenticatorTransportFuture[]
                | undefined,
            },
          });
        } catch {
          return null;
        }
        if (!verification.verified) return null;

        await ctx.runMutation(internal.passkeys.recordAuthentication, {
          passkeyId: passkey._id,
          newCounter: verification.authenticationInfo.newCounter,
          deviceType: verification.authenticationInfo.credentialDeviceType,
          backedUp: verification.authenticationInfo.credentialBackedUp,
        });

        return { userId: passkey.userId };
      },
    }),

    // ── MCP connector (OAuth 2.1 authorization-code + PKCE) ─────────────
    // The token half of the remote MCP connector. /api/oauth/token calls
    // signIn("mcp", { code, codeVerifier, clientId, redirectUri }); we
    // consume the one-shot authorization code minted by mcpOauth.approve
    // (so it's bound to the user who consented), verify the PKCE S256
    // challenge, and return that userId — which mints a normal Convex Auth
    // session. The MCP access token IS a standard Convex JWT; refresh runs
    // through the stock `auth:signIn { refreshToken }` path. No password,
    // no bearer table — the session is revocable like any other.
    ConvexCredentials({
      id: "mcp",
      authorize: async (
        credentials,
        ctx,
      ): Promise<{ userId: Id<"users"> } | null> => {
        const { code, codeVerifier, clientId, redirectUri } = credentials;
        if (
          typeof code !== "string" ||
          typeof codeVerifier !== "string" ||
          typeof clientId !== "string" ||
          typeof redirectUri !== "string"
        ) {
          return null;
        }
        if (!isValidPkceVerifier(codeVerifier)) return null;

        // One-shot consume (a failed attempt burns the code — anti-replay).
        const grant = await ctx.runMutation(internal.mcpOauth.takeCode, {
          codeHash: await sha256Hex(code),
        });
        if (!grant) return null;
        if (grant.clientId !== clientId) return null;
        if (grant.redirectUri !== redirectUri) return null;

        const challenge = await pkceChallengeFromVerifier(codeVerifier);
        if (challenge !== grant.codeChallenge) return null;

        return { userId: grant.userId };
      },
    }),

    // ── Native embed-session handoff (one-shot token) ───────────────────
    // The PROD auth bridge for the native inline manipulative renderer. The
    // web `/embed/manipulative` route loads inside a session-less
    // react-native-webview; the already-authenticated native app mints a
    // one-shot token for ITS OWN identity (embedAuth.issueEmbedToken) and
    // hands it over in the URL fragment. Here we consume it atomically
    // (single-use, ≤120s TTL — a replay/expired token yields null) and return
    // that userId, which mints a normal, revocable Convex Auth session. No
    // password, no shared cookie. Replaces the dev-only /dev-login redirect.
    // See convex/embedAuth.ts.
    ConvexCredentials({
      id: "embedToken",
      authorize: async (
        credentials,
        ctx,
      ): Promise<{ userId: Id<"users"> } | null> => {
        const token = credentials.token;
        if (typeof token !== "string" || !token) return null;
        const consumed = await ctx.runMutation(
          internal.embedAuth.consumeEmbedToken,
          { token },
        );
        if (!consumed) return null;
        return { userId: consumed.userId };
      },
    }),

    // ── iPad device pairing (camera-free sign-in) ───────────────────────
    // The signed-out iPad's path to a real session. A staffer approves a short
    // code in the web console; the device then exchanges (requestId + the raw
    // VERIFIER it generated on-device and never displayed) here. We consume the
    // approved request atomically (consumePairingExchange verifies
    // sha256(verifier) === the stored hash, checks the ≤60s single-use window,
    // burns it, AND mints + records the auth session in that SAME transaction),
    // then hand the already-created session id back to Convex Auth rather
    // than letting it mint a new one after this callback returns — that is
    // what makes the session enumerable/revocable from the instant it exists,
    // with no crash window between sign-in and a later best-effort attach.
    // The short code alone is inert; only the verifier-holding device can
    // complete this exchange. See convex/devicePairing.ts for the full
    // protocol + threat model.
    ConvexCredentials({
      id: "devicePair",
      authorize: async (
        credentials,
        ctx,
      ): Promise<{ userId: Id<"users">; sessionId: Id<"authSessions"> } | null> => {
        const { requestId, verifier } = credentials;
        if (
          typeof requestId !== "string" ||
          !requestId ||
          typeof verifier !== "string" ||
          !verifier
        ) {
          return null;
        }
        const consumed = await ctx.runMutation(
          internal.devicePairing.consumePairingExchange,
          { requestId, verifier },
        );
        if (!consumed) return null;
        return { userId: consumed.userId, sessionId: consumed.sessionId };
      },
    }),

    // ── Managed-claim device sign-in (ZERO-TOUCH iPad provisioning) ─────
    // The ADE→SimpleMDM managed-fleet path where NOBODY types anything on the
    // device. SimpleMDM delivers a per-device CLAIM token via managed app config;
    // the app reads it on first launch and exchanges it here. We consume the
    // claim (consumeManagedClaim verifies sha256(claimToken) against the stored
    // hash, records the exchange + durable binding, and audits it — but does
    // NOT burn it, since a managed device must re-claim after a reinstall/wipe),
    // mints + records the auth session in that SAME transaction, and returns
    // the already-created session id (same atomic-session rationale as
    // `devicePair` above; no second auth family). See
    // convex/managedDeviceClaims.ts for the protocol + AppConfig contract + the
    // single-use-vs-durable rationale.
    ConvexCredentials({
      id: "deviceClaim",
      authorize: async (
        credentials,
        ctx,
      ): Promise<{ userId: Id<"users">; sessionId: Id<"authSessions"> } | null> => {
        const { claimToken, deviceId, deviceLabel, serial } = credentials;
        if (typeof claimToken !== "string" || !claimToken) return null;
        const consumed = await ctx.runMutation(
          internal.managedDeviceClaims.consumeManagedClaim,
          {
            claimToken,
            deviceId: typeof deviceId === "string" ? deviceId : undefined,
            deviceLabel: typeof deviceLabel === "string" ? deviceLabel : undefined,
            serial: typeof serial === "string" ? serial : undefined,
          },
        );
        if (!consumed) return null;
        return { userId: consumed.userId, sessionId: consumed.sessionId };
      },
    }),

    // ── Dev-only test login (E2E / Playwright) ──────────────────────────
    // INERT IN PRODUCTION. This provider mints a session for any username
    // WITHOUT a password or passkey — but ONLY when the deployment has a
    // `DEV_TEST_LOGIN_SECRET` env var set AND the caller presents the
    // matching secret. That env var is set on the dev deployment only and
    // must NEVER be set on production; with it unset
    // this provider rejects every request. Lets automated tests sign in as
    // staff capabilities (e.g. school:operations) without fighting the passkey/staff
    // password flow.
    ConvexCredentials({
      id: "devLogin",
      authorize: async (
        credentials,
        ctx,
      ): Promise<{ userId: Id<"users"> } | null> => {
        // Hard guard #1: NEVER on the prod deployment, even if someone
        // fat-fingers the env var onto prod. CONVEX_CLOUD_URL is a
        // Convex-provided system var = this deployment's own URL.
        const isProductionDeployment = (() => {
          const cloudUrl = process.env.CONVEX_CLOUD_URL;
          if (!cloudUrl) return false;
          return isPublicProductionDeployment("RABBITHOLE_ALLOW_DEV_LOGIN");
        })();
        if (isProductionDeployment) {
          return null;
        }
        // Hard guard #2: requires the dev-only secret env var (absent on prod).
        const secret = process.env.DEV_TEST_LOGIN_SECRET;
        if (!secret) return null; // disabled (prod): no env var, no login
        if (
          typeof credentials.secret !== "string" ||
          credentials.secret !== secret
        ) {
          return null;
        }
        const username = credentials.username;
        if (typeof username !== "string" || !username) return null;
        const user = await ctx.runQuery(internal.users.getByUsernameInternal, {
          username,
        });
        if (!user) return null;
        // Clear the staff passkey-enrollment gate so the /dev-login handoff +
        // Playwright land straight on the dashboard (no /setup-passkey detour).
        // No-op for non-staff; idempotent. Dev-only by virtue of the guards above.
        await ctx.runMutation(internal.passkeys.devEnsureEnrollmentBypass, {
          userId: user._id,
        });
        return { userId: user._id };
      },
    }),

    // ── Magic-link (passwordless email sign-in for any account w/ email) ─
    // OPERATIONAL: email sends via Resend (`AUTH_RESEND_KEY` + `AUTH_EMAIL_FROM`,
    // from no-reply@messages.rabbithole.school) and the sign-in UI is live
    // (MAGIC_LINK_ENABLED in AuthForm). On a deployment with `AUTH_RESEND_KEY`
    // unset, sendMagicLinkEmail logs the URL instead of sending (dev fallback).
    //
    // `authorize: undefined` = true magic-link behavior: the high-entropy
    // token in the link is sufficient (no need to re-enter the email).
    // Eligibility + account resolution live in `resolveMagicLinkUser`
    // (createOrUpdateUser) and the `sendVerificationRequest` pre-check;
    // this provider NEVER creates an account.
    Email({
      id: MAGIC_LINK_PROVIDER_ID,
      maxAge: MAGIC_LINK_TTL_SECONDS,
      authorize: undefined,
      async generateVerificationToken() {
        // 32 random bytes -> 64 hex chars. Well above the 24-char entropy
        // floor that would otherwise require re-entering the email.
        const bytes = new Uint8Array(32);
        crypto.getRandomValues(bytes);
        return Array.from(bytes)
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
      },
      // `ctx` is passed at runtime by @convex-dev/auth but isn't in the
      // 0.0.92 Email `sendVerificationRequest` type (only Phone got it) —
      // hence the optional `ActionCtx` param + the early return guard.
      async sendVerificationRequest(
        { identifier, url }: { identifier: string; url: string },
        ctx?: ActionCtx,
      ) {
        if (!ctx) return;
        const email = normalizeEmail(identifier);
        // Don't email a link to a non-account (avoids account enumeration:
        // the UI always says "check your email"). Same eligibility gate
        // enforced at verification time in resolveMagicLinkUser.
        const eligible = await ctx.runQuery(
          internal.users.isMagicLinkEligible,
          { email },
        );
        if (!eligible) return;
        await sendMagicLinkEmail({ to: email, url });
      },
    }),
  ],
  callbacks: {
    async createOrUpdateUser(ctx, args) {
      // Magic-link (Email provider): resolve to a pre-provisioned account
      // that has a real email on file; never create one. Branch BEFORE the
      // password logic, which assumes a synthetic `username@local` email.
      if (args.provider.id === MAGIC_LINK_PROVIDER_ID) {
        return await resolveMagicLinkUser(ctx, args);
      }

      // This branch runs for the Password provider only (the passkey
      // provider returns a userId directly and never calls it). Block
      // password login for staff who already have a passkey — see
      // blockPasswordIfPasskeyEnrolled above.
      if (args.existingUserId) {
        // Defense in depth: a pending-enrollment account has no credential yet,
        // so it should never reach this branch — but never let a password bind
        // to one even if it somehow does.
        const existingUser = await ctx.db.get(args.existingUserId);
        assertNotPendingEnrollment(existingUser);
        await blockPasswordIfPasskeyEnrolled(ctx, args.existingUserId);
        return args.existingUserId;
      }

      // Extract bare username from the synthetic email the frontend sends
      const rawEmail = args.profile.email as string | undefined;
      const username = rawEmail?.replace(/@.*$/, "") ?? "";

      // Check if a seeded user with this username already exists
      const existing = await ctx.db
        .query("users")
        .filter((q) => q.eq(q.field("username"), username))
        .unique();
      if (existing) {
        // A non-human SERVICE account (e.g. the onboarding owner
        // "rabbithole-guide") must never be sign-in-able — otherwise its
        // hard-coded, passwordless, never-passkey'd row is a standing
        // account-takeover claim via this password sign-up path.
        assertNotSystemAccount(existing);
        // An invite-created staff account still awaiting passwordless
        // enrollment must NOT get a password bound here — its only sign-in path
        // is the passkey/magic-link enroll link (see pendingEnrollment). This
        // is the fix for the orphaned-account-takeover window: until the
        // legitimate redeemer enrolls, the username is unclaimable by password.
        assertNotPendingEnrollment(existing);
        // A SCHOLAR row is claimable ONLY by redeeming a one-time enroll link
        // (which sets the server-only profile marker). A scholar username is
        // public — it is on the roster and printed on one-pagers — so without
        // this, anyone who knew one could bind their own password to a real
        // child's account. See assertScholarAdoptionAuthorized.
        await assertScholarAdoptionAuthorized(ctx, existing);
        // Seeded-user path (no auth account yet). Same rule: a staffer who
        // already enrolled a passkey can't bootstrap a password account.
        await blockPasswordIfPasskeyEnrolled(ctx, existing._id);
        return existing._id;
      }

      // Public signup is CLOSED, unconditionally and forever. Every real
      // account is minted by redeeming a valid institution invite
      // (users.registerWithCode pre-creates the row, so the invite path returns
      // via the existing-username branch above and never reaches here) or by
      // staff. There is deliberately NO empty-deployment bootstrap here: an
      // empty users table is NOT proof of a virgin deployment — a prod restore /
      // partial re-seed (see the /restore-backup skill) empties it temporarily,
      // and a public bootstrap in that window would mint an anonymous PLATFORM
      // ADMIN that survives the reseed. The first platform admin is instead
      // created out-of-band via the admin-key-gated
      // `internal.users.bootstrapFirstPlatformAdmin` (npx convex run), which
      // refuses once any platform admin exists. (Legacy SIGNUP_CODE /
      // TEACHER_SIGNUP_CODE / DESIGNER_SIGNUP_CODE were removed — the DB invite
      // system replaces them.)
      throw new Error("Registration requires an invite");
    },
  },
});
