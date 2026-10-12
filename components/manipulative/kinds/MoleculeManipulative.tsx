"use client";

import { Box, Flex, Text } from "@chakra-ui/react";
import { useMemo, useState } from "react";

import {
  elementName,
  moleculeAtomLabelVisible,
  moleculeDrawList,
  moleculeHighlightSelection,
} from "@/lib/manipulative/molecule";
import type { MoleculeSpec } from "@/lib/manipulative/types";
import type { KindProps } from "../Manipulative";
import { C } from "../colors";

const PAD = 28;
const ELEMENT_COLOR: Record<string, string> = {
  C: C.charcoal,
  H: "#7c8798",
  N: "#2864b7",
  O: "#c43d3d",
  F: "#288b57",
  Cl: "#288b57",
  Br: "#8a4a24",
  I: "#6f4a9e",
  P: "#bc6c25",
  S: "#a77b00",
};

export function MoleculeManipulative({ spec }: KindProps<MoleculeSpec>) {
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

  return (
    <Box>
      <Flex justify="space-between" align="center" gap={3} mb={2}>
        <Box minW={0}>
          <Text fontSize="15px" fontWeight="700" color="brand.primary">
            {spec.resolvedName}
          </Text>
          <Text fontSize="12px" color="fg.muted">
            {spec.formula} · PubChem CID {spec.cid}
          </Text>
        </Box>
        <Box
          as="button"
          aria-pressed={carbonLabelsVisible}
          aria-label={`${carbonLabelsVisible ? "Hide" : "Show"} carbon labels`}
          onClick={() => setCarbonLabelsVisible((visible) => !visible)}
          flexShrink={0}
          px={3}
          py={2}
          borderWidth="1px"
          borderColor="border.default"
          borderRadius="10px"
          bg={carbonLabelsVisible ? "bg.muted" : "white"}
          color="fg.default"
          fontSize="13px"
          fontWeight="700"
          css={{ cursor: "pointer" }}
        >
          Carbons {carbonLabelsVisible ? "on" : "off"}
        </Box>
      </Flex>

      <Box
        borderWidth="1px"
        borderColor="border.default"
        borderRadius="16px"
        bg="white"
        overflow="hidden"
      >
        <svg
          width="100%"
          height="auto"
          viewBox={`0 0 ${viewWidth} ${viewHeight}`}
          role="img"
          aria-label={`2D molecular structure of ${spec.resolvedName}`}
          style={{ display: "block", maxHeight: 390 }}
        >
          {drawList.ops.map((op, index) => {
            if (op.op === "atom") return null;
            const highlighted = highlightedBonds.has(op.bondIndex);
            const color = highlighted ? C.orange : C.charcoal;
            if (op.op === "polygon") {
              return (
                <polygon
                  key={`bond-${op.bondIndex}-${index}`}
                  points={op.points
                    .map((point) => `${point.x + PAD},${point.y + PAD}`)
                    .join(" ")}
                  fill={color}
                />
              );
            }
            return (
              <line
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
            const choose = () => setSelectedAtom(op.index);
            return (
              <g
                key={`atom-${op.index}`}
                role="button"
                tabIndex={0}
                aria-label={`${op.el}, ${elementName(op.el)}, ${op.bondCount} ${op.bondCount === 1 ? "bond" : "bonds"}`}
                onClick={choose}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    choose();
                  }
                }}
                style={{ cursor: "pointer" }}
              >
                <circle
                  cx={op.at.x + PAD}
                  cy={op.at.y + PAD}
                  r={18}
                  fill="transparent"
                />
                {(showLabel || highlighted || selectedNow) && (
                  <circle
                    cx={op.at.x + PAD}
                    cy={op.at.y + PAD}
                    r={selectedNow ? 13 : highlighted ? 12 : 10}
                    fill="white"
                    stroke={
                      selectedNow
                        ? C.violet
                        : highlighted
                          ? C.orange
                          : "transparent"
                    }
                    strokeWidth={selectedNow || highlighted ? 3 : 0}
                  />
                )}
                {showLabel && (
                  <text
                    x={op.at.x + PAD}
                    y={op.at.y + PAD}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize="15"
                    fontWeight="700"
                    fill={ELEMENT_COLOR[op.el] ?? C.charcoal}
                  >
                    {op.el}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </Box>

      <Text mt={2} minH="22px" fontSize="14px" fontWeight="600" color="fg.muted">
        {selected
          ? `${selected.el} — ${elementName(selected.el)} · ${selectedBondCount} ${selectedBondCount === 1 ? "bond" : "bonds"}`
          : "Tap an atom to identify it."}
      </Text>
    </Box>
  );
}
