import type { StyleProp, TextStyle } from "react-native";

export type CommandTextInputProps = {
  value: string;
  onChangeText: (text: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  onEscape?: () => void;
  onCommandReturn?: () => void;
  captureEditorCommands?: boolean;
  autoFocus?: boolean;
  editable?: boolean;
  maxLength?: number;
  showSoftInputOnFocus?: boolean;
  placeholder?: string;
  placeholderTextColor?: string;
  textColor?: string;
  fontName?: string;
  fontSize?: number;
  contentInsetHorizontal?: number;
  contentInsetVertical?: number;
  accessibilityLabel?: string;
  style?: StyleProp<TextStyle>;
};
