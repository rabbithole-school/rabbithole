import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Image } from "expo-image";
import { router, Stack } from "expo-router";
import { SymbolView } from "expo-symbols";
import * as Haptics from "expo-haptics";

import { api } from "@/lib/convex";
import { leaveAccount } from "@/lib/accountNavigation";
import { resolveUserImageUri } from "@/lib/webEmbedConfig";
import { fonts, palette, useColors } from "@/theme";
import { AppTextInput } from "@/components/AppTextInput";
import { useDeviceSignOutPrompt } from "@/hooks/useDeviceSignOut";

// Account Details — the scholar's self-service account screen. Parity with the
// web ProfileEditModal: identity, email (turns on magic-link sign-in; their
// username + password keep working), and the reading font (dyslexia-friendly
// options). Sign Out lives here too.

const FONTS: { value: string | null; label: string }[] = [
  { value: null, label: "System default" },
  { value: "andika", label: "Andika" },
  { value: "opendyslexic", label: "OpenDyslexic" },
];

const ROLE_LABELS: Record<string, string> = {
  scholar: "Scholar",
  teacher: "Teacher",
  admin: "Admin",
  curriculum_designer: "Curriculum Designer",
  staff: "Staff",
  parent: "Parent",
};

export default function AccountScreen() {
  const me = useQuery(api.users.currentUser, {});
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const setMyEmail = useMutation(api.users.setMyEmail);
  const updatePreferredFont = useMutation(api.users.updatePreferredFont);
  const promptSignOut = useDeviceSignOutPrompt();

  const sourceEmail = me?.email;
  const [email, setEmail] = useState(() => sourceEmail ?? "");
  const [syncedEmail, setSyncedEmail] = useState(sourceEmail);
  const [emailSaved, setEmailSaved] = useState(false);
  const [savingEmail, setSavingEmail] = useState(false);

  const header = (
    <Stack.Screen
      options={{
        headerLeft: () => (
          <Pressable
            onPress={() => leaveAccount(router)}
            accessibilityRole="button"
            accessibilityLabel="Back"
            hitSlop={12}
            style={({ pressed }) => [styles.backButton, pressed && { opacity: 0.6 }]}
          >
            <SymbolView name="chevron.left" size={18} tintColor={colors.violet} />
          </Pressable>
        ),
      }}
    />
  );

  if (syncedEmail !== sourceEmail) {
    setSyncedEmail(sourceEmail);
    if (sourceEmail) setEmail(sourceEmail);
  }

  if (me === undefined) {
    return (
      <>
        {header}
        <View style={styles.center}>
          <ActivityIndicator color={colors.violet} size="large" />
        </View>
      </>
    );
  }

  const name = me?.name ?? "You";
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");

  const roleLabel = me?.role ? (ROLE_LABELS[me.role] ?? me.role) : "Scholar";
  const avatarUri = resolveUserImageUri(me?.image);

  const saveEmail = async () => {
    const v = email.trim();
    if (!v || savingEmail) return;
    setSavingEmail(true);
    try {
      await setMyEmail({ email: v });
      setEmailSaved(true);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setTimeout(() => setEmailSaved(false), 2000);
    } catch (e) {
      console.warn("[account] setEmail failed", e);
    } finally {
      setSavingEmail(false);
    }
  };

  const pickFont = (value: string | null) => {
    Haptics.selectionAsync();
    updatePreferredFont({ preferredFont: value });
  };

  const handleSignOut = () => {
    Haptics.selectionAsync();
    promptSignOut();
  };

  return (
    <>
      {header}
      <ScrollView style={styles.flex} contentContainerStyle={styles.content}>
      {/* Profile hero */}
      <View style={styles.profileCard}>
        {avatarUri ? (
          <Image
            source={{ uri: avatarUri }}
            style={styles.bigAvatar}
            contentFit="cover"
            alt="Your profile photo"
          />
        ) : (
          <View style={[styles.bigAvatar, styles.bigAvatarFallback]}>
            <Text style={styles.bigAvatarText}>{initials}</Text>
          </View>
        )}
        <Text style={styles.name}>{name}</Text>
        {me?.username && <Text style={styles.username}>@{me.username}</Text>}
        <View style={styles.roleChip}>
          <Text style={styles.roleChipText}>{roleLabel}</Text>
        </View>
      </View>

      {/* email → magic link */}
      <Text style={styles.sectionLabel}>EMAIL</Text>
      <View style={styles.card}>
        <View style={styles.emailRow}>
          <AppTextInput
            style={styles.input}
            value={email}
            onChangeText={(t) => {
              setEmail(t);
              setEmailSaved(false);
            }}
            placeholder="name@example.com"
            placeholderTextColor={colors.charcoalSubtle}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Pressable
            onPress={saveEmail}
            disabled={savingEmail || !email.trim()}
            style={styles.saveBtn}
          >
            {savingEmail ? (
              <ActivityIndicator color={colors.violet} size="small" />
            ) : emailSaved ? (
              <SymbolView name="checkmark.circle.fill" size={24} tintColor={colors.green} />
            ) : (
              <Text style={styles.saveText}>Save</Text>
            )}
          </Pressable>
        </View>
        <Text style={styles.hint}>
          Set an email to sign in with a one-time link instead of your password.
        </Text>
      </View>

      {/* reading font */}
      <Text style={styles.sectionLabel}>READING FONT</Text>
      <View style={styles.card}>
        {FONTS.map((f, i) => {
          const active = (me?.preferredFont ?? null) === f.value;
          return (
            <Pressable
              key={f.label}
              onPress={() => pickFont(f.value)}
              style={[styles.fontRow, i < FONTS.length - 1 && styles.fontRowBorder]}
            >
              <Text style={styles.fontLabel}>{f.label}</Text>
              {active && (
                <SymbolView name="checkmark" size={18} tintColor={colors.violet} />
              )}
            </Pressable>
          );
        })}
      </View>

      {/* appearance — placeholder (theming owned by a separate workstream) */}
      <Text style={styles.sectionLabel}>APPEARANCE</Text>
      <View style={styles.card}>
        <View style={[styles.fontRow, styles.disabledRow]}>
          <View style={styles.appearanceLabel}>
            <SymbolView name="circle.lefthalf.filled" size={18} tintColor={colors.charcoalSubtle} />
            <Text style={[styles.fontLabel, styles.disabledText]}>Theme</Text>
          </View>
          <Text style={styles.appearanceValue}>System</Text>
        </View>
      </View>

      {/* sign out */}
      <Pressable
        onPress={handleSignOut}
        style={({ pressed }) => [styles.signOut, pressed && { opacity: 0.75 }]}
      >
        <SymbolView
          name="rectangle.portrait.and.arrow.right"
          size={19}
          tintColor={colors.statusRed}
        />
        <Text style={styles.signOutText}>Sign out</Text>
      </Pressable>
      </ScrollView>
    </>
  );
}

function makeStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
  flex: { flex: 1, backgroundColor: c.bgSubtle },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: c.bgSubtle },
  backButton: {
    minWidth: 36,
    minHeight: 36,
    alignItems: "flex-start",
    justifyContent: "center",
  },
  content: {
    width: "100%",
    maxWidth: 600,
    alignSelf: "center",
    padding: 24,
    paddingBottom: 48,
  },
  // Profile hero card
  profileCard: {
    backgroundColor: c.bg,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: c.border,
    alignItems: "center",
    paddingVertical: 28,
    paddingHorizontal: 20,
    marginBottom: 4,
    gap: 6,
  },
  bigAvatar: { width: 80, height: 80, borderRadius: 40, marginBottom: 4 },
  bigAvatarFallback: {
    backgroundColor: palette.violet[500],
    alignItems: "center",
    justifyContent: "center",
  },
  bigAvatarText: { color: c.white, fontFamily: fonts.bold, fontSize: 30 },
  name: { fontSize: 22, fontFamily: fonts.bold, color: c.navy, textAlign: "center" },
  username: {
    fontSize: 14,
    fontFamily: fonts.regular,
    color: c.charcoalSubtle,
  },
  roleChip: {
    marginTop: 4,
    backgroundColor: c.violetSubtle,
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  roleChipText: {
    fontSize: 12,
    fontFamily: fonts.semibold,
    color: c.violet,
    letterSpacing: 0.3,
  },
  sectionLabel: {
    fontSize: 12,
    letterSpacing: 1,
    fontFamily: fonts.bold,
    color: c.charcoalSubtle,
    marginTop: 26,
    marginBottom: 9,
    marginLeft: 4,
  },
  card: {
    backgroundColor: c.bg,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: c.border,
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  emailRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8 },
  input: {
    flex: 1,
    fontSize: 17,
    fontFamily: fonts.regular,
    color: c.charcoal,
    paddingVertical: 6,
  },
  saveBtn: { minWidth: 52, alignItems: "center", justifyContent: "center", paddingVertical: 6 },
  saveText: { fontSize: 16, fontFamily: fonts.semibold, color: c.violet },
  hint: {
    fontSize: 13,
    lineHeight: 18,
    fontFamily: fonts.regular,
    color: c.charcoalSubtle,
    paddingBottom: 10,
  },
  fontRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 14,
  },
  fontRowBorder: { borderBottomWidth: 1, borderBottomColor: c.gray100 },
  fontLabel: { fontSize: 16, fontFamily: fonts.regular, color: c.charcoal },
  disabledRow: { opacity: 0.45 },
  disabledText: { color: c.charcoalSubtle },
  appearanceLabel: { flexDirection: "row", alignItems: "center", gap: 10 },
  appearanceValue: {
    fontSize: 15,
    fontFamily: fonts.regular,
    color: c.charcoalSubtle,
  },
  signOut: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 9,
    marginTop: 34,
    paddingVertical: 16,
    backgroundColor: c.bg,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: c.border,
  },
  signOutText: { fontSize: 16, fontFamily: fonts.semibold, color: c.statusRed },
  });
}
