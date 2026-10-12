"use client";

/**
 * Interim check-in editor within the scholar-first Reports IA (?ic=1).
 *
 * The school's mid-term "Interim Academic & Whole Child Evaluation" — one per
 * scholar × reporting period. Resolves the scholar + period (like the Whole
 * Child editor), lazily opens the check-in on first visit, then renders the
 * template (`convex/lib/interimCheckinTemplate.ts`) as two parts of rated
 * sections plus three teacher-comment fields.
 *
 * The scale is a diagnostic, not a grade: no colored ratings, no averages, no
 * scores. Teacher-facing only — nothing here reaches the tutor or parents.
 */
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Box, Button, Flex, Heading, HStack, Spinner, Text, Textarea, VStack } from "@chakra-ui/react";
import { Check } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Avatar } from "@/components/Avatar";
import { Surface } from "@/components/ui/Surface";
import { ReportShell } from "@/components/narrative/ReportShell";
import { useScholarRoster } from "@/hooks/useScholarRoster";
import { toaster } from "@/lib/toaster";
import {
  INTERIM_COMMENT_FIELDS,
  INTERIM_ITEM_KEYS,
  INTERIM_RATINGS,
  INTERIM_SECTIONS,
  type InterimCommentKey,
  type InterimRating,
  type InterimSection,
  interimRatedCount,
} from "@/convex/lib/interimCheckinTemplate";
import { useActiveInstitution } from "@/hooks/useActiveInstitution";

const TOTAL_ITEMS = INTERIM_ITEM_KEYS.length;

export function InterimCheckinEditor({
  scholarId,
  periodParam,
}: {
  scholarId: Id<"users">;
  periodParam: string | null;
}) {
  const { scopeParam, hrefWithActiveInstitution } = useActiveInstitution();
  const current = useQuery(api.reportingPeriods.current, { scope: scopeParam });
  const periods = useQuery(api.reportingPeriods.list, { scope: scopeParam });
  const { scholars, isLoading: rosterLoading } = useScholarRoster();

  const activePeriod = periods
    ? (periodParam && periods.find((p) => String(p._id) === periodParam)) || current || periods[0] || null
    : (current ?? undefined);
  const periodId = (activePeriod?._id ?? null) as Id<"reportingPeriods"> | null;
  const scholar = scholars.find((s) => s.id === String(scholarId));

  const backHref = hrefWithActiveInstitution(
    `/teacher/report/${String(scholarId)}${periodId ? `?period=${String(periodId)}` : ""}`,
  );
  const rosterHref = hrefWithActiveInstitution(`/teacher/report${periodId ? `?period=${String(periodId)}` : ""}`);

  const checkin = useQuery(
    api.interimCheckins.getForScholarPeriod,
    periodId ? { scholarId, periodId } : "skip",
  );

  const open = useMutation(api.interimCheckins.open);
  const queryArgs = periodId ? { scholarId, periodId } : null;
  const setRating = useMutation(api.interimCheckins.setRating).withOptimisticUpdate((store, args) => {
    if (!queryArgs) return;
    const cur = store.getQuery(api.interimCheckins.getForScholarPeriod, queryArgs);
    if (!cur) return;
    const ratings = { ...cur.ratings };
    if (args.rating === undefined) delete ratings[args.itemKey];
    else ratings[args.itemKey] = args.rating;
    store.setQuery(api.interimCheckins.getForScholarPeriod, queryArgs, { ...cur, ratings });
  });
  const setFlag = useMutation(api.interimCheckins.setFlag).withOptimisticUpdate((store, args) => {
    if (!queryArgs) return;
    const cur = store.getQuery(api.interimCheckins.getForScholarPeriod, queryArgs);
    if (!cur) return;
    const flags = cur.flags.filter((f) => f !== args.flagKey);
    if (args.on) flags.push(args.flagKey);
    store.setQuery(api.interimCheckins.getForScholarPeriod, queryArgs, { ...cur, flags });
  });
  const saveComment = useMutation(api.interimCheckins.saveComment);
  const setDone = useMutation(api.interimCheckins.setDone);

  // Lazily create the check-in on first visit. `open` is idempotent; the ref
  // guards against React's dev double-effect firing it twice.
  const openingRef = useRef(false);
  const [openError, setOpenError] = useState<string | null>(null);
  useEffect(() => {
    if (!periodId) return;
    if (checkin === null && !openingRef.current && !openError) {
      openingRef.current = true;
      open({ scholarId, periodId })
        .catch((e) => {
          setOpenError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          openingRef.current = false;
        });
    }
  }, [checkin, periodId, scholarId, open, openError]);

  const crumbs = [
    { label: "All scholars", href: rosterHref },
    { label: scholar?.name ?? "Scholar", href: backHref },
    { label: "Interim check-in" },
  ];

  if (openError) {
    return (
      <ReportShell crumbs={crumbs} scholarId={scholarId}>
        <Text fontSize="sm" color="charcoal.400" fontFamily="heading" textAlign="center" py={16}>
          Couldn&apos;t start the interim check-in: {openError}
        </Text>
      </ReportShell>
    );
  }

  const message = (text: string) => (
    <ReportShell crumbs={crumbs} scholarId={scholarId}>
      <Text fontSize="sm" color="charcoal.400" fontFamily="heading" textAlign="center" py={16}>
        {text}
      </Text>
    </ReportShell>
  );
  const spinner = (
    <ReportShell crumbs={crumbs} scholarId={scholarId}>
      <Flex justify="center" py={16}>
        <Spinner size="lg" color="violet.500" />
      </Flex>
    </ReportShell>
  );

  if (periods === undefined || current === undefined || rosterLoading) return spinner;
  if (!periodId) return message("No reporting period set up yet. Create one from the Reports tab first.");
  if (!scholar) return message("No scholar found with that id.");
  if (!checkin) return spinner;

  const done = checkin.status === "final";
  const rated = interimRatedCount(checkin.ratings);
  const checkinId = checkin._id;

  const handleRating = (itemKey: string, next: InterimRating | undefined) => {
    setRating({ checkinId, itemKey, ...(next ? { rating: next } : {}) }).catch((e) => {
      toaster.error({ title: "Couldn't save rating", description: e instanceof Error ? e.message : String(e) });
    });
  };
  const handleFlag = (flagKey: string, on: boolean) => {
    setFlag({ checkinId, flagKey, on }).catch((e) => {
      toaster.error({ title: "Couldn't save flag", description: e instanceof Error ? e.message : String(e) });
    });
  };
  const handleComment = (field: InterimCommentKey, body: string) =>
    saveComment({ checkinId, field, body }).catch((e: unknown) => {
      toaster.error({ title: "Couldn't save comment", description: e instanceof Error ? e.message : String(e) });
      throw e;
    });
  const handleDone = (nextDone: boolean) => {
    setDone({ checkinId, done: nextDone }).catch((e) => {
      toaster.error({ title: "Couldn't update status", description: e instanceof Error ? e.message : String(e) });
    });
  };

  const academic = INTERIM_SECTIONS.filter((s) => s.part === "academic");
  const wholeChild = INTERIM_SECTIONS.filter((s) => s.part === "wholeChild");

  return (
    <ReportShell crumbs={crumbs} scholarId={scholarId}>
      <Box px={6} pb={6}>
        {/* Header */}
        <Flex align="flex-start" justify="space-between" gap={4} wrap="wrap" mb={5}>
          <HStack gap={3} align="center" minW={0}>
            <Avatar name={scholar.name} src={scholar.image ?? undefined} colorKey={scholarId} size="md" />
            <Box minW={0}>
              <Heading fontFamily="heading" fontWeight="700" size="lg" color="navy.600">
                {scholar.name}
              </Heading>
              <Text fontSize="sm" color="charcoal.400" fontFamily="body">
                Interim check-in · {activePeriod?.label ?? "No reporting period"}
              </Text>
              <Text fontSize="xs" color="charcoal.400" fontFamily="body" mt={0.5}>
                {checkin.teacherName ? `${checkin.teacherName} · ` : ""}
                {done && checkin.completedAt
                  ? new Date(checkin.completedAt).toLocaleDateString()
                  : "Draft"}
              </Text>
            </Box>
          </HStack>
          <Text fontSize="sm" color="charcoal.500" fontFamily="heading" fontWeight="600" flexShrink={0}>
            {rated} of {TOTAL_ITEMS} rated
          </Text>
        </Flex>

        {/* Academic development */}
        <PartHeading>Academic development</PartHeading>
        <VStack align="stretch" gap={4} mb={6}>
          {academic.map((section) => (
            <SectionCard
              key={section.key}
              section={section}
              ratings={checkin.ratings}
              flags={checkin.flags}
              onRate={handleRating}
              onFlag={handleFlag}
            />
          ))}
        </VStack>

        {/* Whole child */}
        <PartHeading>Whole child</PartHeading>
        <VStack align="stretch" gap={4} mb={6}>
          {wholeChild.map((section) => (
            <SectionCard
              key={section.key}
              section={section}
              ratings={checkin.ratings}
              flags={checkin.flags}
              onRate={handleRating}
              onFlag={handleFlag}
            />
          ))}
        </VStack>

        {/* Teacher comments */}
        <PartHeading>Teacher comments</PartHeading>
        <Surface p={5} mb={6}>
          <VStack align="stretch" gap={5}>
            {INTERIM_COMMENT_FIELDS.map((field) => (
              <CommentField
                key={field.key}
                label={field.label}
                serverValue={checkin.comments[field.key] ?? ""}
                onSave={(body) => handleComment(field.key, body)}
              />
            ))}
          </VStack>
        </Surface>

        {/* Footer */}
        <Flex justify="flex-end">
          {done ? (
            <Button size="sm" variant="outline" colorPalette="gray" fontFamily="heading" onClick={() => handleDone(false)}>
              Reopen
            </Button>
          ) : (
            <Button size="sm" colorPalette="violet" fontFamily="heading" onClick={() => handleDone(true)}>
              <Check size={14} style={{ marginRight: 4 }} /> Mark done
            </Button>
          )}
        </Flex>
      </Box>
    </ReportShell>
  );
}

function PartHeading({ children }: { children: React.ReactNode }) {
  return (
    <Heading
      fontFamily="heading"
      fontWeight="700"
      fontSize="xs"
      textTransform="uppercase"
      letterSpacing="0.06em"
      color="charcoal.400"
      mb={2.5}
    >
      {children}
    </Heading>
  );
}

function SectionCard({
  section,
  ratings,
  flags,
  onRate,
  onFlag,
}: {
  section: InterimSection;
  ratings: Record<string, string>;
  flags: string[];
  onRate: (itemKey: string, next: InterimRating | undefined) => void;
  onFlag: (flagKey: string, on: boolean) => void;
}) {
  return (
    <Surface p={5}>
      <Heading fontFamily="heading" fontWeight="700" size="md" color="navy.600" mb={3}>
        {section.title}
      </Heading>
      <VStack align="stretch" gap={4}>
        {section.groups.map((group) => (
          <Box key={group.key}>
            {group.title && (
              <Text
                fontFamily="heading"
                fontWeight="700"
                fontSize="xs"
                textTransform="uppercase"
                letterSpacing="0.04em"
                color="violet.600"
                mb={2}
              >
                {group.title}
              </Text>
            )}
            <VStack align="stretch" gap={0}>
              {group.items.map((item, i) => (
                <Flex
                  key={item.key}
                  align="center"
                  justify="space-between"
                  gap={3}
                  wrap="wrap"
                  py={2.5}
                  borderTopWidth={i === 0 ? undefined : "1px"}
                  borderColor="gray.100"
                >
                  <Box flex="1 1 240px" minW="200px">
                    <ItemLabel label={item.label} />
                  </Box>
                  <RatingScale
                    value={ratings[item.key] as InterimRating | undefined}
                    onChange={(next) => onRate(item.key, next)}
                  />
                </Flex>
              ))}
            </VStack>
          </Box>
        ))}

        {section.preferenceFlag && (
          <FlagRow
            label={section.preferenceFlag.label}
            checked={flags.includes(section.preferenceFlag.key)}
            onToggle={(on) => onFlag(section.preferenceFlag!.key, on)}
          />
        )}
      </VStack>
    </Surface>
  );
}

/** Splits a "Core: …" academic label into a bold dimension lead-in + the rest. */
function ItemLabel({ label }: { label: string }) {
  const m = label.match(/^(Core|Connections|Practice):\s*(.*)$/);
  if (m) {
    return (
      <Text fontSize="sm" color="charcoal.600" fontFamily="body">
        <Text as="span" fontFamily="heading" fontWeight="700" color="navy.600">
          {m[1]}
        </Text>{" "}
        {m[2]}
      </Text>
    );
  }
  return (
    <Text fontSize="sm" color="charcoal.600" fontFamily="body">
      {label}
    </Text>
  );
}

/** The 5-point scale as a compact segmented control — one tap sets, tapping the
 *  selected one clears. Never colored (the scale is a diagnostic, not a grade). */
function RatingScale({
  value,
  onChange,
}: {
  value: InterimRating | undefined;
  onChange: (next: InterimRating | undefined) => void;
}) {
  return (
    <HStack gap={0.5} bg="gray.100" p={0.5} borderRadius="md" flexShrink={0}>
      {INTERIM_RATINGS.map((r) => {
        const active = value === r.value;
        return (
          <Box
            as="button"
            key={r.value}
            onClick={() => onChange(active ? undefined : r.value)}
            aria-pressed={active}
            px={2}
            py={1}
            borderRadius="sm"
            fontFamily="heading"
            fontWeight="600"
            fontSize="xs"
            whiteSpace="nowrap"
            bg={active ? "white" : "transparent"}
            color={active ? "navy.600" : "charcoal.400"}
            shadow={active ? "xs" : "none"}
            _hover={{ bg: active ? "white" : "gray.200" }}
            cursor="pointer"
          >
            {r.label}
          </Box>
        );
      })}
    </HStack>
  );
}

function FlagRow({
  label,
  checked,
  onToggle,
}: {
  label: string;
  checked: boolean;
  onToggle: (on: boolean) => void;
}) {
  return (
    <Flex
      as="label"
      align="center"
      gap={2.5}
      pt={3}
      borderTopWidth="1px"
      borderColor="gray.100"
      cursor="pointer"
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onToggle(e.target.checked)}
        style={{ width: 15, height: 15, accentColor: "var(--chakra-colors-violet-500)", cursor: "pointer" }}
      />
      <Text fontSize="sm" color="charcoal.500" fontFamily="body">
        {label}
      </Text>
    </Flex>
  );
}

const COMMENT_SAVE_DELAY_MS = 800;

function CommentField({
  label,
  serverValue,
  onSave,
}: {
  label: string;
  serverValue: string;
  onSave: (body: string) => Promise<unknown>;
}) {
  // Local state so a reactive query update never clobbers typing. `savedRef`
  // is the last text the server has CONFIRMED; the field is "clean" when what
  // is on screen equals it.
  const [value, setValue] = useState(serverValue);
  const savedRef = useRef(serverValue);
  const latestRef = useRef(serverValue);
  const onSaveRef = useRef(onSave);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    onSaveRef.current = onSave;
  });

  // Another teacher's newer text flows in while this field is clean; a dirty
  // field keeps what is being typed.
  useEffect(() => {
    if (latestRef.current === savedRef.current && serverValue !== savedRef.current) {
      savedRef.current = serverValue;
      latestRef.current = serverValue;
      setValue(serverValue);
    }
  }, [serverValue]);

  const flush = (next: string) => {
    if (next === savedRef.current) return;
    onSaveRef.current(next).then(
      () => {
        savedRef.current = next;
      },
      () => {
        // Stays dirty, so the next blur or unmount retries it.
      },
    );
  };

  const handleChange = (next: string) => {
    setValue(next);
    latestRef.current = next;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => flush(next), COMMENT_SAVE_DELAY_MS);
  };

  const handleBlur = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    flush(value);
  };

  // Leaving the page mid-debounce must still save what was typed.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (latestRef.current !== savedRef.current) {
        onSaveRef.current(latestRef.current).catch(() => {});
      }
    };
  }, []);

  return (
    <Box>
      <Text fontFamily="heading" fontWeight="700" fontSize="sm" color="navy.600" mb={1.5}>
        {label}
      </Text>
      <Textarea
        value={value}
        onChange={(e) => handleChange(e.target.value)}
        onBlur={handleBlur}
        rows={3}
        fontFamily="body"
        fontSize="sm"
        resize="vertical"
        borderColor="gray.200"
        _focusVisible={{ borderColor: "violet.400", boxShadow: "none" }}
      />
    </Box>
  );
}
