"use client";

/**
 * Layout-shift-free inline editing for the curriculum document view. The
 * theory (round 5): most edits should feel like typing into a Google Doc, not
 * flipping the page into a form. So the prose fields — title, description, big
 * idea, tutor prompt — render as plain read text that becomes an input *in the
 * same box* on click, and commit on blur via the existing update mutations.
 *
 * Built on Chakra v3 `Editable` (Ark/zag): its Preview and Input/Textarea are
 * the SAME element swapped in place, so applying identical typography to both
 * means read ↔ edit has no reflow. Two shapes:
 *   - `InlineText`   single-line (titles) — Enter or blur commits.
 *   - `InlineProse`  multi-line, auto-resizing (descriptions, prompts) — blur
 *                    commits; Enter inserts a newline.
 *
 * The whole control stops click propagation so editing a field never also
 * triggers DocPage's page-level "open the full editor" click.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Editable, type SystemStyleObject } from "@chakra-ui/react";

interface InlineBaseProps {
  value: string;
  /** Persist the new value. Called on commit only when it actually changed. */
  onCommit: (next: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  /** Typography applied identically to preview + input, so nothing reflows. */
  textStyle?: SystemStyleObject;
  /** Extra style for the shared box (padding/margins). */
  boxStyle?: SystemStyleObject;
  disabled?: boolean;
  /** Mount already in edit mode + focused (e.g. a field revealed by an
   *  "Add …" button that should land the caret ready to type). */
  startInEdit?: boolean;
  /** Fires when edit mode toggles, with the current draft. Lets a caller
   *  collapse a revealed-but-left-empty field back to its button. */
  onEditChange?: (editing: boolean, value: string) => void;
}

/** The hover/focus affordance shared by both variants — subtle, so reading
 *  stays calm but the field advertises that it's editable. */
const previewAffordance: SystemStyleObject = {
  borderRadius: "sm",
  transition: "background 0.12s ease, box-shadow 0.12s ease",
  cursor: "text",
  _hover: { bg: "violet.50" },
};

const inputAffordance: SystemStyleObject = {
  bg: "violet.50",
  borderRadius: "sm",
  outline: "none",
  boxShadow: "inset 0 0 0 1px var(--chakra-colors-violet-300)",
  _focusVisible: { outline: "none" },
};

function useDraft(value: string) {
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    // Keep the local draft in sync when the remote value changes (e.g. the bot
    // edits the same field, or we switch nodes).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDraft(value);
  }, [value]);
  return [draft, setDraft] as const;
}

type TextInputElement = HTMLInputElement | HTMLTextAreaElement;
type PreviewClickEvent =
  | ReactMouseEvent<HTMLElement>
  | ReactPointerEvent<HTMLElement>;

type CaretDocument = Document & {
  caretPositionFromPoint?: (
    x: number,
    y: number,
  ) => { offsetNode: Node; offset: number } | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
};

function clampOffset(offset: number, length: number) {
  return Math.max(0, Math.min(offset, length));
}

function textOffsetFromNodePosition(
  root: HTMLElement,
  offsetNode: Node,
  offset: number,
) {
  if (offsetNode !== root && !root.contains(offsetNode)) return null;

  const range = root.ownerDocument.createRange();
  range.selectNodeContents(root);
  try {
    range.setEnd(offsetNode, offset);
  } catch {
    return null;
  }

  return clampOffset(range.toString().length, root.textContent?.length ?? 0);
}

function caretOffsetFromPoint(root: HTMLElement, x: number, y: number) {
  const doc = root.ownerDocument as CaretDocument;
  const position = doc.caretPositionFromPoint?.(x, y);
  if (position) {
    return textOffsetFromNodePosition(
      root,
      position.offsetNode,
      position.offset,
    );
  }

  const range = doc.caretRangeFromPoint?.(x, y);
  if (range) {
    return textOffsetFromNodePosition(
      root,
      range.startContainer,
      range.startOffset,
    );
  }

  return null;
}

function useClickCaret() {
  const pendingOffsetRef = useRef<number | null>(null);

  const onPreviewPointerDown = useCallback((event: PreviewClickEvent) => {
    if (event.button !== 0) return;

    const offset = caretOffsetFromPoint(
      event.currentTarget,
      event.clientX,
      event.clientY,
    );
    pendingOffsetRef.current = offset;
  }, []);

  const applyCaretOnFocus = useCallback((el: TextInputElement) => {
    const offset = pendingOffsetRef.current;
    pendingOffsetRef.current = null;
    if (offset === null) return;

    const placeCaret = () => {
      const next = clampOffset(offset, el.value.length);
      try {
        el.setSelectionRange(next, next);
      } catch {
        // Some input types do not support text selection. These editors use text
        // inputs/textareas, so this is only a defensive guard.
      }
    };

    placeCaret();
    requestAnimationFrame(placeCaret);
  }, []);

  return { onPreviewPointerDown, applyCaretOnFocus };
}

export function InlineText({
  value,
  onCommit,
  placeholder,
  ariaLabel,
  textStyle,
  boxStyle,
  disabled,
}: InlineBaseProps) {
  const [draft, setDraft] = useDraft(value);
  const { onPreviewPointerDown, applyCaretOnFocus } = useClickCaret();
  const shared: SystemStyleObject = {
    ...textStyle,
    px: 1,
    mx: -1,
    py: 0.5,
    my: -0.5,
    // Chakra's Editable recipe stamps a 36px control min-height on the
    // preview/input; with display:block that top-aligns a single line of title
    // text inside an oversized box, so the headline reads ~5px high of center.
    // Collapse the box to its real line height so the parent's align="center"
    // can center the glyphs true.
    minH: "auto",
    width: "full",
    display: "block",
    ...boxStyle,
  };

  return (
    <Editable.Root
      value={draft}
      onValueChange={(e) => setDraft(e.value)}
      onValueCommit={(e) => {
        if (e.value !== value) onCommit(e.value);
      }}
      activationMode="click"
      submitMode="both"
      selectOnFocus={false}
      placeholder={placeholder}
      disabled={disabled}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      width="full"
    >
      <Editable.Preview
        {...shared}
        {...previewAffordance}
        onPointerDown={onPreviewPointerDown}
        onMouseDown={onPreviewPointerDown}
        aria-label={ariaLabel}
        color={value ? undefined : "charcoal.300"}
      />
      <Editable.Input
        {...shared}
        {...inputAffordance}
        onFocus={(e) => applyCaretOnFocus(e.currentTarget)}
        aria-label={ariaLabel}
      />
    </Editable.Root>
  );
}

export function InlineProse({
  value,
  onCommit,
  placeholder,
  ariaLabel,
  textStyle,
  boxStyle,
  disabled,
  startInEdit,
  onEditChange,
}: InlineBaseProps) {
  const [draft, setDraft] = useDraft(value);
  const draftRef = useRef(value);
  useEffect(() => {
    draftRef.current = value;
  }, [value]);
  const { onPreviewPointerDown, applyCaretOnFocus } = useClickCaret();
  const shared: SystemStyleObject = {
    ...textStyle,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    px: 2,
    mx: -2,
    py: 1,
    my: -1,
    width: "full",
    display: "block",
    ...boxStyle,
  };

  // Auto-grow the textarea to its content so the edit box matches the wrapped
  // preview height (no layout shift). We size it ourselves rather than use
  // Editable's `autoResize`, which forces the *preview* to a single truncated
  // line (`white-space: pre; text-overflow: ellipsis`).
  const sizeTextarea = (el: HTMLElement | null) => {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };

  return (
    <Editable.Root
      value={draft}
      onValueChange={(e) => {
        draftRef.current = e.value;
        setDraft(e.value);
      }}
      onValueCommit={(e) => {
        if (e.value !== value) onCommit(e.value);
      }}
      defaultEdit={startInEdit}
      onEditChange={(e) => onEditChange?.(e.edit, draftRef.current)}
      activationMode="click"
      submitMode="blur"
      selectOnFocus={false}
      placeholder={placeholder}
      disabled={disabled}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      width="full"
    >
      <Editable.Preview
        {...shared}
        {...previewAffordance}
        onPointerDown={onPreviewPointerDown}
        onMouseDown={onPreviewPointerDown}
        aria-label={ariaLabel}
        color={value ? undefined : "charcoal.300"}
      />
      <Editable.Textarea
        {...shared}
        {...inputAffordance}
        onFocus={(e) => {
          const el = e.currentTarget;
          applyCaretOnFocus(el);
          requestAnimationFrame(() => sizeTextarea(el));
        }}
        onInput={(e) => sizeTextarea(e.currentTarget)}
        rows={1}
        resize="none"
        overflow="hidden"
        aria-label={ariaLabel}
      />
    </Editable.Root>
  );
}
