import type { Metadata } from "next";
import {
  Box,
  Container,
  Heading,
  Link,
  Separator,
  Stack,
  Text,
} from "@chakra-ui/react";
import { Surface } from "@/components/ui/Surface";
import { SectionEyebrow } from "@/components/ui/SectionEyebrow";

/**
 * /sources — the public content-sources & attribution page.
 *
 * This page is deliberately reachable WITHOUT signing in. Rabbithole is
 * otherwise entirely login-gated, but some of the openly-licensed material we
 * use carries reuse terms that must be honored *before* login — most
 * concretely, Khan Academy's terms require a login-gated service to display
 * "All Khan Academy content is available for free at www.khanacademy.org"
 * before login (see review/instruction-show-and-do-plan.html §7, "Compliance
 * obligations"). So this credits page has to live pre-auth and be linked from
 * /sign-in.
 *
 * It is a Server Component and runs NO Convex query (authed or otherwise), so
 * there is nothing here for the app's per-page client auth gate to redirect —
 * a signed-out visitor gets the full page. Keep it that way: don't add
 * useCurrentUser / useQuery or any component that requires a session.
 *
 * Adding another source later is meant to be cheap: append an entry to the
 * SOURCES array below and it renders as its own section. Keep the tone plain
 * and factual — this is a credits page for a parent or teacher, not marketing.
 */

export const metadata: Metadata = {
  title: "Content sources — Rabbithole",
  description:
    "Where the learning material in Rabbithole comes from, and the licenses it's used under.",
};

type Source = {
  id: string;
  name: string;
  /** Rendered as the section body. Plain paragraphs, parent-readable. */
  body: React.ReactNode;
};

const SOURCES: Source[] = [
  {
    id: "khan-academy",
    name: "Khan Academy",
    body: (
      <Stack gap={4}>
        <Text>
          Some of the short instructional videos in Rabbithole are curated clips
          from Khan Academy. Khan Academy is a nonprofit that makes its lessons
          free for everyone.
        </Text>

        {/* The exact notice string Khan's reuse terms require a login-gated
            service to show before login. Keep it verbatim. */}
        <Box
          bg="gray.50"
          borderWidth="1px"
          borderColor="gray.200"
          borderRadius="md"
          px={4}
          py={3}
        >
          <Text fontWeight="500">
            All Khan Academy content is available for free at{" "}
            <Link
              href="https://www.khanacademy.org"
              color="violet.600"
              textDecoration="underline"
              rel="noopener noreferrer"
              target="_blank"
            >
              www.khanacademy.org
            </Link>
            {/* No trailing period: the required notice string ends at the URL,
                and a period after a long wrapping link lands alone on its own
                line. The notice sits in its own callout, so it reads fine. */}
          </Text>
        </Box>

        <Text>
          We use these videos under the{" "}
          <Link
            href="https://creativecommons.org/licenses/by-nc-sa/4.0/"
            color="violet.600"
            textDecoration="underline"
            rel="noopener noreferrer"
            target="_blank"
          >
            Creative Commons BY-NC-SA license
          </Link>{" "}
          that Khan Academy publishes them under. That license allows
          noncommercial reuse, and Rabbithole fits: we&apos;re a nonprofit school app,
          we charge nothing for access, and we show no ads.
        </Text>

        <Text>
          Rabbithole is <strong>not</strong> affiliated with, sponsored by, or
          endorsed by Khan Academy. We&apos;re an independent app that happens to use
          their freely-available material — any mistakes in how a clip is chosen
          or presented are ours, not theirs.
        </Text>
      </Stack>
    ),
  },
];

export default function SourcesPage() {
  return (
    <Box minH="100dvh" bg="gray.50" py={{ base: 10, md: 16 }} px={4}>
      <Container maxW="2xl">
        <Stack gap={8}>
          <Stack gap={3}>
            <Heading as="h1" size="xl" fontFamily="heading">
              Content sources
            </Heading>
            <Text color="fg.muted" fontSize="lg">
              Rabbithole is a Socratic tutor for a small school. Alongside the
              lessons our own teachers write, we draw on openly-licensed and
              freely-available educational material made by others. This page
              lists where that material comes from and the terms it&apos;s used
              under.
            </Text>
          </Stack>

          <Stack gap={6}>
            {SOURCES.map((source) => (
              <Surface key={source.id} p={{ base: 5, md: 6 }}>
                <Stack gap={4}>
                  <SectionEyebrow>Source</SectionEyebrow>
                  <Heading as="h2" size="md" fontFamily="heading">
                    {source.name}
                  </Heading>
                  <Separator />
                  {source.body}
                </Stack>
              </Surface>
            ))}
          </Stack>

          <Text color="fg.subtle" fontSize="sm">
            {/* A plain anchor, not `as={NextLink}`: this page is a Server
                Component (it exports `metadata`), and passing the NextLink
                FUNCTION into Chakra's client `Link` throws "Functions cannot be
                passed directly to Client Components" — a 500 that would have
                taken the whole pre-login notice down. */}
            <Link href="/sign-in" color="violet.600">
              Back to sign in
            </Link>
          </Text>
        </Stack>
      </Container>
    </Box>
  );
}
