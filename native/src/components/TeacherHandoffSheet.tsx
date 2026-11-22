/**
 * The pop-up behind a header pill that hands something to the teacher: the
 * app builder's Send to teacher, and homework's "I'm done with this". A title,
 * one line saying what will happen, and two buttons. Either button may run an
 * async action; the sheet closes when it succeeds and shows `failedText` when
 * it throws, so a failure never reaches the scholar as a raw error.
 */
import { useState } from "react";
import {
  KeyboardAvoidingView,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { Modal } from "./FreezableModal";
import { fonts, useColors } from "../theme";

export type HandoffSheetAction = {
  label: string;
  /** Shown on this button while its action runs. */
  busyLabel?: string;
  /** Omit to make the button just close the sheet. */
  onPress?: () => Promise<void>;
};

export function TeacherHandoffSheet({
  open,
  onClose,
  title,
  body,
  secondary,
  primary,
  failedText,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  body: string;
  /** The outlined button on the left. */
  secondary: HandoffSheetAction;
  /** The filled button on the right. */
  primary: HandoffSheetAction;
  failedText: string;
}) {
  const colors = useColors();
  const [running, setRunning] = useState<"primary" | "secondary" | null>(null);
  const [failed, setFailed] = useState(false);

  // Closing clears the sheet, so it opens fresh next time (the Modal itself
  // stays mounted).
  const close = () => {
    if (running) return;
    setFailed(false);
    onClose();
  };

  const run = async (which: "primary" | "secondary") => {
    if (running) return;
    const action = which === "primary" ? primary : secondary;
    if (!action.onPress) {
      close();
      return;
    }
    setRunning(which);
    setFailed(false);
    try {
      await action.onPress();
      setRunning(null);
      onClose();
    } catch {
      setRunning(null);
      setFailed(true);
    }
  };

  const buttonLabel = (which: "primary" | "secondary", action: HandoffSheetAction) =>
    running === which && action.busyLabel ? action.busyLabel : action.label;

  return (
    <Modal transparent animationType="fade" visible={open} onRequestClose={close}>
      <KeyboardAvoidingView behavior="padding" style={styles.fill}>
        <Pressable
          style={[styles.backdrop, { backgroundColor: "rgba(0,0,0,0.4)" }]}
          onPress={close}
          accessibilityLabel="Close"
        >
          {/* Inner Pressable swallows taps so they don't hit the backdrop. */}
          <Pressable
            onPress={() => {}}
            style={[styles.card, { backgroundColor: colors.bg, borderColor: colors.border }]}
          >
            <Text style={[styles.title, { color: colors.fg, fontFamily: fonts.bold }]}>
              {title}
            </Text>
            <Text style={[styles.body, { color: colors.fgMuted, fontFamily: fonts.regular }]}>
              {body}
            </Text>
            {failed ? (
              <Text style={[styles.error, { color: colors.danger, fontFamily: fonts.regular }]}>
                {failedText}
              </Text>
            ) : null}
            <View style={styles.buttons}>
              <Pressable
                onPress={() => void run("secondary")}
                disabled={running !== null}
                accessibilityRole="button"
                style={[
                  styles.button,
                  {
                    borderColor: colors.border,
                    borderWidth: StyleSheet.hairlineWidth,
                    opacity: running ? 0.5 : 1,
                  },
                ]}
              >
                <Text style={[styles.buttonText, { color: colors.violet, fontFamily: fonts.semibold }]}>
                  {buttonLabel("secondary", secondary)}
                </Text>
              </Pressable>
              <Pressable
                onPress={() => void run("primary")}
                disabled={running !== null}
                accessibilityRole="button"
                style={[
                  styles.button,
                  { backgroundColor: colors.violetSolid, opacity: running ? 0.5 : 1 },
                ]}
              >
                <Text style={[styles.buttonText, { color: colors.white, fontFamily: fonts.semibold }]}>
                  {buttonLabel("primary", primary)}
                </Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  backdrop: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  card: {
    width: "100%",
    maxWidth: 460,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 20,
    gap: 12,
  },
  title: { fontSize: 18 },
  body: { fontSize: 15, lineHeight: 21 },
  error: { fontSize: 15 },
  buttons: { flexDirection: "row", justifyContent: "flex-end", gap: 10, marginTop: 4 },
  button: {
    height: 38,
    borderRadius: 12,
    paddingHorizontal: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonText: { fontSize: 15 },
});
