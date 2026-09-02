import { useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { StatusBar } from "expo-status-bar";
import { useAuthActions } from "@convex-dev/auth/react";

import { fonts, palette, status } from "@/theme";
import {
  MIN_PASSWORD_LENGTH,
  normalizePassword,
  passwordAuthParams,
} from "../../vendor/shared/password";
import { AppTextInput } from "@/components/AppTextInput";

// Real username + password sign-in for the native iPad app — the scholar's
// entry point against production (the dev-only `devLogin` provider is inert on
// prod, so a real screen is required).
//
// Mirrors the web scholar sign-in (components/AuthForm.tsx) on both copy and the
// auth contract: the Convex Auth `password` provider needs an email, so we build
// a SYNTHETIC one (`${username}@local`), try `flow: "signIn"`, and fall back to
// `flow: "signUp"` only when the account doesn't exist yet (the seeded-user
// first-login case). Colors come from the raw brand palette (not useColors())
// so the white card renders identically in light and dark, matching the web
// dark-shell sign-in.
//
// TODO(native-auth): passkey + magic-link sign-in are a follow-up (they need
// native WebAuthn + deep-link handling); username + password is the correct
// scholar parity for launch.

const DEV_SCHOLAR = process.env.EXPO_PUBLIC_DEV_SCHOLAR ?? "test-scholar-001";
const DEV_LOGIN_SECRET = process.env.EXPO_PUBLIC_DEV_LOGIN_SECRET ?? "";
// Dev-only convenience, NEVER present in a production build (__DEV__ is false in
// release) and only when a dev-login secret is configured.
export const DEV_LOGIN_AVAILABLE = __DEV__ && DEV_LOGIN_SECRET.length > 0;

export function SignIn({ notice }: { notice?: string }) {
  const { signIn } = useAuthActions();
  const passwordRef = useRef<TextInput>(null);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [focused, setFocused] = useState<"username" | "password" | null>(null);

  const handleSubmit = async () => {
    const trimmed = username.trim();
    const normalizedPassword = normalizePassword(password);
    if (!trimmed || !normalizedPassword) return;
    setIsSubmitting(true);
    setError("");

    if (normalizedPassword.length < MIN_PASSWORD_LENGTH) {
      setError(
        `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      );
      setIsSubmitting(false);
      return;
    }
    if (trimmed.includes("@")) {
      setError("Pick a username, not an email address");
      setIsSubmitting(false);
      return;
    }

    // The password provider requires an email — use a synthetic one internally.
    const email = `${trimmed}@local`;

    try {
      // Sign-in ONLY — never `flow: "signUp"`. A scholar username is public
      // (roster, one-pagers), so a sign-up fallback let anyone who knew one bind
      // their own password to a real child's account (the username coupon,
      // TODO #scholar-self-claim). The server refuses it now as well. An account
      // with no credential is set up by a teacher's one-time link.
      await signIn("password", {
        email,
        ...passwordAuthParams(password, "signIn"),
      });
      // On success the auth gate (app/_layout.tsx) re-renders the app once
      // useConvexAuth() flips to authenticated — keep the button in its loading
      // state through that transition (no explicit navigation here).
    } catch (err) {
      const raw = err instanceof Error ? err.message : "";
      if (/passkey/i.test(raw)) {
        setError("This account uses a passkey. Sign in on the web for now.");
      } else {
        setError("Invalid username or password");
      }
      setIsSubmitting(false);
    }
  };

  const devLogin = () => {
    setError("");
    signIn("devLogin", { username: DEV_SCHOLAR, secret: DEV_LOGIN_SECRET }).catch(
      (e) => {
        console.warn("[devLogin] failed", e);
        setError("Dev login failed");
      },
    );
  };

  const canSubmit = username.trim().length > 0 && password.length > 0 && !isSubmitting;

  return (
    <LinearGradient
      // Matches the web sign-in gradient (135°: navy → navy-hover → charcoal).
      colors={[palette.navy[500], palette.navy[700], palette.charcoal[500]]}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={styles.fill}
    >
      <StatusBar style="light" />
      <KeyboardAvoidingView
        style={styles.fill}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
        >
          <View style={styles.card}>
            {/* Two SIBLING Text nodes, not nested — nested/inline Text on iOS
                flattens into one NSAttributedString run with no separate
                native view, so a `transform` on an inner Text is silently
                ignored there (confirmed on device: the rabbit didn't flip). */}
            <View style={styles.mark} accessibilityLabel="Rabbithole">
              <Text style={[styles.markGlyph, styles.rabbit]}>🐇</Text>
              <Text style={styles.markGlyph}>🕳️</Text>
            </View>
            <Text style={styles.heading}>Welcome back</Text>
            <Text style={styles.subtext}>Enter your username to continue</Text>
            {notice && <Text style={styles.notice}>{notice}</Text>}

            <AppTextInput
              style={[styles.input, focused === "username" && styles.inputFocused]}
              placeholder="Username"
              placeholderTextColor={palette.charcoal[300]}
              value={username}
              onChangeText={setUsername}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              textContentType="username"
              autoComplete="username"
              autoFocus
              returnKeyType="next"
              onFocus={() => setFocused("username")}
              onBlur={() => setFocused(null)}
              onSubmitEditing={() => passwordRef.current?.focus()}
              editable={!isSubmitting}
            />
            <AppTextInput
              ref={passwordRef}
              style={[styles.input, focused === "password" && styles.inputFocused]}
              placeholder="Password"
              placeholderTextColor={palette.charcoal[300]}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              textContentType="password"
              autoComplete="current-password"
              returnKeyType="go"
              onFocus={() => setFocused("password")}
              onBlur={() => setFocused(null)}
              onSubmitEditing={handleSubmit}
              editable={!isSubmitting}
            />

            {error !== "" && <Text style={styles.error}>{error}</Text>}

            <Pressable
              onPress={handleSubmit}
              disabled={!canSubmit}
              style={({ pressed }) => [
                styles.button,
                pressed && canSubmit && styles.buttonPressed,
                !canSubmit && styles.buttonDisabled,
              ]}
            >
              {isSubmitting ? (
                <View style={styles.buttonLoading}>
                  <ActivityIndicator color={palette.white} size="small" />
                  <Text style={styles.buttonText}>Signing in…</Text>
                </View>
              ) : (
                <Text style={styles.buttonText}>Sign In</Text>
              )}
            </Pressable>

            {DEV_LOGIN_AVAILABLE && (
              <Pressable
                onPress={devLogin}
                disabled={isSubmitting}
                style={({ pressed }) => [styles.devButton, pressed && { opacity: 0.7 }]}
              >
                <Text style={styles.devButtonText}>🔧 Dev login as {DEV_SCHOLAR}</Text>
              </Pressable>
            )}
          </View>

          <Text style={styles.footer}>
            An open-source Socratic tutor
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  scroll: {
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
    paddingVertical: 40,
  },
  card: {
    width: "100%",
    maxWidth: 460,
    backgroundColor: palette.white,
    borderRadius: 24,
    paddingHorizontal: 32,
    paddingVertical: 40,
    alignItems: "center",
    // Soft elevation to lift the card off the gradient.
    shadowColor: palette.navy[900],
    shadowOpacity: 0.35,
    shadowRadius: 32,
    shadowOffset: { width: 0, height: 16 },
    elevation: 12,
  },
  mark: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 8,
  },
  markGlyph: { fontSize: 46, lineHeight: 54 },
  rabbit: { transform: [{ scaleX: -1 }] },
  heading: {
    fontFamily: fonts.bold,
    fontSize: 30,
    lineHeight: 36,
    letterSpacing: -0.5,
    color: palette.navy[500],
    textAlign: "center",
  },
  subtext: {
    fontFamily: fonts.regular,
    fontSize: 15,
    color: palette.charcoal[400],
    textAlign: "center",
    marginTop: 6,
    marginBottom: 24,
  },
  notice: {
    width: "100%",
    fontFamily: fonts.medium,
    fontSize: 14,
    lineHeight: 20,
    color: palette.charcoal[500],
    textAlign: "center",
    marginTop: -10,
    marginBottom: 18,
  },
  input: {
    width: "100%",
    height: 52,
    backgroundColor: palette.gray[50],
    borderWidth: 1,
    borderColor: palette.gray[300],
    borderRadius: 12,
    paddingHorizontal: 16,
    fontSize: 17,
    fontFamily: fonts.regular,
    color: palette.charcoal[500],
    marginTop: 12,
  },
  inputFocused: { borderColor: palette.violet[400] },
  error: {
    width: "100%",
    fontFamily: fonts.regular,
    fontSize: 14,
    color: status.red,
    textAlign: "center",
    marginTop: 12,
  },
  button: {
    width: "100%",
    height: 56,
    borderRadius: 12,
    backgroundColor: palette.violet[500],
    alignItems: "center",
    justifyContent: "center",
    marginTop: 20,
  },
  buttonPressed: { backgroundColor: palette.violet[600] },
  buttonDisabled: { opacity: 0.5 },
  buttonLoading: { flexDirection: "row", alignItems: "center", gap: 10 },
  buttonText: {
    fontFamily: fonts.semibold,
    fontSize: 17,
    color: palette.white,
  },
  devButton: {
    marginTop: 18,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: palette.gray[100],
  },
  devButtonText: {
    fontFamily: fonts.medium,
    fontSize: 13,
    color: palette.charcoal[500],
  },
  footer: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: "rgba(255,255,255,0.55)",
    textAlign: "center",
    marginTop: 24,
  },
});
