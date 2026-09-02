"use client";

import { Suspense, useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAction, useQuery } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import {
  MIN_PASSWORD_LENGTH,
  normalizePassword,
  passwordAuthParams,
  passwordsMatch,
} from "@/shared/password";
import {
  Box,
  Button,
  Container,
  Heading,
  Input,
  Spinner,
  Text,
  VStack,
} from "@chakra-ui/react";
import Link from "next/link";
import { CheckCircle } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  runPasskeyRegistration,
  isPasskeyCancellation,
  browserSupportsWebAuthn,
  guessDeviceLabel,
  relatedOriginPasskeyFallbackUrl,
} from "@/lib/passkeyClient";
import { PasskeyRelatedOriginFallback } from "@/components/PasskeyRelatedOriginFallback";

/**
 * Passkey enrollment ceremony — the flow for STAFF and PARENT accounts, whose
 * one-time link sets up a passkey.
 */
function PasskeyEnroll({ token, next }: { token: string; next?: string }) {
  const startEnroll = useAction(api.passkeys.startEnrollmentWithToken);
  const finishEnroll = useAction(api.passkeys.finishEnrollmentWithToken);

  const [status, setStatus] = useState<"idle" | "busy" | "done" | "error">(
    "idle",
  );
  const [message, setMessage] = useState("");
  const [passkeyFallbackUrl, setPasskeyFallbackUrl] = useState<string | null>(null);

  // Deferred past SSR to avoid a hydration mismatch (navigator is absent
  // server-side). Assume supported for the first render, correct after mount.
  const [supported, setSupported] = useState(true);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- client-only capability check, deferred past SSR to avoid a hydration mismatch
    setSupported(browserSupportsWebAuthn());
  }, []);

  const handleEnroll = async () => {
    setStatus("busy");
    setMessage("");
    setPasskeyFallbackUrl(null);
    try {
      await runPasskeyRegistration({
        start: () => startEnroll({ token }),
        finish: (args: {
          challengeId: Id<"webauthnChallenges">;
          response: string;
          label?: string;
        }) => finishEnroll({ token, ...args }),
        label: guessDeviceLabel(),
      });
      setStatus("done");
    } catch (err) {
      const fallbackUrl = relatedOriginPasskeyFallbackUrl(err, window.location);
      if (fallbackUrl) {
        setStatus("error");
        setMessage("This browser can’t set up a passkey on rabbithole.school.");
        setPasskeyFallbackUrl(fallbackUrl);
        return;
      }
      if (isPasskeyCancellation(err)) {
        setStatus("idle");
        return;
      }
      console.error("Enrollment failed:", err);
      setStatus("error");
      setMessage(
        err instanceof Error
          ? err.message
          : "Something went wrong setting up your passkey.",
      );
    }
  };

  return (
    <EnrollShell done={status === "done"} emoji="🔑">
      {status === "done" ? (
        <DonePanel signInHref={next ? `/sign-in?next=${encodeURIComponent(next)}` : "/sign-in"}>
          Your passkey is ready. Next time, just click{" "}
          <Text as="span" fontWeight="600" color="navy.500">
            &ldquo;Sign in with a passkey&rdquo;
          </Text>{" "}
          on the sign-in screen.
        </DonePanel>
      ) : (
        <>
          <Heading
            as="h1"
            size="xl"
            fontFamily="heading"
            color="navy.500"
            letterSpacing="tight"
          >
            Set up your passkey
          </Heading>
          <Text color="charcoal.400" fontFamily="heading" fontSize="sm">
            Sign in to Rabbithole with a passkey — your device&apos;s Touch ID or
            Face ID. No password to remember.
          </Text>

          {!supported && (
            <Text fontSize="sm" color="red.500" fontFamily="body">
              This browser doesn&apos;t support passkeys. Try Safari or Chrome on
              your phone or laptop.
            </Text>
          )}
          {status === "error" && (
            <Text fontSize="sm" color="red.500" fontFamily="body" role="alert">
              {message}
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
            disabled={!supported || status === "busy"}
            onClick={handleEnroll}
          >
            {status === "busy" ? "Waiting for your device…" : "Create my passkey"}
          </Button>
        </>
      )}
    </EnrollShell>
  );
}

/**
 * Password enrollment — the flow for a SCHOLAR account. The scholar chooses a
 * password, which the redeem action stores server-side (properly hashed, linked
 * to their existing account); we then sign them straight in with username +
 * password.
 *
 * The server arg is still named `pin` (a wire contract shared with the Slack
 * bot); only the human-facing noun changed. It was never a PIN — the redeem
 * action validates length ≥ 4 and nothing else, so any characters are legal,
 * and both sign-in forms already say "Password".
 */
function ScholarPasswordEnroll({
  token,
  username,
}: {
  token: string;
  username: string;
}) {
  const redeem = useAction(api.enrollment.redeemScholarEnrollToken);
  const { signIn } = useAuthActions();
  const router = useRouter();

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [status, setStatus] = useState<"idle" | "busy" | "done" | "error">(
    "idle",
  );
  const [message, setMessage] = useState("");

  const handleSubmit = async () => {
    const normalizedPassword = normalizePassword(password);
    if (normalizedPassword.length < MIN_PASSWORD_LENGTH) {
      setStatus("error");
      setMessage(
        `Your password needs at least ${MIN_PASSWORD_LENGTH} characters.`,
      );
      return;
    }
    if (!passwordsMatch(password, confirm)) {
      setStatus("error");
      setMessage("The two passwords don't match.");
      return;
    }
    setStatus("busy");
    setMessage("");
    try {
      await redeem({ token, pin: normalizedPassword });
      // Credential now exists server-side — sign in with it directly.
      await signIn("password", {
        email: `${username}@local`,
        ...passwordAuthParams(password, "signIn"),
      });
      setStatus("done");
      // Navigate to "/" and let the role router route WHOEVER is actually
      // signed in (scholar → /scholar). Never deep-link to a role-specific
      // page here: when an operator runs this while signed in as staff in the
      // same browser, the just-signed-in scholar identity can lose a race to
      // the operator's session, and landing a mismatched identity on a
      // role-gated page crashes its ErrorBoundary (verified: /teacher +
      // scholar identity). "/" is deterministic for every outcome — even a
      // dropped auto-sign-in just lands on /sign-in, where the new password works.
      router.replace("/");
    } catch (err) {
      console.error("Scholar enrollment failed:", err);
      setStatus("error");
      setMessage(
        err instanceof Error
          ? err.message
          : "Something went wrong setting your password.",
      );
    }
  };

  return (
    <EnrollShell done={status === "done"} emoji="🔐">
      {status === "done" ? (
        <DonePanel>You&apos;re signed in — taking you to Rabbithole…</DonePanel>
      ) : (
        <>
          <Heading
            as="h1"
            size="xl"
            fontFamily="heading"
            color="navy.500"
            letterSpacing="tight"
          >
            Set your password
          </Heading>
          <Text color="charcoal.400" fontFamily="heading" fontSize="sm">
            You&apos;re setting up sign-in for{" "}
            <Text as="span" fontWeight="600" color="navy.500">
              {username}
            </Text>
            . Choose a password you&apos;ll remember — at least 4 characters.
          </Text>

          <VStack gap={3} w="full">
            {/* No inputMode="numeric": the secret is a password (any
                characters, length ≥ 4 — see convex/enrollment.ts), so forcing a
                number pad on a touch device would quietly contradict the field
                it is asking to fill. */}
            <Input
              type="password"
              placeholder="Choose a password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
              bg="gray.50"
              border="1px solid"
              borderColor="gray.300"
              borderRadius="lg"
              fontFamily="body"
              h={12}
              autoComplete="new-password"
              autoFocus
            />
            <Input
              type="password"
              placeholder="Type it again"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
              bg="gray.50"
              border="1px solid"
              borderColor="gray.300"
              borderRadius="lg"
              fontFamily="body"
              h={12}
              autoComplete="new-password"
            />
          </VStack>

          {status === "error" && (
            <Text fontSize="sm" color="red.500" fontFamily="body">
              {message}
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
            disabled={!password || !confirm || status === "busy"}
            onClick={handleSubmit}
          >
            {status === "busy"
              ? "Setting your password…"
              : "Set password and sign in"}
          </Button>
        </>
      )}
    </EnrollShell>
  );
}

/** Shared card chrome for both enroll flows. */
function EnrollShell({
  children,
  done,
  emoji,
}: {
  children: React.ReactNode;
  done: boolean;
  emoji: string;
}) {
  return (
    <Box
      minH="100dvh"
      bg="linear-gradient(135deg, #222656 0%, #1a1d42 50%, #364153 100%)"
      display="flex"
      alignItems="center"
      justifyContent="center"
      p={4}
      position="fixed"
      inset={0}
      overflowY="auto"
    >
      <Container maxW="md">
        <VStack
          gap={6}
          bg="white"
          p={{ base: 8, md: 12 }}
          borderRadius="2xl"
          shadow="2xl"
          textAlign="center"
        >
          {done ? (
            <Box color="green.500" lineHeight="1">
              <CheckCircle size={56} />
            </Box>
          ) : (
            <Box fontSize="48px" lineHeight="1" userSelect="none">
              {emoji}
            </Box>
          )}
          {children}
        </VStack>
      </Container>
    </Box>
  );
}

function DonePanel({
  children,
  signInHref = "/sign-in",
}: {
  children: React.ReactNode;
  signInHref?: string;
}) {
  return (
    <VStack gap={4} w="full">
      <Heading
        as="h1"
        size="xl"
        fontFamily="heading"
        color="navy.500"
        letterSpacing="tight"
      >
        You&apos;re all set
      </Heading>
      <Text fontFamily="body" color="charcoal.500">
        {children}
      </Text>
      <Link href={signInHref} style={{ width: "100%" }}>
        <Button
          size="lg"
          w="full"
          bg="violet.500"
          color="white"
          _hover={{ bg: "violet.600" }}
          fontFamily="heading"
          h={14}
        >
          Go to sign in
        </Button>
      </Link>
    </VStack>
  );
}

function EnrollInner() {
  const params = useSearchParams();
  const token = params.get("token") ?? "";
  // Same-origin post-enrollment destination (e.g. a new school admin → School
  // Settings). Only forwarded to the passkey ceremony's sign-in link.
  const nextRaw = params.get("next");
  const next =
    nextRaw && nextRaw.startsWith("/") && !nextRaw.startsWith("//")
      ? nextRaw
      : undefined;
  // Look up who this token is for, so we render the right ceremony (a scholar
  // sets a password; staff/parents register a passkey). null = invalid/expired.
  const liveInfo = useQuery(api.enrollment.tokenInfo, token ? { token } : "skip");

  // Latch the FIRST resolved value. tokenInfo is reactive and both ceremonies
  // burn the token on success (usedAt → tokenInfo goes null); without latching,
  // the subscription would flip to null mid-success and yank the "You're all
  // set" screen out from under the user, replacing it with "Link expired". Once
  // we've decided which ceremony to show, the child owns its own lifecycle.
  const [latched, setLatched] = useState<{
    value: { username: string | null; name: string | null; ceremony: string } | null;
  } | null>(null);
  useEffect(() => {
    if (liveInfo !== undefined && latched === null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot latch of the initial query result; intentionally ignores later reactive updates
      setLatched({ value: liveInfo });
    }
  }, [liveInfo, latched]);

  if (!token) {
    return (
      <EnrollShell done={false} emoji="🔑">
        <Heading as="h1" size="xl" fontFamily="heading" color="navy.500">
          Set up your account
        </Heading>
        <Text fontSize="sm" color="red.500" fontFamily="body">
          This enrollment link is missing its token. Ask an admin for a new link.
        </Text>
      </EnrollShell>
    );
  }

  // Still loading the initial lookup — show a real "checking" state, not a
  // blank card, so a slow connection doesn't look broken.
  if (latched === null) {
    return (
      <EnrollShell done={false} emoji="🔑">
        <Heading as="h1" size="xl" fontFamily="heading" color="navy.500">
          Checking your link…
        </Heading>
        <Spinner color="violet.500" />
      </EnrollShell>
    );
  }

  const info = latched.value;
  if (info === null) {
    return (
      <EnrollShell done={false} emoji="🔑">
        <Heading as="h1" size="xl" fontFamily="heading" color="navy.500">
          Link expired
        </Heading>
        <Text fontSize="sm" color="red.500" fontFamily="body">
          This enrollment link is invalid, already used, or expired. Ask an admin
          for a new one.
        </Text>
      </EnrollShell>
    );
  }

  // `ceremony === "pin"` is the server's wire value (convex/enrollment.ts
  // tokenInfo); the human-facing noun is "password".
  if (info.ceremony === "pin") {
    return <ScholarPasswordEnroll token={token} username={info.username ?? ""} />;
  }
  return <PasskeyEnroll token={token} next={next} />;
}

export default function EnrollPage() {
  return (
    <Suspense fallback={null}>
      <EnrollInner />
    </Suspense>
  );
}
