import { useCallback, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { router } from "expo-router";
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SymbolView, type SymbolViewProps } from "expo-symbols";
import * as Haptics from "expo-haptics";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";

import { api } from "@/lib/convex";
import { resolveUserImageUri } from "@/lib/webEmbedConfig";
import { fonts, palette, useColors } from "@/theme";
import { useDeviceSignOutPrompt } from "@/hooks/useDeviceSignOut";
import { ScholarAvatar } from "@/components/ScholarAvatar";
import { usePresentationAsam } from "@/contexts/AsamControllerContext";

const ROLE_LABELS: Record<string, string> = {
  scholar: "Scholar",
  teacher: "Teacher",
  admin: "Admin",
  curriculum_designer: "Curriculum Designer",
  staff: "Staff",
  parent: "Parent",
};

/**
 * The top-right account control — the scholar's avatar opening a native-feeling
 * pull-down menu (Option A from the account-menu sketches). Replaces the old
 * generic person glyph that jumped straight to My Learning.
 *
 * Full parity with the web scholar AccountMenu (components/AccountMenu.tsx):
 * identity header (avatar + name + @username), My Learning, The Workshop,
 * Account Details, Sign Out. Teacher/admin-only items (Admin Tools, remote
 * "Viewing as", pulse orb) are intentionally absent — this is the scholar app.
 *
 * "Teacher unlock" is a deliberate native-only exception to that parity: it
 * opens the SAME Rabbithole Lock modal the hidden 4-finger-hold gesture opens
 * (AsamParentGate, via AsamControllerContext) rather than being a new
 * surface, and only renders when that gate is actually mounted
 * (ASAM_HYBRID_ENABLED). There is no web counterpart because ASAM is
 * native-only by design — the web app never runs in Single App Mode.
 */
export function AccountMenuButton() {
  const me = useQuery(api.users.currentUser, {});
  const memberships = useQuery(api.memberships.myMemberships, {});
  const promptSignOut = useDeviceSignOutPrompt();
  const { openTeacherUnlock, isTeacherUnlockAvailable } = usePresentationAsam();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);

  const anim = useSharedValue(0);
  const show = useCallback(() => {
    Haptics.selectionAsync();
    setOpen(true);
    anim.set(withSpring(1, { damping: 18, stiffness: 320, mass: 0.7 }));
  }, [anim]);
  const hide = useCallback(
    (then?: () => void) => {
      anim.set(withTiming(0, { duration: 130, easing: Easing.in(Easing.cubic) }));
      setTimeout(() => {
        setOpen(false);
        then?.();
      }, 125);
    },
    [anim],
  );

  const cardStyle = useAnimatedStyle(() => ({
    opacity: anim.get(),
    transform: [
      { scale: 0.92 + anim.get() * 0.08 },
      { translateY: (1 - anim.get()) * -8 },
    ],
  }));

  const go = (path: string) => hide(() => router.push(path as never));
  const onSignOut = () =>
    hide(() => {
      promptSignOut();
    });

  const name = me?.name ?? "You";
  const username = me?.username ?? null;
  const image = resolveUserImageUri(me?.image);
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const learnerContext = memberships?.find(
    (membership) =>
      membership.role === "scholar" &&
      membership.institutionKind === "community",
  );
  const roleLabel = learnerContext
    ? `Learner · ${learnerContext.institutionName}`
    : me?.role
      ? (ROLE_LABELS[me.role] ?? me.role)
      : null;

  return (
    <>
      <Pressable
        onPress={show}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel="Account menu"
      >
        <ScholarAvatar name={name} image={image} size={30} />
      </Pressable>

      <Modal visible={open} transparent animationType="none" onRequestClose={() => hide()}>
        <Pressable style={styles.backdrop} onPress={() => hide()}>
          {/* caret pointing up at the avatar */}
          <Animated.View
            style={[styles.caret, { top: insets.top + 40, right: 22 }, cardStyle]}
            pointerEvents="none"
          />
          <Animated.View
            style={[styles.card, { top: insets.top + 46, right: 10 }, cardStyle]}
          >
            <Pressable onPress={() => {}}>
              {/* identity header */}
              <View style={styles.header}>
                <ScholarAvatar name={name} image={image} size={36} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.headerName} numberOfLines={1}>
                    {name}
                  </Text>
                  {username && (
                    <Text style={styles.headerUser} numberOfLines={1}>
                      @{username}
                    </Text>
                  )}
                  {roleLabel && (
                    <View style={styles.roleChip}>
                      <Text style={styles.roleChipText}>{roleLabel}</Text>
                    </View>
                  )}
                </View>
              </View>

              <Item icon="graduationcap.fill" label="My Learning" onPress={() => go("/me")} colors={colors} styles={styles} />
              <Item icon="wrench.and.screwdriver.fill" label="The Workshop" onPress={() => go("/workshop")} colors={colors} styles={styles} />
              <Item icon="person.crop.circle" label="Account details" onPress={() => go("/account")} colors={colors} styles={styles} />
              {isTeacherUnlockAvailable && (
                <Item
                  icon="lock.shield"
                  label="Teacher unlock"
                  onPress={() => hide(() => openTeacherUnlock())}
                  colors={colors}
                  styles={styles}
                />
              )}
              <Item
                icon="rectangle.portrait.and.arrow.right"
                label="Sign out"
                danger
                last
                onPress={onSignOut}
                colors={colors}
                styles={styles}
              />
            </Pressable>
          </Animated.View>
        </Pressable>
      </Modal>
    </>
  );
}

function Item({
  icon,
  label,
  onPress,
  danger = false,
  last = false,
  colors,
  styles,
}: {
  icon: SymbolViewProps["name"];
  label: string;
  onPress: () => void;
  danger?: boolean;
  last?: boolean;
  colors: ReturnType<typeof useColors>;
  styles: ReturnType<typeof makeStyles>;
}) {
  const tint = danger ? colors.statusRed : colors.charcoal;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.item,
        !last && styles.itemBorder,
        pressed && { backgroundColor: colors.gray100 },
      ]}
    >
      <SymbolView name={icon} size={19} tintColor={danger ? colors.statusRed : colors.charcoalMuted} />
      <Text style={[styles.itemLabel, { color: tint }]}>{label}</Text>
    </Pressable>
  );
}

function makeStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
  backdrop: { flex: 1 },
  card: {
    position: "absolute",
    width: 252,
    backgroundColor: c.bg === "#ffffff" ? "rgba(252,252,253,0.98)" : "rgba(35,43,55,0.98)",
    borderRadius: 15,
    overflow: "hidden",
    shadowColor: palette.navy[900] ?? "#000",
    shadowOpacity: 0.22,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 10 },
    borderWidth: 0.5,
    borderColor: c.border,
  },
  caret: {
    position: "absolute",
    width: 14,
    height: 14,
    backgroundColor: c.bg === "#ffffff" ? "rgba(252,252,253,0.98)" : "rgba(35,43,55,0.98)",
    transform: [{ rotate: "45deg" }],
    borderLeftWidth: 0.5,
    borderTopWidth: 0.5,
    borderColor: c.border,
  },
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    paddingHorizontal: 14,
    paddingTop: 14,
    paddingBottom: 12,
    borderBottomWidth: 0.5,
    borderBottomColor: c.gray100,
  },
  headerName: { fontSize: 14, fontFamily: fonts.bold, color: c.navy },
  headerUser: { fontSize: 12, fontFamily: fonts.regular, color: c.charcoalSubtle, marginTop: 1 },
  roleChip: {
    alignSelf: "flex-start",
    marginTop: 5,
    backgroundColor: c.violetSubtle,
    borderRadius: 20,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  roleChipText: {
    fontSize: 10.5,
    fontFamily: fonts.semibold,
    color: c.violet,
    letterSpacing: 0.2,
  },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  itemBorder: { borderBottomWidth: 0.5, borderBottomColor: c.gray100 },
  itemLabel: { fontSize: 15, fontFamily: fonts.medium },
  });
}
