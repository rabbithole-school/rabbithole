import { useMemo } from "react";
import { Stack, useRouter } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SymbolView } from "expo-symbols";

import { fonts, useColors } from "@/theme";
import { TEACHER_ARCHIVE_COPY } from "../../vendor/shared/teacherArchive";

/**
 * The calm full-screen state a scholar sees when a session's app was put away
 * by a teacher (review/teacher-archive-scholar-apps.html). It replaces the
 * whole session surface — chat, builder, app WebView, Present controls, chip
 * strip — because the scholar gets NO read-only view; only a teacher can bring
 * it back. Same copy as the web (shared/teacherArchive.ts).
 */
export function TeacherArchivedSession({ title }: { title: string }) {
  const router = useRouter();
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const goHome = () => {
    if (router.canDismiss()) router.dismissAll();
    else router.replace("/");
  };
  return (
    <>
      {/* Screen options MERGE: when an archive lands on an open builder, its
          Edit/Play, History, Present and Chat header controls would stay up
          unless every slot it set is reset here. */}
      <Stack.Screen
        options={{
          title,
          headerShown: true,
          headerTitle: title,
          headerLeft: undefined,
          headerRight: () => null,
        }}
      />
      <View style={styles.root}>
        <View style={styles.card}>
          <SymbolView name="archivebox" size={40} tintColor={colors.gray300} />
          <Text style={styles.title} numberOfLines={2}>
            {title}
          </Text>
          <Text style={styles.label}>{TEACHER_ARCHIVE_COPY.scholarLabel}</Text>
          <Text style={styles.explain}>{TEACHER_ARCHIVE_COPY.scholarExplain}</Text>
          <Pressable
            accessibilityRole="button"
            onPress={goHome}
            style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
          >
            <Text style={styles.buttonText}>{TEACHER_ARCHIVE_COPY.backHome}</Text>
          </Pressable>
        </View>
      </View>
    </>
  );
}

function makeStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: c.bg,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 32,
    },
    card: {
      width: "100%",
      maxWidth: 480,
      alignItems: "center",
      gap: 12,
    },
    title: {
      fontSize: 22,
      fontFamily: fonts.semibold,
      color: c.navy,
      textAlign: "center",
      marginTop: 4,
    },
    label: {
      fontSize: 14,
      fontFamily: fonts.semibold,
      color: c.charcoalSubtle,
      textAlign: "center",
    },
    explain: {
      fontSize: 16,
      lineHeight: 23,
      fontFamily: fonts.regular,
      color: c.fgMuted,
      textAlign: "center",
    },
    button: {
      marginTop: 12,
      backgroundColor: c.violet,
      borderRadius: 999,
      paddingVertical: 12,
      paddingHorizontal: 24,
    },
    buttonPressed: { opacity: 0.85 },
    buttonText: { color: c.white, fontSize: 16, fontFamily: fonts.semibold },
  });
}
