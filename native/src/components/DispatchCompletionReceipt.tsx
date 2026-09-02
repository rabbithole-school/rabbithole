import { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";

import { fonts, useColors, type Colors } from "@/theme";
import {
  dispatchCompletionReceiptCopy,
  type DispatchCompletionReceipt as DispatchCompletionReceiptData,
  type DispatchCompletionReceiptKind,
} from "../../vendor/shared/dispatchCompletionReceipt";

export function DispatchCompletionReceipt({
  receipts,
  kind,
}: {
  receipts: readonly DispatchCompletionReceiptData[];
  kind: DispatchCompletionReceiptKind;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  if (receipts.length === 0) return null;

  return (
    <View style={styles.container}>
      {receipts.map((receipt) => (
        <View key={receipt.assignmentId} style={styles.row}>
          <Text style={styles.check}>✓</Text>
          <Text style={styles.copy}>
            {dispatchCompletionReceiptCopy(receipt.teacherName, kind)}
          </Text>
        </View>
      ))}
    </View>
  );
}

function makeStyles(colors: Colors) {
  return StyleSheet.create({
    container: {
      width: "100%",
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
      paddingTop: 10,
      marginTop: 8,
      gap: 6,
    },
    row: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 8,
    },
    check: {
      flexShrink: 0,
      marginTop: 1,
      fontFamily: fonts.bold,
      fontSize: 14,
      lineHeight: 20,
      color: colors.green,
    },
    copy: {
      flex: 1,
      fontFamily: fonts.regular,
      fontSize: 14,
      lineHeight: 20,
      color: colors.fgMuted,
    },
  });
}
