"use client";

/**
 * The Code view's reading mode (web twin of
 * native/src/components/vibecode/AppCodeReader.tsx): the app's own source,
 * opened on the world's rules and the code that decides with them, with
 * everything else folded into one line per run.
 *
 * It needs nothing from the builder. The model (shared/appCodeMap.ts →
 * buildReader) reads the code itself and the rules the app already publishes
 * in APP STATE. Labels stay honest to the code: a part shows its name as
 * written and the lines that run it, verbatim; a fold lists the names inside
 * it. A rule's starting value is tinted where it sits; clicking it says which
 * rule it is, who set it, and that its card in the app is where it changes.
 * The card stays the one place a rule's value is edited.
 *
 * Editing stays in the existing textarea, one click away.
 */
import { useMemo, useState } from "react";
import { Box, Button, chakra, Flex, Text } from "@chakra-ui/react";
import { CaretDown, CaretRight, PencilSimple } from "@phosphor-icons/react";
import { buildReader, type AppRuleEntry, type Token } from "@/shared/appCodeMap";

/** Long open parts render this many lines until the reader asks for more. */
const OPEN_LINE_CAP = 120;

const TOKEN_COLOR: Record<Token["kind"], string> = {
  keyword: "violet.600",
  string: "navy.400",
  // Numbers are what a reader scans for first: the strongest readable hue.
  number: "darkCyan.700",
  comment: "charcoal.300",
  text: "charcoal.500",
};

const CodeLine = chakra("div", {
  base: {
    fontFamily: "mono",
    fontSize: "13px",
    lineHeight: "1.7",
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    fontVariantLigatures: "none",
  },
});

export function AppCodeReader({
  source,
  rules,
  startingRules,
  onEdit,
}: {
  source: string;
  /** APP STATE `rules` now: name, current value, who set it. */
  rules: readonly AppRuleEntry[] | undefined;
  /** The same rules as the app's code first wrote them (`__rhDefaults`). */
  startingRules: readonly AppRuleEntry[] | undefined;
  /** Absent when the code is read-only. */
  onEdit?: () => void;
}) {
  const reader = useMemo(() => buildReader(source, rules, startingRules), [source, rules, startingRules]);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const [note, setNote] = useState<{ line: number; name: string } | null>(null);
  const toggle = (start: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(start)) next.delete(start);
      else next.add(start);
      return next;
    });

  const renderLine = (k: number) => {
    const tokens = reader.tokens.get(k);
    const noteHere = note?.line === k ? note.name : null;
    return (
      <Box key={k}>
        <CodeLine>
          {tokens ? (
            tokens.map((t, i) => {
              const rule = reader.ruleFor(k, t);
              if (!rule) {
                return (
                  <chakra.span key={i} color={TOKEN_COLOR[t.kind]}>
                    {t.text}
                  </chakra.span>
                );
              }
              return (
                <chakra.button
                  key={i}
                  type="button"
                  onClick={() => setNote(noteHere === rule ? null : { line: k, name: rule })}
                  aria-label={`Rule: ${rule}`}
                  aria-expanded={noteHere === rule}
                  color={TOKEN_COLOR[t.kind]}
                  fontWeight="bold"
                  bg="orange.50"
                  boxShadow="0 0 0 1px var(--chakra-colors-orange-300)"
                  borderRadius="4px"
                  cursor="pointer"
                  font="inherit"
                  _focusVisible={{ outline: "2px solid", outlineColor: "violet.500" }}
                >
                  {t.text}
                </chakra.button>
              );
            })
          ) : (
            <chakra.span color="charcoal.400">{reader.map.lines[k]}</chakra.span>
          )}
        </CodeLine>
        {noteHere ? (
          <Box
            my={1}
            px={3}
            py={2}
            maxW="460px"
            bg="white"
            borderWidth="1px"
            borderColor="gray.200"
            borderRadius="md"
            fontSize="sm"
            color="charcoal.500"
          >
            {reader.noteFor(noteHere)}
          </Box>
        ) : null}
      </Box>
    );
  };

  return (
    <Flex direction="column" gap={2}>
      <Flex align="center" gap={3} mb={1}>
        <Text flex={1} fontSize="sm" color="charcoal.400">
          {"Rabbithole’s AI writes this code based on your conversation with it. It’s JavaScript code that runs inside the Rabbithole app."}
        </Text>
        {onEdit ? (
          <Button size="sm" variant="outline" colorPalette="violet" fontFamily="heading" onClick={onEdit}>
            <PencilSimple /> Edit code
          </Button>
        ) : null}
      </Flex>
      {reader.blocks.map((b) => {
        const isRest = b.kind === "rest";
        const open = isRest ? expanded.has(b.start) : !expanded.has(b.start);
        const title = b.kind === "part" ? b.part.title : b.title;
        const titleIsCode = b.kind === "part" ? b.part.titleIsCode : b.titleIsCode;
        const calledFrom = b.kind === "part" ? b.part.calledFrom : undefined;
        const count = b.end - b.start + 1;
        return (
          <Section
            key={b.start}
            start={b.start}
            end={b.end}
            count={count}
            title={title}
            titleIsCode={titleIsCode}
            calledFrom={calledFrom}
            open={open}
            muted={isRest}
            onToggle={() => toggle(b.start)}
            renderLine={renderLine}
          />
        );
      })}
    </Flex>
  );
}

function Section({
  start,
  end,
  count,
  title,
  titleIsCode,
  calledFrom,
  open,
  muted,
  onToggle,
  renderLine,
}: {
  start: number;
  end: number;
  count: number;
  title: string;
  titleIsCode: boolean;
  calledFrom?: string[];
  open: boolean;
  muted: boolean;
  onToggle: () => void;
  renderLine: (k: number) => React.ReactNode;
}) {
  const [showAll, setShowAll] = useState(false);
  const last = showAll ? end : Math.min(end, start + OPEN_LINE_CAP - 1);
  const rows: number[] = [];
  if (open) for (let k = start; k <= last; k++) rows.push(k);
  return (
    <Box
      borderWidth="1px"
      borderColor="gray.200"
      borderRadius="lg"
      px={3}
      py={2}
      bg={muted && !open ? "gray.50" : "white"}
    >
      <chakra.button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        display="flex"
        alignItems="center"
        gap={2.5}
        w="100%"
        textAlign="left"
        cursor="pointer"
      >
        <Box color="charcoal.400" flexShrink={0}>
          {open ? <CaretDown size={12} /> : <CaretRight size={12} />}
        </Box>
        <Text
          flex={1}
          minW={0}
          truncate
          fontFamily={titleIsCode ? "mono" : "heading"}
          fontSize={titleIsCode ? "14px" : "md"}
          fontWeight="semibold"
          color={muted ? "charcoal.400" : "charcoal.500"}
        >
          {title}
        </Text>
        <Text fontSize="sm" color="charcoal.400" flexShrink={0}>
          {count === 1 ? "1 line" : `${count} lines`}
        </Text>
      </chakra.button>
      {open && calledFrom?.length ? (
        <Flex direction="column" gap={0.5} mt={1} ml={5}>
          {calledFrom.map((site) => (
            <Text key={site} fontSize="sm" color="charcoal.400">
              Runs from{" "}
              <chakra.code fontFamily="mono" fontSize="12px" color="charcoal.500" css={{ fontVariantLigatures: "none" }}>
                {site}
              </chakra.code>
            </Text>
          ))}
        </Flex>
      ) : null}
      {open ? <Box mt={1}>{rows.map(renderLine)}</Box> : null}
      {open && last < end ? (
        <Button size="sm" variant="plain" colorPalette="violet" px={0} onClick={() => setShowAll(true)}>
          Show {end - last} more lines
        </Button>
      ) : null}
    </Box>
  );
}
