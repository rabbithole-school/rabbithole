"use client";

import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { Box, HStack, Text } from "@chakra-ui/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  findPlaceholders,
  publishBlocker,
  REPORT_SECTION_KEY,
  REPORT_SECTION_TITLE,
} from "@/convex/lib/parentReport";
import { DictationMicButton } from "@/components/DictationMicButton";
import { toaster } from "@/lib/toaster";

const SAVE_DEBOUNCE_MS = 900;

/** Shared by the textarea and the highlight layer behind it: they must lay out identically. */
const TEXT_STYLE: React.CSSProperties = {
  fontFamily: "var(--chakra-fonts-body)",
  fontSize: "15px",
  lineHeight: 1.7,
  letterSpacing: "normal",
  padding: "14px 16px",
  borderWidth: "1px",
  borderStyle: "solid",
  borderRadius: "10px",
  boxSizing: "border-box",
  whiteSpace: "pre-wrap",
  overflowWrap: "break-word",
  wordBreak: "normal",
  width: "100%",
  margin: 0,
};

/**
 * The parent report's one prose body, with every bracketed placeholder
 * ("[a moment from class]") highlighted so the teacher can see what still
 * needs filling. A plain textarea sits over a mirror layer that paints the
 * highlights; the textarea grows with its content, so the two never scroll
 * apart.
 *
 * Owns its debounced autosave (flushed on unmount) and adopts external writes
 * (a fresh draft, the curriculum bot) whenever the teacher has no unsaved
 * edits — the same contract the old per-section editor had.
 */
export function ReportProseEditor({
  narrativeId,
  initialBody,
  readOnly,
  published,
  onUnsavedChange,
}: {
  narrativeId: Id<"courseNarratives">;
  initialBody: string;
  readOnly?: boolean;
  /** Parents can already see this report: an edit saves only once it has no placeholders and isn't empty. */
  published?: boolean;
  /** Told whenever the editor gains or clears unsaved edits, so Publish can wait for the save. */
  onUnsavedChange?: (unsaved: boolean) => void;
}) {
  const saveSection = useMutation(api.courseNarratives.saveSection);
  const [body, setBody] = useState(initialBody);
  const [saveState, setSaveState] = useState<"idle" | "saved">("idle");
  const savedRef = useRef(initialBody);
  const bodyRef = useRef(body);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const save = useCallback(
    (text: string) =>
      saveSection({ narrativeId, key: REPORT_SECTION_KEY, title: REPORT_SECTION_TITLE, body: text }),
    [saveSection, narrativeId],
  );

  const updateBody = (next: string) => {
    bodyRef.current = next;
    setBody(next);
  };

  const readOnlyRef = useRef(readOnly);
  const publishedRef = useRef(published);
  useEffect(() => {
    readOnlyRef.current = readOnly;
    publishedRef.current = published;
  }, [readOnly, published]);

  useEffect(() => {
    onUnsavedChange?.(body !== savedRef.current && !readOnly);
    // A read-only report (drafting, or published) is never written from here:
    // a published one is what parents see.
    if (body === savedRef.current || readOnly) return;
    if (published && publishedBlocker(body)) return;
    const t = setTimeout(() => {
      save(body)
        .then(() => {
          savedRef.current = body;
          setSaveState("saved");
          onUnsavedChange?.(bodyRef.current !== body);
        })
        .catch(() => {
          toaster.error({ title: "Couldn't save the report" });
          setSaveState("idle");
        });
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- debounce keys off `body` and `readOnly` only
  }, [body, readOnly, published]);

  useEffect(() => {
    return () => {
      if (
        !readOnlyRef.current &&
        bodyRef.current !== savedRef.current &&
        !(publishedRef.current && publishedBlocker(bodyRef.current))
      )
        save(bodyRef.current).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- flush-on-unmount only
  }, []);

  useEffect(() => {
    if (initialBody !== savedRef.current && bodyRef.current === savedRef.current) {
      savedRef.current = initialBody;
      updateBody(initialBody);
    }
  }, [initialBody]);

  // Grow the textarea to its content so the highlight layer never needs to scroll.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.max(el.scrollHeight + 2, 220)}px`;
  }, [body]);

  const selectRange = (start: number, end: number) => {
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(start, end);
  };

  const placeholders = findPlaceholders(body);
  // A published report's edit waits until it could be published itself.
  const held = !!published && !readOnly && body !== initialBody && publishedBlocker(body) !== null;
  const pending = !readOnly && !held && body !== initialBody;

  return (
    <Box>
      <HStack justify="space-between" mb={2} align="center" gap={2}>
        <Text fontSize="sm" color="charcoal.400" fontFamily="heading" minH="20px">
          {held
            ? "Not saved yet: parents can see this report, so fill every placeholder first"
            : pending
              ? "Saving…"
              : saveState === "saved"
                ? "Saved"
                : ""}
        </Text>
        {!readOnly && (
          <DictationMicButton
            size="xs"
            ariaLabel="Dictate into the report"
            onTranscript={(t) => updateBody(bodyRef.current.trim() ? `${bodyRef.current.trim()} ${t}` : t)}
          />
        )}
      </HStack>
      <Box position="relative">
        <div
          aria-hidden
          style={{
            ...TEXT_STYLE,
            position: "absolute",
            inset: 0,
            color: "transparent",
            borderColor: "transparent",
            pointerEvents: "none",
            overflow: "hidden",
          }}
        >
          {segments(body).map((seg, i) =>
            seg.placeholder ? (
              <mark
                key={i}
                style={{
                  background: "var(--chakra-colors-yellow-200)",
                  color: "transparent",
                  borderRadius: "3px",
                }}
              >
                {seg.text}
              </mark>
            ) : (
              <Fragment key={i}>{seg.text}</Fragment>
            ),
          )}
          {/* A trailing newline needs a character after it to take up a line. */}
          {"​"}
        </div>
        <textarea
          ref={textareaRef}
          value={body}
          readOnly={readOnly}
          onChange={(e) => updateBody(e.target.value)}
          placeholder="Draft the report, or write it here…"
          aria-label="Parent report"
          spellCheck
          style={{
            ...TEXT_STYLE,
            position: "relative",
            display: "block",
            background: "transparent",
            borderColor: "var(--chakra-colors-gray-200)",
            color: readOnly ? "var(--chakra-colors-charcoal-400)" : "var(--chakra-colors-charcoal-700)",
            resize: "none",
            overflow: "hidden",
          }}
        />
      </Box>
      <HStack mt={2} justify="space-between" align="start" gap={3}>
        <Text fontSize="sm" color="charcoal.400" fontFamily="heading" whiteSpace="nowrap">
          {wordCount(body)} words
        </Text>
        {placeholders.length > 0 && (
          <HStack gap={1.5} wrap="wrap" justify="flex-end">
            <Text fontSize="sm" fontFamily="heading" color="charcoal.600">
              {placeholders.length} to fill:
            </Text>
            {placeholders.map((p, i) => (
              <Box
                as="button"
                key={`${p.start}-${i}`}
                onClick={() => selectRange(p.start, p.end)}
                bg="yellow.200"
                color="charcoal.700"
                fontFamily="body"
                fontSize="sm"
                px={2}
                borderRadius="md"
                maxW="260px"
                truncate
                cursor="pointer"
                title="Jump to this placeholder"
                _hover={{ bg: "yellow.300" }}
              >
                {p.text}
              </Box>
            ))}
          </HStack>
        )}
      </HStack>
    </Box>
  );
}

function segments(text: string): { text: string; placeholder: boolean }[] {
  const out: { text: string; placeholder: boolean }[] = [];
  let at = 0;
  for (const p of findPlaceholders(text)) {
    if (p.start > at) out.push({ text: text.slice(at, p.start), placeholder: false });
    out.push({ text: p.text, placeholder: true });
    at = p.end;
  }
  if (at < text.length) out.push({ text: text.slice(at), placeholder: false });
  return out;
}

function wordCount(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

/** Why a published report's edit can't save yet (placeholders, or empty), or null. */
function publishedBlocker(body: string): string | null {
  return publishBlocker([{ key: REPORT_SECTION_KEY, title: REPORT_SECTION_TITLE, body }]);
}
