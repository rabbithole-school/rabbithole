"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Button, Spinner } from "@chakra-ui/react";
import { MagnifyingGlass } from "@phosphor-icons/react";
import { useAction } from "convex/react";
import { api } from "@/convex/_generated/api";

// Picker JS API types — Google ships no official @types package, so we
// declare just the surface we use. `eslint-disable` because there's no
// good alternative for ambient browser globals.
declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    gapi?: any;
    google?: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      accounts: any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      picker: any;
    };
  }
}

interface PickerResultDoc {
  id: string;
  name?: string;
  url?: string;
  mimeType?: string;
}

interface GooglePickerButtonProps {
  onPicked: (doc: PickerResultDoc) => void;
  /** Override label. */
  label?: string;
  /** Override the leading icon (defaults to the search magnifier). */
  icon?: ReactNode;
  /** Disable while a parent action is running. */
  disabled?: boolean;
  /** Optional pre-fetched access token; saves a round-trip when one is
   *  already in scope (e.g. parent already used it for another call). */
  accessTokenHint?: string;
  /**
   * "slides" (default) shows a Slides-only picker; "files" shows a general
   * Drive file picker restricted to scannable types (PDF / images);
   * "documents" shows a Google Docs–only picker (for linking a Doc);
   * "drive" shows EVERY file type in Drive (no mime filter) — for surfaces
   * that can read anything, e.g. the curriculum chatbot's attachments;
   * "folders" shows a folder picker (select a Drive folder, e.g. the
   * scanner inbox for drive-sync).
   */
  mode?: "slides" | "files" | "documents" | "drive" | "folders";
  /**
   * Replace the default outline Button with a custom trigger (e.g. a launcher
   * tile). Receives the click handler and current loading/disabled state.
   */
  renderTrigger?: (opts: { onClick: () => void; loading: boolean; disabled: boolean }) => ReactNode;
}

// Keep in lockstep with the server-side ingest allow-list
// (convex/lib/ingestMimes.ts). HEIC/HEIF are intentionally excluded — the
// pipeline can't read them, so offering them in the picker would just produce
// an "Unsupported file type" failure after the round-trip.
const SCAN_MIME_TYPES = "application/pdf,image/jpeg,image/png,image/webp,image/gif";
const GDOC_MIME = "application/vnd.google-apps.document";
const FOLDER_MIME = "application/vnd.google-apps.folder";

// Note: the picker opens BELOW Chakra's modal layer (it sets an inline z-index
// ~1001), so when launched from inside the scanner "Upload" drawer it would
// appear behind it. That's corrected in globals.css with a `.picker-dialog`
// !important rule rather than here — the picker re-applies its own inline
// z-index after it mounts, which beats any JS we'd run at open time. That
// z-index rule is the only styling we can apply: the picker injects just its
// chrome (`.picker-dialog` + backdrop) into our DOM and renders all of its
// content inside a cross-origin `iframe.picker-dialog-frame` on
// docs.google.com, which our stylesheets cannot reach.

const SCRIPT_URLS = {
  gapi: "https://apis.google.com/js/api.js",
  gis: "https://accounts.google.com/gsi/client",
};

/** Idempotent script loader keyed by URL. */
function loadScript(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof document === "undefined") {
      reject(new Error("Picker can only be used in the browser"));
      return;
    }
    const existing = document.querySelector(
      `script[src="${url}"]`
    ) as HTMLScriptElement | null;
    if (existing) {
      if (existing.dataset.loaded === "true") {
        resolve();
        return;
      }
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () =>
        reject(new Error(`Failed to load ${url}`))
      );
      return;
    }
    const s = document.createElement("script");
    s.src = url;
    s.async = true;
    s.defer = true;
    s.addEventListener("load", () => {
      s.dataset.loaded = "true";
      resolve();
    });
    s.addEventListener("error", () =>
      reject(new Error(`Failed to load ${url}`))
    );
    document.head.appendChild(s);
  });
}

/**
 * Button that loads the Google Picker, requests an access token via
 * Google Identity Services (silent reauth if the user already
 * consented through our server-side OAuth), and opens a Slides-only
 * Picker. On selection it invokes `onPicked({ id, url, name })`.
 *
 * Failures alert the user with a specific message — much easier to
 * debug than the generic "Picker closed" silent-fail mode.
 */
export function GooglePickerButton({
  onPicked,
  label = "Pick a Google Slides deck",
  icon,
  disabled = false,
  accessTokenHint,
  mode = "slides",
  renderTrigger,
}: GooglePickerButtonProps) {
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_API_KEY;
  const clientId = process.env.NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID;
  const [loading, setLoading] = useState(false);
  const [scriptsReady, setScriptsReady] = useState(false);
  // Mint the signed-in user's Drive token server-side (bypasses the GIS popup).
  const getServerDriveToken = useAction(
    api.googleAccountsActions.getDriveAccessToken,
  );

  // Lazy-load both scripts on mount so the first click is instant.
  useEffect(() => {
    let cancelled = false;
    Promise.all([loadScript(SCRIPT_URLS.gapi), loadScript(SCRIPT_URLS.gis)])
      .then(() => {
        if (cancelled) return;
        // Load the picker module once gapi is available.
        if (window.gapi?.load) {
          window.gapi.load("picker", () => {
            if (!cancelled) setScriptsReady(true);
          });
        }
      })
      .catch(() => {
        // Network errors will surface when the user clicks; don't toast
        // on mount.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const requestAccessToken = useCallback(async (): Promise<string> => {
    if (accessTokenHint) return accessTokenHint;

    // Prefer a server-minted token for the signed-in user. This bypasses the
    // GIS OAuth popup entirely — that popup polls the cross-origin OAuth
    // window's `closed`/postMessage state to return the token, a handshake
    // that browsers now sever under popup-isolation / third-party-storage
    // rules, leaving the flow to hang forever (no callback, no error_callback,
    // just a spinner + a benign COOP console warning). When the user has a
    // linked Google account with Drive read scope this resolves immediately;
    // otherwise it returns null and we fall back to the GIS flow below.
    try {
      const server = await getServerDriveToken();
      if (server?.token) return server.token;
    } catch {
      // Not signed in to Convex, no linked account, or the mint failed —
      // fall through to the in-browser GIS popup, which may still work.
    }

    return new Promise<string>((resolve, reject) => {
      if (!clientId) {
        reject(new Error("NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID not set"));
        return;
      }
      if (!window.google?.accounts?.oauth2) {
        reject(new Error("Google Identity Services not loaded"));
        return;
      }
      const tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope:
          "https://www.googleapis.com/auth/drive.readonly " +
          "https://www.googleapis.com/auth/drive.file",
        // Default behavior: silent if scope already granted to this
        // client_id, else show a consent popup. We previously passed
        // `prompt: ""` (auto-no-interaction) which meant the popup
        // would fail to appear when the user hadn't yet granted
        // drive.readonly — they'd hit "Token request failed" with no
        // way forward. Letting GIS prompt as needed handles the
        // new-scope reconsent path cleanly.
        callback: (resp: { access_token?: string; error?: string }) => {
          if (resp.error) {
            reject(new Error(`Token request failed: ${resp.error}`));
            return;
          }
          if (!resp.access_token) {
            reject(new Error("No access token returned"));
            return;
          }
          resolve(resp.access_token);
        },
        // CRITICAL: GIS routes popup-level failures (popup blocked, popup
        // closed before finishing, and Workspace-admin-blocked scope grants)
        // to `error_callback`, NOT `callback`. Without this the success
        // callback simply never fires, the wrapping Promise never settles, and
        // the trigger spins forever with no feedback. Reject so the caller can
        // stop the spinner and surface a real message.
        error_callback: (err?: { type?: string; message?: string }) => {
          const code = err?.type ?? "unknown";
          const e = new Error(
            code === "popup_failed_to_open"
              ? "Google sign-in popup was blocked. Allow pop-ups for this site, then try again."
              : code === "popup_closed"
              ? "Google sign-in was cancelled."
              : `Google sign-in failed${err?.message ? `: ${err.message}` : ""}.`,
          ) as Error & { code?: string };
          e.code = code;
          reject(e);
        },
      });
      tokenClient.requestAccessToken();
    });
  }, [clientId, accessTokenHint, getServerDriveToken]);

  const openPicker = useCallback(async () => {
    if (!apiKey) {
      alert("NEXT_PUBLIC_GOOGLE_API_KEY is not set.");
      return;
    }
    if (!clientId) {
      alert("NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID is not set.");
      return;
    }
    setLoading(true);
    try {
      const accessToken = await requestAccessToken();
      const google = window.google;
      if (!google?.picker) {
        throw new Error("Picker library failed to load");
      }
      // Two views — a primary "My Drive" view + "Recents" — scoped by mode:
      // Slides-only for deck attachment, PDF/image files for scan import,
      // Google Docs for linking, ANY file for "drive", or folders for the
      // drive-sync inbox.
      const primaryView =
        mode === "files"
          ? new google.picker.DocsView(google.picker.ViewId.DOCS)
              .setIncludeFolders(false)
              .setSelectFolderEnabled(false)
              .setMimeTypes(SCAN_MIME_TYPES)
              .setMode(google.picker.DocsViewMode.LIST)
          : mode === "drive"
          ? // No setMimeTypes at all — that's what makes every file type show
            // up. Folders are included so the user can navigate into them, but
            // not selectable (a folder isn't an attachment).
            new google.picker.DocsView(google.picker.ViewId.DOCS)
              .setIncludeFolders(true)
              .setSelectFolderEnabled(false)
              .setMode(google.picker.DocsViewMode.LIST)
          : mode === "documents"
          ? new google.picker.DocsView(google.picker.ViewId.DOCUMENTS)
              .setIncludeFolders(false)
              .setSelectFolderEnabled(false)
              .setMimeTypes(GDOC_MIME)
              .setMode(google.picker.DocsViewMode.LIST)
          : mode === "folders"
          ? new google.picker.DocsView(google.picker.ViewId.FOLDERS)
              .setIncludeFolders(true)
              .setSelectFolderEnabled(true)
              .setMimeTypes(FOLDER_MIME)
              .setMode(google.picker.DocsViewMode.LIST)
          : new google.picker.DocsView(google.picker.ViewId.PRESENTATIONS)
              .setIncludeFolders(false)
              .setSelectFolderEnabled(false)
              .setMode(google.picker.DocsViewMode.LIST);

      const picker = new google.picker.PickerBuilder()
        .setOAuthToken(accessToken)
        .setDeveloperKey(apiKey)
        .setAppId(clientId.split("-")[0]) // numeric project id prefix
        // Pin the picker's postMessage origin to this page. Without it the
        // picker infers an origin and, in some embeddings, the dialog silently
        // fails to appear (renders nothing, throws nothing). Harmless when it
        // already matches; required when it doesn't.
        .setOrigin(window.location.protocol + "//" + window.location.host)
        .addView(primaryView);
      // A "recently picked" second view helps for files/decks, but recents of
      // folders is noise — folders mode gets just the folder browser.
      if (mode !== "folders") {
        const recentView = new google.picker.DocsView(
          google.picker.ViewId.RECENTLY_PICKED
        );
        // "drive" mode deliberately sets NO mime filter here either.
        if (mode !== "drive") {
          recentView.setMimeTypes(
            mode === "files"
              ? SCAN_MIME_TYPES
              : mode === "documents"
              ? GDOC_MIME
              : "application/vnd.google-apps.presentation"
          );
        }
        picker.addView(recentView);
      }
      picker
        .setTitle(
          mode === "files"
            ? "Choose a file"
            : mode === "drive"
            ? "Choose a file from Drive"
            : mode === "documents"
            ? "Choose a Google Doc"
            : mode === "folders"
            ? "Choose a folder"
            : "Choose a Google Slides deck"
        )
        .setCallback(
          (data: {
            action: string;
            docs?: Array<{
              id: string;
              name?: string;
              url?: string;
              mimeType?: string;
            }>;
          }) => {
            if (data.action === google.picker.Action.PICKED) {
              const doc = data.docs?.[0];
              if (doc) onPicked({ id: doc.id, name: doc.name, url: doc.url, mimeType: doc.mimeType });
              setLoading(false);
            } else if (data.action === google.picker.Action.CANCEL) {
              setLoading(false);
            }
          }
        );
      picker.build().setVisible(true);
      // The classic picker injects a `.picker-dialog` element into <body> as
      // soon as it opens. Watch for it so a SILENT failure to open can't leave
      // the user staring at nothing: if it never appears, the picker didn't
      // load — almost always the Picker API is not enabled on the Google
      // project, or the API key is restricted to other domains — so surface an
      // actionable message and stop the spinner. Once it does appear, clear the
      // spinner (the picker is now the visible surface; its own callback
      // handles pick/cancel).
      const startedAt = Date.now();
      const poll = window.setInterval(() => {
        if (document.querySelector(".picker-dialog")) {
          window.clearInterval(poll);
          setLoading(false);
        } else if (Date.now() - startedAt > 4000) {
          window.clearInterval(poll);
          setLoading(false);
          console.error(
            "[GooglePicker] dialog never mounted after setVisible(true).",
            { apiKeyPresent: !!apiKey, mode, origin: window.location.origin },
          );
          alert(
            "The Google Drive picker didn't open. This usually means the " +
              "Picker API isn't enabled for the Google Cloud project, or the " +
              "API key is restricted to other domains. Open the browser " +
              "console for the exact Google error, then try again.",
          );
        }
      }, 150);
    } catch (e) {
      // A closed popup is an ordinary cancel — reset silently. Everything else
      // (blocked popup, blocked scopes, picker load failure) gets a message so
      // the user isn't left staring at a spinner. Either way the spinner stops.
      const code = (e as { code?: string })?.code;
      if (code !== "popup_closed") {
        alert(
          "Could not open Google Picker: " +
            (e instanceof Error ? e.message : String(e)),
        );
      }
      setLoading(false);
    }
  }, [apiKey, clientId, onPicked, requestAccessToken, mode]);

  if (renderTrigger) {
    return <>{renderTrigger({ onClick: openPicker, loading, disabled: disabled || !scriptsReady })}</>;
  }

  return (
    <Button
      size="sm"
      variant="outline"
      fontFamily="heading"
      onClick={openPicker}
      disabled={disabled || loading || !scriptsReady}
    >
      {loading ? (
        <Spinner size="sm" />
      ) : (
        <>
          {icon ?? <MagnifyingGlass />}
          <span style={{ marginLeft: 6 }}>{label}</span>
        </>
      )}
    </Button>
  );
}
