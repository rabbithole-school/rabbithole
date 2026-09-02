"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { Box, HStack, Text, Textarea } from "@chakra-ui/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { DictationMicButton } from "@/components/DictationMicButton";
import { toaster } from "@/lib/toaster";

const SAVE_DEBOUNCE_MS = 900;

/**
 * One editable narrative section's authoring textarea (context / progress /
 * a PCM dimension / goals). Self-contained: owns its own draft + debounced
 * autosave (flushed on unmount) so `NarrativeComposer` doesn't have to
 * reconcile local edits against the reactive `courseNarratives.get`
 * subscription. A 🎤 dictate affordance appends transcribed speech.
 *
 * No AI affordances here — "Check draft" and the AI "draft this paragraph"
 * button were removed 2026-07-02; AI help now lives in the curriculum bot's
 * side panel, not baked into this editor.
 */
export function NarrativeSectionEditor({
  narrativeId,
  sectionKey,
  title,
  initialBody,
  rows = 4,
}: {
  narrativeId: Id<"courseNarratives">;
  sectionKey: string;
  title: string;
  initialBody: string;
  rows?: number;
}) {
  const saveSection = useMutation(api.courseNarratives.saveSection);

  const [body, setBody] = useState(initialBody);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const savedRef = useRef(initialBody);
  const bodyRef = useRef(body);

  const updateBody = (next: string) => {
    bodyRef.current = next;
    setBody(next);
  };

  useEffect(() => {
    if (body === savedRef.current) return;
    setSaveState("saving");
    const t = setTimeout(() => {
      saveSection({ narrativeId, key: sectionKey, title, body })
        .then(() => {
          savedRef.current = body;
          setSaveState("saved");
        })
        .catch(() => {
          toaster.error({ title: `Couldn't save "${title}"` });
          setSaveState("idle");
        });
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- debounce keys off `body` only
  }, [body]);

  // Flush a pending edit if the composer unmounts (e.g. switching tabs or
  // navigating away) before the debounce timer fires.
  useEffect(() => {
    return () => {
      if (bodyRef.current !== savedRef.current) {
        saveSection({ narrativeId, key: sectionKey, title, body: bodyRef.current }).catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- flush-on-unmount only
  }, []);

  // Adopt EXTERNAL updates to this section — e.g. the curriculum bot wrote it
  // from the side panel — but only when the teacher has no unsaved local edits,
  // so a live bot-write appears in the open editor without ever clobbering
  // something the teacher is mid-typing.
  useEffect(() => {
    if (initialBody !== savedRef.current && bodyRef.current === savedRef.current) {
      savedRef.current = initialBody;
      updateBody(initialBody);
    }
  }, [initialBody]);

  return (
    <Box>
      <HStack justify="space-between" mb={1.5} align="center" wrap="wrap" gap={2}>
        <HStack gap={2}>
          <Text fontFamily="heading" fontWeight="700" fontSize="sm" color="navy.600">
            {title}
          </Text>
          {saveState === "saving" && (
            <Text fontSize="2xs" color="charcoal.300" fontFamily="body">
              saving…
            </Text>
          )}
          {saveState === "saved" && (
            <Text fontSize="2xs" color="green.600" fontFamily="body">
              saved
            </Text>
          )}
        </HStack>
        <DictationMicButton
          size="xs"
          ariaLabel={`Dictate — ${title}`}
          onTranscript={(t) =>
            updateBody(bodyRef.current.trim() ? `${bodyRef.current.trim()} ${t}` : t)
          }
        />
      </HStack>
      <Textarea
        value={body}
        onChange={(e) => updateBody(e.target.value)}
        rows={rows}
        fontFamily="body"
        fontSize="sm"
        bg="white"
        borderColor="gray.200"
        _focus={{ borderColor: "violet.300" }}
        placeholder={`Write ${title.toLowerCase()}…`}
      />
    </Box>
  );
}
