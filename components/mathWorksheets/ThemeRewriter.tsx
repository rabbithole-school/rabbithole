"use client";

/**
 * "Make it about what your kid loves": the optional AI layer on a worksheet.
 * Rewrites only the story of each word problem; themeRewrite.ts checks that
 * every number, number word and unit survived, and a problem that fails keeps
 * its plain wording. The grown-up pays with their own OpenRouter sign-in or a
 * pasted key, the call goes from this tab straight to the provider, and the
 * key lives in page memory only.
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  complete,
  finishOpenRouterSignIn,
  keyFromPaste,
  KeyRejectedError,
  OPENROUTER_LIMIT_USD,
  startOpenRouterSignIn,
  type ModelKey,
} from "@/lib/mathWorksheets/byoModel";
import {
  acceptRewrites,
  cleanTheme,
  MAX_THEME_LENGTH,
  REWRITE_SYSTEM,
  rewriteUserPrompt,
  type RewriteCandidate,
} from "@/lib/mathWorksheets/themeRewrite";

// Page memory: survives moving between sheets in this tab, gone on reload.
let heldKey: ModelKey | null = null;
let pendingTheme: string | null = null;

const RETURN_KEY = "mw-openrouter-return";

export function ThemeRewriter({
  candidates,
  onRewrite,
}: {
  candidates: RewriteCandidate[];
  onRewrite: (rewrites: Map<number, string>) => void;
}) {
  const router = useRouter();
  const [theme, setTheme] = useState(() => pendingTheme ?? "");
  const [key, setKey] = useState<ModelKey | null>(heldKey);
  const [showPaste, setShowPaste] = useState(false);
  const [paste, setPaste] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ran = useRef(false);

  async function run(k: ModelKey, rawTheme: string) {
    const t = cleanTheme(rawTheme);
    if (!t) {
      setError("Type a topic first, like dinosaurs or soccer.");
      return;
    }
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const reply = await complete(k, REWRITE_SYSTEM, rewriteUserPrompt(t, candidates));
      const { accepted, rejected } = acceptRewrites(candidates, reply);
      onRewrite(accepted);
      const kept = rejected.length;
      setStatus(
        `Rewrote ${accepted.size} of ${candidates.length} word problems about ${t}.` +
          (kept ? ` ${kept} kept their plain wording because the rewrite changed a number or unit.` : ""),
      );
    } catch (e) {
      if (e instanceof KeyRejectedError) {
        heldKey = null;
        setKey(null);
      }
      setError(e instanceof Error ? e.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  // Back from OpenRouter with ?code=…: trade it for a key, restore the sheet
  // the grown-up was on, and finish the rewrite they asked for. Every state
  // update happens in a callback, after the effect body has returned.
  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const url = new URL(window.location.href);
    const code = url.searchParams.get("code");
    if (!code) {
      if (heldKey && pendingTheme) {
        const k = heldKey;
        const t = pendingTheme;
        pendingTheme = null;
        setTimeout(() => void run(k, t), 0);
      }
      return;
    }
    let saved: { query: string; theme: string } | null = null;
    try {
      saved = JSON.parse(sessionStorage.getItem(RETURN_KEY) ?? "null");
    } catch {
      saved = null;
    }
    sessionStorage.removeItem(RETURN_KEY);
    url.searchParams.delete("code");
    window.history.replaceState(null, "", url.pathname + url.search);
    if (saved?.theme) setTimeout(() => setTheme(saved.theme), 0);
    finishOpenRouterSignIn(code)
      .then((k) => {
        heldKey = k;
        setKey(k);
        if (saved && saved.query !== url.search) {
          // A different sheet: go back to it; the remounted panel finishes the run.
          pendingTheme = saved.theme || null;
          router.replace(url.pathname + saved.query, { scroll: false });
        } else if (saved?.theme) {
          void run(k, saved.theme);
        }
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : "Sign-in did not finish. Try again.");
      });
    // Runs once on mount by design.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function signIn() {
    const t = cleanTheme(theme);
    if (!t) {
      setError("Type a topic first, like dinosaurs or soccer.");
      return;
    }
    sessionStorage.setItem(RETURN_KEY, JSON.stringify({ query: window.location.search, theme: t }));
    await startOpenRouterSignIn(window.location.origin + window.location.pathname);
  }

  function applyPastedKey() {
    const k = keyFromPaste(paste);
    if (!k) {
      setError("That doesn't look like an OpenRouter key (sk-or-…) or an Anthropic key (sk-ant-…).");
      return;
    }
    heldKey = k;
    setKey(k);
    setPaste("");
    setShowPaste(false);
    void run(k, theme);
  }

  function forget() {
    heldKey = null;
    setKey(null);
    setStatus(null);
  }

  return (
    <div className="mw-surface mw-noprint" aria-labelledby="mw-theme-h">
      <h2 className="mw-h2" id="mw-theme-h">
        Make it about what your kid loves
      </h2>
      <p className="mw-p">
        An AI model can rewrite the {candidates.length === 1 ? "word problem" : `${candidates.length} word problems`} on this
        sheet around a topic. The numbers, units and answers stay exactly the same, and we check every one before showing
        it. It runs on your own AI account, and a sheet costs about a cent.
      </p>
      <div className="mw-controls">
        <label className="mw-field" style={{ flex: "1 1 220px" }}>
          A topic, like dinosaurs or soccer
          <input
            value={theme}
            maxLength={MAX_THEME_LENGTH}
            onChange={(e) => setTheme(e.target.value)}
            placeholder="dinosaurs"
            autoComplete="off"
          />
        </label>
        {key ? (
          <>
            <button type="button" className="mw-btn mw-btn-primary" disabled={busy} onClick={() => void run(key, theme)}>
              {busy ? "Rewriting…" : "Rewrite the word problems"}
            </button>
            <button type="button" className="mw-btn" onClick={forget}>
              Forget my key
            </button>
          </>
        ) : (
          <>
            <button type="button" className="mw-btn mw-btn-primary" disabled={busy} onClick={() => void signIn()}>
              {busy ? "Signing in…" : "Sign in with OpenRouter"}
            </button>
            <button type="button" className="mw-btn" onClick={() => setShowPaste((v) => !v)}>
              I have an API key
            </button>
          </>
        )}
      </div>
      <p className="mw-note">
        A topic only, please, with no names. For grown-ups: we never ask anything about your child and store nothing.
        The topic and this sheet&rsquo;s word problems go from this tab to the AI service you choose, and nowhere else.
      </p>
      {!key && (
        <p className="mw-note">
          OpenRouter is a service that sells AI model use. You sign in there, add a few dollars of credit if you have none,
          and approve a key with a ${OPENROUTER_LIMIT_USD} spending limit (you can change it). OpenRouter sends the bill to
          you. The key stays in this tab and is forgotten when you close or reload it.
        </p>
      )}
      {showPaste && !key && (
        <div className="mw-controls" style={{ marginTop: 12 }}>
          <label className="mw-field" style={{ flex: "1 1 280px" }}>
            OpenRouter or Anthropic API key
            <input
              type="password"
              value={paste}
              onChange={(e) => setPaste(e.target.value)}
              placeholder="sk-or-… or sk-ant-…"
              autoComplete="off"
            />
          </label>
          <button type="button" className="mw-btn" onClick={applyPastedKey}>
            Use this key
          </button>
        </div>
      )}
      {showPaste && !key && (
        <p className="mw-note">
          The key goes from this tab straight to the provider and is dropped when you close the tab. Our server never sees it.
          A key with a small spending limit is the safest kind to paste anywhere.
        </p>
      )}
      {status && <p className="mw-note">{status}</p>}
      {error && <p className="mw-error">{error}</p>}
    </div>
  );
}
