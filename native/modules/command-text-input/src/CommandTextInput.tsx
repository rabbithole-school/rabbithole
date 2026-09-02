import { requireNativeView } from "expo";
import * as React from "react";
import { TextInput } from "react-native";

import type { CommandTextInputProps } from "./CommandTextInput.types";

type NativeTextEvent = { nativeEvent: { text: string } };

type NativeProps = {
  text: string;
  editable: boolean;
  maxLength?: number;
  placeholder?: string;
  placeholderTextColor?: string;
  textColor?: string;
  fontName?: string;
  fontSize: number;
  contentInsetHorizontal: number;
  contentInsetVertical: number;
  autoFocus: boolean;
  showSoftInputOnFocus: boolean;
  captureEditorCommands: boolean;
  inputAccessibilityLabel?: string;
  onTextChange: (event: NativeTextEvent) => void;
  onInputFocus?: () => void;
  onInputBlur?: () => void;
  onEscape?: () => void;
  onCommandReturn?: () => void;
  style?: CommandTextInputProps["style"];
};

let NativeView: React.ComponentType<NativeProps> | null = null;
try {
  NativeView = requireNativeView("CommandTextInput") as React.ComponentType<NativeProps>;
} catch {
  NativeView = null;
}

export const isCommandTextInputAvailable = NativeView != null;

export function CommandTextInput({
  value,
  onChangeText,
  onFocus,
  onBlur,
  onEscape,
  onCommandReturn,
  captureEditorCommands = false,
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
  if (!NativeView) {
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

  return (
    <NativeView
      autoFocus={autoFocus}
      captureEditorCommands={captureEditorCommands}
      contentInsetHorizontal={contentInsetHorizontal}
      contentInsetVertical={contentInsetVertical}
      editable={editable}
      fontName={fontName}
      fontSize={fontSize}
      inputAccessibilityLabel={accessibilityLabel}
      maxLength={maxLength}
      onCommandReturn={onCommandReturn}
      onEscape={onEscape}
      onInputBlur={onBlur}
      onInputFocus={onFocus}
      onTextChange={(event) => onChangeText(event.nativeEvent.text)}
      placeholder={placeholder}
      placeholderTextColor={placeholderTextColor}
      showSoftInputOnFocus={showSoftInputOnFocus}
      style={style}
      text={value}
      textColor={textColor}
    />
  );
}
