import { createElement, type ReactNode } from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", async () => {
  const react = await vi.importActual<typeof import("react")>("react");
  const passthrough = ({ children }: { children?: ReactNode }) => children ?? null;
  return {
    KeyboardAvoidingView: passthrough,
    Platform: { OS: "ios" },
    Pressable: ({
      children,
      ...props
    }: {
      children?: ReactNode;
      [key: string]: unknown;
    }) => react.createElement("pressable", props, children),
    ScrollView: passthrough,
    StyleSheet: {
      absoluteFill: {},
      create: <T,>(styles: T) => styles,
    },
    Text: passthrough,
    View: passthrough,
  };
});
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ bottom: 0 }),
}));
vi.mock("@/components/AppTextInput", () => ({
  AppTextInput: (props: Record<string, unknown>) => createElement("text-input", props),
}));
vi.mock("@/theme", () => ({
  fonts: { bold: "bold", regular: "regular" },
  palette: { navy: { 900: "#000" } },
  useColors: () =>
    new Proxy<Record<string, string>>({}, { get: () => "#000" }),
}));

import { MakePictureDialog } from "./MakePictureDialog";

describe("MakePictureDialog", () => {
  it("reopens with the scholar's submitted prompt intact", async () => {
    const onSubmit = vi.fn();
    let renderer!: ReturnType<typeof create>;

    await act(async () => {
      renderer = create(
        createElement(MakePictureDialog, {
          initialPrompt: "a labeled water cycle",
          onSubmit,
          onCancel: vi.fn(),
        }),
      );
    });

    const input = renderer.root.findByType("text-input");
    expect(input.props.value).toBe("a labeled water cycle");
    expect(input.props.accessibilityLabel).toBe(
      "Describe the image you want to make",
    );

    act(() => {
      input.props.onChangeText("clouds rain into a river");
    });
    const updatedInput = renderer.root.findByType("text-input");
    act(() => {
      updatedInput.props.onSubmitEditing();
    });

    expect(onSubmit).toHaveBeenCalledWith("clouds rain into a river");
  });
});
