// Keep-alive embedded WebView host. Mounted once at app root; shown/hidden via
// the externalAppHost store. External Apps, Web Assignments, and Rabbithole-hosted
// interactive web content all use this same WebView so cookies and page state can
// survive close→reopen without creating one-off routes.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useMutation, useQuery } from "convex/react";
import { useConvexAuth } from "@convex-dev/auth/react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  AppState,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import WebView from "react-native-webview";
// `ShouldStartLoadRequest` (WebViewNavigation + `isTopFrame`) is the real event
// type for onShouldStartLoadWithRequest, but the package only re-exports
// `WebViewNavigation` from its root — hence the deep import of its own decl.
import type { ShouldStartLoadRequest } from "react-native-webview/lib/WebViewTypes";
import { SymbolView } from "expo-symbols";
import * as Haptics from "expo-haptics";
import * as FileSystem from "expo-file-system/legacy";
import CookieManager, { type Cookie, type Cookies } from "@preeternal/react-native-cookie-manager";

import { api, type Id } from "@/lib/convex";
import {
  closeEmbeddedWebContent,
  useOpenEmbeddedWebContent,
  type OpenEmbeddedWebContent,
} from "@/lib/externalAppHost";
import {
  isManipulativeDoneMessage,
  type ManipulativeDoneMessage,
} from "../../vendor/manipulative/practiceContract";
import {
  effectiveAllowedHosts,
  parseWebCapture,
  urlAllowedByAllowlist,
} from "@/lib/webActivityExtract";
import {
  webEmbedNavigationUrlError,
  webEmbedOriginWhitelist,
  webEmbedUrlError,
} from "@/lib/webEmbedConfig";
import { isAllowedYouTubeResourceUrl } from "@/lib/activityResourcePlayer";
import { fonts, useColors } from "@/theme";

const CAPTURE_INTERVAL_MS = 25_000;
const FIRST_CAPTURE_DELAY_MS = 2_000;
const COOKIE_FILE =
  (FileSystem.documentDirectory ?? "") + "rh_embedded_web_cookies.json";
const LEGACY_COOKIE_FILE =
  (FileSystem.documentDirectory ?? "") + "rh_external_cookies.json";

const EXTRACT_SNIPPET = `
(function () {
  var send = function (payload) {
    try {
      if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
        window.ReactNativeWebView.postMessage(JSON.stringify(payload));
      }
    } catch (e) {}
  };
  var out = { rhWebCapture: 1 };
  try { out.url = String(location.href); } catch (e) {}
  try { out.title = String(document.title || ""); } catch (e) {}
  try { out.text = ((document.body && document.body.innerText) || "").slice(0, 6000); } catch (e) { out.text = ""; }
  try {
    var fetchTasks = function (path) {
      return fetch(path, { credentials: "include" }).then(function (r) {
        out.apiStatus = r ? r.status : -1;
        return r && r.ok ? r.json() : null;
      });
    };
    var d = new Date();
    var pad = function (n) { return (n < 10 ? "0" : "") + n; };
    var dated = "/api/previous-tasks/" + d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
    fetchTasks(dated)
      .then(function (data) {
        if (Array.isArray(data) && data.length) return data;
        return fetchTasks("/api/previous-tasks/");
      })
      .then(function (data) {
        if (Array.isArray(data)) { out.api = data.slice(0, 60); }
        else if (data && typeof data === "object") {
          var inner = data.tasks || data.results || data.items || data.data;
          if (Array.isArray(inner)) { out.api = inner.slice(0, 60); }
        }
        send(out);
      })
      .catch(function () { send(out); });
  } catch (e) { send(out); }
})();
true;
`;

const INTERACTIVE_GESTURE_SNIPPET = `
(function () {
  try {
    var id = "rh-native-interactive-webview-style";
    var style = document.getElementById(id);
    if (!style) {
      style = document.createElement("style");
      style.id = id;
      document.head.appendChild(style);
    }
    style.textContent = "html,body{overscroll-behavior:none;-webkit-user-select:none;-webkit-touch-callout:none;}body{touch-action:none;}";
  } catch (e) {}
})();
true;
`;

// ── Declarative auto-login flows ──────────────────────────────────────────
// Some External Apps have a multi-step sign-in that the plain username/password
// selector fill can't drive (e.g. PressReader's library-card modal: open the
// "Library or Group Sign In" panel → pick the library → card # + PIN → tick the
// required agreement → Log In). The catalog stores only a `loginFlow` id; the
// executable script lives here, in reviewed native code. USERNAME/PASSWORD are
// injected as the leading `var` decls by `buildLoginFlowScript` (JSON-escaped).
//
// PressReader library-card flow. Self-driving + idempotent state machine that
// polls (~600ms, up to ~40s) and advances whichever of PressReader's sign-in
// steps is currently on screen — verified on-device against the live SPA
// (2026-07-07):
//   D. the library-card form ("Library card number" + "PIN or Password") →
//      fill card # (username) + PIN (password), tick the required agreement,
//      click "Log In" once. Checked FIRST so once we reach it we never regress.
//   C. the "Select Library" search → type the library query, then click the
//      "Hawaii State Public Library System" result row.
//   B. the welcome modal → click "Library or Group" to open the card path.
//   A. no modal yet → click a top-level "Sign in" to open it.
// Steps are gated on PRECISE labels (a bare email/password sign-in must NOT be
// mistaken for the card form), and only unchecked checkboxes are clicked so an
// already-on "Stay signed in" is left intact.
const PRESSREADER_FLOW_BODY = `
  var MAX_MS = 40000;
  var LIB_QUERY = 'Hawaii';
  var LIB_MATCH = /hawaii state public library/i;
  var start = Date.now();
  var submitted = false;
  function nativeSet(el, value) {
    if (!el) return false;
    try {
      var win = (el.ownerDocument && el.ownerDocument.defaultView) || window;
      var proto = el.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
      var desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, value); else el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } catch (e) { return false; }
  }
  function visible(el) {
    if (!el) return false;
    try { var r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch (e) { return false; }
  }
  function textOf(el) { try { return ((el && (el.textContent || el.value)) || '').trim(); } catch (e) { return ''; } }
  // Most-specific match: among visible elements whose text matches, return the
  // one with the SHORTEST text, so we click a row/label — not a huge container.
  function findByText(selector, re) {
    var nodes = Array.prototype.slice.call(document.querySelectorAll(selector))
      .filter(function (n) { return visible(n) && re.test(textOf(n)); });
    nodes.sort(function (a, b) { return textOf(a).length - textOf(b).length; });
    return nodes[0] || null;
  }
  function labelText(input) {
    var t = '';
    try {
      t += (input.getAttribute('placeholder') || '') + ' ' + (input.getAttribute('name') || '') + ' '
        + (input.getAttribute('aria-label') || '') + ' ' + (input.getAttribute('id') || '');
      if (input.id) { var lbl = document.querySelector('label[for="' + input.id + '"]'); if (lbl) t += ' ' + textOf(lbl); }
      var wrap = input.closest ? input.closest('label') : null; if (wrap) t += ' ' + textOf(wrap);
    } catch (e) {}
    return t.toLowerCase();
  }
  function inputByLabel(re) {
    var inputs = Array.prototype.slice.call(document.querySelectorAll('input, textarea')).filter(visible);
    for (var i = 0; i < inputs.length; i++) { if (re.test(labelText(inputs[i]))) return inputs[i]; }
    return null;
  }
  function fillCardForm(card, pin) {
    if (card.value !== USERNAME) nativeSet(card, USERNAME);
    if (pin.value !== PASSWORD) nativeSet(pin, PASSWORD);
    if (!card.value || !pin.value) return;
    Array.prototype.slice.call(document.querySelectorAll('input[type=checkbox]'))
      .filter(visible).forEach(function (b) { if (!b.checked) { try { b.click(); } catch (e) {} } });
    var btn = findByText('button, [type=submit], a[role=button]', /^\\s*log ?in\\s*$/i);
    if (btn) { submitted = true; setTimeout(function () { try { btn.click(); } catch (e) {} }, 300); }
  }
  function tick() {
    if (submitted || Date.now() - start > MAX_MS) return;
    // D — the library-card form (precise labels; checked first).
    var card = inputByLabel(/library card|card number|barcode/);
    var pin = inputByLabel(/pin|password/);
    if (card && pin) { fillCardForm(card, pin); return; }
    // C — the "Select Library" search: type the query, then click the result.
    var search = inputByLabel(/search.*(librar|group)/);
    if (!search) { var s = document.querySelector('input[type=search]'); if (s && visible(s)) search = s; }
    if (search) {
      if ((search.value || '').toLowerCase().indexOf('hawaii') === -1) { nativeSet(search, LIB_QUERY); return; }
      var row = findByText('button, a, li, [role=button], [role=option], p, span, div', LIB_MATCH);
      if (row) { try { row.click(); } catch (e) {} }
      return;
    }
    // B — the welcome modal: open the Library-or-Group path.
    var lib = findByText('button, a, [role=button]', /library.*group/i);
    if (lib) { try { lib.click(); } catch (e) {} return; }
    // A — no modal yet: open the sign-in UI.
    var signin = findByText('button, a, [role=button]', /^\\s*sign ?in\\s*$/i);
    if (signin) { try { signin.click(); } catch (e) {} return; }
  }
  var iv = setInterval(function () {
    if (submitted || Date.now() - start > MAX_MS) { clearInterval(iv); return; }
    try { tick(); } catch (e) {}
  }, 600);
  try { tick(); } catch (e) {}
`;

const LOGIN_FLOW_BODIES: Record<string, string> = {
  pressReaderLibraryCard: PRESSREADER_FLOW_BODY,
};

/**
 * Build the injectable auto-login script for a declarative `loginFlow`, with the
 * scholar's saved credentials JSON-escaped into leading `var` decls. Returns
 * null for an unknown/absent flow (callers fall back to the selector fill).
 */
function buildLoginFlowScript(
  flow: string | null | undefined,
  username: string,
  password: string | null | undefined,
): string | null {
  const body = flow ? LOGIN_FLOW_BODIES[flow] : undefined;
  if (!body) return null;
  const u = JSON.stringify(username);
  const p = JSON.stringify(password ?? "");
  return `(function(){try{var USERNAME=${u};var PASSWORD=${p};${body}}catch(e){}})();true;`;
}

// react-native-webview's v14 component type resolves to `never` under this
// Expo/TS combo for several iOS-only props, but the props are supported at runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const EmbeddedWebView = WebView as any;

type TrackedContent = Extract<
  OpenEmbeddedWebContent,
  { kind: "externalApp" | "webActivity" }
>;
type StartSessionResult = { sessionId: Id<"webActivitySessions"> };

function contentKey(content: OpenEmbeddedWebContent) {
  switch (content.kind) {
    case "externalApp":
      return `app:${content.appId}:${content.url}`;
    case "webActivity":
      return `activity:${content.activityId}:${content.assignmentId ?? ""}:${content.url}`;
    case "interactive":
      return `interactive:${content.id ?? content.url}:${content.url}`;
  }
}

function isTrackedContent(
  content: OpenEmbeddedWebContent | null,
): content is TrackedContent {
  return content?.kind === "externalApp" || content?.kind === "webActivity";
}

function sessionArgs(content: TrackedContent) {
  if (content.kind === "externalApp") return { appId: content.appId };
  return {
    activityId: content.activityId,
    ...(content.assignmentId ? { assignmentId: content.assignmentId } : {}),
  };
}

function originFromUrl(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function originsForContent(content: OpenEmbeddedWebContent | null): string[] {
  if (!content) return [];
  const origins = new Set<string>();
  const own = originFromUrl(content.url);
  if (own) origins.add(own);
  for (const raw of content.allowedHosts ?? []) {
    const host = raw.trim().toLowerCase();
    if (!host || host.startsWith("*.")) continue;
    origins.add(`https://${host}`);
  }
  return [...origins];
}

async function readCookieJar(): Promise<Record<string, Cookies>> {
  try {
    const info = await FileSystem.getInfoAsync(COOKIE_FILE);
    const file = info.exists ? COOKIE_FILE : LEGACY_COOKIE_FILE;
    const fallbackInfo = info.exists ? info : await FileSystem.getInfoAsync(file);
    if (!fallbackInfo.exists) return {};
    const raw = await FileSystem.readAsStringAsync(file);
    return JSON.parse(raw) as Record<string, Cookies>;
  } catch {
    return {};
  }
}

async function restoreCookiesForOrigins(origins: string[]) {
  if (origins.length === 0) return;
  const jar = await readCookieJar();
  for (const origin of origins) {
    const cookies = jar[origin];
    if (!cookies) continue;
    for (const cookie of Object.values(cookies)) {
      const persisted: Cookie = {
        ...cookie,
        version: cookie.version ?? "1",
        expires:
          cookie.expires ??
          new Date(Date.now() + 1000 * 60 * 60 * 24 * 90).toISOString(),
      };
      await CookieManager.set(origin, persisted, true).catch(() => false);
    }
  }
}

async function saveCookiesForOrigins(origins: string[]) {
  if (origins.length === 0) return;
  const jar = await readCookieJar();
  for (const origin of origins) {
    const cookies = await CookieManager.get(origin, true).catch(() => null);
    if (!cookies) continue;
    if (Object.keys(cookies).length > 0) {
      jar[origin] = cookies;
    } else {
      delete jar[origin];
    }
  }
  await FileSystem.writeAsStringAsync(COOKIE_FILE, JSON.stringify(jar)).catch(
    () => {},
  );
}

export function ExternalAppHost() {
  const requested = useOpenEmbeddedWebContent();
  const { isAuthenticated } = useConvexAuth();
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const webViewRef = useRef<WebView>(null);
  const [mounted, setMounted] = useState<OpenEmbeddedWebContent | null>(null);
  const mountedKeyRef = useRef<string | null>(null);
  const [webViewKey, setWebViewKey] = useState(0);
  const [canBack, setCanBack] = useState(false);
  const [canForward, setCanForward] = useState(false);
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const [cookiesReady, setCookiesReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blockedMessage, setBlockedMessage] = useState<string | null>(null);
  const [onLogin, setOnLogin] = useState(false);
  // Lane 3 — set once the embedded /embed/manipulative page posts
  // RH_MANIPULATIVE_DONE. `solved` here is the SERVER's graded verdict (the web
  // page already called `submitAnswer` before posting), so the host only
  // reflects it into chrome — it never re-grades.
  const [manipulativeDone, setManipulativeDone] = useState<ManipulativeDoneMessage | null>(
    null,
  );
  // Lane 3 auth handoff — the resolved WebView URL with a one-shot `#et=` embed
  // token appended (null until minted). It's reset to null on each new mount
  // (in the mount effect above) and re-derived by the effect below.
  const [handoffUri, setHandoffUri] = useState<string | null>(null);
  const prefilledFor = useRef<string | null>(null);
  const [opacity] = useState(() => new Animated.Value(0));

  const startSession = useMutation(api.webActivitySessions.start);
  const recordProgress = useMutation(api.webActivitySessions.recordProgress);
  const finalizeSession = useMutation(api.webActivitySessions.finalize);
  // Lane 3 prod auth bridge — mints a one-shot embed-session token for THIS
  // app's own identity, handed to the /embed/manipulative page in the URL
  // fragment so it can grade as the scholar. See convex/embedAuth.ts.
  const issueEmbedToken = useMutation(api.embedAuth.issueEmbedToken);
  const sessionRunIdRef = useRef(0);
  const finalizedRunIdsRef = useRef(new Set<number>());
  const pendingStartRef = useRef<{
    runId: number;
    promise: Promise<StartSessionResult>;
  } | null>(null);
  const sessionIdRef = useRef<{
    runId: number;
    sessionId: Id<"webActivitySessions">;
  } | null>(null);
  const captureIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const offDomainDeltaRef = useRef(0);
  const lastUrlRef = useRef<string>("");

  useEffect(() => {
    if (!requested) return;
    const key = contentKey(requested);
    if (mountedKeyRef.current !== key) {
      mountedKeyRef.current = key;
      setMounted(requested);
      setWebViewKey((value) => value + 1);
      setCanBack(false);
      setCanForward(false);
      setLoading(true);
      setReady(false);
      setCookiesReady(false);
      setError(null);
      setBlockedMessage(null);
      setOnLogin(false);
      setManipulativeDone(null);
      setHandoffUri(null);
      prefilledFor.current = null;
      offDomainDeltaRef.current = 0;
      lastUrlRef.current = requested.url;
    } else {
      setMounted(requested);
    }
  }, [requested]);

  const open =
    !!requested &&
    !!mounted &&
    contentKey(requested) === contentKey(mounted);
  useEffect(() => {
    Animated.timing(opacity, {
      toValue: open ? 1 : 0,
      duration: 220,
      useNativeDriver: true,
    }).start();
  }, [open, opacity]);

  const credentialAppId =
    mounted?.kind === "externalApp"
      ? mounted.appId
      : mounted?.kind === "webActivity"
        ? mounted.externalAppId
        : null;
  const creds = useQuery(
    api.scholarApps.credentialsForApp,
    credentialAppId && isAuthenticated ? { appId: credentialAppId } : "skip",
  );
  const userSelector =
    creds?.usernameSelector ??
    "input[type=email],input[name*=user i],input[name*=email i],input[type=text]";
  const passwordSelector = creds?.passwordSelector ?? "input[type=password]";
  const loginFlow = creds?.loginFlow ?? null;
  let autoLoginCredentialGateOpen = true;
  let isCredentialAutoLoginApp = false;
  let revealCredentialAutoLoginApp = useCallback(() => {}, []);

  const allowedHosts = useMemo(
    () =>
      mounted
        ? effectiveAllowedHosts({
            webUrl: mounted.url,
            webAllowedHosts: mounted.allowedHosts,
          })
        : [],
    [mounted],
  );

  const shouldCapture = isTrackedContent(mounted);
  const urlError = mounted ? webEmbedUrlError(mounted.url) : null;
  const gestureMode = mounted?.gestureMode ?? "page";
  const interactive = gestureMode === "interactive";
  const lockedYouTube = mounted?.navigationPolicy === "youtube";
  const cookieOrigins = useMemo(() => originsForContent(mounted), [mounted]);

  // Lane 3 prod auth bridge. For an interactive embed flagged `authHandoff`
  // (e.g. /embed/manipulative), mint a one-shot embed-session token bound to
  // THIS app's own identity and append it as an `#et=` fragment (never the
  // query string — the page reads + strips it client-side, so it can't reach
  // web-server logs). `webViewKey` is a dep so a Reload mints a FRESH token
  // (the prior one is single-use / may be expired). On failure — or before the
  // app has signed in — we fall back to the bare URL, so the embed page shows
  // its own signed-out state instead of hanging.
  const wantsHandoff =
    mounted?.kind === "interactive" && mounted.authHandoff === true;
  const mountedUrl = mounted?.url ?? null;
  useEffect(() => {
    if (!mountedUrl || !wantsHandoff) return; // no handoff — derived below
    let cancelled = false;
    void (async () => {
      if (!isAuthenticated) {
        if (!cancelled) setHandoffUri(mountedUrl);
        return;
      }
      try {
        const { token } = await issueEmbedToken({});
        if (cancelled) return;
        const sep = mountedUrl.includes("#") ? "&" : "#";
        setHandoffUri(`${mountedUrl}${sep}et=${encodeURIComponent(token)}`);
      } catch {
        if (!cancelled) setHandoffUri(mountedUrl); // degrade, don't hang
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mountedUrl, wantsHandoff, isAuthenticated, webViewKey, issueEmbedToken]);

  // The URL handed to the WebView: for an authHandoff embed it's the
  // token-bearing URL once minted (null until then, which gates the load);
  // otherwise the plain mounted URL. `handoffReady` is only unmet while an
  // authHandoff embed is still minting its token.
  const sourceUri = wantsHandoff ? handoffUri : mounted?.url ?? null;
  const handoffReady = !wantsHandoff || handoffUri !== null;

  useEffect(() => {
    let cancelled = false;
    void restoreCookiesForOrigins(cookieOrigins).then(() => {
      if (!cancelled) setCookiesReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [cookieOrigins]);


  const saveCookies = useCallback(
    () => saveCookiesForOrigins(cookieOrigins),
    [cookieOrigins],
  );

  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active") void saveCookies();
    });
    return () => sub.remove();
  }, [saveCookies]);

  const injectedJavaScript = useMemo(() => {
    const snippets = [];
    if (interactive) snippets.push(INTERACTIVE_GESTURE_SNIPPET);
    if (shouldCapture) snippets.push(EXTRACT_SNIPPET);
    snippets.push("true;");
    return snippets.join("\n");
  }, [interactive, shouldCapture]);

  const injectCapture = useCallback(() => {
    if (shouldCapture) webViewRef.current?.injectJavaScript(EXTRACT_SNIPPET);
  }, [shouldCapture]);

  const injectInteractiveGestureCss = useCallback(() => {
    if (interactive) webViewRef.current?.injectJavaScript(INTERACTIVE_GESTURE_SNIPPET);
  }, [interactive]);

  const finishSession = useCallback(
    async (
      markDone: boolean,
      runId = sessionRunIdRef.current,
      startPromise: Promise<StartSessionResult> | null = null,
    ) => {
      if (finalizedRunIdsRef.current.has(runId)) return;
      finalizedRunIdsRef.current.add(runId);
      if (sessionRunIdRef.current === runId && captureIntervalRef.current) {
        clearInterval(captureIntervalRef.current);
        captureIntervalRef.current = null;
      }
      await saveCookies();
      let sessionId =
        sessionIdRef.current?.runId === runId
          ? sessionIdRef.current.sessionId
          : null;
      const pendingStart =
        startPromise ??
        (pendingStartRef.current?.runId === runId
          ? pendingStartRef.current.promise
          : null);
      if (!sessionId && pendingStart) {
        try {
          sessionId = (await pendingStart).sessionId;
        } catch {
          return;
        }
      }
      if (sessionIdRef.current?.runId === runId) sessionIdRef.current = null;
      if (pendingStartRef.current?.runId === runId) pendingStartRef.current = null;
      if (!sessionId) return;
      try {
        await finalizeSession({
          sessionId,
          ...(markDone ? { markDone: true } : {}),
        });
      } catch {
        // Offline at close: the heartbeat row still records useful duration.
      }
    },
    [finalizeSession, saveCookies],
  );

  useEffect(() => {
    if (!open || !isAuthenticated || !isTrackedContent(mounted)) return;
    const tracked = mounted;
    const runId = sessionRunIdRef.current + 1;
    sessionRunIdRef.current = runId;
    sessionIdRef.current = null;
    const startPromise = startSession(sessionArgs(tracked));
    pendingStartRef.current = { runId, promise: startPromise };
    void startPromise
      .then((result) => {
        if (sessionRunIdRef.current === runId) {
          sessionIdRef.current = { runId, sessionId: result.sessionId };
        }
      })
      .catch((err) => {
        console.warn("[web-embed] session start failed", err);
      });
    captureIntervalRef.current = setInterval(injectCapture, CAPTURE_INTERVAL_MS);
    return () => {
      void finishSession(false, runId, startPromise);
    };
  }, [finishSession, injectCapture, isAuthenticated, mounted, open, startSession]);

  const fillCredentials = useCallback(() => {
    if (!creds) return;
    Haptics.selectionAsync();
    // Multi-step apps (e.g. PressReader's library-card modal) declare a
    // `loginFlow`: run the bundled auto-login script (fills + submits) rather
    // than the single username/password selector fill.
    const flowJs = buildLoginFlowScript(loginFlow, creds.username, creds.password);
    if (flowJs) {
      Alert.alert(
        `${mounted?.title ?? "App"} login`,
        `Sign in as ${creds.username}?`,
        [
          { text: "Sign in", onPress: () => webViewRef.current?.injectJavaScript(flowJs) },
          { text: "Close", style: "cancel" },
        ],
      );
      return;
    }
    const username = JSON.stringify(creds.username);
    const password = JSON.stringify(creds.password ?? "");
    const userSel = JSON.stringify(userSelector);
    const passSel = JSON.stringify(passwordSelector);
    const js = `(function(){try{var set=function(el,v){if(!el)return;var win=el.ownerDocument&&el.ownerDocument.defaultView?el.ownerDocument.defaultView:window;var d=Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype,'value');if(d&&d.set)d.set.call(el,v);else el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));};set(document.querySelector(${userSel}),${username});set(document.querySelector(${passSel}),${password});}catch(e){}})();true;`;
    Alert.alert(
      `${mounted?.title ?? "App"} login`,
      `Username: ${creds.username}\nPassword: ${creds.password ? "••••••••" : "(not saved)"}`,
      [
        { text: "Autofill", onPress: () => webViewRef.current?.injectJavaScript(js) },
        { text: "Close", style: "cancel" },
      ],
    );
  }, [creds, loginFlow, mounted?.title, passwordSelector, userSelector]);

  const savedUsername = creds?.username;
  const savedPassword = creds?.password;
  const prefillUsername = useCallback(() => {
    if (!savedUsername) return;
    const username = JSON.stringify(savedUsername);
    const selector = JSON.stringify(userSelector);
    webViewRef.current?.injectJavaScript(
      `(function(){try{var el=document.querySelector(${selector});if(!el)return;var win=el.ownerDocument&&el.ownerDocument.defaultView?el.ownerDocument.defaultView:window;var d=Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype,'value');if(d&&d.set)d.set.call(el,${username});else el.value=${username};el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}catch(e){}})();true;`,
    );
  }, [savedUsername, userSelector]);

  // Auto-run a declarative multi-step login flow (e.g. PressReader) when the
  // login page is reached — the script self-drives the sign-in and submits.
  const runLoginFlow = useCallback(() => {
    if (!savedUsername) return;
    const js = buildLoginFlowScript(loginFlow, savedUsername, savedPassword);
    if (js) webViewRef.current?.injectJavaScript(js);
  }, [loginFlow, savedPassword, savedUsername]);

  const closeHost = useCallback(
    (markDone: boolean) => {
      void saveCookies();
      void finishSession(markDone);
      closeEmbeddedWebContent();
    },
    [finishSession, saveCookies],
  );

  const confirmClose = useCallback(() => {
    const title = mounted?.title ?? "this activity";
    if (mounted?.kind === "webActivity") {
      Alert.alert(`Done with ${title}?`, "Close the web activity and mark it done.", [
        { text: "Stay", style: "cancel" },
        { text: "Done", onPress: () => closeHost(true) },
      ]);
      return;
    }
    // Lane 3 — once the manipulative is graded (either way), "Continue" should
    // just close: there's nothing left to lose by leaving, so skip the
    // confirmation prompt that guards an in-progress interactive embed.
    if (mounted?.kind === "interactive" && manipulativeDone) {
      closeHost(false);
      return;
    }
    Alert.alert(
      mounted?.kind === "interactive" ? `Close ${title}?` : `Leave ${title}?`,
      mounted?.kind === "interactive"
        ? "You can reopen it from Rabbithole when you need it again."
        : "Your place is kept — jump back in anytime.",
      [
        { text: "Stay", style: "cancel" },
        {
          text: mounted?.kind === "interactive" ? "Close" : "Leave",
          style: mounted?.kind === "interactive" ? "default" : "destructive",
          onPress: () => closeHost(false),
        },
      ],
    );
  }, [closeHost, manipulativeDone, mounted]);

  const retry = useCallback(() => {
    Haptics.selectionAsync();
    setError(null);
    setReady(false);
    setLoading(true);
    // Drop any stale (single-use) embed token so an authHandoff embed re-mints
    // a fresh one before the WebView reloads — never reuse a consumed token.
    setHandoffUri(null);
    setWebViewKey((value) => value + 1);
  }, []);

  const autoLoginInspectorRef = useRef<() => void>(() => {});

  const handleLoadEnd = useCallback(() => {
    setLoading(false);
    setReady(true);
    autoLoginInspectorRef.current();
    injectInteractiveGestureCss();
    setTimeout(injectCapture, FIRST_CAPTURE_DELAY_MS);
  }, [injectCapture, injectInteractiveGestureCss]);


  const handleMessage = useCallback(
    (event: { nativeEvent: { data: string } }) => {
      let payload: unknown;
      try {
        payload = JSON.parse(event.nativeEvent.data);
      } catch {
        return;
      }
      // Lane 3 bridge: the /embed/manipulative page (a "interactive" content
      // kind) posts RH_MANIPULATIVE_DONE once it has already graded the
      // submission server-side via `submitAnswer`. Validate with the frozen
      // contract's guard before trusting anything from the WebView, then just
      // reflect the verdict into chrome — no re-grading here.
      if (mounted?.kind === "interactive" && isManipulativeDoneMessage(payload)) {
        setManipulativeDone(payload);
        Haptics.notificationAsync(
          payload.solved
            ? Haptics.NotificationFeedbackType.Success
            : Haptics.NotificationFeedbackType.Warning,
        );
        return;
      }
      if (!shouldCapture) return;
      const capture = payload as Record<string, unknown>;
      if (capture.rhWebCapture !== 1) return;
      const parsed = parseWebCapture({
        text: typeof capture.text === "string" ? capture.text : undefined,
        api: capture.api,
        now: Date.now(),
      });
      const activeSession = sessionIdRef.current;
      if (!activeSession) return;
      const delta = offDomainDeltaRef.current;
      offDomainDeltaRef.current = 0;
      void recordProgress({
        sessionId: activeSession.sessionId,
        extracted: parsed.extracted,
        extractedSource: parsed.source,
        lastUrl:
          typeof capture.url === "string" ? capture.url : lastUrlRef.current || undefined,
        offDomainBlockDelta: delta > 0 ? delta : undefined,
      }).catch(() => {});
    },
    [isCredentialAutoLoginApp, mounted, recordProgress, revealCredentialAutoLoginApp, shouldCapture],
  );

  const handleShouldStartLoad = useCallback(
    (request: ShouldStartLoadRequest) => {
      const url = request.url;
      if (!url || allowedHosts.length === 0) return true;
      // The domain lock is about where a SCHOLAR can navigate — and iOS routes
      // EVERY navigation action through this callback, cross-origin SUB-FRAMES
      // included (SSO frames, embedded players, DRM'd content frames, ad slots).
      // Blocking those punished the page, not the kid: a site that works in
      // Safari hangs inside Rabbithole waiting on a frame that can never load,
      // while each one also fired the "kept you here" toast and inflated the
      // teacher-visible `offDomainBlocks` count. Measured 2026-08-19 on one
      // ordinary page load: 30+ blocked third-party frames, zero of them a
      // navigation anyone made. A sub-frame cannot take the kid off the
      // activity — only the top frame can — so only the top frame is gated.
      // (This is also why sub-frame URLs must not become `lastUrl`.)
      if (!request.isTopFrame) return true;
      if (lockedYouTube) {
        if (isAllowedYouTubeResourceUrl(url)) {
          lastUrlRef.current = url;
          return true;
        }
        offDomainDeltaRef.current += 1;
        setBlockedMessage("That link leaves this video, so Rabbithole kept you here.");
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        setTimeout(() => setBlockedMessage(null), 2800);
        return false;
      }
      const protocolError = webEmbedNavigationUrlError(url);
      if (protocolError) {
        offDomainDeltaRef.current += 1;
        setBlockedMessage(protocolError);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        setTimeout(() => setBlockedMessage(null), 2800);
        return false;
      }
      if (urlAllowedByAllowlist(url, allowedHosts)) {
        lastUrlRef.current = url;
        return true;
      }
      offDomainDeltaRef.current += 1;
      setBlockedMessage("That link leaves this activity, so Rabbithole kept you here.");
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      setTimeout(() => setBlockedMessage(null), 2800);
      return false;
    },
    [allowedHosts, lockedYouTube],
  );

  const handleNavigationChange = useCallback(
    (state: { url: string; canGoBack: boolean; canGoForward: boolean }) => {
      setCanBack(state.canGoBack);
      setCanForward(state.canGoForward);
      if (state.url) lastUrlRef.current = state.url;
      const pattern = creds?.loginUrlPattern;
      const isLogin = pattern
        ? state.url.includes(pattern)
        : /\/login|sign[-_]?in/i.test(state.url);
      setOnLogin(isLogin);
      if (isLogin && creds?.username && prefilledFor.current !== state.url) {
        prefilledFor.current = state.url;
        // A declarative flow self-drives the whole sign-in; otherwise just
        // prefill the username helper and let the scholar type the rest.
        if (loginFlow) setTimeout(runLoginFlow, 600);
        else setTimeout(prefillUsername, 250);
      }
    },
    [creds?.loginUrlPattern, creds?.username, loginFlow, prefillUsername, runLoginFlow],
  );

  if (!mounted) return null;

  const visibleError = urlError ?? error;
  const showLoading =
    open && !visibleError && (!cookiesReady || !handoffReady || loading || !ready);
  const showCredentialChip = onLogin && !!creds?.username;
  const isManipulative = mounted.kind === "interactive" && manipulativeDone !== null;
  const doneLabel =
    mounted.kind === "webActivity" ? "Done" : isManipulative ? "Continue" : "Close";

  return (
    <Animated.View
      pointerEvents={open ? "auto" : "none"}
      style={[
        StyleSheet.absoluteFill,
        styles.root,
        {
          paddingTop: insets.top,
          opacity,
          zIndex: open ? 50 : -1,
        },
      ]}
    >
      <View style={styles.bar}>
        <ToolbarButton
          label="Back"
          disabled={!canBack}
          onPress={() => webViewRef.current?.goBack()}
          colors={colors}
        >
          <Text style={[styles.navText, !canBack && styles.navTextDisabled]}>‹</Text>
        </ToolbarButton>
        <ToolbarButton
          label="Forward"
          disabled={!canForward}
          onPress={() => webViewRef.current?.goForward()}
          colors={colors}
        >
          <Text style={[styles.navText, !canForward && styles.navTextDisabled]}>›</Text>
        </ToolbarButton>
        <ToolbarButton label="Reload" onPress={retry} colors={colors}>
          <SymbolView name="arrow.clockwise" size={19} tintColor={colors.violet} />
        </ToolbarButton>
        <View style={styles.titleWrap}>
          <Text style={styles.title} numberOfLines={1}>{mounted.title}</Text>
          {mounted.kind === "interactive" && mounted.subtitle ? (
            <Text style={styles.subtitle} numberOfLines={1}>{mounted.subtitle}</Text>
          ) : null}
        </View>
        {creds ? (
          <ToolbarButton label="Fill saved login" onPress={fillCredentials} colors={colors}>
            <Text style={styles.keyText}>🔑</Text>
          </ToolbarButton>
        ) : null}
        <Pressable
          onPress={confirmClose}
          accessibilityRole="button"
          accessibilityLabel={doneLabel}
          style={({ pressed }) => [styles.doneButton, pressed && styles.buttonPressed]}
        >
          <Text style={styles.doneText}>{doneLabel}</Text>
        </Pressable>
      </View>

      {showCredentialChip ? (
        <Pressable onPress={fillCredentials} style={styles.chip} accessibilityRole="button">
          <Text style={styles.chipText} numberOfLines={1}>
            {loginFlow
              ? `Tap 🔑 to sign in as ${creds!.username}`
              : `Your username: ${creds!.username} — tap 🔑 to fill`}
          </Text>
        </Pressable>
      ) : null}

      <View style={styles.webWrap}>
        {!urlError && cookiesReady && handoffReady && autoLoginCredentialGateOpen && sourceUri ? (
          <EmbeddedWebView
            key={webViewKey}
            ref={webViewRef}
            source={
              mounted.documentHtml
                ? {
                    html: mounted.documentHtml,
                    baseUrl: mounted.documentBaseUrl ?? mounted.url,
                  }
                : { uri: sourceUri }
            }
            style={styles.webView}
            containerStyle={styles.webView}
            originWhitelist={webEmbedOriginWhitelist}
            sharedCookiesEnabled
            thirdPartyCookiesEnabled
            domStorageEnabled
            cacheEnabled
            incognito={false}
            allowsInlineMediaPlayback
            mediaPlaybackRequiresUserAction={lockedYouTube}
            allowsAirPlayForMediaPlayback={false}
            allowsPictureInPictureMediaPlayback={false}
            allowsLinkPreview={false}
            scrollEnabled={!interactive}
            bounces={false}
            overScrollMode="never"
            automaticallyAdjustContentInsets={false}
            contentInsetAdjustmentBehavior="never"
            allowsBackForwardNavigationGestures={!interactive}
            injectedJavaScript={injectedJavaScript}
            injectedJavaScriptBeforeContentLoaded={interactive ? INTERACTIVE_GESTURE_SNIPPET : undefined}
            onLoadStart={() => {
              setLoading(true);
              setError(null);
              setReady(false);
            }}
            onLoadEnd={handleLoadEnd}
            onError={(event: { nativeEvent: { description?: string } }) => {
              setLoading(false);
              setReady(false);
              setError(event.nativeEvent.description ?? "The web page could not be loaded.");
            }}
            onHttpError={(event: { nativeEvent: { statusCode?: number } }) => {
              const code = event.nativeEvent.statusCode;
              if (code && code >= 400) setError(`The web page returned HTTP ${code}.`);
            }}
            onMessage={handleMessage}
            onShouldStartLoadWithRequest={handleShouldStartLoad}
            onNavigationStateChange={handleNavigationChange}
          />
        ) : null}

        {showLoading ? (
          <View style={styles.overlay} pointerEvents="auto">
            <View style={styles.loadingCard}>
              <ActivityIndicator size="large" color={colors.violet} />
              <Text style={styles.loadingTitle}>{mounted.title}</Text>
              <Text style={styles.loadingSub}>Opening inside Rabbithole…</Text>
            </View>
          </View>
        ) : null}

        {visibleError ? (
          <View style={styles.overlay} pointerEvents="auto">
            <View style={styles.errorCard}>
              <Text style={styles.errorTitle}>Couldn’t open this activity</Text>
              <Text style={styles.errorBody}>{visibleError}</Text>
              <View style={styles.errorActions}>
                {!urlError ? (
                  <Pressable
                    onPress={retry}
                    accessibilityRole="button"
                    style={({ pressed }) => [styles.primaryAction, pressed && styles.buttonPressed]}
                  >
                    <Text style={styles.primaryActionText}>Try again</Text>
                  </Pressable>
                ) : null}
                <Pressable
                  onPress={() => closeHost(false)}
                  accessibilityRole="button"
                  style={({ pressed }) => [styles.secondaryAction, pressed && styles.buttonPressed]}
                >
                  <Text style={styles.secondaryActionText}>Close</Text>
                </Pressable>
              </View>
            </View>
          </View>
        ) : null}

        {blockedMessage ? (
          <View style={styles.blockedToast} pointerEvents="none">
            <Text style={styles.blockedText}>{blockedMessage}</Text>
          </View>
        ) : null}

        {mounted.kind === "interactive" && manipulativeDone ? (
          <View style={styles.manipulativeToast} pointerEvents="none">
            <Text
              style={[
                styles.manipulativeToastText,
                {
                  backgroundColor: manipulativeDone.solved
                    ? colors.statusGreen
                    : colors.statusRed,
                },
              ]}
            >
              {manipulativeDone.solved ? "Solved! Tap Continue." : "Not quite — Reset to try again."}
            </Text>
          </View>
        ) : null}
      </View>
    </Animated.View>
  );
}

type ToolbarButtonProps = {
  label: string;
  disabled?: boolean;
  onPress: () => void;
  children: ReactNode;
  colors: ReturnType<typeof useColors>;
};

function ToolbarButton({ label, disabled, onPress, children, colors }: ToolbarButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      style={({ pressed }) => [
        toolbarStyles.button,
        pressed && !disabled && { backgroundColor: colors.gray100 },
        disabled && toolbarStyles.buttonDisabled,
      ]}
    >
      {children}
    </Pressable>
  );
}

const toolbarStyles = StyleSheet.create({
  button: {
    minWidth: 38,
    minHeight: 38,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonDisabled: { opacity: 0.45 },
});

type ColorSet = ReturnType<typeof useColors>;

function makeStyles(colors: ColorSet) {
  return StyleSheet.create({
    root: {
      backgroundColor: colors.bg,
    },
    bar: {
      minHeight: 54,
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 14,
      gap: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
      backgroundColor: colors.bg,
    },
    navText: {
      fontSize: 30,
      lineHeight: 32,
      color: colors.violet,
      fontFamily: fonts.medium,
    },
    navTextDisabled: { color: colors.gray300 },
    titleWrap: {
      flex: 1,
      minWidth: 0,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 8,
    },
    title: {
      fontSize: 16.5,
      fontFamily: fonts.semibold,
      color: colors.navy,
      textAlign: "center",
    },
    subtitle: {
      marginTop: 1,
      fontSize: 12.5,
      fontFamily: fonts.regular,
      color: colors.fgMuted,
      textAlign: "center",
    },
    keyText: { fontSize: 20 },
    doneButton: {
      minHeight: 38,
      borderRadius: 12,
      paddingHorizontal: 12,
      alignItems: "center",
      justifyContent: "center",
    },
    doneText: {
      fontSize: 16,
      fontFamily: fonts.semibold,
      color: colors.violet,
    },
    buttonPressed: { opacity: 0.78 },
    chip: {
      backgroundColor: colors.violet,
      paddingVertical: 8,
      paddingHorizontal: 16,
    },
    chipText: {
      color: colors.white,
      fontSize: 13,
      fontFamily: fonts.semibold,
      textAlign: "center",
    },
    webWrap: {
      flex: 1,
      backgroundColor: colors.bg,
    },
    webView: { flex: 1, backgroundColor: colors.bg },
    overlay: {
      ...StyleSheet.absoluteFill,
      alignItems: "center",
      justifyContent: "center",
      padding: 28,
      backgroundColor: colors.bg,
    },
    loadingCard: {
      minWidth: 280,
      maxWidth: 420,
      alignItems: "center",
      justifyContent: "center",
      gap: 12,
      borderRadius: 24,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.bg,
      padding: 28,
      shadowColor: colors.navy,
      shadowOpacity: 0.08,
      shadowRadius: 18,
      shadowOffset: { width: 0, height: 8 },
    },
    loadingTitle: {
      marginTop: 4,
      fontSize: 18,
      fontFamily: fonts.bold,
      color: colors.navy,
      textAlign: "center",
    },
    loadingSub: {
      fontSize: 14.5,
      fontFamily: fonts.regular,
      color: colors.fgMuted,
      textAlign: "center",
    },
    errorCard: {
      width: "100%",
      maxWidth: 460,
      borderRadius: 24,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.bg,
      padding: 24,
      shadowColor: colors.navy,
      shadowOpacity: 0.08,
      shadowRadius: 18,
      shadowOffset: { width: 0, height: 8 },
    },
    errorTitle: {
      fontSize: 20,
      lineHeight: 25,
      fontFamily: fonts.bold,
      color: colors.navy,
      textAlign: "center",
    },
    errorBody: {
      marginTop: 8,
      fontSize: 15,
      lineHeight: 21,
      fontFamily: fonts.regular,
      color: colors.fgMuted,
      textAlign: "center",
    },
    errorActions: {
      marginTop: 20,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 12,
    },
    primaryAction: {
      borderRadius: 999,
      paddingVertical: 10,
      paddingHorizontal: 18,
      backgroundColor: colors.violet,
    },
    primaryActionText: {
      fontSize: 15,
      fontFamily: fonts.semibold,
      color: colors.white,
    },
    secondaryAction: {
      borderRadius: 999,
      paddingVertical: 10,
      paddingHorizontal: 18,
      backgroundColor: colors.gray100,
    },
    secondaryActionText: {
      fontSize: 15,
      fontFamily: fonts.semibold,
      color: colors.navy,
    },
    blockedToast: {
      position: "absolute",
      left: 24,
      right: 24,
      bottom: 24,
      alignItems: "center",
    },
    blockedText: {
      overflow: "hidden",
      borderRadius: 999,
      backgroundColor: colors.navy,
      color: colors.white,
      paddingVertical: 10,
      paddingHorizontal: 16,
      fontSize: 14,
      fontFamily: fonts.semibold,
      textAlign: "center",
    },
    manipulativeToast: {
      position: "absolute",
      left: 24,
      right: 24,
      bottom: 24,
      alignItems: "center",
    },
    manipulativeToastText: {
      overflow: "hidden",
      borderRadius: 999,
      color: colors.white,
      paddingVertical: 10,
      paddingHorizontal: 18,
      fontSize: 14,
      fontFamily: fonts.semibold,
      textAlign: "center",
    },
  });
}
