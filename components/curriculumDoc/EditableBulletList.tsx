"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
} from "react";
import { Box, HStack, Textarea } from "@chakra-ui/react";

type KeyedBullet = { key: string; text: string };
type CommitBullet = { key?: string; text: string };
type DraftBullet = CommitBullet & { localId: string };

interface EditableBulletListProps {
  items: KeyedBullet[];
  onCommit: (next: CommitBullet[]) => void;
  placeholder?: string;
  ariaLabel: string;
}

let nextLocalId = 0;

function newLocalId() {
  nextLocalId += 1;
  return `new-bullet-${nextLocalId}`;
}

function draftFromItems(items: CommitBullet[]): DraftBullet[] {
  const rows = items.map((item) => ({
    ...item,
    localId: item.key ?? newLocalId(),
  }));
  return rows.length > 0 ? rows : [{ localId: newLocalId(), text: "" }];
}

function commitItems(draft: DraftBullet[]): CommitBullet[] {
  return draft
    .map(({ key, text }) => ({ key, text: text.trim() }))
    .filter((item) => item.text.length > 0);
}

function signature(items: CommitBullet[]) {
  return JSON.stringify(
    items
      .map(({ key, text }) => ({ key, text: text.trim() }))
      .filter((item) => item.text.length > 0),
  );
}

function autosize(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

function isComposing(event: KeyboardEvent<HTMLTextAreaElement>) {
  return event.nativeEvent.isComposing;
}

export function EditableBulletList({
  items,
  onCommit,
  placeholder,
  ariaLabel,
}: EditableBulletListProps) {
  const propSignature = useMemo(() => signature(items), [items]);
  const [draft, setDraft] = useState<DraftBullet[]>(() => draftFromItems(items));
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const lastCommittedSignatureRef = useRef(propSignature);
  const textareaRefs = useRef<Array<HTMLTextAreaElement | null>>([]);

  useEffect(() => {
    lastCommittedSignatureRef.current = propSignature;
    // Keep remote changes in sync without treating the placeholder row as data.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDraft(draftFromItems(items));
    // `items` often receives a new identity for a parent refresh while its
    // committed signature is unchanged; listening to that identity would erase
    // in-progress local typing. `propSignature` is the intentional sync key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propSignature]);

  useLayoutEffect(() => {
    for (const el of textareaRefs.current) autosize(el);
  }, [draft]);

  const focusItem = useCallback((index: number, caret: number) => {
    requestAnimationFrame(() => {
      const el = textareaRefs.current[index];
      if (!el) return;
      el.focus({ preventScroll: true });
      const next = Math.max(0, Math.min(caret, el.value.length));
      el.setSelectionRange(next, next);
      autosize(el);
    });
  }, []);

  const commitDraft = useCallback(() => {
    const next = commitItems(draft);
    const nextSignature = signature(next);
    if (nextSignature !== lastCommittedSignatureRef.current) {
      lastCommittedSignatureRef.current = nextSignature;
      onCommit(next);
    }
    setDraft(draftFromItems(next));
  }, [draft, onCommit]);

  const handleBlurCapture = useCallback(
    (event: FocusEvent<HTMLDivElement>) => {
      const nextTarget = event.relatedTarget;
      if (nextTarget && event.currentTarget.contains(nextTarget)) return;
      setActiveIndex(null);
      commitDraft();
    },
    [commitDraft],
  );

  const updateText = useCallback((index: number, text: string) => {
    setDraft((current) =>
      current.map((item, i) => (i === index ? { ...item, text } : item)),
    );
  }, []);

  const insertAfter = useCallback(
    (index: number, el: HTMLTextAreaElement) => {
      const item = draft[index];
      if (!item) return;
      const start = el.selectionStart ?? item.text.length;
      const end = el.selectionEnd ?? start;
      const before = item.text.slice(0, start);
      const after = item.text.slice(end);
      const moveKeyToNewItem =
        !!item.key && before.trim().length === 0 && after.trim().length > 0;
      const currentItem: DraftBullet = {
        ...item,
        key: moveKeyToNewItem ? undefined : item.key,
        text: before,
      };
      const newItem: DraftBullet = {
        localId: newLocalId(),
        key: moveKeyToNewItem ? item.key : undefined,
        text: after,
      };

      setDraft([
        ...draft.slice(0, index),
        currentItem,
        newItem,
        ...draft.slice(index + 1),
      ]);
      setActiveIndex(index + 1);
      focusItem(index + 1, 0);
    },
    [draft, focusItem],
  );

  const mergeIntoPrevious = useCallback(
    (index: number) => {
      if (index === 0) return;
      const previous = draft[index - 1];
      const current = draft[index];
      if (!previous || !current) return;

      const caret = previous.text.length;
      const mergedPrevious: DraftBullet = {
        ...previous,
        key:
          previous.key ??
          (previous.text.trim().length === 0 ? current.key : undefined),
        text: `${previous.text}${current.text}`,
      };

      setDraft([
        ...draft.slice(0, index - 1),
        mergedPrevious,
        ...draft.slice(index + 1),
      ]);
      setActiveIndex(index - 1);
      focusItem(index - 1, caret);
    },
    [draft, focusItem],
  );

  const handleKeyDown = useCallback(
    (index: number, event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (isComposing(event)) return;

      if (event.key === "Enter") {
        event.preventDefault();
        insertAfter(index, event.currentTarget);
        return;
      }

      if (
        event.key === "Backspace" &&
        event.currentTarget.selectionStart === 0 &&
        event.currentTarget.selectionEnd === 0
      ) {
        event.preventDefault();
        mergeIntoPrevious(index);
        return;
      }

      if (event.key === "ArrowUp" && index > 0) {
        event.preventDefault();
        focusItem(
          index - 1,
          Math.min(
            event.currentTarget.selectionStart ?? 0,
            draft[index - 1]?.text.length ?? 0,
          ),
        );
        return;
      }

      if (event.key === "ArrowDown" && index < draft.length - 1) {
        event.preventDefault();
        focusItem(
          index + 1,
          Math.min(
            event.currentTarget.selectionStart ?? 0,
            draft[index + 1]?.text.length ?? 0,
          ),
        );
      }
    },
    [draft, focusItem, insertAfter, mergeIntoPrevious],
  );

  return (
    <Box
      as="ul"
      aria-label={ariaLabel}
      listStyleType="none"
      m={0}
      p={0}
      onBlurCapture={handleBlurCapture}
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {draft.map((item, index) => {
        const isActive = activeIndex === index;
        return (
          <HStack
            as="li"
            key={item.localId}
            align="flex-start"
            gap={2.5}
            py={0.75}
          >
            <Box
              aria-hidden="true"
              bg="fg.muted"
              borderRadius="full"
              flexShrink={0}
              h="1.5"
              mt="0.68em"
              w="1.5"
            />
            <Textarea
              ref={(node) => {
                textareaRefs.current[index] = node;
              }}
              aria-label={`${ariaLabel}, item ${index + 1}`}
              value={item.text}
              placeholder={index === 0 ? placeholder : undefined}
              readOnly={!isActive}
              rows={1}
              resize="none"
              overflow="hidden"
              minH="calc(1em * 1.55)"
              h="auto"
              px={1.5}
              mx={-1.5}
              py={0.5}
              my={-0.5}
              borderWidth="0"
              borderRadius="sm"
              bg={isActive ? "bg.subtle" : "transparent"}
              boxShadow={
                isActive
                  ? "inset 0 0 0 1px var(--chakra-colors-brand-secondary)"
                  : "none"
              }
              color="fg.default"
              caretColor="fg.default"
              fontFamily="body"
              fontSize="sm"
              lineHeight="1.55"
              outline="none"
              _hover={{ bg: "bg.subtle" }}
              _focusVisible={{ outline: "none" }}
              _placeholder={{ color: "fg.subtle" }}
              onFocus={() => setActiveIndex(index)}
              onChange={(event) => {
                updateText(index, event.currentTarget.value);
                autosize(event.currentTarget);
              }}
              onKeyDown={(event) => handleKeyDown(index, event)}
            />
          </HStack>
        );
      })}
    </Box>
  );
}
