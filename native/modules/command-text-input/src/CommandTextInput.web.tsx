import { TextInput } from "react-native";

import type { CommandTextInputProps } from "./CommandTextInput.types";

export const isCommandTextInputAvailable = false;

export function CommandTextInput({
  value,
  onChangeText,
  onFocus,
  onBlur,
  autoFocus = false,
  editable = true,
  maxLength,
  showSoftInputOnFocus = true,
  placeholder,
  placeholderTextColor,
  textColor,
  fontName,
  fontSize = 16,
  contentInsetHorizontal = 0,
  contentInsetVertical = 0,
  accessibilityLabel,
  style,
}: CommandTextInputProps) {
  return (
    <TextInput
      accessibilityLabel={accessibilityLabel}
      autoFocus={autoFocus}
      editable={editable}
      maxLength={maxLength}
      multiline
      onBlur={onBlur}
      onChangeText={onChangeText}
      onFocus={onFocus}
      placeholder={placeholder}
      placeholderTextColor={placeholderTextColor}
      showSoftInputOnFocus={showSoftInputOnFocus}
      style={[
        style,
        {
          color: textColor,
          fontFamily: fontName,
          fontSize,
          paddingHorizontal: contentInsetHorizontal,
          paddingVertical: contentInsetVertical,
          textAlignVertical: "top",
        },
      ]}
      value={value}
    />
  );
}
