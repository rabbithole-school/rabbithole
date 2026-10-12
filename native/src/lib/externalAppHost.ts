// Tiny external-store for the keep-alive embedded WebView host. The host is
// mounted once at the app root and only hidden on close, so page state survives
// close→reopen within a launch and WKWebView's persistent store keeps cookies
// across launches.
import { useSyncExternalStore } from "react";

import type { Id } from "@/lib/convex";
import { youTubePlayerContent } from "@/lib/activityResourcePlayer";
import {
  rabbitholeWebBaseUrl,
  rabbitholeWebUrl,
} from "@/lib/webEmbedConfig";

export type EmbeddedWebGestureMode = "page" | "interactive";

export type ExternalAppHostRequest =
  | { kind: "url" }
  | { kind: "customApp"; token: string };

export type EmbeddedWebBase = {
  title: string;
  url: string;
  /** Optional local document shell; `url` remains its identity and allowlist seed. */
  documentHtml?: string;
  /** Trusted origin used as the local document's base URL and Referer. */
  documentBaseUrl?: string;
  /** Host allowlist. Empty/unset falls back to the URL's own host. */
  allowedHosts?: string[] | null;
  /** Additional top-frame and media restrictions for locked YouTube playback. */
  navigationPolicy?: "default" | "youtube";
  /**
   * "interactive" disables native WebView scrolling/back gestures so pointer
   * drags reach canvas/SVG/Mafs-style content. The web content should also set
   * `touch-action: none` on the drag surface.
   */
  gestureMode?: EmbeddedWebGestureMode;
};

export type OpenExternalApp = EmbeddedWebBase & {
  kind: "externalApp";
  appId: Id<"externalApps">;
  hostRequest: ExternalAppHostRequest;
};

export type OpenWebActivity = EmbeddedWebBase & {
  kind: "webActivity";
  activityId: Id<"activities">;
  assignmentId?: Id<"assignments">;
  /** Optional linked catalog app; enables the saved-login helper. */
  externalAppId?: Id<"externalApps"> | null;
};

export type OpenInteractiveWebContent = EmbeddedWebBase & {
  kind: "interactive";
  /** Stable id when a caller wants one logical embed to survive URL changes. */
  id?: string;
  subtitle?: string;
  /**
   * When true, the host mints a one-shot embed-session token
   * (`api.embedAuth.issueEmbedToken`) for its OWN authenticated identity and
   * appends it to the URL as an `#et=...` fragment before loading — the prod
   * auth bridge for Rabbithole-hosted embeds that need this app's session
   * (e.g. `/embed/manipulative`, which grades via an authedMutation). Leave
   * unset for arbitrary interactive web content that carries its own auth.
   */
  authHandoff?: boolean;
};

export type OpenEmbeddedWebContent =
  | OpenExternalApp
  | OpenWebActivity
  | OpenInteractiveWebContent;

let current: OpenEmbeddedWebContent | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

export function openEmbeddedWebContent(content: OpenEmbeddedWebContent) {
  current = {
    ...content,
    gestureMode:
      content.gestureMode ?? (content.kind === "interactive" ? "interactive" : "page"),
  };
  emit();
}

export function externalAppHostRequestForUrl(
  pathOrUrl: string,
): ExternalAppHostRequest {
  try {
    const candidate = new URL(rabbitholeWebUrl(pathOrUrl));
    const webOrigin = new URL(rabbitholeWebBaseUrl).origin;
    const pathname = candidate.pathname.replace(/\/+$/, "") || "/";
    const token = candidate.searchParams.get("token")?.trim();
    if (
      candidate.origin === webOrigin &&
      pathname === "/custom-apps" &&
      token
    ) {
      return { kind: "customApp", token };
    }
  } catch {
    // Invalid values remain on the existing URL-host path.
  }
  return { kind: "url" };
}

export function nativeCustomAppHeartbeatArgs(
  sessionId: Id<"webActivitySessions">,
) {
  return {
    sessionId,
    // The launcher URL contains the bearer token and has no analytic value once
    // the live static app is running from srcdoc.
    lastUrl: undefined,
  };
}

export function openExternalApp(app: {
  appId: Id<"externalApps">;
  name: string;
  url: string;
  webAllowedHosts?: string[] | null;
  allowedHosts?: string[] | null;
}) {
  const url = rabbitholeWebUrl(app.url);
  openEmbeddedWebContent({
    kind: "externalApp",
    appId: app.appId,
    title: app.name,
    // A custom app's webUrl is a domain-agnostic path ("/custom-apps?token=…");
    // resolve it against the configured Rabbithole web origin. An absolute
    // external URL (a third-party practice site, etc.) passes through rabbitholeWebUrl unchanged.
    url,
    hostRequest: externalAppHostRequestForUrl(app.url),
    allowedHosts: app.allowedHosts ?? app.webAllowedHosts ?? null,
    gestureMode: "page",
  });
}

export function openWebActivity(activity: Omit<OpenWebActivity, "kind">) {
  // A web activity whose URL is a YouTube video must play in the SAME sandboxed
  // player video resources use (nocookie embed, locked hosts, no related /
  // Shorts / search), not the generic host-locked WebView on youtube.com. Keep
  // kind "webActivity" so the webActivitySessions lifecycle is unchanged; only
  // the embed document + allowlist + navigation policy swap in. Non-YouTube
  // activities keep their exact prior shape (`youTubePlayerContent` → null).
  const youTubePlayer = youTubePlayerContent(activity.url);
  openEmbeddedWebContent({
    ...activity,
    ...youTubePlayer,
    kind: "webActivity",
    gestureMode: youTubePlayer?.gestureMode ?? activity.gestureMode ?? "page",
  });
}

export function openInteractiveWebContent(content: Omit<OpenInteractiveWebContent, "kind">) {
  openEmbeddedWebContent({
    ...content,
    kind: "interactive",
    gestureMode: content.gestureMode ?? "interactive",
  });
}

/**
 * Open a YouTube link in the same sandboxed, locked-down player that activity
 * video resources use — no browser chrome, no end-screen, no way to wander into
 * open YouTube. Returns true when the URL was a playable YouTube video (and the
 * player was opened); returns false when it is not YouTube, so callers can fall
 * back to their normal link handling.
 */
export function openYouTubeVideo(args: {
  url: string;
  title: string;
  subtitle?: string;
  id?: string;
}): boolean {
  const content = youTubePlayerContent(args.url);
  if (!content) return false;
  openInteractiveWebContent({
    id: args.id ?? `youtube-video:${args.url}`,
    title: args.title,
    subtitle: args.subtitle,
    ...content,
  });
  return true;
}

/**
 * Open a Rabbithole-hosted manipulative in the inline embed host with the PROD
 * one-shot embed-session handoff (`authHandoff: true`) — the host hands this
 * app's identity to the `/embed/manipulative` page so it can grade as the
 * scholar. `url` is the fully-resolved `/embed/manipulative?itemId=…` URL
 * (build it with `manipulativeEmbedUrl` from webEmbedConfig).
 */
export function openManipulativeEmbed(
  content: Omit<OpenInteractiveWebContent, "kind" | "authHandoff">,
) {
  openEmbeddedWebContent({
    ...content,
    kind: "interactive",
    gestureMode: content.gestureMode ?? "interactive",
    authHandoff: true,
  });
}

export function closeEmbeddedWebContent() {
  current = null;
  emit();
}

// Back-compat aliases for the existing External App launcher code.
export const closeExternalApp = closeEmbeddedWebContent;

export function useOpenEmbeddedWebContent(): OpenEmbeddedWebContent | null {
  return useSyncExternalStore(
    (callback) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    () => current,
  );
}

export const useOpenExternalApp = useOpenEmbeddedWebContent;
