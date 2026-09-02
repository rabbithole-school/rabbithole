/**
 * Distributor (native) — the RN port of the web Distributor. Deal a pile of
 * items one round at a time into equal plates and watch the leftover pile shrink
 * to the true remainder. Isolates division as equal sharing (a ÷ b = "how many
 * each", with a remainder). Each "+" deals one item to EVERY plate at once — a
 * full round — so the plates stay equal; the win is dealing every round you can.
 *
 * The bar count is stepped (a discrete count → a Stepper, like Riemann). All the
 * math is reused verbatim from the shared logic layer (`distributorPerGroupMax`,
 * `distributorRemainder`, `initialDistributor`); this file owns only pixels.
 */

import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import {
  distributorPerGroupMax,
  distributorRemainder,
  initialDistributor,
} from "../../../vendor/manipulative/logic";
import type { DistributorState } from "../../../vendor/manipulative/logic";
import type { DistributorSpec } from "../../../vendor/manipulative/types";
import type { KindProps } from "./kit";
import { Stepper } from "./Stepper";
import { fonts, palette } from "@/theme";

function DotBox({
  count,
  color,
  label,
}: {
  count: number;
  color: string;
  label: string;
}) {
  return (
    <View style={styles.plateCol}>
      <View style={styles.plate}>
        {Array.from({ length: count }, (_, i) => (
          <View key={i} style={[styles.pip, { backgroundColor: color }]} />
        ))}
      </View>
      <Text style={styles.plateLabel}>{label}</Text>
    </View>
  );
}

export function DistributorNative({
  spec,
  onSolvedChange,
  onStateChange,
}: KindProps<DistributorSpec, DistributorState>) {
  const max = distributorPerGroupMax(spec);
  const [perGroup, setPerGroup] = useState(() => initialDistributor(spec).perGroup);
  const remainder = distributorRemainder(spec, { perGroup });

  const setDeal = (v: number) => {
    setPerGroup(v);
    onSolvedChange(v === max && !!spec.goal);
    onStateChange?.({ perGroup: v });
  };

  return (
    <View style={styles.wrap}>
      <View style={styles.plates}>
        {Array.from({ length: spec.groups }, (_, i) => (
          <DotBox key={i} count={perGroup} color={palette.cyan[500]} label={`Plate ${i + 1}`} />
        ))}
        <DotBox count={remainder} color={palette.orange[500]} label="Left over" />
      </View>

      <Stepper value={perGroup} min={0} max={max} label="each plate" onChange={setDeal} />

      <Text style={styles.equation}>
        {spec.total} ÷ {spec.groups} = {perGroup}
        {remainder > 0 ? ` remainder ${remainder}` : ""}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { width: "100%", gap: 14, alignItems: "center" },
  plates: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    alignItems: "flex-start",
    gap: 12,
  },
  plateCol: { alignItems: "center", gap: 4, minWidth: 72 },
  plate: {
    width: 72,
    minHeight: 72,
    padding: 8,
    borderWidth: 1,
    borderColor: palette.gray[200],
    borderRadius: 14,
    backgroundColor: palette.white,
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    alignItems: "center",
    gap: 6,
  },
  pip: { width: 14, height: 14, borderRadius: 7 },
  plateLabel: {
    fontFamily: fonts.bold,
    fontSize: 12,
    color: palette.charcoal[400],
  },
  equation: {
    fontFamily: fonts.bold,
    fontSize: 16,
    color: palette.navy[500],
    textAlign: "center",
  },
});
