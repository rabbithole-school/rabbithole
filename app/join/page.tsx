"use client";

// /join — redeem an institution invite link (the multi-tenant onboarding
// surface). Reads ?code=, validates it via `institutionInvites.inviteInfo`, and
// renders the right form + ceremony:
//   create_institution → name your NEW school (name + timezone) + your account,
//     then enroll a passkey and land on School Settings (passwordless leader).
//   join_institution / teacher → your account, then enroll a passkey.
//   join_institution / scholar → username + password (scholars stay password).
// Redemption is `users.registerWithCode` — the single signup entry point, so
// the auth-callback handshake keeps working. Chrome mirrors AuthForm / /enroll.

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import {
  MIN_PASSWORD_LENGTH,
  normalizePassword,
  passwordAuthParams,
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
import { api } from "@/convex/_generated/api";
import { isValidEmail } from "@/convex/lib/email";
import { usernameError } from "@/convex/lib/username";
import { TimeZoneField } from "@/components/ui/TimeZoneField";
import { defaultTimeZone } from "@/lib/timeZones";

/** Card chrome shared by every /join state (matches AuthForm / /enroll). */
function JoinShell({ children }: { children: React.ReactNode }) {
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
          gap={5}
          bg="white"
          p={{ base: 8, md: 10 }}
          borderRadius="2xl"
          shadow="2xl"
          textAlign="center"
        >
          <Box fontSize="44px" lineHeight="1" userSelect="none" aria-label="Rabbithole">
            <span style={{ display: "inline-block", transform: "scaleX(-1)" }}>🐇</span>
            <span>🕳️</span>
          </Box>
          {children}
        </VStack>
      </Container>
    </Box>
  );
}

const inputChrome = {
  bg: "gray.50",
  border: "1px solid",
  borderColor: "gray.300",
  borderRadius: "lg",
  fontFamily: "body",
  h: 12,
  _focus: { borderColor: "violet.400", boxShadow: "none", outline: "none" },
  _focusVisible: { boxShadow: "none", outline: "none" },
} as const;

const ROLE_LABEL: Record<string, string> = {
  school_admin: "school admin",
  teacher: "teacher",
  scholar: "scholar",
};

type InviteInfo = {
  kind: "create_institution" | "join_institution";
  role: string;
  institutionName: string | null;
  label: string | null;
  ceremony: "passkey" | "password";
};

function JoinForm({ code, info }: { code: string; info: InviteInfo }) {
  const registerWithCode = useMutation(api.users.registerWithCode);
  const { signIn } = useAuthActions();
  const router = useRouter();

  const isCreate = info.kind === "create_institution";
  const isPasskey = info.ceremony === "passkey";

  const [institutionName, setInstitutionName] = useState("");
  const [timeZone, setTimeZone] = useState(defaultTimeZone);
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const heading = isCreate
    ? "Create your school"
    : `Join ${info.institutionName ?? "your school"}`;
  const subtext = isCreate
    ? "Name your school and set up your leader account."
    : `You've been invited as a ${ROLE_LABEL[info.role] ?? info.role}.`;

  const submit = async () => {
    const u = username.trim();
    if (!u) {
      setError("Choose a username.");
      return;
    }
    if (u.includes("@")) {
      setError("Pick a username, not an email address.");
      return;
    }
    const usernameProblem = usernameError(username);
    if (usernameProblem) {
      setError(usernameProblem);
      return;
    }
    if (isCreate && !institutionName.trim()) {
      setError("Enter a name for your school.");
      return;
    }
    // Creating a school makes a passkey-primary leader account, whose only
    // magic-link recovery path is their email — so it's required here (but not
    // for a scholar/staff join, where email stays optional).
    if (isCreate && !isValidEmail(email)) {
      setError(
        email.trim()
          ? "Enter a valid email address."
          : "Enter an email — it's your backup way to sign in if you lose your passkey.",
      );
      return;
    }
    const normalizedPassword = normalizePassword(password);
    if (
      !isPasskey &&
      normalizedPassword.length < MIN_PASSWORD_LENGTH
    ) {
      setError(
        `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
      );
      return;
    }
    setBusy(true);
    setError("");
    try {
      const outcome = await registerWithCode({
        username: u,
        code,
        name: name.trim() || undefined,
        email: email.trim() || undefined,
        institutionName: isCreate ? institutionName.trim() : undefined,
        timeZone: isCreate ? timeZone : undefined,
      });
      if (outcome?.kind === "enroll") {
        // Passwordless (school_admin / staff): go set up a passkey. A new
        // school leader lands on School Settings after they sign in with it.
        const dest = isCreate ? "/school/settings" : "/";
        router.replace(`${outcome.path}&next=${encodeURIComponent(dest)}`);
        return;
      }
      // Scholar: the row is pre-created — finish with a password sign-up.
      await signIn("password", {
        email: `${u}@local`,
        ...passwordAuthParams(password, "signUp"),
      });
      router.replace("/");
    } catch (err) {
      const raw = err instanceof Error ? err.message : "";
      setError(raw || "Something went wrong. Check the details and try again.");
      setBusy(false);
    }
  };

  return (
    <>
      <VStack gap={1}>
        <Heading as="h1" size="lg" fontFamily="heading" color="navy.500" letterSpacing="tight">
          {heading}
        </Heading>
        <Text color="charcoal.400" fontFamily="heading" fontSize="sm">
          {subtext}
        </Text>
      </VStack>

      <VStack gap={3} w="full">
        {isCreate && (
          <>
            <Box w="full" textAlign="left">
              <Text fontSize="xs" color="charcoal.500" mb={1} fontFamily="heading">
                School name
              </Text>
              <Input
                placeholder="e.g. Prism Academy"
                value={institutionName}
                onChange={(e) => setInstitutionName(e.target.value)}
                disabled={busy}
                autoFocus
                {...inputChrome}
              />
            </Box>
            <Box w="full" textAlign="left">
              <Text fontSize="xs" color="charcoal.500" mb={1} fontFamily="heading">
                Time zone
              </Text>
              <TimeZoneField
                value={timeZone}
                onChange={setTimeZone}
                disabled={busy}
                size="md"
                w="full"
                inputProps={{ "aria-label": "Time zone", ...inputChrome }}
              />
            </Box>
          </>
        )}

        <Box w="full" textAlign="left">
          <Text fontSize="xs" color="charcoal.500" mb={1} fontFamily="heading">
            Your name{" "}
            {isPasskey && <Text as="span" color="charcoal.300">(optional)</Text>}
          </Text>
          <Input
            placeholder="e.g. James Wong"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
            autoFocus={!isCreate && isPasskey}
            {...inputChrome}
          />
        </Box>

        <Box w="full" textAlign="left">
          <Text fontSize="xs" color="charcoal.500" mb={1} fontFamily="heading">
            Username
          </Text>
          <Input
            placeholder="Choose a username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            disabled={busy}
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            {...inputChrome}
          />
        </Box>

        {isPasskey && (
          <Box w="full" textAlign="left">
            <Text fontSize="xs" color="charcoal.500" mb={1} fontFamily="heading">
              Email{" "}
              {isCreate ? (
                <Text as="span" color="charcoal.300">
                  (your sign-in-link backup if you lose your passkey)
                </Text>
              ) : (
                <Text as="span" color="charcoal.300">
                  (optional — a sign-in-link backup)
                </Text>
              )}
            </Text>
            <Input
              type="email"
              placeholder="you@school.edu"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              disabled={busy}
              required={isCreate}
              aria-required={isCreate}
              autoComplete="email"
              {...inputChrome}
            />
          </Box>
        )}

        {!isPasskey && (
          <Box w="full" textAlign="left">
            <Text fontSize="xs" color="charcoal.500" mb={1} fontFamily="heading">
              Password
            </Text>
            <Input
              type="password"
              placeholder="Choose a password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              disabled={busy}
              autoComplete="new-password"
              {...inputChrome}
            />
            <Text fontSize="2xs" color="charcoal.400" mt={1} fontFamily="heading">
              At least 4 characters.
            </Text>
          </Box>
        )}

        {error && (
          <Text fontSize="sm" color="red.500" fontFamily="body">
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
          disabled={busy}
          loading={busy}
          onClick={submit}
        >
          {isCreate
            ? "Create school & continue"
            : isPasskey
              ? "Create account & continue"
              : "Create account"}
        </Button>
        {isPasskey && (
          <Text fontSize="xs" color="charcoal.300" fontFamily="heading">
            Next you&apos;ll set up a passkey (Touch ID / Face ID) — no password to
            remember.
          </Text>
        )}
      </VStack>

      <Link href="/sign-in">
        <Text
          color="charcoal.400"
          fontSize="sm"
          fontFamily="heading"
          cursor="pointer"
          _hover={{ color: "violet.500", textDecoration: "underline" }}
        >
          Already have an account? Sign in
        </Text>
      </Link>
    </>
  );
}

function JoinInner() {
  const params = useSearchParams();
  const code = params.get("code") ?? "";
  const info = useQuery(
    api.institutionInvites.inviteInfo,
    code ? { code } : "skip",
  );

  // Latch the FIRST resolved value so a redemption that flips the invite to
  // used/exhausted mid-submit doesn't yank the form out from under the user.
  const [latched, setLatched] = useState<InviteInfo | null | undefined>(
    undefined,
  );
  useEffect(() => {
    if (info !== undefined && latched === undefined) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot latch of the initial query result
      setLatched(info as InviteInfo | null);
    }
  }, [info, latched]);

  if (!code) {
    return (
      <JoinShell>
        <Heading as="h1" size="lg" fontFamily="heading" color="navy.500">
          Invite link
        </Heading>
        <Text fontSize="sm" color="red.500" fontFamily="body">
          This invite link is missing its code. Ask whoever invited you for a new
          link.
        </Text>
      </JoinShell>
    );
  }

  if (latched === undefined) {
    return (
      <JoinShell>
        <Heading as="h1" size="lg" fontFamily="heading" color="navy.500">
          Checking your invite…
        </Heading>
        <Spinner color="violet.500" />
      </JoinShell>
    );
  }

  if (latched === null) {
    return (
      <JoinShell>
        <Heading as="h1" size="lg" fontFamily="heading" color="navy.500">
          Invite unavailable
        </Heading>
        <Text fontSize="sm" color="red.500" fontFamily="body">
          This invite link is invalid, expired, revoked, or already used up. Ask
          whoever invited you for a fresh link.
        </Text>
        <Link href="/sign-in">
          <Text
            color="charcoal.400"
            fontSize="sm"
            fontFamily="heading"
            cursor="pointer"
            _hover={{ color: "violet.500", textDecoration: "underline" }}
          >
            Already have an account? Sign in
          </Text>
        </Link>
      </JoinShell>
    );
  }

  return (
    <JoinShell>
      <JoinForm code={code} info={latched} />
    </JoinShell>
  );
}

export default function JoinPage() {
  return (
    <Suspense fallback={null}>
      <JoinInner />
    </Suspense>
  );
}
