/**
 * VibecodeHistorySheet — the native twin of the web
 * `components/vibecode/VibecodeHistoryPanel.tsx` (TRA-301,
 * review/teacher-build-flow.html state C). Edit mode only.
 *
 * A right-anchored `Drawer` listing the session's code revisions newest first:
 * the render-check thumbnail, the request that produced the revision (or a
 * "Restored vN version" label), the version number, and the time. "Restore"
 * rolls a revision forward as a NEW revision — it never rewrites history — and
 * is owned by the SCREEN (same handler the inline `vN · Restore` markers use),
 * so the sheet stays a pure list.
 *
 * Revisions arrive as METADATA ONLY; the html is fetched on Restore. The parent
 * holds the query so the transcript can render the same version numbers inline.
 */

import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Image } from "expo-image";

import { Drawer } from "@/components/ui/Drawer";
import { fonts, useColors } from "@/theme";
import { formatClockTime } from "../../../vendor/shared/workshopMode";

export type HistoryRevision = {
  id: string;
  revision: number;
  version: number;
  createdAt: number;
  requestText: string | null;
  snapshotUrl: string | null;
  restoredFromRevision: number | null;
  messageId: string | null;
};

function RevisionThumb({ url }: { url: string | null }) {
  const colors = useColors();
  return (
    <View
      style={[
        styles.thumb,
        { borderColor: colors.border, backgroundColor: colors.gray200 },
      ]}
    >
      {url ? (
        <Image
          source={{ uri: url }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          alt="App revision thumbnail"
        />
      ) : null}
    </View>
  );
}

export function VibecodeHistorySheet({
  revisions,
  open,
  onClose,
  onRestore,
  restoring,
}: {
  /** `undefined` while the query is still loading. */
  revisions: HistoryRevision[] | undefined;
  open: boolean;
  onClose: () => void;
  onRestore: (revision: { id: string; version: number }) => void;
  restoring: boolean;
}) {
  const colors = useColors();

  return (
    <Drawer open={open} onClose={onClose} side="right" title="History">
      {revisions === undefined ? (
        <View style={styles.loading}>
          <ActivityIndicator size="small" color={colors.violet} />
        </View>
      ) : revisions.length === 0 ? (
        <Text style={[styles.empty, { color: colors.fgMuted }]}>
          No revisions yet — each designer turn is saved here.
        </Text>
      ) : (
        // The Drawer body does not scroll on its own; a session can hold up to
        // MAX_REVISIONS_PER_SESSION rows, so the list owns its scroller.
        <ScrollView contentContainerStyle={styles.list}>
          {revisions.map((rev, index) => {
            const label =
              rev.restoredFromRevision != null
                ? `Restored v${rev.restoredFromRevision} version`
                : (rev.requestText ?? "Revision");
            const isCurrent = index === 0;
            return (
              <View
                key={rev.id}
                style={[styles.row, { borderColor: colors.border }]}
              >
                <RevisionThumb url={rev.snapshotUrl} />
                <View style={styles.rowBody}>
                  <Text
                    style={[styles.rowLabel, { color: colors.fg }]}
                    numberOfLines={2}
                  >
                    {label}
                  </Text>
                  <Text style={[styles.rowMeta, { color: colors.fgMuted }]}>
                    {`v${rev.version} · ${formatClockTime(rev.createdAt)}${
                      isCurrent ? " · current" : ""
                    }`}
                  </Text>
                </View>
                {isCurrent ? null : (
                  <Pressable
                    onPress={() =>
                      onRestore({ id: rev.id, version: rev.version })
                    }
                    disabled={restoring}
                    accessibilityRole="button"
                    accessibilityLabel={`Restore v${rev.version}`}
                    style={[
                      styles.restore,
                      {
                        borderColor: colors.violet,
                        opacity: restoring ? 0.5 : 1,
                      },
                    ]}
                  >
                    <Text style={[styles.restoreText, { color: colors.violet }]}>
                      Restore
                    </Text>
                  </Pressable>
                )}
              </View>
            );
          })}
        </ScrollView>
      )}
    </Drawer>
  );
}

const styles = StyleSheet.create({
  loading: { paddingVertical: 24, alignItems: "center" },
  empty: { fontFamily: fonts.regular, fontSize: 14, paddingVertical: 12 },
  list: { paddingVertical: 12, gap: 10 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    padding: 10,
  },
  thumb: {
    width: 88,
    height: 56,
    flexShrink: 0,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  rowBody: { flex: 1, minWidth: 0, gap: 2 },
  rowLabel: { fontFamily: fonts.semibold, fontSize: 14 },
  rowMeta: { fontFamily: fonts.regular, fontSize: 12 },
  // 44pt minimum touch target — the sheet's one action must be reliably
  // tappable on every row.
  restore: {
    flexShrink: 0,
    minHeight: 44,
    justifyContent: "center",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  restoreText: { fontFamily: fonts.semibold, fontSize: 13 },
});
