/**
 * InstructionVideo (native) — the iPad player for an instructional `video` atom.
 * The RN twin of the web player, held to scholar-facing web/native parity
 * (CLAUDE.md 2026-07-04): the same caption-first framing, the same tap-to-play
 * poster, and — like the web twin — NO per-clip "Source: …" link. The source
 * credit lives on the pre-auth /sources page, which carries Khan Academy's
 * required notice verbatim.
 *
 * WHY A LOCAL HTML WRAPPER (not source={{ uri }}):
 * YouTube now requires an HTTP Referer / client identity from embedded clients;
 * without it playback dies with **error 153**. The documented react-native-webview
 * fix is a local HTML document served with a stable **https `baseUrl`** — that
 * `baseUrl` (`PLAYER_BASE_URL`) is what supplies the Referer. A custom request
 * header does NOT reliably survive WebKit's redirects/subresource loads, so we do
 * not use one. See review/instruction-show-and-do-plan.html §7 "Embed mechanics".
 *
 * WHAT KEEPS THIS SAFE ON A MANAGED SCHOOL iPad:
 *  - `mediaPlaybackRequiresUserAction` stays TRUE — tap to play, never autoplay
 *    (a standing ban); playing also stops the TTS singleton.
 *  - AirPlay + Picture-in-Picture are OFF — both are escape paths off the device.
 *  - Top-frame navigation is intercepted (`onShouldStartLoadWithRequest`) against
 *    a host allowlist that permits ONLY the youtube-nocookie / youtube / google
 *    hosts the player itself needs, and blocks YouTube's own watch/channel escape
 *    paths — so a tap on the channel name can't wander into open YouTube.
 *  - The YouTube IFrame Player API reports player errors (2/5/100/101/150/153);
 *    each becomes an app-owned fallback card, never a dead black frame.
 *  - The clip LEAVES the player the moment it ends, so YouTube's end-screen grid
 *    of suggested videos never gets a chance to paint (see `buildPlayerHtml`).
 *
 * The WebView does not even mount until the scholar taps the poster.
 */

import { useMemo, useState } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import WebView from "react-native-webview";
import type { WebViewNavigation } from "react-native-webview";

import { fonts, useColors, type Colors } from "@/theme";
import { getNativeTTS } from "@/lib/nativeTTS";
import {
  instructionVideoEmbedUrl,
  type InstructionVideoAtom,
} from "../../../vendor/practice/instructionEntries";

// A stable https origin for the local HTML document. Passed as the WebView's
// `baseUrl`, it becomes the page origin and the Referer YouTube now demands
// (missing Referer → error 153). It must match the `origin` the IFrame API is
// told about below, and it is the nocookie host so the whole embed is
// privacy-enhanced end to end.
export const PLAYER_BASE_URL = "https://www.youtube-nocookie.com";

// The ONLY hosts the player legitimately needs: the nocookie embed + IFrame API
// (youtube.com/iframe_api, /youtubei), the media stream (googlevideo.com),
// thumbnails/avatars (ytimg.com, ggpht.com), and Google's static/api hosts.
// Everything else is blocked at navigation time.
const PLAYER_ALLOWED_HOST_SUFFIXES = [
  "youtube-nocookie.com",
  "youtube.com",
  "ytimg.com",
  "ggpht.com",
  "googlevideo.com",
  "gstatic.com",
  "google.com",
  "googleapis.com",
] as const;

// YouTube's own escape paths — even on an otherwise-allowed youtube host, a
// top-frame nav to these leaves the clip for open YouTube. `/embed/{id}` and
// `/iframe_api` are the player itself and are deliberately NOT matched.
const YT_ESCAPE_PATH =
  /^\/(watch|channel|user|results|playlist|shorts|feed|account|@|embed\/videoseries)/i;

function hostOf(url: string): string | null {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(url);
  if (!m) return null;
  let host = m[1];
  const at = host.lastIndexOf("@");
  if (at >= 0) host = host.slice(at + 1);
  return host.split(":")[0].toLowerCase();
}

function pathOf(url: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]+([^?#]*)/i.exec(url);
  return m && m[1] ? m[1] : "/";
}

function hostMatches(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith("." + suffix);
}

/**
 * Navigation gate for the player WebView. Allows the initial local document and
 * the player's own subresource hosts; blocks YouTube's watch/channel escape
 * paths and every off-domain host. Exported so the policy is inspectable.
 */
export function isAllowedPlayerUrl(url: string): boolean {
  if (!url) return false;
  if (
    url.startsWith("about:") ||
    url.startsWith("data:") ||
    url.startsWith("blob:")
  ) {
    return true;
  }
  const host = hostOf(url);
  if (!host) return false;
  const allowedHost = PLAYER_ALLOWED_HOST_SUFFIXES.some((s) =>
    hostMatches(host, s),
  );
  if (!allowedHost) return false;
  if (
    (hostMatches(host, "youtube.com") ||
      hostMatches(host, "youtube-nocookie.com")) &&
    YT_ESCAPE_PATH.test(pathOf(url))
  ) {
    return false;
  }
  return true;
}

/** App-owned copy for each player error code — never a dead frame. */
export function playerErrorFallback(code: number | null): {
  title: string;
  body: string;
} {
  switch (code) {
    case 100:
      return {
        title: "This clip is no longer available",
        body: "The video was removed or made private.",
      };
    case 101:
    case 150:
      return {
        title: "This clip can't be played here",
        body: "The owner turned off embedding for this video.",
      };
    case 153:
      return {
        title: "This clip couldn't start",
        body: "The player couldn't reach YouTube. Check the connection and tap to try again.",
      };
    case 2:
      return {
        title: "This clip couldn't load",
        body: "There was a problem with the video link.",
      };
    case 5:
    default:
      return {
        title: "This clip couldn't play",
        body: "Something went wrong with the player. Tap to try again.",
      };
  }
}

/** Tap-to-play poster image (no WebView, no network to YouTube's player). */
export function posterUrl(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

/**
 * The local HTML document. It embeds the SHARED privacy-enhanced clip URL
 * (`instructionVideoEmbedUrl`) in an iframe and attaches the YouTube IFrame
 * Player API to it (via `enablejsapi=1` + a matching `origin`) to surface player
 * error events — and the END of the clip — back to the app. Served with
 * `PLAYER_BASE_URL` as the WebView `baseUrl` so the Referer is present.
 *
 * WHY IT WATCHES FOR `ENDED`:
 * When a clip finishes, YouTube paints its end screen — a grid of suggested
 * videos — over the last frame. `rel=0` cannot turn that off (since 2018 it only
 * narrows the suggestions to the same channel), so the only way to keep a
 * scholar out of a suggestion rabbit hole is to leave the player the instant the
 * clip is over. On `ENDED` this document (a) hides the iframe immediately, so
 * the grid never paints even for a frame, and (b) posts `{type:'ended'}` so the
 * app unmounts the WebView and returns to its own poster with "Watch again".
 */
export function buildPlayerHtml(
  atom: Pick<InstructionVideoAtom, "videoId" | "startSec" | "endSec">,
): string {
  const src =
    instructionVideoEmbedUrl(atom) +
    `&enablejsapi=1&origin=${encodeURIComponent(PLAYER_BASE_URL)}`;
  const srcJson = JSON.stringify(src);
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<style>
  html, body { margin: 0; padding: 0; background: #000; height: 100%; overflow: hidden; }
  #player { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
</style>
</head>
<body>
<iframe id="player" src=${srcJson} frameborder="0"
  allow="encrypted-media; fullscreen" allowfullscreen></iframe>
<script>
  function post(o) {
    if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
      window.ReactNativeWebView.postMessage(JSON.stringify(o));
    }
  }
  var apiTimer = setTimeout(function () { post({ type: 'error', code: 153 }); }, 9000);
  var END_SEC = ${JSON.stringify(atom.endSec)};
  var ended = false;
  var watchdog = null;
  // The clip is over: hide the player BEFORE YouTube can paint its end-screen
  // suggestion grid, then hand back to the app (which unmounts this WebView).
  function finish() {
    if (ended) return;
    ended = true;
    if (watchdog) clearInterval(watchdog);
    var el = document.getElementById('player');
    if (el) el.style.visibility = 'hidden';
    post({ type: 'ended' });
  }
  window.onYouTubeIframeAPIReady = function () {
    try {
      var player = new YT.Player('player', {
        events: {
          onReady: function () {
            clearTimeout(apiTimer);
            post({ type: 'ready' });
            // The clock poll is the PRIMARY end detector, not a fallback:
            // probed against the real player (2026-08-07), its state event
            // arrived only AFTER the clock crossed the clip boundary — i.e.
            // onStateChange alone hands YouTube the frames in which it paints
            // the suggestion grid. Keep both; this one wins.
            watchdog = setInterval(function () {
              try {
                if (player.getCurrentTime && player.getCurrentTime() >= END_SEC - 0.1) finish();
              } catch (e) {}
            }, 100);
          },
          // 0 === YT.PlayerState.ENDED.
          onStateChange: function (e) { if (e && e.data === 0) finish(); },
          onError: function (e) { clearTimeout(apiTimer); post({ type: 'error', code: (e && e.data) || 5 }); }
        }
      });
    } catch (err) {
      clearTimeout(apiTimer);
      post({ type: 'error', code: 5 });
    }
  };
  var tag = document.createElement('script');
  tag.src = 'https://www.youtube.com/iframe_api';
  tag.onerror = function () { clearTimeout(apiTimer); post({ type: 'error', code: 153 }); };
  document.head.appendChild(tag);
</script>
</body>
</html>`;
}

export function InstructionVideo({ atom }: { atom: InstructionVideoAtom }) {
  const colors = useColors();
  const styles = makeStyles(colors);

  // The WebView does not mount until the scholar taps the poster.
  const [playing, setPlaying] = useState(false);
  const [errorCode, setErrorCode] = useState<number | null>(null);
  const [blockedNote, setBlockedNote] = useState<string | null>(null);
  // Force a fresh WebView (and thus a fresh player) on retry.
  const [reloadKey, setReloadKey] = useState(0);
  // Set once the clip has run to its end, so the poster offers "Watch again".
  const [watched, setWatched] = useState(false);

  const html = useMemo(() => buildPlayerHtml(atom), [atom]);
  const poster = posterUrl(atom.videoId);

  const startPlaying = () => {
    // Playing a clip stops the tap-to-read TTS singleton — one voice at a time.
    try {
      getNativeTTS().stop();
    } catch {
      // The engine is best-effort here; never let it block playback.
    }
    setErrorCode(null);
    setBlockedNote(null);
    setReloadKey((k) => k + 1);
    setPlaying(true);
  };

  const onMessage = (event: { nativeEvent: { data: string } }) => {
    try {
      const data = JSON.parse(event.nativeEvent.data) as {
        type?: string;
        code?: number;
      };
      if (data.type === "error") {
        setErrorCode(typeof data.code === "number" ? data.code : 5);
      } else if (data.type === "ended") {
        // The clip finished. Unmounting the WebView is what actually keeps the
        // scholar out of YouTube's end-screen suggestion grid — the document
        // hides the iframe first so the grid never even paints.
        setPlaying(false);
        setWatched(true);
      }
    } catch {
      // Non-JSON messages are not ours; ignore.
    }
  };

  const onShouldStartLoad = (request: WebViewNavigation): boolean => {
    if (isAllowedPlayerUrl(request.url)) return true;
    setBlockedNote("That link leaves this clip, so Rabbithole kept you here.");
    setTimeout(() => setBlockedNote(null), 2800);
    return false;
  };

  const fallback = errorCode !== null ? playerErrorFallback(errorCode) : null;

  return (
    <View style={styles.card}>
      {/* The one-line "why watch" — never the word "Video", never "Watch this". */}
      <Text style={styles.caption}>{atom.captionText}</Text>

      <View style={styles.stage}>
        {fallback ? (
          <Pressable
            style={styles.fallback}
            onPress={startPlaying}
            accessibilityRole="button"
            accessibilityLabel={`${fallback.title}. Tap to try again.`}
          >
            <Text style={styles.fallbackTitle}>{fallback.title}</Text>
            <Text style={styles.fallbackBody}>{fallback.body}</Text>
            <Text style={styles.fallbackRetry}>Tap to try again ↻</Text>
          </Pressable>
        ) : playing ? (
          <WebView
            key={reloadKey}
            source={{ html, baseUrl: PLAYER_BASE_URL }}
            style={styles.webView}
            originWhitelist={["https://*", "about:", "data:"]}
            // Inline playback needs BOTH playsinline in the URL (shared helper)
            // AND allowsInlineMediaPlayback here.
            allowsInlineMediaPlayback
            // Keep TRUE: tap to play, never autoplay (a standing ban).
            mediaPlaybackRequiresUserAction
            // Escape paths off a locked-down school iPad.
            allowsAirPlayForMediaPlayback={false}
            allowsPictureInPictureMediaPlayback={false}
            allowsLinkPreview={false}
            javaScriptEnabled
            domStorageEnabled
            bounces={false}
            scrollEnabled={false}
            onMessage={onMessage}
            onShouldStartLoadWithRequest={onShouldStartLoad}
          />
        ) : (
          <Pressable
            style={styles.poster}
            onPress={startPlaying}
            accessibilityRole="button"
            accessibilityLabel={watched ? "Watch the clip again" : "Play the clip"}
          >
            <Image
              source={{ uri: poster }}
              style={styles.posterImage}
              resizeMode="cover"
              alt=""
              aria-hidden
            />
            <View style={styles.posterScrim} />
            <View style={styles.playBadge}>
              <Text style={styles.playGlyph}>▶</Text>
            </View>
            <Text style={styles.posterHint}>
              {watched ? "Watch again" : "Tap to play"}
            </Text>
          </Pressable>
        )}
      </View>

      {blockedNote ? <Text style={styles.blockedNote}>{blockedNote}</Text> : null}
    </View>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    card: {
      width: "100%",
      backgroundColor: c.bgSubtle,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 14,
      padding: 16,
      gap: 12,
    },
    caption: {
      fontFamily: fonts.medium,
      fontSize: 15.5,
      lineHeight: 23,
      color: c.fg,
    },
    stage: {
      width: "100%",
      aspectRatio: 16 / 9,
      borderRadius: 12,
      overflow: "hidden",
      backgroundColor: "#000",
    },
    webView: {
      flex: 1,
      backgroundColor: "#000",
    },
    poster: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
    },
    // `StyleSheet.absoluteFill` is what this RN version's types expose (and the
    // idiom the rest of native/src uses); `absoluteFillObject` does not exist here.
    posterImage: {
      ...StyleSheet.absoluteFill,
    },
    posterScrim: {
      ...StyleSheet.absoluteFill,
      backgroundColor: "rgba(0,0,0,0.28)",
    },
    playBadge: {
      width: 64,
      height: 64,
      borderRadius: 32,
      backgroundColor: "rgba(0,0,0,0.55)",
      borderWidth: 2,
      borderColor: c.white,
      alignItems: "center",
      justifyContent: "center",
    },
    playGlyph: {
      color: c.white,
      fontSize: 26,
      // Nudge the triangle to optical center.
      marginLeft: 4,
    },
    posterHint: {
      position: "absolute",
      bottom: 12,
      fontFamily: fonts.semibold,
      fontSize: 13,
      color: c.white,
    },
    fallback: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 20,
      gap: 8,
      backgroundColor: c.bgSubtle,
    },
    fallbackTitle: {
      fontFamily: fonts.bold,
      fontSize: 15.5,
      color: c.fg,
      textAlign: "center",
    },
    fallbackBody: {
      fontFamily: fonts.regular,
      fontSize: 14,
      lineHeight: 21,
      color: c.fgMuted,
      textAlign: "center",
    },
    fallbackRetry: {
      fontFamily: fonts.semibold,
      fontSize: 13.5,
      color: c.teal,
      marginTop: 4,
    },
    blockedNote: {
      fontFamily: fonts.medium,
      fontSize: 13,
      color: c.statusRed,
    },
  });
}
