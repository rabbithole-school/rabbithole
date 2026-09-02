"use client";

/**
 * Bite-size metadata editor for the curriculum document view.
 *
 * The trigger is always a Chakra `Button` with `variant="ghost"`, a fixed
 * height, and a stable transparent border. Hover/focus/open only change paint,
 * never dimensions; the editor itself is portaled in a Menu/Popover so the
 * document body does not reflow.
 */
import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import NextLink from "next/link";
import {
  Box,
  Button,
  type ButtonProps,
  Field as ChakraField,
  HStack,
  Input,
  Link as ChakraLink,
  Menu,
  Popover,
  Portal,
  Stack,
  Text,
} from "@chakra-ui/react";
import { ArrowSquareOut, CaretDown, Check } from "@phosphor-icons/react";
import { ActivityKindIcon } from "@/components/ActivityKindIcon";
import { STRAND_CONFIG, STRAND_ORDER, type Strand } from "@/lib/constants";
import { ACTIVITY_KIND, type ActivityKind } from "@/lib/activityKinds";

export type EditableChipValue = string | number | boolean | null;

export interface EditableChipSelectOption<
  T extends EditableChipValue = EditableChipValue,
> {
  value: T;
  label: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
}

interface EditableChipCommonProps<TValue> {
  label?: string;
  value: TValue;
  displayValue?: ReactNode;
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
  readOnly?: boolean;
  readOnlyHint?: ReactNode;
  readOnlyHref?: string;
  readOnlyLinkLabel?: string;
  width?: string;
  minW?: string;
  "data-testid"?: string;
}

type SelectChipProps<T extends EditableChipValue> =
  EditableChipCommonProps<T | null | undefined> & {
    type: "select";
    options: ReadonlyArray<EditableChipSelectOption<T>>;
    onCommit: (next: T) => void | Promise<unknown>;
  };

type NumberChipProps = EditableChipCommonProps<number | null | undefined> & {
  type: "number";
  onCommit: (next: number | null) => void | Promise<unknown>;
  min?: number;
  max?: number;
  step?: number;
  integer?: boolean;
  formatValue?: (value: number) => ReactNode;
};

type TextChipProps = EditableChipCommonProps<string | null | undefined> & {
  type: "text";
  onCommit: (next: string) => void | Promise<unknown>;
  trimOnCommit?: boolean;
  maxLength?: number;
};

export type EditableChipProps<
  T extends EditableChipValue = EditableChipValue,
> = SelectChipProps<T> | NumberChipProps | TextChipProps;

const ACTIVITY_KIND_EDIT_ORDER = ["online", "offline", "shareBack", "web", "game", "simulator", "vibecode"] as const satisfies ReadonlyArray<
  Exclude<ActivityKind, "problem_set">
>;

export function activityKindSelectOptions(): EditableChipSelectOption<
  Exclude<ActivityKind, "problem_set">
>[] {
  // Problem sets are intentionally excluded from the document-view kind switch.
  // If inline practice authoring ever exists, it should be a shared Practice
  // editor reused by /teacher/math-skills and this document surface.
  return ACTIVITY_KIND_EDIT_ORDER.map((kind) => ({
    value: kind,
    label: ACTIVITY_KIND[kind].label,
    description: ACTIVITY_KIND[kind].description,
    icon: <ActivityKindIcon kind={kind} size={14} />,
  }));
}

export function strandSelectOptions(): EditableChipSelectOption<Strand>[] {
  return STRAND_ORDER.map((strand) => {
    const cfg = STRAND_CONFIG[strand];
    const Icon = cfg.icon;
    return {
      value: strand,
      label: cfg.label,
      icon: <Icon size={14} weight="bold" />,
    };
  });
}

function nodeToText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeToText).join("");
  return "";
}

function isUnset(value: unknown) {
  return value === null || value === undefined || value === "";
}

export function sameValue(a: unknown, b: unknown) {
  return Object.is(a ?? null, b ?? null);
}

/**
 * The shared body of a select dropdown: an optional uppercase eyebrow label
 * followed by the option rows (icon · sm heading label · 2xs description · a
 * violet check on the current value). Extracted so the header-chip `SelectChip`
 * and the in-menu `NodeOptionsMenuItems` submenu render one identical option
 * list — one option-row renderer, not two. Each `Menu.Item` carries
 * `value={String(index)}`, so the owning `Menu.Root`'s `onSelect` maps the
 * chosen index back to an option.
 */
export function SelectOptionItems<T extends EditableChipValue>({
  label,
  hint,
  options,
  value,
}: {
  label?: string;
  /** One-line fine print under the eyebrow, describing the field. */
  hint?: string;
  options: ReadonlyArray<EditableChipSelectOption<T>>;
  value: T | null;
}) {
  return (
    <>
      {(label || hint) && (
        <Box px={3} pt={2.5} pb={1}>
          {label && (
            <Text
              fontFamily="heading"
              fontSize="2xs"
              fontWeight="800"
              letterSpacing="0.08em"
              textTransform="uppercase"
              color="charcoal.400"
            >
              {label}
            </Text>
          )}
          {hint && (
            <Text fontSize="2xs" color="charcoal.400" lineHeight="1.35" mt={0.5}>
              {hint}
            </Text>
          )}
        </Box>
      )}
      {options.map((option, index) => {
        const selectedOption = sameValue(option.value, value);
        return (
          <Menu.Item
            key={`${index}:${String(option.value)}`}
            value={String(index)}
            disabled={option.disabled}
            cursor={option.disabled ? "not-allowed" : "pointer"}
            py={2}
          >
            {option.icon && (
              <Box mt="1px" color="charcoal.400" flexShrink={0}>
                {option.icon}
              </Box>
            )}
            <Stack gap={0.5} flex={1} minW={0} ml={option.icon ? 1.5 : 0}>
              <Text
                fontFamily="heading"
                fontSize="sm"
                fontWeight={selectedOption ? "750" : "550"}
                color={selectedOption ? "violet.600" : "charcoal.600"}
              >
                {option.label}
              </Text>
              {option.description && (
                <Text fontSize="2xs" color="charcoal.400" lineHeight="1.35">
                  {option.description}
                </Text>
              )}
            </Stack>
            {selectedOption && <Check size={13} weight="bold" />}
          </Menu.Item>
        );
      })}
    </>
  );
}

function chipAriaLabel(label: string | undefined, display: ReactNode, readOnly?: boolean) {
  const field = label ?? "metadata";
  const current = nodeToText(display) || "unset";
  return `${readOnly ? "View" : "Edit"} ${field}, current value ${current}`;
}

export function triggerStyles({ empty, open }: { empty: boolean; open?: boolean }) {
  return {
    h: "26px",
    minW: "auto",
    px: 2,
    gap: 1.5,
    borderRadius: "full",
    borderWidth: "1px",
    borderColor: "transparent",
    bg: open ? "bg.subtle" : "transparent",
    color: empty ? "fg.muted" : "charcoal.500",
    fontFamily: "heading",
    fontSize: "xs",
    fontWeight: "650",
    lineHeight: "1",
    whiteSpace: "nowrap" as const,
    flexShrink: 0,
    transition: "background 0.12s ease, color 0.12s ease, box-shadow 0.12s ease",
    _hover: { bg: "bg.subtle", color: "charcoal.700" },
    _focusVisible: {
      outline: "2px solid",
      outlineColor: "violet.200",
      outlineOffset: "1px",
      boxShadow: "none",
    },
  };
}

type ChipTriggerProps = Omit<ButtonProps, "children" | "display"> & {
  children: ReactNode;
  display: ReactNode;
  label?: string;
  open?: boolean;
  placeholder?: string;
  readOnly?: boolean;
  width?: string;
  minW?: string;
  disabled?: boolean;
  testId?: string;
  ariaLabel?: string;
};

const ChipTrigger = forwardRef<HTMLButtonElement, ChipTriggerProps>(function ChipTrigger({
  children,
  display,
  label,
  open,
  placeholder,
  readOnly,
  width,
  minW,
  disabled,
  testId,
  ariaLabel,
  ...triggerProps
}, ref) {
  const empty = isUnset(display) || nodeToText(display) === placeholder;
  return (
    <Button
      ref={ref}
      type="button"
      size="xs"
      variant="ghost"
      disabled={disabled}
      aria-label={ariaLabel ?? chipAriaLabel(label, display, readOnly)}
      aria-disabled={readOnly || undefined}
      data-testid={testId}
      data-open={open ? "true" : undefined}
      {...triggerStyles({ empty, open })}
      w={width}
      minW={minW ?? "auto"}
      {...triggerProps}
    >
      {children}
    </Button>
  );
});

function ChipBoundary({ children }: { children: ReactNode }) {
  return (
    <Box
      as="span"
      display="inline-flex"
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {children}
    </Box>
  );
}

function TriggerContents({
  display,
  icon,
  open,
  readOnly,
}: {
  display: ReactNode;
  icon?: ReactNode;
  open?: boolean;
  readOnly?: boolean;
}) {
  return (
    <HStack as="span" gap={1.5} minW={0} maxW="full">
      {icon && (
        <Box as="span" display="inline-flex" flexShrink={0} color="charcoal.400">
          {icon}
        </Box>
      )}
      <Text as="span" truncate>
        {display}
      </Text>
      {!readOnly && (
        <CaretDown
          size={11}
          weight="bold"
          style={{
            flexShrink: 0,
            transform: open ? "rotate(180deg)" : undefined,
            transition: "transform 0.12s ease",
          }}
        />
      )}
    </HStack>
  );
}

function ReadOnlyChip({
  display,
  props,
}: {
  display: ReactNode;
  props: EditableChipCommonProps<unknown>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <ChipBoundary>
      <Popover.Root
        open={open}
        onOpenChange={(details) => setOpen(details.open)}
        positioning={{ placement: "bottom-start", sameWidth: false }}
      >
        <Popover.Trigger asChild>
          <ChipTrigger
            display={display}
            label={props.label}
            placeholder={props.placeholder}
            readOnly
            open={open}
            width={props.width}
            minW={props.minW}
            disabled={props.disabled}
            testId={props["data-testid"]}
            ariaLabel={props.ariaLabel}
          >
            <TriggerContents display={display} readOnly />
          </ChipTrigger>
        </Popover.Trigger>
        <Portal>
          <Popover.Positioner>
            <Popover.Content w="260px" maxW="calc(100vw - 24px)" shadow="lg" borderRadius="lg">
              <Popover.Arrow />
              <Popover.Body p={3} onClick={(e) => e.stopPropagation()}>
                <Stack gap={2}>
                  <Text fontSize="sm" color="charcoal.600" fontFamily="body" lineHeight="1.45">
                    {props.readOnlyHint ?? "This field is managed somewhere else."}
                  </Text>
                  {props.readOnlyHref && (
                    <ChakraLink
                      asChild
                      alignSelf="flex-start"
                      fontFamily="heading"
                      fontSize="xs"
                      fontWeight="650"
                      color="violet.600"
                      _hover={{ textDecoration: "underline" }}
                    >
                      <NextLink href={props.readOnlyHref}>
                        {props.readOnlyLinkLabel ?? "Open related editor"}
                        <ArrowSquareOut size={12} style={{ marginLeft: 4 }} />
                      </NextLink>
                    </ChakraLink>
                  )}
                </Stack>
              </Popover.Body>
            </Popover.Content>
          </Popover.Positioner>
        </Portal>
      </Popover.Root>
    </ChipBoundary>
  );
}

function SelectChip<T extends EditableChipValue>({
  props,
}: {
  props: SelectChipProps<T>;
}) {
  const [open, setOpen] = useState(false);
  const selected = props.options.find((option) => sameValue(option.value, props.value));
  const display =
    selected?.label ?? props.displayValue ?? props.placeholder ?? `Add ${props.label ?? "value"}`;
  const selectedIcon = selected?.icon;

  if (props.readOnly) return <ReadOnlyChip display={display} props={props} />;

  return (
    <ChipBoundary>
      <Menu.Root
        open={open}
        onOpenChange={(details) => setOpen(details.open)}
        positioning={{ placement: "bottom-start" }}
        onSelect={(details) => {
          const next = props.options[Number(details.value)];
          if (!next || next.disabled) return;
          if (!sameValue(next.value, props.value)) void props.onCommit(next.value);
          setOpen(false);
        }}
      >
        <Menu.Trigger asChild>
          <ChipTrigger
            display={display}
            label={props.label}
            placeholder={props.placeholder}
            open={open}
            width={props.width}
            minW={props.minW}
            disabled={props.disabled}
            testId={props["data-testid"]}
            ariaLabel={props.ariaLabel}
          >
            <TriggerContents display={display} icon={selectedIcon} open={open} />
          </ChipTrigger>
        </Menu.Trigger>
        <Portal>
          <Menu.Positioner>
            <Menu.Content
              minW="220px"
              maxW="320px"
              shadow="lg"
              borderRadius="lg"
              onClick={(e) => e.stopPropagation()}
            >
              <SelectOptionItems
                label={props.label}
                options={props.options}
                value={props.value ?? null}
              />
            </Menu.Content>
          </Menu.Positioner>
        </Portal>
      </Menu.Root>
    </ChipBoundary>
  );
}

function PopoverEditorFrame({
  open,
  setOpen,
  display,
  common,
  children,
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
  display: ReactNode;
  common: EditableChipCommonProps<unknown>;
  children: ReactNode;
}) {
  return (
    <ChipBoundary>
      <Popover.Root
        open={open}
        onOpenChange={(details) => setOpen(details.open)}
        positioning={{ placement: "bottom-start", sameWidth: false }}
      >
        <Popover.Trigger asChild>
          <ChipTrigger
            display={display}
            label={common.label}
            placeholder={common.placeholder}
            open={open}
            width={common.width}
            minW={common.minW}
            disabled={common.disabled}
            testId={common["data-testid"]}
            ariaLabel={common.ariaLabel}
          >
            <TriggerContents display={display} open={open} />
          </ChipTrigger>
        </Popover.Trigger>
        <Portal>
          <Popover.Positioner>
            <Popover.Content w="240px" maxW="calc(100vw - 24px)" shadow="lg" borderRadius="lg">
              <Popover.Arrow />
              <Popover.Body p={3} onClick={(e) => e.stopPropagation()}>
                {children}
              </Popover.Body>
            </Popover.Content>
          </Popover.Positioner>
        </Portal>
      </Popover.Root>
    </ChipBoundary>
  );
}

function TextChip({ props }: { props: TextChipProps }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(props.value ?? "");
  const [draftSource, setDraftSource] = useState({
    open,
    value: props.value,
  });
  const inputRef = useRef<HTMLInputElement | null>(null);
  const display = props.value || props.displayValue || props.placeholder || `Add ${props.label ?? "text"}`;

  if (draftSource.open !== open || draftSource.value !== props.value) {
    setDraftSource({ open, value: props.value });
    if (!open) setDraft(props.value ?? "");
  }

  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  if (props.readOnly) return <ReadOnlyChip display={display} props={props} />;

  const commit = () => {
    const next = props.trimOnCommit ? draft.trim() : draft;
    if (next !== (props.value ?? "")) void props.onCommit(next);
  };

  return (
    <PopoverEditorFrame open={open} setOpen={setOpen} display={display} common={props}>
      <ChakraField.Root>
        {props.label && <ChakraField.Label>{props.label}</ChakraField.Label>}
        <Input
          ref={inputRef}
          size="sm"
          value={draft}
          maxLength={props.maxLength}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              commit();
              setOpen(false);
            }
            if (event.key === "Escape") {
              setDraft(props.value ?? "");
              setOpen(false);
            }
          }}
          placeholder={props.placeholder}
          fontFamily="heading"
          fontSize="sm"
          borderColor="gray.200"
          _focus={{ borderColor: "violet.400", boxShadow: "none" }}
        />
      </ChakraField.Root>
    </PopoverEditorFrame>
  );
}

function NumberChip({ props }: { props: NumberChipProps }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(props.value == null ? "" : String(props.value));
  const [error, setError] = useState<string | null>(null);
  const [draftSource, setDraftSource] = useState({
    open,
    value: props.value,
  });
  const inputRef = useRef<HTMLInputElement | null>(null);
  const display =
    props.value == null
      ? props.displayValue || props.placeholder || `Add ${props.label ?? "number"}`
      : (props.formatValue?.(props.value) ?? props.value);

  if (draftSource.open !== open || draftSource.value !== props.value) {
    setDraftSource({ open, value: props.value });
    if (!open) {
      setDraft(props.value == null ? "" : String(props.value));
      setError(null);
    }
  }

  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  if (props.readOnly) return <ReadOnlyChip display={display} props={props} />;

  const parseDraft = () => {
    const trimmed = draft.trim();
    if (!trimmed) return null;
    const parsed = props.integer === false ? Number(trimmed) : Number.parseInt(trimmed, 10);
    if (!Number.isFinite(parsed)) return undefined;
    const withMin = props.min === undefined ? parsed : Math.max(props.min, parsed);
    const withMax = props.max === undefined ? withMin : Math.min(props.max, withMin);
    return props.integer === false ? withMax : Math.round(withMax);
  };

  const commit = () => {
    const next = parseDraft();
    if (next === undefined) {
      setError("Enter a valid number.");
      return false;
    }
    setError(null);
    if (!sameValue(next, props.value)) void props.onCommit(next);
    return true;
  };

  return (
    <PopoverEditorFrame open={open} setOpen={setOpen} display={display} common={props}>
      <ChakraField.Root invalid={!!error}>
        {props.label && <ChakraField.Label>{props.label}</ChakraField.Label>}
        <Input
          ref={inputRef}
          size="sm"
          type="number"
          inputMode="numeric"
          value={draft}
          min={props.min}
          max={props.max}
          step={props.step ?? 1}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter" && commit()) setOpen(false);
            if (event.key === "Escape") {
              setDraft(props.value == null ? "" : String(props.value));
              setError(null);
              setOpen(false);
            }
          }}
          placeholder={props.placeholder}
          fontFamily="heading"
          fontSize="sm"
          borderColor="gray.200"
          _focus={{ borderColor: "violet.400", boxShadow: "none" }}
        />
        {error && <ChakraField.ErrorText>{error}</ChakraField.ErrorText>}
      </ChakraField.Root>
    </PopoverEditorFrame>
  );
}

export function EditableChip<T extends EditableChipValue = EditableChipValue>(
  props: EditableChipProps<T>,
) {
  if (props.type === "select") return <SelectChip props={props} />;
  if (props.type === "number") return <NumberChip props={props} />;
  return <TextChip props={props} />;
}
