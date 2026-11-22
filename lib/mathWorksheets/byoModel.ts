/**
 * Bring-your-own-tokens model calls for the worksheet maker, made from the
 * browser straight to the provider. Our server never sees a key, and there is
 * no free allowance: the grown-up pays the provider from the first rewrite.
 *
 * Two ways in:
 * - OpenRouter sign-in (OAuth PKCE). The grown-up signs in on OpenRouter,
 *   approves a key with a spending limit we prefill, and is billed by
 *   OpenRouter. Only the one-time PKCE verifier waits in sessionStorage across
 *   the redirect (OpenRouter's docs allow that); the key itself lives in page
 *   memory and is gone on reload.
 * - Paste a key (developers): an OpenRouter key (sk-or-…) or an Anthropic key
 *   (sk-ant-…), also held in memory only.
 */

/** A small, fast model is enough to retell a word problem; the checker guards the numbers. */
export const OPENROUTER_MODEL = "anthropic/claude-haiku-5.5";
export const ANTHROPIC_MODEL = "claude-haiku-5-5";
/** Prefilled on OpenRouter's approval screen, in US dollars; the grown-up can change it. */
export const OPENROUTER_LIMIT_USD = 2;
export const OPENROUTER_EXPIRATION = "30-days";

const VERIFIER_KEY = "mw-openrouter-verifier";

export type ModelKey = { provider: "openrouter" | "anthropic"; key: string };

export function keyFromPaste(raw: string): ModelKey | null {
  const key = raw.trim();
  if (/^sk-or-[A-Za-z0-9_-]{10,}$/.test(key)) return { provider: "openrouter", key };
  if (/^sk-ant-[A-Za-z0-9_-]{10,}$/.test(key)) return { provider: "anthropic", key };
  return null;
}

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

/** Send the grown-up to OpenRouter; they come back to `returnUrl` with `?code=`. */
export async function startOpenRouterSignIn(returnUrl: string): Promise<void> {
  const { verifier, challenge } = await pkcePair();
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  const q = new URLSearchParams({
    callback_url: returnUrl,
    code_challenge: challenge,
    code_challenge_method: "S256",
    limit: String(OPENROUTER_LIMIT_USD),
    expiration: OPENROUTER_EXPIRATION,
    key_label: "Rabbithole math worksheets",
  });
  window.location.assign(`https://openrouter.ai/auth?${q.toString()}`);
}

/** Trade the one-time code for a key. The verifier is removed either way. */
export async function finishOpenRouterSignIn(code: string): Promise<ModelKey> {
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);
  if (!verifier) throw new Error("This sign-in started in another tab or expired. Try again.");
  const res = await fetch("https://openrouter.ai/api/v1/auth/keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
  });
  if (!res.ok) throw new Error(`OpenRouter said no (${res.status}). Try signing in again.`);
  const { key } = (await res.json()) as { key?: string };
  if (!key) throw new Error("OpenRouter sent no key. Try signing in again.");
  return { provider: "openrouter", key };
}

/** One system + user turn; returns the reply text. */
export async function complete(k: ModelKey, system: string, user: string): Promise<string> {
  if (k.provider === "openrouter") {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${k.key}`,
        "X-Title": "Rabbithole math worksheets",
        "HTTP-Referer": window.location.origin,
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        max_tokens: 2000,
        temperature: 0.7,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) throw new Error(await providerError(res));
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content ?? "";
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": k.key,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 2000,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok) throw new Error(await providerError(res));
  const data = (await res.json()) as { content?: { type: string; text?: string }[] };
  return (data.content ?? []).map((c) => c.text ?? "").join("");
}

/** The provider refused the key itself; the caller should forget it. */
export class KeyRejectedError extends Error {}

async function providerError(res: Response): Promise<string> {
  if (res.status === 401 || res.status === 403) throw new KeyRejectedError("That key was turned down. Check it, or sign in again.");
  if (res.status === 402) return "Your OpenRouter credit has run out. Add credit on OpenRouter, then try again.";
  if (res.status === 429) return "The provider is busy. Wait a minute and try again.";
  return `The provider returned an error (${res.status}).`;
}
