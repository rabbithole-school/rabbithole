"use client";

import { useAuthActions } from "@convex-dev/auth/react";
import { useConvexAuth, useAction } from "convex/react";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { Box, Button, Container, Heading, Image, Input, Text, VStack, HStack } from "@chakra-ui/react";
import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Key, EnvelopeSimple } from "@phosphor-icons/react";
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
  SHELL_BG,
  StarfieldBackground,
} from "@/components/StarfieldBackground";
import {
  MIN_PASSWORD_LENGTH,
  normalizePassword,
  passwordAuthParams,
} from "@/shared/password";

interface AuthFormProps {
  mode: "signIn" | "signUp";
  /**
   * Sign in under an institution's name instead of Rabbithole's, for people
   * who know the institution but not the app. Email link only: no username,
   * password, passkey or invite link, and Rabbithole drops to a small
   * "Powered by" line.
   */
  brand?: AuthBrand;
}

export interface AuthBrand {
  /** Leads the card: "Sign in to {name}". */
  name: string;
  logoSrc: string;
  logoAlt: string;
  /** Where a signed-in visitor lands when the URL carries no `?next=`. */
  defaultDestination: string;
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
function postLoginDestination(fallback = "/"): string {
  if (typeof window === "undefined") return fallback;
  const next = new URLSearchParams(window.location.search).get("next");
  return safeNextPath(next, window.location.origin, fallback);
}

/**
 * `next` as a same-origin path, or `fallback`. A prefix check is not enough:
 * browsers read a backslash after the slash ("/\evil.com"), or a tab or
 * newline between two slashes, as "//evil.com", another host. So resolve it against this origin, keep it only if the origin is
 * unchanged, and hand back just its path, query and hash.
 */
export function safeNextPath(next: string | null, origin: string, fallback = "/"): string {
  if (!next || !next.startsWith("/")) return fallback;
  let url: URL;
  try {
    url = new URL(next, origin);
  } catch {
    return fallback;
  }
  if (url.origin !== origin) return fallback;
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * The email sign-in state is addressable as `?sign_in=email` so it can be
 * linked and shared directly ("go here and enter your email") rather than
 * described as a click path. Read from window.location for the same reason as
 * postLoginDestination: the statically rendered /sign-in page then needs no
 * Suspense boundary.
 */
const EMAIL_MODE_PARAM = "sign_in";
const EMAIL_MODE_VALUE = "email";

function emailModeInUrl(): boolean {
  if (typeof window === "undefined") return false;
  return (
    new URLSearchParams(window.location.search).get(EMAIL_MODE_PARAM) ===
    EMAIL_MODE_VALUE
  );
}

/**
 * Add or drop `?sign_in=email` without a Next navigation — this card is a
 * client component on a static page, and a router push would remount it and
 * throw away anything already typed. history.pushState keeps the Back button
 * working, which is what makes the two states feel like one flipped card.
 */
function writeEmailModeToUrl(on: boolean, replace = false) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (on) url.searchParams.set(EMAIL_MODE_PARAM, EMAIL_MODE_VALUE);
  else url.searchParams.delete(EMAIL_MODE_PARAM);
  const next = `${url.pathname}${url.search}${url.hash}`;
  if (replace) window.history.replaceState(null, "", next);
  else window.history.pushState(null, "", next);
}

/**
 * The email half of the sign-in card. It REPLACES the username/password/passkey
 * controls rather than appearing beneath them, so the card reads as one form in
 * one of two states.
 */
function EmailSignInPanel({
  email,
  onEmailChange,
  onSend,
  onBack,
  sent,
  busy,
  error,
  sentMessage = "If an account exists for that email, a sign-in link is on its way. The link expires in 15 minutes.",
}: {
  email: string;
  onEmailChange: (value: string) => void;
  onSend: () => void;
  /** Omitted when there is no other sign-in method to go back to. */
  onBack?: () => void;
  sent: boolean;
  busy: boolean;
  error: string;
  sentMessage?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!sent) inputRef.current?.focus({ preventScroll: true });
  }, [sent]);

  if (sent) {
    return (
      <VStack w="full" gap={3}>
        <Text fontSize="sm" color="charcoal.500" fontFamily="body">
          {sentMessage}
        </Text>
        {onBack && (
        <Button
          type="button"
          variant="plain"
          size="sm"
          p={0}
          h="auto"
          fontSize="sm"
          color="violet.600"
          fontFamily="heading"
          _hover={{ textDecoration: "underline" }}
          onClick={onBack}
        >
          &larr; Back to username sign-in
        </Button>
        )}
      </VStack>
    );
  }

  return (
    <VStack w="full" gap={3}>
      <Input
        ref={inputRef}
        type="email"
        placeholder="you@example.com"
        value={email}
        onChange={(e) => onEmailChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !busy && email.trim()) onSend();
        }}
        bg="gray.50"
        border="1px solid"
        borderColor="gray.300"
        borderRadius="lg"
        fontFamily="body"
        h={12}
        _focus={{ borderColor: "violet.400", boxShadow: "none", outline: "none" }}
        _focusVisible={{ boxShadow: "none", outline: "none" }}
        autoComplete="email"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="send"
      />
      {error && (
        <Text fontSize="sm" color="red.500" fontFamily="body" role="alert">
          {error}
        </Text>
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
        disabled={busy || !email.trim()}
        onClick={onSend}
      >
        {busy ? "Sending\u2026" : "Send sign-in link"}
      </Button>
      {onBack && (
      <Button
        type="button"
        variant="plain"
        size="sm"
        p={0}
        h="auto"
        fontSize="sm"
        color="violet.600"
        fontFamily="heading"
        _hover={{ textDecoration: "underline" }}
        onClick={onBack}
      >
        &larr; Back to username sign-in
      </Button>
      )}
    </VStack>
  );
}

const config = {
  signIn: {
    heading: "Welcome back",
    subtext: "",
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
  // Same idea for the wordmark: the landing page already shows it in the left
  // column, so the card drops it there. /sign-in and /sign-up have no other
  // branding on the page, so they keep it.
  showLogo = true,
  brand,
}: AuthFormProps & { showAccountLink?: boolean; showLogo?: boolean }) {
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

  const fallbackDestination = brand?.defaultDestination;

  // Magic-link: passwordless email sign-in for any account with an email.
  const [showLinkForm, setShowLinkForm] = useState(false);
  const [linkEmail, setLinkEmail] = useState("");
  const [isLinkBusy, setIsLinkBusy] = useState(false);
  const [linkSent, setLinkSent] = useState(false);

  // Adopt `?sign_in=email` on arrival, and follow Back/Forward between the two
  // states. Deferred past SSR (the server cannot see the query string here),
  // so the password card renders first and flips on mount.
  useEffect(() => {
    const sync = () => setShowLinkForm(emailModeInUrl());
    sync();
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  /** Flip the card, and make the new state addressable. */
  const enterEmailMode = () => {
    setShowLinkForm(true);
    setLinkSent(false);
    setError("");
    setPasskeyFallbackUrl(null);
    if (!emailModeInUrl()) writeEmailModeToUrl(true);
  };

  const leaveEmailMode = () => {
    setShowLinkForm(false);
    setLinkSent(false);
    setError("");
    writeEmailModeToUrl(false);
  };

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
  // Half-width sibling buttons cannot hold "Sign in with a passkey" on one
  // line, and one button wrapping while its twin does not stops them reading
  // as a pair. The icon plus the method name carries it — the card's heading
  // already says this is signing in.
  const passkeyShortNoun = isIPad ? "Touch ID" : "passkey";

  const handlePasskeySignIn = async () => {
    setError("");
    setPasskeyFallbackUrl(null);
    setIsPasskeyBusy(true);
    try {
      await runPasskeySignIn({
        start: () => startPasskeyAuth({}),
        signIn,
      });
      window.location.href = postLoginDestination(fallbackDestination);
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
      // A branded card sends the link straight to its destination; the
      // Rabbithole card keeps landing on "/", which routes by role.
      await signIn(
        MAGIC_LINK_PROVIDER_ID,
        brand ? { email, redirectTo: postLoginDestination(fallbackDestination) } : { email },
      );
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

  // The card has TWO states, not one state with an extra field revealed:
  // username+password (with passkey), or email-link. `?sign_in=email` names
  // the second one so it can be handed to someone directly.
  // A branded card is email-only, so it has no password state to flip from.
  const emailMode =
    mode === "signIn" && MAGIC_LINK_ENABLED && (showLinkForm || !!brand);

  useEffect(() => {
    // Only redirect if both authenticated AND a user doc exists
    if (isAuthenticated && !userLoading && user && !hasAutoRedirected.current) {
      hasAutoRedirected.current = true;
      // Automatic redirects are not user gestures; keep them client-side so
      // dev/StrictMode doesn't turn duplicate full-document navigations into
      // noisy beforeunload errors.
      router.replace(postLoginDestination(fallbackDestination));
    }
  }, [isAuthenticated, userLoading, user, router, fallbackDestination]);

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
      window.location.href = postLoginDestination(fallbackDestination);
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
        {showLogo && brand && (
          <Image
            src={brand.logoSrc}
            alt={brand.logoAlt}
            w="112px"
            h="112px"
            userSelect="none"
            draggable={false}
          />
        )}
        {showLogo && !brand && (
          <Box
            w="128px"
            h="128px"
            borderRadius="28%"
            overflow="hidden"
            backgroundImage="url('/rh-logo.png')"
            backgroundSize="cover"
            backgroundPosition="center"
            userSelect="none"
            role="img"
            aria-label="Rabbithole"
          />
        )}
        <Heading
          as="h1"
          size="2xl"
          fontFamily="heading"
          color="navy.500"
          letterSpacing="tight"
        >
          {brand
            ? `Sign in to ${brand.name}`
            : emailMode
              ? "Sign in with email"
              : c.heading}
        </Heading>
        {/* A branded card's subtext is an instruction, so it goes once the
            link is sent and the confirmation below takes over. */}
        {(emailMode || c.subtext) && !(brand && linkSent) && (
          <Text color="charcoal.400" fontFamily="heading" fontSize="sm">
            {brand
              ? "Enter your email and we\u2019ll send you a sign-in link. No password needed."
              : emailMode
                ? "We\u2019ll email you a link that signs you in \u2014 no password needed"
                : c.subtext}
          </Text>
        )}
      </VStack>

      <VStack gap={3} w="full">
        {emailMode ? (
          <EmailSignInPanel
            email={linkEmail}
            onEmailChange={setLinkEmail}
            onSend={handleSendMagicLink}
            onBack={brand ? undefined : leaveEmailMode}
            sent={linkSent}
            busy={isLinkBusy}
            error={error}
            sentMessage={
              brand
                ? "If that email is on file with us, a sign-in link is on its way. The link expires in 15 minutes."
                : undefined
            }
          />
        ) : (
        <>
        {/* Username, password and submit are one unit; the 12px above and
            below sets them apart from the heading and from the alternative
            ways in below. */}
        <Input
          mt={3}
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
          mb={3}
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

        {/* Three ways in, stacked and identically sized: the password submit
            is the primary, passkey and email link are its secondary siblings.
            They sat side by side at half width before, which made them read as
            a separate lesser pair and wrapped their labels unevenly. */}
        {mode === "signIn" && showPasskeyUI && (
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
            <HStack gap={2} justify="center">
              <Key size={20} weight="duotone" />
              <Box as="span">
                {isPasskeyBusy
                  ? `Waiting for ${passkeyShortNoun}…`
                  : `Sign in with ${passkeyShortNoun}`}
              </Box>
            </HStack>
          </Button>
        )}
        {mode === "signIn" && MAGIC_LINK_ENABLED && (
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
            onClick={enterEmailMode}
          >
            <HStack gap={2} justify="center">
              <EnvelopeSimple size={20} weight="duotone" />
              <Box as="span">Sign in with email</Box>
            </HStack>
          </Button>
        )}
        </>
        )}
      </VStack>

      {showAccountLink && !brand && (
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
export function AuthForm({ mode, brand }: AuthFormProps) {
  // Dark full-bleed gradient screen: light status-bar icons + dark inset
  // strips on the iPad (no-op on web).
  useDarkShellChrome();

  if (brand) return <BrandedAuthScreen mode={mode} brand={brand} />;

  return (
    <Box
      minH="100dvh"
      // Same wash as the landing page, so arriving at /sign-in directly does
      // not look like a different product.
      bg={SHELL_BG}
      display="flex"
      alignItems="center"
      justifyContent="center"
      flexDirection="column"
      p={4}
      position="fixed"
      inset={0}
      overflowY="auto"
    >
      <StarfieldBackground position="fixed" />
      <Container maxW="lg" position="relative" zIndex={1}>
        <AuthCard mode={mode} />
      </Container>

      <VStack
        as="footer"
        gap={2}
        mt={6}
        textAlign="center"
        position="relative"
        zIndex={1}
      >
        <Text
          color="whiteAlpha.500"
          fontSize="xs"
          fontFamily="heading"
        >
          A Socratic tutor, built in the open
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

/**
 * The institution-branded screen: a plain light page with none of the
 * Rabbithole starfield, the institution's card, and Rabbithole only in a
 * small footer line.
 */
function BrandedAuthScreen({
  mode,
  brand,
}: {
  mode: AuthFormProps["mode"];
  brand: AuthBrand;
}) {
  return (
    <Box
      minH="100dvh"
      bg="gray.50"
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
        <AuthCard mode={mode} brand={brand} showAccountLink={false} />
      </Container>
      <Text
        as="footer"
        mt={6}
        color="charcoal.400"
        fontSize="xs"
        fontFamily="heading"
        textAlign="center"
      >
        Powered by Rabbithole
      </Text>
    </Box>
  );
}
