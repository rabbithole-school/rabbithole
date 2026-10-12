import { useMemo, useState } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from "react-native";
import Svg, {
  Circle,
  G,
  Line,
  Polygon,
  Text as SvgText,
} from "react-native-svg";

import {
  elementName,
  moleculeAtomLabelVisible,
  moleculeDrawList,
  moleculeHighlightSelection,
} from "../../../vendor/manipulative/molecule";
import type { MoleculeSpec } from "../../../vendor/manipulative/types";
import type { KindProps } from "./kit";
import { fonts, palette } from "@/theme";

const PAD = 28;
const HEIGHT = 320;
const ELEMENT_COLOR: Record<string, string> = {
  C: palette.charcoal[500],
  H: palette.charcoal[300],
  N: "#2864b7",
  O: "#c43d3d",
  F: "#288b57",
  Cl: "#288b57",
  Br: "#8a4a24",
  I: "#6f4a9e",
  P: "#bc6c25",
  S: "#a77b00",
};

export function MoleculeNative({ spec }: KindProps<MoleculeSpec, never>) {
  const [width, setWidth] = useState(0);
  const [carbonLabelsVisible, setCarbonLabelsVisible] = useState(true);
  const [selectedAtom, setSelectedAtom] = useState<number | null>(null);
  const molecule = useMemo(
    () => ({ atoms: spec.atoms, bonds: spec.bonds }),
    [spec.atoms, spec.bonds],
  );
  const drawList = useMemo(() => moleculeDrawList(molecule), [molecule]);
  const highlight = useMemo(
    () => moleculeHighlightSelection(molecule, spec.highlight),
    [molecule, spec.highlight],
  );
  const highlightedAtoms = useMemo(
    () => new Set(highlight.atomIndexes),
    [highlight.atomIndexes],
  );
  const highlightedBonds = useMemo(
    () => new Set(highlight.bondIndexes),
    [highlight.bondIndexes],
  );
  const selected = selectedAtom == null ? null : spec.atoms[selectedAtom];
  const selectedBondCount =
    selectedAtom == null
      ? 0
      : spec.bonds.filter(
          (bond) => bond.a === selectedAtom || bond.b === selectedAtom,
        ).length;
  const viewWidth = drawList.width + PAD * 2;
  const viewHeight = drawList.height + PAD * 2;
  const onLayout = (event: LayoutChangeEvent) =>
    setWidth(event.nativeEvent.layout.width);

  return (
    <View style={styles.wrap}>
      <View style={styles.header}>
        <View style={styles.titleWrap}>
          <Text style={styles.title}>{spec.resolvedName}</Text>
          <Text style={styles.meta}>
            {spec.formula} · PubChem CID {spec.cid}
          </Text>
        </View>
        <Pressable
          onPress={() => setCarbonLabelsVisible((visible) => !visible)}
          accessibilityRole="button"
          accessibilityState={{ selected: carbonLabelsVisible }}
          accessibilityLabel={`${carbonLabelsVisible ? "Hide" : "Show"} carbon labels`}
          style={({ pressed }) => [
            styles.toggle,
            carbonLabelsVisible && styles.toggleActive,
            pressed && styles.togglePressed,
          ]}
        >
          <Text style={styles.toggleText}>
            Carbons {carbonLabelsVisible ? "on" : "off"}
          </Text>
        </Pressable>
      </View>

      <View style={styles.stage} onLayout={onLayout}>
        {width > 0 && (
          <Svg
            width={width}
            height={HEIGHT}
            viewBox={`0 0 ${viewWidth} ${viewHeight}`}
            preserveAspectRatio="xMidYMid meet"
            accessibilityLabel={`2D molecular structure of ${spec.resolvedName}`}
          >
            {drawList.ops.map((op, index) => {
              if (op.op === "atom") return null;
              const highlighted = highlightedBonds.has(op.bondIndex);
              const color = highlighted
                ? palette.orange[500]
                : palette.charcoal[500];
              if (op.op === "polygon") {
                return (
                  <Polygon
                    key={`bond-${op.bondIndex}-${index}`}
                    points={op.points
                      .map((point) => `${point.x + PAD},${point.y + PAD}`)
                      .join(" ")}
                    fill={color}
                  />
                );
              }
              return (
                <Line
                  key={`bond-${op.bondIndex}-${index}`}
                  x1={op.from.x + PAD}
                  y1={op.from.y + PAD}
                  x2={op.to.x + PAD}
                  y2={op.to.y + PAD}
                  stroke={color}
                  strokeWidth={highlighted ? 4 : 2.4}
                  strokeLinecap="round"
                />
              );
            })}

            {drawList.ops.map((op) => {
              if (op.op !== "atom") return null;
              const highlighted = highlightedAtoms.has(op.index);
              const selectedNow = selectedAtom === op.index;
              const showLabel = moleculeAtomLabelVisible(
                op.el,
                carbonLabelsVisible,
              );
              return (
                <G
                  key={`atom-${op.index}`}
                  onPress={() => setSelectedAtom(op.index)}
                  accessibilityRole="button"
                  accessibilityLabel={`${op.el}, ${elementName(op.el)}, ${op.bondCount} ${op.bondCount === 1 ? "bond" : "bonds"}`}
                >
                  <Circle
                    cx={op.at.x + PAD}
                    cy={op.at.y + PAD}
                    r={20}
                    fill="transparent"
                  />
                  {(showLabel || highlighted || selectedNow) && (
                    <Circle
                      cx={op.at.x + PAD}
                      cy={op.at.y + PAD}
                      r={selectedNow ? 13 : highlighted ? 12 : 10}
                      fill={palette.white}
                      stroke={
                        selectedNow
                          ? palette.violet[500]
                          : highlighted
                            ? palette.orange[500]
                            : "transparent"
                      }
                      strokeWidth={selectedNow || highlighted ? 3 : 0}
                    />
                  )}
                  {showLabel && (
                    <SvgText
                      x={op.at.x + PAD}
                      y={op.at.y + PAD + 5}
                      textAnchor="middle"
                      fontSize={15}
                      fontFamily={fonts.bold}
                      fill={ELEMENT_COLOR[op.el] ?? palette.charcoal[500]}
                    >
                      {op.el}
                    </SvgText>
                  )}
                </G>
              );
            })}
          </Svg>
        )}
      </View>

      <Text style={styles.selection}>
        {selected
          ? `${selected.el} — ${elementName(selected.el)} · ${selectedBondCount} ${selectedBondCount === 1 ? "bond" : "bonds"}`
          : "Tap an atom to identify it."}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { width: "100%", gap: 8 },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
  },
  titleWrap: { flex: 1 },
  title: {
    fontFamily: fonts.bold,
    fontSize: 16,
    color: palette.navy[500],
  },
  meta: {
    fontFamily: fonts.medium,
    fontSize: 12,
    color: palette.charcoal[400],
  },
  toggle: {
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderWidth: 1,
    borderColor: palette.gray[200],
    borderRadius: 10,
    backgroundColor: palette.white,
  },
  toggleActive: { backgroundColor: palette.gray[100] },
  togglePressed: { opacity: 0.75 },
  toggleText: {
    fontFamily: fonts.bold,
    fontSize: 13,
    color: palette.charcoal[500],
  },
  stage: {
    height: HEIGHT,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: palette.gray[200],
    borderRadius: 16,
    backgroundColor: palette.white,
  },
  selection: {
    minHeight: 22,
    fontFamily: fonts.bold,
    fontSize: 14,
    color: palette.charcoal[400],
  },
});
