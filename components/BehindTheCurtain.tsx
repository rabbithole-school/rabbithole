"use client";

import {
  Box,
  Button,
  HStack,
  Heading,
  Text,
  VStack,
} from "@chakra-ui/react";
import {
  ArrowSquareOut,
  Brain,
  ChalkboardTeacher,
  Cpu,
  Eye,
  GithubLogo,
  ListChecks,
  Notebook,
  NotePencil,
  ShieldCheck,
} from "@phosphor-icons/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import {
  MODELS,
  MODEL_DISPLAY,
  MODEL_MAKER,
  TUTOR_KNOWLEDGE_CUTOFF,
} from "@/convex/lib/models";
import { KID_SAFE_PRINCIPLES } from "@/lib/kidSafePrinciples";
import { openExternal } from "@/lib/native";

// ── A peek behind the curtain ────────────────────────────────────────
//
// The transparency surface (the "How it works" page): demystify how
// Rabbithole actually works and make the governance explicit. The throughline:
// Rabbithole is a thinking partner that challenges rather than does the
// thinking — not a friend to bond with or a crutch to lean on — and continuity
// comes from a governed record + real humans, NOT an AI that "remembers" or
// "misses" the kid (the ELIZA "it gets me" feeling is powered by mystery; we
// remove the mystery). Copy is audience-aware (scholar / parent / staff). It
// surfaces only learner-safe counts — never the score-bearing or
// observer-voiced contents of the record (see learningRecord.mySummary +
// review/learner-parent-pedagogy.md).

// The public source-of-truth for every AI instruction Rabbithole uses. The
// file opens with a parent-facing "why this exists" note; pointing scholars at
// it keeps that same promise to them too — a tool you can read is harder to
// mistake for a mind (review/anti-parasocial-design.md). Desktop opens a new
// tab; the iPad shell opens it in the built-in browser (the openExternal seam).
let PROMPTS_SOURCE_URL =
  "https://github.com/rabbithole-school/rabbithole/blob/main/convex/prompts.ts";
let META_PROMPTS_SOURCE_URL =
  "https://github.com/rabbithole-school/rabbithole/blob/main/convex/metaPrompts.ts";


type LearningRecordSummary = NonNullable<
  FunctionReturnType<typeof api.learningRecord.mySummary>
>;

function monthAnchor(ts: number): string {
  const date = new Date(ts);
  const now = new Date();
  return date.getFullYear() === now.getFullYear()
    ? date.toLocaleDateString(undefined, { month: "long" })
    : date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

const SCHOLAR_COPY = {
  intro:
    "The honest tour of how Rabbithole works — what it does with your learning, who's in charge of it, and what it really is. No mystery.",
  notesTitle: "It takes notes as you work",
  notesBody:
    "While you and the AI talk, Rabbithole jots down short notes about how you think and what you're getting good at. The cards on your My Learning page are all built from those notes.",
  keptTitle: "Your teacher can see all of it",
  keptBody:
    "These notes are saved automatically as you work — the AI doesn't choose what to keep or hide anything from anyone. Your teacher, a real person, can see every one of them and can change or delete any. Nothing about you is hidden from them. A clear learning insight you share in Today's reflection can become part of your portrait too. Ask Rabbithole is different: that conversation never becomes portrait evidence.",
  memoryTitle: "The AI doesn't really remember you",
  memoryBody:
    "When you come back tomorrow, the AI hasn't been sitting here thinking about you, and it can't miss you — it isn't a person. It feels like it knows you because it reads the kept notes before you start. What carries from one day to the next is a real record and a real teacher, not a robot that remembers.",
  partnerTitle: "It's here to make you think",
  partnerBody:
    "Rabbithole isn't a friend to hang out with, and it won't do your thinking for you. It's a thinking partner — it asks tough questions instead of handing you answers, and it gets more challenging as you grow. The point is you becoming a stronger thinker.",
  verifyBody:
    "None of this is a secret. The exact instructions we give the AI are posted in public for anyone to read — including you. If something here sounds too good to be true, go check it yourself.",
};

// Same facts and governance as the scholar copy, re-pitched for an adult who
// already understands AI basics — no hand-holding or "it can't miss you"
// reassurance. Parents care about what's recorded, who controls it, and the
// design intent; speak to that directly.
const PARENT_COPY: typeof SCHOLAR_COPY = {
  intro:
    "How Rabbithole works with your child's learning — what it records, who controls it, what the AI is, and where to read the real thing. No black boxes.",
  notesTitle: "It keeps a learning record",
  notesBody:
    "As your child works, a separate analysis pass writes short, structured notes about how they think and what they're mastering. The strengths, growth, and suggestions you see here are built from those notes.",
  keptTitle: "The teacher controls the whole record",
  keptBody:
    "The tutor your child chats with never writes these notes or decides what's kept — that's deliberate. Your child's teacher can see the entire record and can edit, override, or delete any of it. Nothing about your child is hidden from them.",
  memoryTitle: "The tutor has no memory of its own",
  memoryBody:
    "Each session, the tutor is handed the kept notes to read — it carries nothing over on its own and forms no bond between visits. Continuity lives in the governed record and the people around your child, by design, not in an AI that “remembers” them.",
  partnerTitle: "A thinking partner, not a crutch",
  partnerBody:
    "Rabbithole is built to make your child think harder — it challenges and questions instead of handing over answers, and it scales up as they grow. It's a thinking partner, not a companion to bond with or a crutch to lean on; the aim is a sharper, more independent thinker. (Hence no consumer-AI engagement hooks — no streaks, no “I missed you.”)",
  verifyBody:
    "None of this is hidden. The exact instructions we give the AI are public and annotated for parents — read them yourself, and hold us to them.",
};

// Staff (teacher / curriculum designer / operations staff / admin): the same adult
// register as the parent copy but about a scholar in general, plus a teacher-
// specific "your part in the loop" section rendered only for this audience.
const STAFF_COPY: typeof SCHOLAR_COPY = {
  intro:
    "How Rabbithole works under the hood — what it records about a scholar, who controls it, what the AI is, and where to read the real thing.",
  notesTitle: "It keeps a governed learning record",
  notesBody:
    "As a scholar works, a separate observer pass writes short, structured notes — mastery, signals, seeds, connections — from the transcript. The record and the dashboards you use are built from those.",
  keptTitle: "You can see and change all of it",
  keptBody:
    "The tutor only reads the record; it never writes its own. You can see the whole thing and edit, override, approve, or remove any of it. Nothing about a scholar is hidden from staff.",
  memoryTitle: "The tutor has no memory of its own",
  memoryBody:
    "Each session the tutor is handed the kept notes through a fixed, ordered assembly — it doesn't choose what to recall and carries nothing over on its own. Continuity is the governed record plus the humans in the loop, never a self-remembering model.",
  partnerTitle: "A thinking partner, not a crutch",
  partnerBody:
    "Rabbithole is built to make a scholar think harder, not to offload the thinking — it challenges and withholds answers, and it scales up as they grow. It's a thinking partner, not a crutch; the aim is a sharper, more independent thinker — which is also why we reject the engagement levers of consumer AI (streaks, persona, re-engagement nudges).",
  verifyBody:
    "Nothing here is hidden. The exact tutor and observer instructions are public and annotated — read them, and coach the AI when it gets something wrong.",
};

export function BehindTheCurtain({
  summary,
  audience = "scholar",
}: {
  summary: LearningRecordSummary | undefined;
  /** Whose voice the copy speaks in. Scholar = second person ("you", warm and
   *  simple); parent + staff = an adult register ("your child" / "a scholar").
   *  Staff also gets an extra "your part in the loop" section. Same facts and
   *  governance throughout — only the framing changes. */
  audience?: "scholar" | "parent" | "staff";
}) {
  const isScholar = audience === "scholar";
  const copy =
    audience === "parent"
      ? PARENT_COPY
      : audience === "staff"
        ? STAFF_COPY
        : SCHOLAR_COPY;
  // Block 1's count sentence depends on data; the rest of the panel is static
  // copy and renders immediately (even while the count is still loading).
  let noticeCount: string;
  if (summary === undefined) {
    noticeCount = ""; // loading — show the framing without a number
  } else if (summary.noteCount === 0) {
    noticeCount =
      " There aren't any yet — they start filling in as you work with the AI.";
  } else {
    const since =
      summary.firstNoteAt !== null
        ? `, going back to ${monthAnchor(summary.firstNoteAt)}`
        : "";
    noticeCount = ` So far it's saved ${summary.noteCount} ${
      summary.noteCount === 1 ? "note" : "notes"
    } about your learning${since}.`;
  }

  // The "what is this, really?" facts. The key correction: Rabbithole is NOT
  // the model — its core is the Rabbithole-authored instruction set (the rules
  // you can read), and it currently *runs on top of* a swappable model. Facts
  // are GLOBAL (from convex/lib/models.ts), never per-scholar, so they add no
  // redaction surface; voiced in the third person so the AI stays a thing, not
  // a someone. Register adapts: kids get plain words, parents/staff an adult tone.
  const modelLabel = MODEL_DISPLAY[MODELS.SONNET];
  const cutoff = TUTOR_KNOWLEDGE_CUTOFF;
  const facts: { label: string; body: string }[] = isScholar
    ? [
        {
          label: "What it really is",
          body:
            "Mostly a big set of written rules — made by the Rabbithole team — that tell an AI how to act. Those rules are the part you can read.",
        },
        {
          label: "What it runs on",
          body: `Right now those rules run on top of an AI called ${modelLabel}, made by ${MODEL_MAKER}. The AI underneath could be swapped out — the rules are Rabbithole's.`,
        },
        {
          label: "Where it runs",
          body:
            "On computers in a big data center — it isn't alive, and it isn't a person, even when it sounds like one.",
        },
        {
          label: "What the AI knows",
          body: cutoff
            ? `${modelLabel} learned from a huge pile of writing up to ${cutoff}, so it might not know about recent things — and it can sound sure even when it's wrong.`
            : `${modelLabel} learned from a huge pile of writing up to a while ago, so it might not know about recent things — and it can sound sure even when it's wrong.`,
        },
      ]
    : [
        {
          label: "What it is",
          body:
            "At its core, Rabbithole is a long set of written instructions — authored by the Rabbithole team — that tell an AI how to behave. Those instructions are the part you can read.",
        },
        {
          label: "What it runs on",
          body: `Those instructions currently run on top of ${modelLabel}, a general-purpose model built by ${MODEL_MAKER}. The underlying model can change; the instructions are ours.`,
        },
        {
          label: "Where it runs",
          body:
            "In a data center — it isn't alive or a person, even when it sounds like one.",
        },
        {
          label: "What the model knows",
          body: cutoff
            ? `${modelLabel} was trained on text up to ${cutoff}, so it can be out of date on recent events — and it can sound confident even when it's wrong.`
            : `${modelLabel} was trained on text up to an earlier cutoff, so it can be out of date on recent events — and it can sound confident even when it's wrong.`,
        },
      ];

  return (
    <Box
      bg="white"
      borderWidth="1px"
      borderColor="gray.200"
      borderRadius="xl"
      shadow="xs"
      p={{ base: 5, md: 7 }}
    >
      <HStack gap={2} mb={1}>
        <Eye color="#222656" size={18} weight="duotone" />
        <Heading size="sm" color="navy.500" fontFamily="heading">
          A peek behind the curtain
        </Heading>
      </HStack>
      <Text fontFamily="body" fontSize="sm" color="charcoal.500" mb={6}>
        {copy.intro}
      </Text>

      <VStack align="stretch" gap={5}>
        <CurtainItem
          icon={<NotePencil color="#AD60BF" size={20} weight="duotone" />}
          title={copy.notesTitle}
        >
          {copy.notesBody}
          {isScholar ? noticeCount : ""}
        </CurtainItem>

        <CurtainItem
          icon={<ChalkboardTeacher color="#AD60BF" size={20} weight="duotone" />}
          title={copy.keptTitle}
        >
          {copy.keptBody}
        </CurtainItem>

        {audience === "staff" && (
          <CurtainItem
            icon={<ShieldCheck color="#AD60BF" size={20} weight="duotone" />}
            title="Your part in the loop"
          >
            You author the curriculum and prompts, and coach the AI like a new
            TA (a thumbs up or down on its choices). You can see and shape
            everything it produces — override its mastery calls, write
            directives, and curate the exploration seeds it suggests (those
            appear in a scholar&apos;s sky by default; you pin or hide them
            rather than approve each one). And sensitive documents —
            assessments, IEPs — pass a redaction boundary, so scores stay
            staff-facing and never reach the tutor.
          </CurtainItem>
        )}

        <CurtainItem
          icon={<Notebook color="#AD60BF" size={20} weight="duotone" />}
          title={copy.memoryTitle}
        >
          {copy.memoryBody}
        </CurtainItem>

        <CurtainItem
          icon={<Brain color="#AD60BF" size={20} weight="duotone" />}
          title={copy.partnerTitle}
        >
          {copy.partnerBody}
        </CurtainItem>

        {/* Kid-safe, static gloss only: never render the assembled prompt or
            anything from the governed learning record here. */}
        <Box borderTopWidth="1px" borderColor="gray.100" pt={5} mt={1}>
          <HStack gap={2} mb={2}>
            <ListChecks color="#222656" size={20} weight="duotone" />
            <Text fontFamily="heading" fontWeight="600" fontSize="sm" color="navy.500">
              The kinds of rules Rabbithole follows
            </Text>
          </HStack>
          <Text fontFamily="body" fontSize="sm" color="charcoal.500" lineHeight="1.6" mb={3}>
            Here&apos;s the short kid version: the AI is supposed to help you do
            the thinking, not do it for you.
          </Text>
          <VStack as="ul" align="stretch" gap={2} listStyleType="none" m={0} p={0}>
            {KID_SAFE_PRINCIPLES.map((principle) => (
              <HStack as="li" key={principle.title} align="flex-start" gap={2}>
                <Box
                  aria-hidden="true"
                  bg="violet.500"
                  borderRadius="full"
                  flexShrink={0}
                  h="6px"
                  mt="2"
                  w="6px"
                />
                <Text fontFamily="body" fontSize="sm" color="charcoal.500" lineHeight="1.6">
                  <Text as="span" fontWeight="600" color="navy.500">
                    {principle.title}:
                  </Text>{" "}
                  {principle.blurb}
                </Text>
              </HStack>
            ))}
          </VStack>
        </Box>

        {/* The anti-anthropomorphization punchline: what Rabbithole literally
            is — Rabbithole-written instructions running on a swappable model,
            not a being. Flat section set off by a hairline rule. */}
        <Box borderTopWidth="1px" borderColor="gray.100" pt={5} mt={1}>
          <HStack gap={2} mb={3}>
            <Cpu color="#222656" size={20} weight="duotone" />
            <Text fontFamily="heading" fontWeight="600" fontSize="sm" color="navy.500">
              What is Rabbithole, really?
            </Text>
          </HStack>
          <VStack align="stretch" gap={2}>
            {facts.map((f) => (
              <IdentityFact key={f.label} label={f.label}>
                {f.body}
              </IdentityFact>
            ))}
          </VStack>
        </Box>

        {/* Capstone: don't trust us, check us. The prompts file is public and
            opens with a transparency note written for parents — we extend the
            same invitation here. A tool you can read is harder to anthropomorphize. */}
        <Box borderTopWidth="1px" borderColor="gray.100" pt={5} mt={1}>
          <HStack gap={2} mb={2}>
            <GithubLogo color="#222656" size={20} weight="duotone" />
            <Text fontFamily="heading" fontWeight="600" fontSize="sm" color="navy.500">
              Don&apos;t take our word for it
            </Text>
          </HStack>
          <Text fontFamily="body" fontSize="sm" color="charcoal.500" lineHeight="1.6" mb={3}>
            {copy.verifyBody}
          </Text>
          <HStack gap={2} flexWrap="wrap">
            <Button
              onClick={() => openExternal(PROMPTS_SOURCE_URL)}
              size="sm"
              bg="navy.500"
              color="white"
              fontFamily="heading"
              fontWeight="600"
              _hover={{ bg: "navy.700" }}
            >
              <GithubLogo weight="bold" />
              Tutor rules
              <ArrowSquareOut />
            </Button>
            <Button
              onClick={() => openExternal(META_PROMPTS_SOURCE_URL)}
              size="sm"
              variant="outline"
              borderColor="navy.300"
              color="navy.500"
              fontFamily="heading"
              fontWeight="600"
              _hover={{ bg: "gray.50" }}
            >
              <GithubLogo weight="bold" />
              Reflection + Ask rules
              <ArrowSquareOut />
            </Button>
          </HStack>
        </Box>
      </VStack>
    </Box>
  );
}

function CurtainItem({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <HStack align="flex-start" gap={3}>
      <Box flexShrink={0} mt={0.5}>
        {icon}
      </Box>
      <Box>
        <Text
          fontFamily="heading"
          fontWeight="600"
          fontSize="sm"
          color="navy.500"
        >
          {title}
        </Text>
        <Text
          fontFamily="body"
          fontSize="sm"
          color="charcoal.500"
          mt={0.5}
          lineHeight="1.6"
        >
          {children}
        </Text>
      </Box>
    </HStack>
  );
}

function IdentityFact({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Text fontFamily="body" fontSize="sm" color="charcoal.500" lineHeight="1.6">
      <Text as="span" fontWeight="600" color="navy.500">
        {label}:
      </Text>{" "}
      {children}
    </Text>
  );
}
