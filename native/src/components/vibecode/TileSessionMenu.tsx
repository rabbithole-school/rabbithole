/**
 * The Workshop title for a tile session (convex/lib/tileSessions.ts): a
 * pull-down over the scholar's sessions of the same app, newest first, with
 * ＋ New, Rename… and Archived (n). It follows Home's title pull-down
 * (SessionsSwitcher.tsx) and the archive on Home's rows. Tile sessions
 * never sit on Home, so this menu is the one place to archive one.
 *
 * Web twin: components/vibecode/TileSessionSwitcher.tsx.
 */
import { useCallback, useMemo, useState } from "react";
import {
  ActionSheetIOS,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useMutation, useQuery } from "convex/react";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SymbolView } from "expo-symbols";
import * as Haptics from "expo-haptics";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";

import { Modal } from "@/components/FreezableModal";
import { api, type Id } from "@/lib/convex";
import { fonts, useColors } from "@/theme";
import { HOME_ARCHIVE_COPY } from "../../../vendor/shared/homeArchive";
import { serverErrorMessage } from "../../../vendor/shared/serverErrorMessage";

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** When a session was last opened, in the web switcher's words
 *  (lib/relativeTime.ts formatRelative). */
export function lastOpenedLabel(ts: number, now = Date.now()): string {
  const date = new Date(ts);
  const today = new Date(now);
  const mins = Math.floor((now - ts) / 60_000);
  if (mins < 1) return "just now";
  const startOfToday = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  ).getTime();
  if (ts >= startOfToday) {
    if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
    const hours = Math.floor(mins / 60);
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  const dayMs = 86_400_000;
  const days = Math.ceil((startOfToday - ts) / dayMs);
  if (days <= 1) return "Yesterday";
  if (days <= 6) return `${days} days ago`;
  const label = `${MONTHS[date.getMonth()]} ${date.getDate()}`;
  return date.getFullYear() === today.getFullYear()
    ? label
    : `${label}, ${date.getFullYear()}`;
}

type TileSessions = NonNullable<
  ReturnType<typeof useQuery<typeof api.vibecode.tileSessionsForSelf>>
>;

/** The switcher's read; null for anyone it does not apply to (a teacher
 *  reading the session, an app that opens no session). */
export function useTileSessions(
  externalAppId: Id<"externalApps"> | null | undefined,
): TileSessions | null | undefined {
  return useQuery(
    api.vibecode.tileSessionsForSelf,
    externalAppId ? { externalAppId } : "skip",
  );
}

export function TileSessionMenu({
  sessionId,
  externalAppId,
  title,
  sessions,
  onOpenSession,
  onHome,
}: {
  sessionId: Id<"sessions">;
  externalAppId: Id<"externalApps">;
  title: string;
  sessions: TileSessions;
  onOpenSession: (sessionId: Id<"sessions">) => void;
  onHome: () => void;
}) {
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"active" | "archived">("active");
  const [creating, setCreating] = useState(false);
  const anim = useSharedValue(0);

  const newSession = useMutation(api.vibecode.newTileSessionForSelf);
  const update = useMutation(api.sessions.update);
  const archive = useMutation(api.sessions.archive);
  const unarchive = useMutation(api.sessions.unarchive);

  const show = useCallback(() => {
    Haptics.selectionAsync();
    setView("active");
    setOpen(true);
    anim.set(withSpring(1, { damping: 18, stiffness: 320, mass: 0.7 }));
  }, [anim]);
  const hide = useCallback(
    (then?: () => void) => {
      anim.set(withTiming(0, { duration: 120, easing: Easing.in(Easing.cubic) }));
      setTimeout(() => {
        setOpen(false);
        then?.();
      }, 115);
    },
    [anim],
  );
  const menuStyle = useAnimatedStyle(() => ({
    opacity: anim.get(),
    transform: [
      { scale: 0.93 + anim.get() * 0.07 },
      { translateY: (1 - anim.get()) * -8 },
    ],
  }));

  const fail = (fallback: string) => (err: unknown) => {
    console.warn("[tile-session-menu]", fallback, err);
    Alert.alert(serverErrorMessage(err, fallback));
  };

  const createNew = () => {
    if (creating) return;
    setCreating(true);
    hide(() => {
      newSession({ externalAppId })
        .then((res) => onOpenSession(res.sessionId))
        .catch(fail("Couldn't start a new one. Try again."))
        .finally(() => setCreating(false));
    });
  };

  const archiveRow = (id: Id<"sessions">) => {
    archive({ id })
      .then(() => {
        if (id !== sessionId) return;
        // The open session went away: go to the next active one, or Home.
        const next = sessions.active.find((row) => row.sessionId !== id);
        hide(() => (next ? onOpenSession(next.sessionId) : onHome()));
      })
      .catch(fail(HOME_ARCHIVE_COPY.archiveFailed));
  };

  const confirmArchive = (row: { sessionId: Id<"sessions">; title: string }) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: row.title,
        options: ["Cancel", HOME_ARCHIVE_COPY.archiveAction],
        cancelButtonIndex: 0,
      },
      (i) => {
        if (i === 1) archiveRow(row.sessionId);
      },
    );
  };

  const rename = () => {
    hide(() => {
      Alert.prompt(
        "Rename session",
        undefined,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Save",
            onPress: (value?: string) => {
              const next = value?.trim();
              if (!next || next === title) return;
              update({ id: sessionId, title: next }).catch(
                fail("Couldn't rename it. Try again."),
              );
            },
          },
        ],
        "plain-text",
        title,
      );
    });
  };

  const menuPos = { top: insets.top + 44, alignSelf: "center" as const };
  // Unarchiving the last archived session empties that list: show the
  // sessions again instead of a bare "Archived" header.
  const shownView =
    view === "archived" && sessions.archived.length === 0 ? "active" : view;

  return (
    <>
      <Pressable
        onPress={show}
        hitSlop={8}
        style={styles.trigger}
        accessibilityRole="button"
        accessibilityLabel={`Switch session: ${title}`}
      >
        <Text style={styles.triggerTitle} numberOfLines={1}>
          {title}
        </Text>
        <SymbolView name="chevron.down" size={12} tintColor={colors.fg} />
      </Pressable>

      <Modal
        visible={open}
        transparent
        animationType="none"
        supportedOrientations={["landscape", "landscape-left", "landscape-right"]}
        onRequestClose={() => hide()}
      >
        <Pressable style={styles.backdrop} onPress={() => hide()}>
          <Animated.View style={[styles.menu, menuPos, menuStyle]}>
            <Pressable onPress={() => {}}>
              {shownView === "active" ? (
                <>
                  <ScrollView style={styles.list} bounces={false}>
                    {sessions.active.map((row) => {
                      const current = row.sessionId === sessionId;
                      return (
                        <Pressable
                          key={row.sessionId}
                          onPress={() =>
                            hide(() => {
                              if (!current) onOpenSession(row.sessionId);
                            })
                          }
                          onLongPress={() => confirmArchive(row)}
                          accessibilityRole="button"
                          accessibilityLabel={row.title}
                          accessibilityState={{ selected: current }}
                          accessibilityActions={[
                            {
                              name: "archive",
                              label: HOME_ARCHIVE_COPY.archiveAction,
                            },
                          ]}
                          onAccessibilityAction={(e) => {
                            if (e.nativeEvent.actionName === "archive") {
                              archiveRow(row.sessionId);
                            }
                          }}
                          style={({ pressed }) => [
                            styles.row,
                            styles.rowBorder,
                            pressed && { backgroundColor: colors.gray100 },
                          ]}
                        >
                          <View style={styles.check}>
                            {current && (
                              <SymbolView
                                name="checkmark"
                                size={15}
                                tintColor={colors.violet}
                              />
                            )}
                          </View>
                          <Text
                            style={[styles.rowLabel, current && styles.rowLabelOn]}
                            numberOfLines={1}
                          >
                            {row.title}
                          </Text>
                          <Text style={styles.rowMeta}>
                            {lastOpenedLabel(row.lastOpenedAt)}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </ScrollView>
                  <MenuAction
                    styles={styles}
                    colors={colors}
                    icon="plus"
                    label="New"
                    disabled={creating}
                    onPress={createNew}
                  />
                  <MenuAction
                    styles={styles}
                    colors={colors}
                    icon="pencil"
                    label="Rename…"
                    onPress={rename}
                  />
                  {sessions.archived.length > 0 && (
                    <MenuAction
                      styles={styles}
                      colors={colors}
                      icon="archivebox"
                      label={`Archived (${sessions.archived.length})`}
                      trailing="chevron.right"
                      onPress={() => {
                        Haptics.selectionAsync();
                        setView("archived");
                      }}
                    />
                  )}
                </>
              ) : (
                <>
                  <MenuAction
                    styles={styles}
                    colors={colors}
                    icon="chevron.left"
                    label="Archived"
                    onPress={() => setView("active")}
                  />
                  <ScrollView style={styles.list} bounces={false}>
                    {sessions.archived.map((row) => (
                      <View key={row.sessionId} style={[styles.row, styles.rowTop]}>
                        <View style={styles.check} />
                        <Text style={styles.rowLabel} numberOfLines={1}>
                          {row.title}
                        </Text>
                        <Pressable
                          onPress={() => {
                            Haptics.selectionAsync();
                            unarchive({ id: row.sessionId }).catch(
                              fail("Couldn't unarchive it. Try again."),
                            );
                          }}
                          hitSlop={8}
                          accessibilityRole="button"
                          accessibilityLabel={`Unarchive ${row.title}`}
                        >
                          <Text style={styles.unarchive}>Unarchive</Text>
                        </Pressable>
                      </View>
                    ))}
                  </ScrollView>
                </>
              )}
            </Pressable>
          </Animated.View>
        </Pressable>
      </Modal>
    </>
  );
}

function MenuAction({
  styles,
  colors,
  icon,
  label,
  trailing,
  disabled,
  onPress,
}: {
  styles: ReturnType<typeof makeStyles>;
  colors: ReturnType<typeof useColors>;
  icon: string;
  label: string;
  trailing?: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.row,
        styles.rowTop,
        pressed && { backgroundColor: colors.gray100 },
        disabled && { opacity: 0.5 },
      ]}
    >
      <View style={styles.check}>
        <SymbolView
          name={icon as never}
          size={15}
          tintColor={colors.violet}
        />
      </View>
      <Text style={styles.rowLabel}>{label}</Text>
      {trailing ? (
        <SymbolView
          name={trailing as never}
          size={12}
          tintColor={colors.charcoalSubtle}
        />
      ) : null}
    </Pressable>
  );
}

function makeStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    trigger: { flexDirection: "row", alignItems: "center", gap: 5, maxWidth: 280 },
    triggerTitle: { fontFamily: fonts.semibold, fontSize: 16, color: c.fg, flexShrink: 1 },
    backdrop: { flex: 1 },
    menu: {
      position: "absolute",
      width: 320,
      backgroundColor:
        c.bg === "#ffffff" ? "rgba(252,252,253,0.98)" : "rgba(35,43,55,0.98)",
      borderRadius: 15,
      overflow: "hidden",
      shadowColor: "#000",
      shadowOpacity: 0.22,
      shadowRadius: 24,
      shadowOffset: { width: 0, height: 10 },
      borderWidth: 0.5,
      borderColor: c.border,
    },
    list: { maxHeight: 330 },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingHorizontal: 14,
      paddingVertical: 13,
    },
    rowBorder: { borderBottomWidth: 0.5, borderBottomColor: c.gray100 },
    rowTop: { borderTopWidth: 0.5, borderTopColor: c.gray100 },
    check: { width: 18, alignItems: "center" },
    rowLabel: { flex: 1, fontSize: 15, fontFamily: fonts.medium, color: c.charcoal },
    rowLabelOn: { fontFamily: fonts.semibold, color: c.navy },
    rowMeta: { fontSize: 13, fontFamily: fonts.medium, color: c.charcoalSubtle },
    unarchive: { fontSize: 14, fontFamily: fonts.semibold, color: c.violet },
  });
}
