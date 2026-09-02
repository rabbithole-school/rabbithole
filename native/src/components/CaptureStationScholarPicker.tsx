import { Pressable, StyleSheet, Text, View } from "react-native";
import { Image } from "expo-image";
import { SymbolView } from "expo-symbols";

import type { Id } from "@/lib/convex";
import { resolveUserImageUri } from "@/lib/webEmbedConfig";
import { fonts, palette } from "@/theme";

type RosterScholar = { id: Id<"users">; name: string; image: string | null };

/**
 * The station "team" as a vertical, on-navy inset list (avatar · name ·
 * trailing check). Sits in the left pane of the capture-station split layout.
 */
export function CaptureStationScholarPicker({
  roster,
  selectedIds,
  onToggle,
}: {
  roster: RosterScholar[];
  selectedIds: Id<"users">[];
  onToggle: (id: Id<"users">) => void;
}) {
  return (
    <View style={styles.list}>
      {roster.map((scholar) => {
        const selected = selectedIds.includes(scholar.id);
        return (
          <Pressable
            key={scholar.id}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: selected }}
            accessibilityLabel={scholar.name}
            onPress={() => onToggle(scholar.id)}
            style={[styles.row, selected && styles.rowSelected]}
          >
            <ScholarAvatar name={scholar.name} image={scholar.image} size={34} />
            <Text style={styles.name} numberOfLines={1}>
              {scholar.name}
            </Text>
            <View style={[styles.check, selected && styles.checkSelected]}>
              {selected && (
                <SymbolView name="checkmark" size={13} tintColor={palette.white} />
              )}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

function ScholarAvatar({
  name,
  image,
  size,
}: {
  name: string;
  image: string | null;
  size: number;
}) {
  const resolvedImage = resolveUserImageUri(image);
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
  if (resolvedImage) {
    return (
      <Image
        source={{ uri: resolvedImage }}
        style={{ width: size, height: size, borderRadius: size / 2 }}
        contentFit="cover"
        alt={`${name}'s profile photo`}
      />
    );
  }
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: palette.violet[500],
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text style={{ color: palette.white, fontFamily: fonts.bold, fontSize: size * 0.4 }}>
        {initials}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: 8 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 52,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.10)",
  },
  rowSelected: {
    backgroundColor: "rgba(169,96,188,0.26)",
    borderColor: palette.violet[400],
  },
  name: { flex: 1, color: palette.white, fontFamily: fonts.medium, fontSize: 16 },
  check: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: "rgba(255,255,255,0.4)",
    alignItems: "center",
    justifyContent: "center",
  },
  checkSelected: {
    backgroundColor: palette.violet[500],
    borderColor: palette.violet[500],
  },
});
