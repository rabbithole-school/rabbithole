# AGENTS.md — Rabbithole for adopters

This file is written for a coding agent standing up a Rabbithole deployment.
Read it before you touch the code. Then read `DEPLOYMENT.md`.

## What Rabbithole is

Rabbithole is a Socratic AI tutor for gifted learners. It challenges rather than
answers, withholds solutions, and asks better questions, so the learner thinks
more, not less. Scholars work in sessions with the tutor; teachers watch,
guide, and shape the curriculum; parents see their own children's progress.

**Licensing comes first.** This repository is source-available, not open source.
It is published for inspection. `LICENSE` grants no right to use, copy, modify,
distribute, or deploy the code. Deploying requires prior written permission from
the maintainers. Read `README.md` and `LICENSE`, and contact the maintainers
through the issue tracker before you deploy. Do not treat this document as
permission to run Rabbithole.

## The shape of the repository

Rabbithole ships two separate frontends over one backend:

- **Web** — `app/`, `components/`, `hooks/`. A Next.js and React application.
- **Native iPad** — `native/`. A separate Expo React Native app with its own
  screens. It is real React Native: no DOM, no HTML, no web-only libraries.
- **Backend** — `convex/`. Queries, mutations, actions, and HTTP actions on
  Convex. `convex/schema.ts` is the source of truth for the data model.
- **Shared** — `shared/`. Framework-agnostic code both frontends can use.

A user-facing feature must exist in **both** frontends. A change made only in
`components/` reaches the web app and not the iPad app. Plan and build for both.

## Configuration before anything runs

Every deployment-specific value — a domain, a bundle id, a brand, a secret — was
removed from this published tree. In its place you will find an empty list, a
neutral placeholder, or a generated stub. These are **not** bugs.

`DEPLOYMENT.md` sits beside this file. It is the authoritative, human-readable
list of every value that was removed and what you must do about each one.
`deployment-config.json` beside it is the same list for machines. **Read
`DEPLOYMENT.md` first, and treat every entry as required unless it says
otherwise.** Do not guess a value from a comment or a variable name; the file
tells you what breaks or silently does nothing when a value is unset.

## Stand-up order

1. **Install.** `pnpm install --frozen-lockfile`. Use pnpm, not npm or yarn.
2. **A Convex deployment.** Create one. Point the web app at it through
   `NEXT_PUBLIC_CONVEX_URL` and `NEXT_PUBLIC_CONVEX_SITE_URL`, and set `SITE_URL`
   in the deployment's environment so backend-generated links resolve.
3. **Auth signing keys.** Generate an RSA-2048 keypair, set its PKCS#8 private
   PEM as the Convex environment variable `JWT_PRIVATE_KEY`, and set `JWKS` to a
   JSON Web Key Set containing the corresponding RS256 public JWK. Sign-in does
   not work until both are set.
4. **Model and service keys.** Set `ANTHROPIC_API_KEY` (tutor and observer) and
   `OPENAI_API_KEY` (voice). Passkeys need `PASSKEY_RP_ID`, `PASSKEY_ORIGIN`, and
   `PASSKEY_RP_NAME`; without them they bind to localhost. Email sign-in,
   Google, Mapbox, and the optional integrations each have their own variables
   in `DEPLOYMENT.md` — set the ones you use.
5. **First admin.** Signup is invite-only and closed until one admin exists. Run
   the admin-key-gated mutation `users:bootstrapFirstPlatformAdmin` with a
   username, then sign in and set a password.
6. **Institutions and brand.** Run `institutions:ensureDefaults` once to seed the
   primary institution, then fill in the neutral identity files: the brand, the
   prompt profile, the print identity, and the institution seal. Set the default
   time zone in `shared/institutionDay.ts` and its siblings.
7. **Web.** Build and run the Next.js app.
8. **Native.** Point the iPad app at the backend with `EXPO_PUBLIC_CONVEX_URL`
   (and optionally `EXPO_PUBLIC_CONVEX_SITE_URL`), set `EXPO_PUBLIC_RABBITHOLE_WEB_URL`
   to your web origin, and set `EXPO_PUBLIC_MAPBOX_TOKEN` if you use maps. Set the
   bundle id, scheme, name, icons, and associated domains in `native/app.json`,
   change the matching bundle-id namespaces flagged in `DEPLOYMENT.md`, and
   configure iOS signing in your own build pipeline. Merging code does not put it
   on a device; you build and distribute the native app separately.

## What is optional, and what is absent

Several features are private operational integrations. They ship in the code but
stay **off** until you set their environment variables, and they never crash when
unset — the endpoint returns a "not configured" response and nothing else is
affected. `DEPLOYMENT.md` lists each variable and marks these Optional:

- device management (SimpleMDM),
- a chat-workspace bot (Slack),
- parent messaging over email and WhatsApp,
- Google Drive integration and change events.

Health records and the development seeds and tests are present and working, not
removed. What is genuinely **absent** is the physical lobby display and its
capture endpoint, which are bound to one site's hardware. Do not treat any of
these empty lists, neutral placeholders, or "not configured" responses as bugs.
Build a per-deployment version of an integration only when you actually need it.

## The multi-institution rule

Rabbithole is a multi-institution engine. Authorization belongs on the server in
every handler, and a role check alone is not enough. See **Deployment model** in
`README.md` for the rule and its consequences. Follow it in any handler you add.

## How to verify

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

The native app has its own checks under `native/` (`pnpm native:typecheck`,
`pnpm native:test`). A green build is not a running deployment — it means the
code is sound, not that you have supplied the configuration above.
