import { memo, useMemo } from "react";

import { fonts, useColors } from "@/theme";
import type { ExpressionTemplateState, SlotId } from "@/lib/expressionTemplateInput";
import { ExpressionEditor as KeypadExpressionEditor } from "../../../vendor/react-native-math-keypad/components/ExpressionEditor";
import type { MathKeypadThemeOverride } from "../../../vendor/react-native-math-keypad/theme";

/**
 * The 2-D answer builder, drawn by the MIT-licensed keypad package
 * (packages/react-native-math-keypad, vendored by native/scripts/sync-vendor.js).
 * The package owns the rendering; this wrapper only maps the app's theme onto
 * the package's color and font tokens, so the editor looks exactly as it did
 * when its code lived here. Edit the package, then run `npm run sync:vendor`.
 */
export const ExpressionEditor = memo(function ExpressionEditor({
  state,
  onSetCaret,
  fontSize = 26,
  interactive = true,
}: {
  state: ExpressionTemplateState;
  /** Tap-to-place the insertion bar at a precise gap within a slot. */
  onSetCaret: (id: SlotId, index: number) => void;
  fontSize?: number;
  /** False during feedback/disabled: render inert (no caret, no cyan, no tap). */
  interactive?: boolean;
}) {
  const colors = useColors();
  const theme = useMemo<MathKeypadThemeOverride>(
    () => ({
      colors: {
        ink: colors.charcoal,
        accent: colors.cyan,
        accentSubtle: colors.cyanSubtle,
        emptyBox: colors.charcoalSubtle,
        danger: colors.danger,
      },
      fonts: { editor: fonts.medium, editorItalic: fonts.italic },
    }),
    [colors],
  );
  return (
    <KeypadExpressionEditor
      state={state}
      onSetCaret={onSetCaret}
      fontSize={fontSize}
      interactive={interactive}
      theme={theme}
    />
  );
});
