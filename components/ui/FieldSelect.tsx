"use client";

/**
 * FieldSelect — the on-brand `<select>`. One styled dropdown replaces the
 * raw inline-styled `<select>`s that drifted across the app (admin role
 * picker, observation type, …), each carrying its own ad-hoc
 * `border: 1px solid #ccc` / hard-coded radius / wrong font.
 *
 * Wraps Chakra's NativeSelect so it inherits the same border / radius /
 * focus treatment as our `<Input>` (gray.200 border, md radius, heading
 * font, violet focus ring) and ships a real caret indicator.
 *
 *   <FieldSelect value={role} onChange={(v) => setRole(v)}>
 *     <option value="scholar">scholar</option>
 *     …
 *   </FieldSelect>
 *
 * Forwards extra Chakra props to the Root (w, maxW, size, …).
 */
import { NativeSelect, type NativeSelectRootProps } from "@chakra-ui/react";

export interface FieldSelectProps
  extends Omit<NativeSelectRootProps, "onChange" | "children"> {
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
  disabled?: boolean;
  /** Forwarded to NativeSelect.Field (e.g. aria-label, name). */
  fieldProps?: React.ComponentProps<typeof NativeSelect.Field>;
}

export function FieldSelect({
  value,
  onChange,
  children,
  disabled,
  fieldProps,
  size = "sm",
  ...rootProps
}: FieldSelectProps) {
  return (
    <NativeSelect.Root size={size} disabled={disabled} {...rootProps}>
      <NativeSelect.Field
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        fontFamily="heading"
        color="charcoal.500"
        borderColor="gray.200"
        borderRadius="md"
        _focus={{ borderColor: "violet.400", boxShadow: "none" }}
        {...fieldProps}
      >
        {children}
      </NativeSelect.Field>
      <NativeSelect.Indicator color="charcoal.400" />
    </NativeSelect.Root>
  );
}
