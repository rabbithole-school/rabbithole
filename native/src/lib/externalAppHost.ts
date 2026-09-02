// Tiny external-store for the keep-alive embedded WebView host. The host is
// mounted once at the app root and only hidden on close, so page state survives
// close→reopen within a launch and WKWebView's persistent store keeps cookies
// across launches.
import { useSyncExternalStore } from "react";

import type { Id } from "@/lib/convex";
import { rabbitholeWebUrl } from "@/lib/webEmbedConfig";

export type EmbeddedWebGestureMode = "page" | "interactive";

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

export function openExternalApp(app: {
  appId: Id<"externalApps">;
  name: string;
  url: string;
  webAllowedHosts?: string[] | null;
  allowedHosts?: string[] | null;
}) {
  openEmbeddedWebContent({
    kind: "externalApp",
    appId: app.appId,
    title: app.name,
    // A custom app's webUrl is a domain-agnostic path ("/custom-apps?token=…");
    // resolve it against the configured Rabbithole web origin. An absolute
    // external URL (a third-party practice site, etc.) passes through rabbitholeWebUrl unchanged.
    url: rabbitholeWebUrl(app.url),
    allowedHosts: app.allowedHosts ?? app.webAllowedHosts ?? null,
    gestureMode: "page",
  });
}

export function openWebActivity(activity: Omit<OpenWebActivity, "kind">) {
  openEmbeddedWebContent({
    ...activity,
    kind: "webActivity",
    gestureMode: activity.gestureMode ?? "page",
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
