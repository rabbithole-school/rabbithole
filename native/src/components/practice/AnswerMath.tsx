/**
 * A canonical ANSWER string (`(x+3)/(x-2)`, `log_2(8)`, `3±2i`, `3,-2`, `none`)
 * typeset with SwiftMath, for a multiple-choice option or a revealed answer.
 * Callers gate on `isTypesetAnswer(value)` and keep their old rendering for
 * plain numbers, fractions and prose, so nothing else changes.
 */

import { View } from "react-native";

import { useColors } from "@/theme";
import { MathView } from "../../../modules/expo-math-view";
import { answerToLatex } from "../../../vendor/shared/answerLatex";
import { latexToPlainSpeech, renderableMathLatex } from "../../../vendor/shared/stemMath";

export { isTypesetAnswer } from "../../../vendor/shared/answerLatex";

export function AnswerMath({
  value,
  fontSize = 20,
  color,
  align = "center",
}: {
  value: string;
  fontSize?: number;
  color?: string;
  /** "left" in a multiple-choice option, matching plain-text options. */
  align?: "center" | "left";
}) {
  const colors = useColors();
  const latex = answerToLatex(value);
  if (!latex) return null;
  return (
    <View accessible accessibilityLabel={latexToPlainSpeech(latex)} style={{ alignSelf: align === "left" ? "flex-start" : "center" }}>
      <MathView latex={renderableMathLatex(latex, false)} fontSize={fontSize} color={color ?? colors.fg} typesettingStyle="text" />
    </View>
  );
}
