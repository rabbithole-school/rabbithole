"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import { useConvexAuth, useAction } from "convex/react";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { Box, Button, Container, Heading, Input, Text, VStack, HStack } from "@chakra-ui/react";
import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "@/convex/_generated/api";
import { MAGIC_LINK_PROVIDER_ID } from "@/convex/lib/authConstants";
import {
  runPasskeySignIn,
  isPasskeyCancellation,
  browserSupportsWebAuthn,
  relatedOriginPasskeyFallbackUrl,
} from "@/lib/passkeyClient";
import { useIsIPad, useDarkShellChrome } from "@/lib/native";
import { PasskeyRelatedOriginFallback } from "@/components/PasskeyRelatedOriginFallback";
import {
  MIN_PASSWORD_LENGTH,
  normalizePassword,
  passwordAuthParams,
} from "@/shared/password";

interface AuthFormProps {
  mode: "signIn" | "signUp";
}

// Magic-link email is wired (Resend, sending from messages.rabbithole.school)
// and a real send is verified, so the passwordless-email sign-in entry is live.
// Requires AUTH_RESEND_KEY + AUTH_EMAIL_FROM on the deployment — if those are
// unset (e.g. a fresh dev deployment), sendMagicLinkEmail logs the URL instead
// of sending, so the button still resolves without erroring.
const MAGIC_LINK_ENABLED = true;

/**
 * Where to land after a successful sign-in. Defaults to "/", but honors a
 * same-origin `?next=/path` param so flows that need a round-trip through
 * sign-in (e.g. the MCP /oauth/authorize consent page) come back. Read
 * from window.location (not useSearchParams) so the statically rendered
 * /sign-in page needs no Suspense boundary.
 */
function postLoginDestination(): string {
  if (typeof window === "undefined") return "/";
  const next = new URLSearchParams(window.location.search).get("next");
  // Relative paths only — "//host" or "https://..." would be an open redirect.
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

const config = {
  signIn: {
    heading: "Welcome back",
    subtext: "Enter your username to continue",
    button: "Sign In",
    usernamePlaceholder: "Username",
    passwordPlaceholder: "Password",
    autoComplete: "current-password" as const,
    // Sign-up is invite-only and /sign-up dead-ends unless you arrived on an
    // invite link, so "need an account" points at the waitlist — the one path
    // that actually gets a stranger an account.
    linkText: "Need an account? Request an invite",
    linkHref: "/waitlist",
    errorMessage: "Invalid username or password",
  },
  signUp: {
    heading: "Join Rabbithole",
    subtext: "Have an invite link? Open it to join.",
    button: "Create Account",
    usernamePlaceholder: "Choose a username",
    passwordPlaceholder: "Choose a password",
    autoComplete: "new-password" as const,
    linkText: "Already have an account? Sign in",
    linkHref: "/sign-in",
    errorMessage: "Username already taken",
  },
};

/**
 * The white sign-in card on its own, with no page chrome around it.
 *
 * Split out of `AuthForm` so the marketing landing page (`app/page.tsx`) can
 * put the SAME card in its right-hand column — one sign-in surface, rendered
 * in two layouts, rather than a second login form that drifts from this one.
 * `AuthForm` remains the full-screen presentation used by /sign-in and
 * /sign-up.
 */
export function AuthCard({
  mode,
  // The landing page carries its own "Request an invite" CTA in the page
  // content, so it turns this one off rather than showing the same path twice.
  showAccountLink = true,
}: AuthFormProps & { showAccountLink?: boolean }) {
  const { signIn } = useAuthActions();
  const router = useRouter();
  const { isAuthenticated } = useConvexAuth();
  const { user, isLoading: userLoading } = useCurrentUser();
  const startPasskeyAuth = useAction(api.passkeys.startAuthentication);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isPasskeyBusy, setIsPasskeyBusy] = useState(false);
  const [passkeyFallbackUrl, setPasskeyFallbackUrl] = useState<string | null>(null);
  const hasAutoRedirected = useRef(false);

  // Focus the username field on mount — but with preventScroll, which the
  // `autoFocus` attribute can't do. On the landing page this card sits in a
  // scrollable column, and plain autoFocus scrolled the marketing copy off
  // the top of the screen the moment the page loaded.
  const usernameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    usernameRef.current?.focus({ preventScroll: true });
  }, []);

  // Magic-link: passwordless email sign-in for any account with an email.
  const [showLinkForm, setShowLinkForm] = useState(false);
  const [linkEmail, setLinkEmail] = useState("");
  const [isLinkBusy, setIsLinkBusy] = useState(false);
  const [linkSent, setLinkSent] = useState(false);

  // browserSupportsWebAuthn() reads `navigator`, absent during SSR. Calling
  // it inline makes server + first client render disagree (hydration
  // mismatch). Assume supported for SSR + first client render, correct after
  // mount.
  const [passkeySupported, setPasskeySupported] = useState(true);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- client-only capability check, deferred past SSR to avoid a hydration mismatch
    setPasskeySupported(browserSupportsWebAuthn());
  }, []);

  const showPasskeyUI = passkeySupported;

  // "Passkey" is inscrutable to a lot of students; the school's iPads use
  // Touch ID, so label the button for the gesture they actually perform.
  const isIPad = useIsIPad();
  const passkeyNoun = isIPad ? "Touch ID" : "a passkey";

  const handlePasskeySignIn = async () => {
    setError("");
    setPasskeyFallbackUrl(null);
    setIsPasskeyBusy(true);
    try {
      await runPasskeySignIn({
        start: () => startPasskeyAuth({}),
        signIn,
      });
      window.location.href = postLoginDestination();
    } catch (err) {
      const fallbackUrl =
        typeof window !== "undefined"
          ? relatedOriginPasskeyFallbackUrl(err, window.location)
          : null;
      if (fallbackUrl) {
        setError(
          "This browser can’t use your existing passkey on rabbithole.school.",
        );
        setPasskeyFallbackUrl(fallbackUrl);
      } else if (!isPasskeyCancellation(err)) {
        console.error("Passkey sign-in failed:", err);
        setError("Passkey sign-in failed. Try again, or use your username.");
      }
      setIsPasskeyBusy(false);
    }
  };

  const handleSendMagicLink = async () => {
    const email = linkEmail.trim().toLowerCase();
    if (!email || !email.includes("@")) {
      setError("Enter the email address on your account");
      return;
    }
    setError("");
    setPasskeyFallbackUrl(null);
    setIsLinkBusy(true);
    try {
      await signIn(MAGIC_LINK_PROVIDER_ID, { email });
      // Always show success — we never reveal whether an account exists.
      setLinkSent(true);
    } catch (err) {
      console.error("Magic-link request failed:", err);
      // Even on a server error, avoid leaking account existence.
      setLinkSent(true);
    } finally {
      setIsLinkBusy(false);
    }
  };

  const c = config[mode];

  useEffect(() => {
    // Only redirect if both authenticated AND a user doc exists
    if (isAuthenticated && !userLoading && user && !hasAutoRedirected.current) {
      hasAutoRedirected.current = true;
      // Automatic redirects are not user gestures; keep them client-side so
      // dev/StrictMode doesn't turn duplicate full-document navigations into
      // noisy beforeunload errors.
      router.replace(postLoginDestination());
    }
  }, [isAuthenticated, userLoading, user, router]);

  const handleSubmit = async () => {
    if (mode === "signUp") {
      setError(
        "Rabbithole is invite-only — open the invite link you were sent to join.",
      );
      return;
    }

    const trimmed = username.trim();
    const normalizedPassword = normalizePassword(password);
    if (!trimmed || !normalizedPassword) return;
    setIsSubmitting(true);
    setError("");
    setPasskeyFallbackUrl(null);

    if (normalizedPassword.length < MIN_PASSWORD_LENGTH) {
      setError(
        `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      );
      setIsSubmitting(false);
      return;
    }

    if (trimmed.includes("@")) {
      setError("Pick a username, not an email address");
      setIsSubmitting(false);
      return;
    }

    // Password provider requires an email — use synthetic one internally
    const email = `${trimmed}@local`;

    try {
      // Sign-in ONLY. This deliberately does not fall back to `flow:
      // "signUp"` when the account doesn't exist: a scholar username is
      // public (roster, one-pagers), so that fallback let anyone who knew one
      // bind their own password to a real child's account — the username
      // coupon (TODO #scholar-self-claim). The server refuses it now too
      // (assertScholarAdoptionAuthorized), so this would only produce a
      // confusing error. An account with no credential is set up by a
      // teacher's one-time link, never by typing a password here.
      await signIn("password", {
        email,
        ...passwordAuthParams(password, "signIn"),
      });
      window.location.href = postLoginDestination();
    } catch (err) {
      console.error("Auth failed:", err);
      const raw = err instanceof Error ? err.message : "";
      if (/passkey/i.test(raw)) {
        setError("This account uses a passkey. Use the passkey button below.");
      } else if (/invalid invite code|requires an invite/i.test(raw)) {
        setError(
          "Rabbithole is invite-only — open the invite link you were sent to join.",
        );
      } else if (/username is required/i.test(raw)) {
        setError("Username is required.");
      } else {
        setError(c.errorMessage);
      }
      setIsSubmitting(false);
    }
  };

  return (
    <VStack
      gap={6}
      bg="white"
      p={{ base: 8, md: 12 }}
      borderRadius="2xl"
      shadow="2xl"
      textAlign="center"
    >
      <VStack gap={2}>
        <Box
          display="flex"
          alignItems="center"
          justifyContent="center"
          gap={1}
          fontSize="48px"
          lineHeight="1"
          userSelect="none"
          aria-label="Rabbithole"
        >
          <span style={{ display: "inline-block", transform: "scaleX(-1)" }}>🐇</span>
          <span>🕳️</span>
        </Box>
        <Heading
          as="h1"
          size="2xl"
          fontFamily="heading"
          color="navy.500"
          letterSpacing="tight"
        >
          {c.heading}
        </Heading>
        <Text color="charcoal.400" fontFamily="heading" fontSize="sm">
          {c.subtext}
        </Text>
      </VStack>

      <VStack gap={3} w="full">
        <Input
          placeholder={c.usernamePlaceholder}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
          bg="gray.50"
          border="1px solid"
          borderColor="gray.300"
          borderRadius="lg"
          fontFamily="body"
          h={12}
          _focus={{ borderColor: "violet.400", boxShadow: "none", outline: "none" }}
          _focusVisible={{ boxShadow: "none", outline: "none" }}
          ref={usernameRef}
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="next"
        />
        <Input
          type="password"
          placeholder={c.passwordPlaceholder}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
          bg="gray.50"
          border="1px solid"
          borderColor="gray.300"
          borderRadius="lg"
          fontFamily="body"
          h={12}
          _focus={{ borderColor: "violet.400", boxShadow: "none", outline: "none" }}
          _focusVisible={{ boxShadow: "none", outline: "none" }}
          autoComplete={c.autoComplete}
        />
        {mode === "signUp" && (
          <Text fontSize="xs" color="charcoal.400" fontFamily="heading" alignSelf="flex-start" mt={-2}>
            Must be at least 4 characters.
          </Text>
        )}

        {error && (
          <Text fontSize="sm" color="red.500" fontFamily="body" role="alert">
            {error}
          </Text>
        )}
        {passkeyFallbackUrl && (
          <PasskeyRelatedOriginFallback href={passkeyFallbackUrl} />
        )}

        <Button
          size="lg"
          w="full"
          bg="violet.500"
          color="white"
          _hover={{ bg: "violet.600" }}
          fontFamily="heading"
          fontWeight="500"
          h={14}
          disabled={!username.trim() || !password || isSubmitting}
          onClick={handleSubmit}
        >
          {isSubmitting ? (mode === "signUp" ? "Creating account…" : "Signing in…") : c.button}
        </Button>

        {mode === "signIn" && showPasskeyUI && (
          <>
            <HStack w="full" gap={3} my={1}>
              <Box flex={1} h="1px" bg="gray.200" />
              <Text fontSize="xs" color="charcoal.300" fontFamily="heading">
                or
              </Text>
              <Box flex={1} h="1px" bg="gray.200" />
            </HStack>
            <Button
              size="lg"
              w="full"
              variant="outline"
              borderColor="violet.300"
              color="violet.600"
              _hover={{ bg: "violet.50" }}
              fontFamily="heading"
              fontWeight="500"
              h={14}
              disabled={isPasskeyBusy}
              onClick={handlePasskeySignIn}
            >
              {isPasskeyBusy
                ? `Waiting for ${passkeyNoun}…`
                : `🔑 Sign in with ${passkeyNoun}`}
            </Button>
            <Text fontSize="xs" color="charcoal.300" fontFamily="heading">
              Use a passkey if you’ve set one up — works for everyone.
            </Text>

            {/* Magic-link: passwordless email sign-in for any account
                that has set an email (staff, parents, and scholars alike).
                Live (MAGIC_LINK_ENABLED) now that Resend sending is wired
                and verified — see AUTH_RESEND_KEY / AUTH_EMAIL_FROM on the
                deployment and `convex/lib/magicLinkEmail.ts`. */}
            {MAGIC_LINK_ENABLED && (linkSent ? (
              <Text fontSize="sm" color="charcoal.500" fontFamily="body" mt={2}>
                If an account exists for that email, a sign-in link is on
                its way. The link expires in 15 minutes.
              </Text>
            ) : showLinkForm ? (
              <VStack w="full" gap={2} mt={1}>
                <Input
                  type="email"
                  placeholder="you@example.com"
                  value={linkEmail}
                  onChange={(e) => setLinkEmail(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleSendMagicLink()}
                  bg="gray.50"
                  border="1px solid"
                  borderColor="gray.300"
                  borderRadius="lg"
                  fontFamily="body"
                  h={12}
                  _focus={{ borderColor: "violet.400", boxShadow: "none", outline: "none" }}
                  _focusVisible={{ boxShadow: "none", outline: "none" }}
                  autoComplete="email"
                />
                <Button
                  w="full"
                  variant="ghost"
                  color="violet.600"
                  _hover={{ bg: "violet.50" }}
                  fontFamily="heading"
                  fontWeight="500"
                  h={12}
                  disabled={isLinkBusy || !linkEmail.trim()}
                  onClick={handleSendMagicLink}
                >
                  {isLinkBusy ? "Sending…" : "Send sign-in link"}
                </Button>
              </VStack>
            ) : (
              <Text
                fontSize="sm"
                color="violet.600"
                fontFamily="heading"
                cursor="pointer"
                _hover={{ textDecoration: "underline" }}
                onClick={() => {
                  setShowLinkForm(true);
                  setError("");
                  setPasskeyFallbackUrl(null);
                }}
              >
                Email me a sign-in link instead
              </Text>
            ))}
          </>
        )}
      </VStack>

      {showAccountLink && (
        <Link href={c.linkHref}>
          <Text
            color="charcoal.400"
            fontSize="sm"
            fontFamily="heading"
            cursor="pointer"
            _hover={{ color: "violet.500", textDecoration: "underline" }}
          >
            {c.linkText}
          </Text>
        </Link>
      )}

      {/* DEV ONLY: a shortcut to the no-password dev-login index. Renders
          only when NEXT_PUBLIC_DEV_LOGIN_SECRET is set (dev worktrees);
          absent from the prod bundle. */}
      {process.env.NEXT_PUBLIC_DEV_LOGIN_SECRET && (
        <Link href="/dev-login" aria-label="Dev login">
          <Box
            mt={1}
            px={3}
            py={1.5}
            borderRadius="full"
            bg="gray.100"
            cursor="pointer"
            _hover={{ bg: "gray.200" }}
            aria-label="Dev login"
          >
            <Text color="charcoal.500" fontSize="xs" fontFamily="heading">
              🔧 Dev login
            </Text>
          </Box>
        </Link>
      )}
    </VStack>
  );
}

/** The full-screen sign-in / sign-up screen: gradient page + the card. */
export function AuthForm({ mode }: AuthFormProps) {
  // Dark full-bleed gradient screen: light status-bar icons + dark inset
  // strips on the iPad (no-op on web).
  useDarkShellChrome();

  return (
    <Box
      minH="100dvh"
      bg="linear-gradient(135deg, #222656 0%, #1a1d42 50%, #364153 100%)"
      display="flex"
      alignItems="center"
      justifyContent="center"
      flexDirection="column"
      p={4}
      position="fixed"
      inset={0}
      overflowY="auto"
    >
      <Container maxW="lg">
        <AuthCard mode={mode} />
      </Container>

      <VStack as="footer" gap={2} mt={6} textAlign="center">
        <Text
          color="whiteAlpha.500"
          fontSize="xs"
          fontFamily="heading"
        >
          An open-source Socratic tutor
        </Text>
        {mode === "signIn" && (
          <Link href="/sources">
            <Text
              color="whiteAlpha.500"
              fontSize="xs"
              fontFamily="heading"
              textDecoration="underline"
              _hover={{ color: "whiteAlpha.700" }}
            >
              Content sources &amp; attribution
            </Text>
          </Link>
        )}
      </VStack>
    </Box>
  );
}
