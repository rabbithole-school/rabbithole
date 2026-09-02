/**
 * ForecastRow (native) — the API-matched twin of `components/ui/ForecastRow.tsx`.
 *
 * The row shape shared by everything a scholar can SEE but not yet DO: a
 * planned entry on today's Now tab, and every row in Coming up. Those were two
 * hand-rolled copies of one object on each frontend — four in total — drifting
 * apart in the small ways duplicated components always do.
 *
 * One row, one anatomy: glyph · (title + attribution) · status. No CTA and no
 * press target: a forecast row is non-actionable by construction, and that is
 * enforced by the server's live/planned `setAt` boundary, not by a caller
 * remembering to leave the CTA off.
 *
 * The ghost treatment — dashed border, tinted background — belongs to the
 * WRAPPER, not the row.
 */

import { type ReactNode, useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { type Colors, fonts, useColors } from "@/theme";

export function ForecastRow({
  glyph,
  title,
  meta,
  status,
}: {
  /** Identity glyph. Present only when the row is NOT under a unit band, and
   *  never a fallback — a generic emoji identifies nothing. */
  glyph?: string | null;
  title: string;
  /** "what this is and whose it is" — unit · with teacher. */
  meta?: string | null;
  /** The status slot: a DueChip, a StatusChip, or nothing. A node, not an
   *  enum. */
  status?: ReactNode;
}) {
  const c = useColors();
  const styles = useMemo(() => makeStyles(c), [c]);
  return (
    <View style={styles.row}>
      <View style={styles.main}>
        {glyph ? <Text style={styles.glyph}>{glyph}</Text> : null}
        <View style={styles.stack}>
          <Text style={styles.title} numberOfLines={2}>
            {title}
          </Text>
          {meta ? (
            <Text style={styles.meta} numberOfLines={1}>
              {meta}
            </Text>
          ) : null}
        </View>
      </View>
      {status ? <View style={styles.status}>{status}</View> : null}
    </View>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    row: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "flex-start",
      gap: 12,
    },
    main: {
      flex: 1,
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 8,
    },
    glyph: { fontSize: 16, lineHeight: 22, flexShrink: 0 },
    stack: { flex: 1, gap: 2 },
    title: { fontFamily: fonts.medium, fontSize: 15, color: c.charcoal },
    meta: { fontFamily: fonts.medium, fontSize: 12, color: c.charcoalMuted },
    status: { flexShrink: 0, marginTop: 2 },
  });
}
