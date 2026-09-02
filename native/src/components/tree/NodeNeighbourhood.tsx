import { Pressable, StyleSheet, Text, View } from "react-native";

import { palette } from "@/theme";
import { MASTERY_DOT_COLOR } from "../../../vendor/shared/masteryDialPalette";
import {
  deriveNeighbourhood,
  neighbourAccessibilityHint,
  neighbourAccessibilityLabel,
  type DerivedNeighbour,
  type NodeNeighbourhood as NodeNeighbourhoodData,
} from "./treeNeighbourhood";

type Props = {
  data: NodeNeighbourhoodData | undefined;
  onNavigate: (nodeKey: string) => void;
};

const RELATION_COPY = {
  prerequisite: "Builds on",
  unlock: "Leads to",
  bridge: "Connects to",
} as const;

function NeighbourChip({
  neighbour,
  onNavigate,
}: {
  neighbour: DerivedNeighbour;
  onNavigate: (nodeKey: string) => void;
}) {
  const borderColor =
    neighbour.relation === "bridge" ? "#b6acd8" : "#aeb7e8";
  return (
    <Pressable
      onPress={() => onNavigate(neighbour.nodeKey)}
      style={({ pressed }) => [
        styles.chip,
        { borderColor },
        pressed && styles.chipPressed,
      ]}
      accessibilityRole="button"
      accessibilityLabel={neighbourAccessibilityLabel(neighbour)}
      accessibilityHint={neighbourAccessibilityHint(neighbour)}
    >
      {neighbour.mastery ? (
        <View
          style={[
            styles.masteryDot,
            { backgroundColor: MASTERY_DOT_COLOR[neighbour.mastery] },
          ]}
        />
      ) : null}
      <Text style={styles.chipText} numberOfLines={2}>
        {neighbour.label}
      </Text>
      {neighbour.observed ? <Text style={styles.observed}>Your connection</Text> : null}
    </Pressable>
  );
}

function RelationGroup({
  relation,
  neighbours,
  onNavigate,
}: {
  relation: DerivedNeighbour["relation"];
  neighbours: DerivedNeighbour[];
  onNavigate: (nodeKey: string) => void;
}) {
  if (neighbours.length === 0) return null;
  return (
    <View style={styles.group}>
      <Text style={styles.groupLabel}>{RELATION_COPY[relation].toUpperCase()}</Text>
      <View style={styles.chips}>
        {neighbours.map((neighbour) => (
          <NeighbourChip key={neighbour.nodeKey} neighbour={neighbour} onNavigate={onNavigate} />
        ))}
      </View>
    </View>
  );
}

export function NodeNeighbourhood({ data, onNavigate }: Props) {
  const neighbourhood = deriveNeighbourhood(data ?? null);
  if (data === undefined) {
    return <Text style={styles.loading}>Loading neighbourhood…</Text>;
  }
  if (!data || !neighbourhood) return null;

  const hasRelationships =
    neighbourhood.prerequisites.length > 0 ||
    neighbourhood.unlocks.length > 0 ||
    neighbourhood.bridges.length > 0;
  if (!hasRelationships && neighbourhood.stories.length === 0) {
    return <Text style={styles.loading}>No connected skills yet.</Text>;
  }

  return (
    <View style={styles.root} accessibilityLabel={`Neighbourhood of ${data.node.label}`}>
      <Text style={styles.heading}>How this fits</Text>
      <RelationGroup
        relation="prerequisite"
        neighbours={neighbourhood.prerequisites}
        onNavigate={onNavigate}
      />
      <RelationGroup relation="unlock" neighbours={neighbourhood.unlocks} onNavigate={onNavigate} />
      <RelationGroup relation="bridge" neighbours={neighbourhood.bridges} onNavigate={onNavigate} />
      {neighbourhood.stories.length > 0 ? (
        <View style={styles.group}>
          <Text style={styles.groupLabel}>OPENS INTO THE WORLD</Text>
          {neighbourhood.stories.map((story) => (
            <Text key={story.edgeId} style={styles.story}>
              {story.direction === "outgoing" ? story.toLabel : story.fromLabel}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { marginTop: 24 },
  heading: {
    color: palette.violet[400],
    fontSize: 14,
    fontFamily: "HankenGrotesk_700Bold",
    marginBottom: 14,
  },
  group: { marginBottom: 16 },
  groupLabel: {
    color: palette.charcoal[400],
    fontSize: 11,
    letterSpacing: 0.9,
    fontFamily: "HankenGrotesk_700Bold",
    marginBottom: 8,
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    minHeight: 44,
    maxWidth: "100%",
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderRadius: 12,
    backgroundColor: palette.white,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  chipPressed: { opacity: 0.7 },
  masteryDot: { width: 8, height: 8, borderRadius: 4, marginRight: 8 },
  chipText: {
    color: palette.charcoal[500],
    fontSize: 15,
    lineHeight: 19,
    fontFamily: "HankenGrotesk_600SemiBold",
    flexShrink: 1,
  },
  observed: {
    color: palette.violet[400],
    fontSize: 11,
    fontFamily: "HankenGrotesk_600SemiBold",
    marginLeft: 8,
  },
  story: {
    color: palette.charcoal[500],
    fontSize: 16,
    lineHeight: 22,
    fontFamily: "HankenGrotesk_600SemiBold",
    marginBottom: 5,
  },
  loading: {
    color: palette.charcoal[400],
    fontSize: 15,
    lineHeight: 21,
    fontFamily: "HankenGrotesk_500Medium",
    marginTop: 20,
  },
});
