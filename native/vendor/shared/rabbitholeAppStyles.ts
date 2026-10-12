/**
 * rabbithole-app.css — the host-injected "brand SDK" stylesheet for sandboxed
 * embedded apps (Vibecode / code artifacts AND custom apps).
 *
 * Authored as a TypeScript module (not a standalone .css file) for ONE reason:
 * it must be injected as an INLINE <style> under a strict, network-less CSP and
 * shipped identically to three runtimes — the web workshop iframe
 * (components/CodeArtifactViewer.tsx), the web custom-app iframe
 * (app/custom-apps/page.tsx) and the native WebView
 * (native/src/components/ExternalAppHost.tsx) — all of which go through the one
 * shared injection path, `injectAppStateSdk` (lib/appStateBridge.mjs). A JS
 * string works in every one; a `.css` import (needing a bundler loader + fetch)
 * would not survive the opaque-origin `default-src 'none'` sandbox.
 *
 * WHAT IT DOES (and deliberately does NOT):
 *   - Gives UI ACTIONS — buttons, inputs, selects, toolbars, cards, banners,
 *     chips — the Rabbithole look: purple primary, brand radii, focus rings,
 *     44px touch targets, and the Hanken Grotesk typeface (inlined @font-face,
 *     so it renders with NO network under the strict CSP).
 *   - Leaves CONTENT free: it sets no colors on generic elements, so an app's
 *     emoji, illustrations, and its own themed content render untouched.
 *
 * CASCADE NOTE: `injectAppStateSdk` places this block right after the doctype,
 * BEFORE the app's own <head>/<style>. So every element default here is an
 * OVERRIDABLE default — an app that deliberately restyles a control wins on
 * source order; an app that doesn't inherits the brand. That is the intended
 * contract (see convex/prompts.ts APP DESIGN RULES).
 */
import { HANKEN_GROTESK_WOFF2_DATA_URI } from "./hankenGroteskFontData";

/** The stylesheet body (no <style> wrapper). Exported for tests. */
export const RABBITHOLE_APP_STYLESHEET = `
@font-face {
  font-family: 'Hanken Grotesk';
  font-style: normal;
  font-weight: 300 700;
  font-display: swap;
  src: url(${HANKEN_GROTESK_WOFF2_DATA_URI}) format('woff2');
}

:root {
  /* Typeface */
  --rh-font: 'Hanken Grotesk', system-ui, -apple-system, 'Segoe UI', sans-serif;

  /* Brand color tokens (mirrors shared/brand.ts — the single source of truth) */
  --rh-primary: #a960bc;          /* violet.500 — the purple primary action */
  --rh-primary-hover: #734180;    /* violet.700 */
  --rh-primary-active: #61376c;   /* violet.800 */
  --rh-primary-contrast: #ffffff;
  --rh-primary-subtle: #faf6fb;   /* violet.50 */
  --rh-primary-muted: #ecdbf0;    /* violet.100 */

  --rh-navy: #222656;             /* navy.500 */
  --rh-accent: #ffa639;           /* orange.500 */
  --rh-green: #00dd91;            /* green.500 */
  --rh-yellow: #ffe77c;           /* yellow.500 */

  --rh-cyan: #2eccdf;             /* cyan.500 */
  --rh-cyan-subtle: #f0fbfc;      /* cyan.50 — the rehearsal-banner fill */
  --rh-cyan-border: #c9f2f7;      /* cyan.200 */
  --rh-cyan-fg: #24a3b3;          /* cyan.700 */

  /* Surfaces & text */
  --rh-bg: #ffffff;
  --rh-bg-subtle: #f9fafa;        /* gray.50 */
  --rh-bg-muted: #f0f1f3;         /* gray.100 */
  --rh-surface: #ffffff;
  --rh-fg: #364153;               /* charcoal.500 — body text */
  --rh-fg-muted: #6d7584;         /* charcoal.400 */
  --rh-border: #e6e8ea;           /* gray.200 */
  --rh-border-strong: #d0d4d9;    /* gray.300 */

  /* Radii (shared/brand.ts radii scale) */
  --rh-radius-sm: 4px;
  --rh-radius-md: 8px;
  --rh-radius-lg: 12px;
  --rh-radius-xl: 16px;
  --rh-radius-full: 9999px;

  /* Depth & ergonomics */
  --rh-shadow-sm: 0 1px 2px rgba(34, 38, 86, 0.06);
  --rh-shadow-md: 0 4px 12px rgba(34, 38, 86, 0.1);
  --rh-focus-ring: 0 0 0 3px rgba(169, 96, 188, 0.35);
  --rh-touch: 44px;               /* Apple HIG minimum touch target */

  font-family: var(--rh-font);
  color-scheme: light;
}

/* Brand typography inherits everywhere unless the app overrides it. Content
   colors are left entirely to the app. */
html {
  font-family: var(--rh-font);
  -webkit-text-size-adjust: 100%;
}

/* Keyboard focus is always a brand ring, on every focusable control. */
:focus-visible {
  outline: 2px solid var(--rh-primary);
  outline-offset: 2px;
}

/* ── Buttons ─────────────────────────────────────────────────────────────
   The default button is the Rabbithole purple primary. Form controls do not
   inherit font-family from the page, so it is set explicitly. */
button,
input[type='button'],
input[type='submit'],
input[type='reset'] {
  font-family: inherit;
  font-size: 1rem;
  font-weight: 600;
  line-height: 1.2;
  color: var(--rh-primary-contrast);
  background-color: var(--rh-primary);
  border: 1px solid transparent;
  border-radius: var(--rh-radius-md);
  padding: 0 18px;
  min-height: var(--rh-touch);
  min-width: var(--rh-touch);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  cursor: pointer;
  touch-action: manipulation;
  transition: background-color 0.15s ease, box-shadow 0.15s ease,
    opacity 0.15s ease;
}
button:hover,
input[type='button']:hover,
input[type='submit']:hover,
input[type='reset']:hover {
  background-color: var(--rh-primary-hover);
}
button:active,
input[type='button']:active,
input[type='submit']:active,
input[type='reset']:active {
  background-color: var(--rh-primary-active);
}
button:disabled,
input[type='button']:disabled,
input[type='submit']:disabled,
input[type='reset']:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Secondary / ghost variants apps can opt into by class. */
.rh-btn-secondary {
  color: var(--rh-primary-hover);
  background-color: var(--rh-primary-subtle);
  border-color: var(--rh-primary-muted);
}
.rh-btn-secondary:hover {
  background-color: var(--rh-primary-muted);
}
.rh-btn-ghost {
  color: var(--rh-primary-hover);
  background-color: transparent;
  border-color: transparent;
}
.rh-btn-ghost:hover {
  background-color: var(--rh-primary-subtle);
}

/* ── Text inputs & selects ───────────────────────────────────────────────
   Only text-like inputs get the field treatment — checkboxes, radios, ranges,
   colors and file pickers keep their native rendering. */
input[type='text'],
input[type='search'],
input[type='email'],
input[type='number'],
input[type='password'],
input[type='tel'],
input[type='url'],
input[type='date'],
input[type='time'],
input[type='datetime-local'],
input[type='month'],
input[type='week'],
input:not([type]),
select,
textarea {
  font-family: inherit;
  font-size: 1rem;
  color: var(--rh-fg);
  background-color: var(--rh-surface);
  border: 1px solid var(--rh-border);
  border-radius: var(--rh-radius-md);
  padding: 0 12px;
  min-height: var(--rh-touch);
}
textarea {
  padding: 10px 12px;
  line-height: 1.5;
  min-height: calc(var(--rh-touch) * 1.5);
}
input[type='text']:focus,
input[type='search']:focus,
input[type='email']:focus,
input[type='number']:focus,
input[type='password']:focus,
input[type='tel']:focus,
input[type='url']:focus,
input[type='date']:focus,
input[type='time']:focus,
input:not([type]):focus,
select:focus,
textarea:focus {
  border-color: var(--rh-primary);
}

/* Range + checkbox + radio pick up the brand color where the platform allows. */
input[type='range'],
input[type='checkbox'],
input[type='radio'] {
  accent-color: var(--rh-primary);
  touch-action: manipulation;
}

/* ── Surfaces ────────────────────────────────────────────────────────────
   Opt-in structural classes so an app's chrome reads as Rabbithole without
   forcing any of it. */
.rh-card {
  background: var(--rh-surface);
  border: 1px solid var(--rh-border);
  border-radius: var(--rh-radius-lg);
  padding: 16px;
  box-shadow: var(--rh-shadow-sm);
}
.rh-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--rh-bg-subtle);
  border: 1px solid var(--rh-border);
  border-radius: var(--rh-radius-lg);
}
.rh-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  background: var(--rh-cyan-subtle);
  border: 1px solid var(--rh-cyan-border);
  border-radius: var(--rh-radius-lg);
  color: var(--rh-cyan-fg);
  font-weight: 600;
  font-size: 0.9375rem;
}
.rh-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  min-height: 28px;
  background: var(--rh-primary-subtle);
  color: var(--rh-primary-hover);
  border: 1px solid var(--rh-primary-muted);
  border-radius: var(--rh-radius-full);
  font-size: 0.8125rem;
  font-weight: 600;
}
`.trim();

/**
 * The full <style> element to inject. `id`/`data-rh-stylesheet` make it easy to
 * spot in a captured srcDoc and prove which host stripped or kept it.
 */
export const RABBITHOLE_APP_STYLE_ELEMENT = `<style id="rabbithole-app-styles" data-rh-stylesheet="rabbithole-app.css">${RABBITHOLE_APP_STYLESHEET}</style>`;
