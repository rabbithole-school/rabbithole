"use client";

/**
 * Guest mode's whole UI: pick one of three questions, type back at most eight
 * times, then a card that says the thing stopped.
 *
 * Dressed as the tutor screen a scholar actually uses. The chrome here — a
 * centred title with a back control, the bare tutor voice against a navy
 * own-turn bubble, the rounded composer with its "+" and its accent send
 * button — mirrors `native/src/app/session/[id].tsx` and the canonical bubble
 * treatment in `native/src/lib/chatBubbles.ts`, so a parent who tries this and
 * later watches their child work sees the same software twice. The values come
 * from the app's own tokens (`lib/theme.ts` → `shared/brand.ts`); nothing here
 * invents a colour.
 *
 * Still no logo, no nav, no "powered by": this runs inside an iframe on a
 * marketing page that is already saying whose product it is.
 *
 * The transcript lives HERE and nowhere else: React state in one tab. There is
 * no Convex client on this page and no auth; the only network call is the SSE
 * POST, which persists nothing. Closing the tab is the delete.
 *
 * The caption under the composer is not decoration. It is the product's own
 * anti-parasocial claim, made to the person most likely to be worried about it
 * (`review/anti-parasocial-design.md`), and it stays on screen for the whole
 * exchange rather than appearing once and scrolling away.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Button, Flex, Text, Textarea, VStack } from "@chakra-ui/react";
import { ArrowUp, CaretLeft, Plus } from "@phosphor-icons/react";
import { convexSiteUrl } from "@/lib/convexUrls";

export type GuestConfig = {
  enabled: boolean;
  maxTurns: number;
  closingLine: string;
  caption: string;
  topics: { id: string; title: string }[];
};

type Turn = { role: "user" | "assistant"; content: string };

/**
 * The reading column the transcript, the composer and the questions all share,
 * so the conversation never sprawls across a wide iframe. Mirrors the native
 * tutor screen's `COLUMN_MAX_WIDTH`.
 */
const COLUMN_MAX_WIDTH = "46rem";
/** The own-turn bubble's radius, matching `chatBubbleStyles` on native. */
const BUBBLE_RADIUS = "28px";
/** The tucked bottom-right corner the app's own-turn bubble has. */
const BUBBLE_TUCK = "10px";

/**
 * Read one SSE stream, calling `onText` for each delta.
 *
 * Hand-rolled rather than reusing `useAgentStream`: that hook carries a Convex
 * auth token, retry planning, and tool-activity plumbing, none of which exist
 * on an unauthenticated surface with no tools. Forty lines here beats an
 * authenticated hook bent into an anonymous shape.
 */
async function readGuestStream(
  response: Response,
  onText: (delta: string) => void,
): Promise<{ error?: string }> {
  const reader = response.body?.getReader();
  if (!reader) return { error: "Something went wrong." };
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const line = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      try {
        const event = JSON.parse(line.slice(6)) as {
          text?: string;
          error?: string;
        };
        if (event.error) return { error: event.error };
        if (event.text) onText(event.text);
      } catch {
        // A malformed frame is not worth failing a whole exchange over.
      }
    }
  }
  return {};
}

export function GuestTutorEmbed({ config }: { config: GuestConfig }) {
  const [topicId, setTopicId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [streaming, setStreaming] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const guestTurnsUsed = turns.filter((t) => t.role === "user").length;
  const capReached = guestTurnsUsed >= config.maxTurns;
  const finished = capReached && !busy && !streaming;

  const topicTitle =
    config.topics.find((topic) => topic.id === topicId)?.title ?? null;

  // Bottom-anchored like a messaging app: the transcript keeps its own scroll
  // box pinned to the newest turn. Never `scrollIntoView` — inside an iframe
  // that walks up and scrolls the EMBEDDING page, which is not ours to move.
  const stickToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  useEffect(() => {
    stickToBottom();
  }, [turns, streaming, busy, error, finished, stickToBottom]);

  const run = useCallback(
    async (topic: string, history: Turn[]) => {
      setBusy(true);
      setError(null);
      setStreaming("");
      let assembled = "";
      try {
        const response = await fetch(`${convexSiteUrl()}/guest-tutor-stream`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ topic, messages: history }),
        });
        const result = await readGuestStream(response, (delta) => {
          assembled += delta;
          setStreaming(assembled);
        });
        if (result.error) {
          setError(result.error);
        } else if (!response.ok) {
          setError("Something went wrong. Try again in a moment.");
        } else if (assembled.trim()) {
          setTurns([...history, { role: "assistant", content: assembled }]);
        }
      } catch {
        setError("Something went wrong. Try again in a moment.");
      } finally {
        setStreaming("");
        setBusy(false);
        requestAnimationFrame(stickToBottom);
      }
    },
    [stickToBottom],
  );

  const pickTopic = (id: string) => {
    setTopicId(id);
    setTurns([]);
    setError(null);
    void run(id, []);
  };

  // Back to the three questions. Costs a fresh opening against the server's
  // per-IP hourly caps (`convex/lib/guestTutor.ts`), so it can't be used to
  // mint unlimited turns.
  const backToTopics = () => {
    setTopicId(null);
    setTurns([]);
    setStreaming("");
    setError(null);
    setInput("");
  };

  const send = () => {
    const content = input.trim();
    if (!content || !topicId || busy || finished) return;
    setInput("");
    const history: Turn[] = [...turns, { role: "user", content }];
    setTurns(history);
    void run(topicId, history);
  };

  // ── Topic picker ────────────────────────────────────────────────────
  // Three cards, no free-text box. A visitor cannot steer an unmoderated
  // tutor somewhere nobody has rehearsed, and three good questions show more
  // than an empty prompt does.
  if (!topicId) {
    return (
      <Shell>
        <Header title="Try Rabbithole" />
        <Box flex={1} minH={0} overflowY="auto" px={5} pb={4}>
          <VStack
            gap={3}
            align="stretch"
            maxW={COLUMN_MAX_WIDTH}
            mx="auto"
            pt={2}
          >
            <Text
              fontFamily="heading"
              fontSize="sm"
              color="charcoal.400"
              pb={1}
            >
              Pick a question.
            </Text>
            {config.topics.map((topic) => (
              <Button
                key={topic.id}
                onClick={() => pickTopic(topic.id)}
                variant="outline"
                justifyContent="flex-start"
                textAlign="left"
                whiteSpace="normal"
                height="auto"
                py={4}
                px={5}
                borderRadius="20px"
                borderColor="border.default"
                color="fg.default"
                fontFamily="body"
                fontWeight="500"
                _hover={{ borderColor: "navy.300", bg: "bg.subtle" }}
              >
                {topic.title}
              </Button>
            ))}
          </VStack>
        </Box>
        <Caption>{config.caption}</Caption>
      </Shell>
    );
  }

  // ── The exchange ────────────────────────────────────────────────────
  return (
    <Shell>
      <Header title={topicTitle} onBack={backToTopics} backDisabled={busy} />

      <Box
        ref={scrollRef}
        flex={1}
        minH={0}
        overflowY="auto"
        px={5}
        aria-live="polite"
        aria-label="Conversation"
      >
        {/* The messaging-app anchor: the column is at least as tall as its
            scroll box and opens with a growing spacer, so a short exchange
            sits at the BOTTOM and grows upward rather than starting at the top
            of a mostly empty screen. */}
        <VStack
          align="stretch"
          gap={5}
          py={4}
          minH="100%"
          maxW={COLUMN_MAX_WIDTH}
          mx="auto"
        >
          <Box flex={1} />
          {turns.map((turn, index) => (
            <Bubble key={index} role={turn.role} content={turn.content} />
          ))}
          {streaming ? <Bubble role="assistant" content={streaming} /> : null}
          {busy && !streaming ? (
            <Text fontFamily="body" fontSize="sm" color="charcoal.300">
              Thinking…
            </Text>
          ) : null}
          {error ? (
            <Text
              role="alert"
              fontFamily="body"
              fontSize="sm"
              color="status.red"
            >
              {error}
            </Text>
          ) : null}

          {finished ? (
            // The closing card. Flat on purpose: no "thanks for chatting", no
            // invitation to come back, no button. The demo's argument is that
            // it stops, so the ending must not undercut it by being warm.
            <Box
              borderWidth="1px"
              borderColor="border.default"
              borderRadius="20px"
              bg="bg.subtle"
              px={5}
              py={4}
            >
              <Text fontFamily="body" fontSize="sm" color="charcoal.500">
                {config.closingLine}
              </Text>
            </Box>
          ) : null}
        </VStack>
      </Box>

      {!finished ? (
        <Composer
          value={input}
          onChange={setInput}
          onSend={send}
          disabled={busy}
        />
      ) : null}
      <Caption>{config.caption}</Caption>
    </Shell>
  );
}

/**
 * The iframe's whole chrome: a full-height white column that never scrolls
 * itself. Everything that scrolls does so inside the transcript box.
 */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <Flex
      direction="column"
      h="100dvh"
      maxH="100dvh"
      overflow="hidden"
      bg="bg.default"
    >
      {children}
    </Flex>
  );
}

/**
 * The tutor screen's header: a circular light back control at the left and the
 * topic centred. The spacer on the right is the same width as the button so
 * the title is centred on the SCREEN, not on the space left over.
 */
function Header({
  title,
  onBack,
  backDisabled = false,
}: {
  title: string | null;
  onBack?: () => void;
  backDisabled?: boolean;
}) {
  return (
    <Flex align="center" px={3} py={3} gap={2} flexShrink={0}>
      <Box w="36px" flexShrink={0}>
        {onBack ? (
          <Button
            onClick={onBack}
            disabled={backDisabled}
            aria-label="Back to the questions"
            variant="plain"
            minW="36px"
            w="36px"
            h="36px"
            p={0}
            borderRadius="full"
            bg="bg.muted"
            color="charcoal.500"
            _hover={{ bg: "gray.200" }}
          >
            <CaretLeft size={18} weight="bold" aria-hidden="true" />
          </Button>
        ) : null}
      </Box>
      <Text
        flex={1}
        textAlign="center"
        fontFamily="heading"
        fontSize="md"
        fontWeight="500"
        color="navy.500"
        lineClamp={1}
      >
        {title}
      </Text>
      <Box w="36px" flexShrink={0} aria-hidden="true" />
    </Flex>
  );
}

/**
 * The composer bar: a decorative "+" (the native app attaches photos there;
 * guest mode has no upload, so it is disabled and out of the tab order), a
 * wide rounded field, and the accent send button tucked inside its right end.
 */
function Composer({
  value,
  onChange,
  onSend,
  disabled,
}: {
  value: string;
  onChange: (next: string) => void;
  onSend: () => void;
  disabled: boolean;
}) {
  return (
    <Flex
      align="flex-end"
      gap={2}
      px={4}
      pt={2}
      pb={2}
      flexShrink={0}
      maxW={COLUMN_MAX_WIDTH}
      w="100%"
      mx="auto"
    >
      <Flex
        w="36px"
        h="36px"
        flexShrink={0}
        mb="3px"
        align="center"
        justify="center"
        borderRadius="full"
        bg="bg.muted"
        color="charcoal.300"
        aria-hidden="true"
      >
        <Plus size={18} weight="bold" />
      </Flex>

      {/* `display="flex"` kills the inline baseline gap under the textarea, so
          the send button really is flush inside the field. */}
      <Box position="relative" flex={1} display="flex">
        <Textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onSend();
            }
          }}
          placeholder="Type your message…"
          aria-label="Your response"
          disabled={disabled}
          rows={1}
          resize="none"
          fontFamily="body"
          fontSize="sm"
          minH="44px"
          maxH="140px"
          py="11px"
          pl={5}
          pr="52px"
          borderRadius="24px"
          borderColor="border.default"
          // Chakra's default focus ring is violet; a demo embedded in the
          // school's own page should not introduce a second accent colour.
          focusRing="none"
          _focusVisible={{ borderColor: "navy.300", outline: "none" }}
        />
        <Button
          onClick={onSend}
          disabled={disabled || !value.trim()}
          aria-label="Send"
          position="absolute"
          right="5px"
          bottom="5px"
          minW="34px"
          w="34px"
          h="34px"
          p={0}
          borderRadius="full"
          bg="violet.500"
          color="white"
          _hover={{ bg: "violet.600" }}
          _disabled={{ bg: "gray.200", color: "gray.400", cursor: "default" }}
        >
          <ArrowUp size={18} weight="bold" aria-hidden="true" />
        </Button>
      </Box>
    </Flex>
  );
}

/** The anti-parasocial line, on screen for the whole exchange. */
function Caption({ children }: { children: React.ReactNode }) {
  return (
    <Text
      flexShrink={0}
      textAlign="center"
      fontFamily="body"
      fontSize="xs"
      color="charcoal.300"
      px={5}
      pb={3}
    >
      {children}
    </Text>
  );
}

/**
 * One turn. The tutor speaks bare, book-like, in a narrow column; the visitor's
 * own words come back in the navy bubble with the tucked corner — the same
 * split the scholar app uses (`native/src/lib/chatBubbles.ts`).
 */
function Bubble({ role, content }: { role: Turn["role"]; content: string }) {
  const isGuest = role === "user";
  if (isGuest) {
    return (
      <Box alignSelf="flex-end" maxW={{ base: "88%", md: "72%" }}>
        <Box
          bg="navy.500"
          borderRadius={BUBBLE_RADIUS}
          borderBottomRightRadius={BUBBLE_TUCK}
          px={5}
          py={3}
        >
          <Text
            fontFamily="body"
            fontSize="sm"
            color="white"
            whiteSpace="pre-wrap"
          >
            {content}
          </Text>
        </Box>
      </Box>
    );
  }
  return (
    <Box alignSelf="flex-start" maxW={{ base: "100%", md: "60%" }} px={1}>
      <Text
        fontFamily="body"
        fontSize="sm"
        color="fg.default"
        whiteSpace="pre-wrap"
      >
        {content}
      </Text>
    </Box>
  );
}
