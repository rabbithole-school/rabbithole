# Deployment checklist

Set these deployment-specific items before you rely on the related features.

## External services

### Convex deployment

- **Identifier:** `Convex deployment`
- **What it is:** The Convex backend that runs every query, mutation, action, and HTTP action.
- **Published as:** Not present. No deployment identity ships.
- **While unset:** The app cannot reach a backend. Nothing loads or saves.
- **Set it:** Create a Convex deployment and provision its schema and functions with the Convex CLI.

### First platform admin

- **Identifier:** `First platform admin`
- **What it is:** The first administrator account. Signup is invite-only and closed until one admin exists.
- **Published as:** Not present. No account ships.
- **While unset:** No one can sign up, so no one can administer the deployment.
- **Set it:** Run the admin-key-gated internal mutation users:bootstrapFirstPlatformAdmin with a username, then sign in and set a password.

### Google OAuth client

- **Identifier:** `Google OAuth client`
- **What it is:** The Google Cloud OAuth client that powers Google sign-in and Drive access.
- **Published as:** Not present. No client ships.
- **While unset:** Google sign-in and the Drive picker fail. Optional if you do not use Google.
- **Set it:** Create an OAuth client in Google Cloud, then set the GOOGLE_OAUTH_* and NEXT_PUBLIC_GOOGLE_* variables listed below.

### Primary institution

- **Identifier:** `Primary institution`
- **What it is:** The default institution rows (primary school plus guests) the app expects to exist.
- **Published as:** Not present. No institution rows ship.
- **While unset:** The app has no institution to place users in until you seed one.
- **Set it:** Run the internal mutation institutions:ensureDefaults once against the deployment.

## Environment variables

### Anthropic API key

- **Variable:** `ANTHROPIC_API_KEY`
- **What it is:** The key for Anthropic Claude, which powers the tutor and the observer analysis.
- **Published as:** Not present. Secrets are never published.
- **While unset:** The tutor and observer produce no responses.
- **Set it:** Set ANTHROPIC_API_KEY in the Convex deployment's environment.

### Email sender identity

- **Variable:** `AUTH_EMAIL_FROM`
- **What it is:** The full From identity for system email, such as 'Rabbithole <no-reply@mail.example.org>'.
- **Published as:** Not present.
- **While unset:** Sending system email throws because no sender is configured. Required once email sending is on.
- **Set it:** Set AUTH_EMAIL_FROM in the Convex deployment's environment.

### Email API key

- **Variable:** `AUTH_RESEND_KEY`
- **What it is:** The Resend API key used to send magic-link sign-in email.
- **Published as:** Not present. Secrets are never published.
- **While unset:** Magic-link email is not sent; the sign-in URL is only logged. Optional if you do not use email sign-in.
- **Set it:** Set AUTH_RESEND_KEY in the Convex deployment's environment.

### Dev sign-in secret (backend)

- **Variable:** `DEV_TEST_LOGIN_SECRET`
- **What it is:** The shared secret the backend requires before /dev-login signs anyone in or lists the seeded users.
- **Published as:** Not present. Secrets are never published.
- **While unset:** /dev-login is disabled even when RABBITHOLE_ALLOW_DEV_LOGIN is true.
- **Set it:** Generate a random string and set it as DEV_TEST_LOGIN_SECRET in the Convex deployment's environment, and the same value as NEXT_PUBLIC_DEV_LOGIN_SECRET in the web app's environment.

### Drive webhook base URL

- **Variable:** `DRIVE_WEBHOOK_BASE_URL`
- **What it is:** The absolute base URL Google Drive push notifications are delivered to.
- **Published as:** Not present.
- **While unset:** Drive webhook registration throws when used. Optional if you do not use Drive change notifications.
- **Set it:** Set DRIVE_WEBHOOK_BASE_URL in the Convex deployment's environment to an absolute HTTPS URL.

### Convex URL (native)

- **Variable:** `EXPO_PUBLIC_CONVEX_URL`
- **What it is:** The iPad app's address for the Convex backend. EXPO_PUBLIC_CONVEX_SITE_URL optionally overrides the HTTP-actions origin.
- **Published as:** Not present.
- **While unset:** The native app throws at startup ('EXPO_PUBLIC_CONVEX_URL is not set') and does not launch.
- **Set it:** Set EXPO_PUBLIC_CONVEX_URL (and optionally EXPO_PUBLIC_CONVEX_SITE_URL) in native/.env before building the app.

### Mapbox token (native)

- **Variable:** `EXPO_PUBLIC_MAPBOX_TOKEN`
- **What it is:** The Mapbox access token used to render maps in the iPad app.
- **Published as:** Not present. Adopters must supply their own; see NOTICE.
- **While unset:** Native map cards render a tokenless empty state; the rest of the app works. Optional.
- **Set it:** Set EXPO_PUBLIC_MAPBOX_TOKEN in native/.env to your Mapbox token.

### Native web origin

- **Variable:** `EXPO_PUBLIC_RABBITHOLE_WEB_URL`
- **What it is:** The web origin the iPad app embeds for webview surfaces and the offline network probe.
- **Published as:** Not present. The code falls back to https://rabbithole.school.
- **While unset:** Native web embeds and the offline probe silently point at https://rabbithole.school instead of your site.
- **Set it:** Set EXPO_PUBLIC_RABBITHOLE_WEB_URL in native/.env to your web app's origin.

### Google Gemini API key

- **Variable:** `GEMINI_API_KEY`
- **What it is:** The key for Google's Gemini image model, used for tutor-generated illustrations and image annotation.
- **Published as:** Not present. Secrets are never published.
- **While unset:** Tutor image generation and annotation are disabled; the rest of the app works. Optional.
- **Set it:** Set GEMINI_API_KEY in the Convex deployment's environment if you want tutor image generation.

### Google Drive change events

- **Variable:** `GOOGLE_EVENTS_PROJECT`
- **What it is:** The Google Cloud Pub/Sub settings for Drive change events: GOOGLE_EVENTS_PROJECT, GOOGLE_EVENTS_TOPIC, GOOGLE_EVENTS_PUSH_SECRET, and GOOGLE_EVENTS_PUSH_SA.
- **Published as:** Not present.
- **While unset:** Drive change-event subscriptions do not work. Optional if you do not use them.
- **Set it:** Set GOOGLE_EVENTS_PROJECT, GOOGLE_EVENTS_TOPIC, GOOGLE_EVENTS_PUSH_SECRET, and GOOGLE_EVENTS_PUSH_SA in the Convex deployment's environment.

### Google OAuth client id

- **Variable:** `GOOGLE_OAUTH_CLIENT_ID`
- **What it is:** The OAuth client id for backend Google sign-in and Drive access.
- **Published as:** Not present.
- **While unset:** Backend Google OAuth throws when used. Optional if you do not use Google.
- **Set it:** Set GOOGLE_OAUTH_CLIENT_ID in the Convex deployment's environment.

### Google OAuth client secret

- **Variable:** `GOOGLE_OAUTH_CLIENT_SECRET`
- **What it is:** The OAuth client secret paired with GOOGLE_OAUTH_CLIENT_ID.
- **Published as:** Not present. Secrets are never published.
- **While unset:** Backend Google OAuth throws when used. Optional if you do not use Google.
- **Set it:** Set GOOGLE_OAUTH_CLIENT_SECRET in the Convex deployment's environment.

### Google OAuth redirect

- **Variable:** `GOOGLE_OAUTH_REDIRECT_URI`
- **What it is:** The redirect URI registered on the Google OAuth client.
- **Published as:** Not present.
- **While unset:** Backend Google OAuth throws when used. Optional if you do not use Google.
- **Set it:** Set GOOGLE_OAUTH_REDIRECT_URI in the Convex deployment's environment to a URI registered on your OAuth client.

### Google OAuth state secret

- **Variable:** `GOOGLE_OAUTH_STATE_SECRET`
- **What it is:** The secret used to sign the OAuth state parameter.
- **Published as:** Not present. Falls back to JWT_PRIVATE_KEY.
- **While unset:** The OAuth state is signed with JWT_PRIVATE_KEY instead. Optional.
- **Set it:** Set GOOGLE_OAUTH_STATE_SECRET in the Convex deployment's environment to use a dedicated secret.

### Auth verification keys

- **Variable:** `JWKS`
- **What it is:** The JSON Web Key Set @convex-dev/auth uses to verify session tokens.
- **Published as:** Not present. Secrets are never published.
- **While unset:** Authentication cannot verify sessions; no one stays signed in.
- **Set it:** Set JWKS to a JSON Web Key Set containing the RS256 public JWK for JWT_PRIVATE_KEY.

### Auth signing key

- **Variable:** `JWT_PRIVATE_KEY`
- **What it is:** The PKCS#8 RSA signing key @convex-dev/auth uses to sign session tokens.
- **Published as:** Not present. Secrets are never published.
- **While unset:** Authentication cannot issue sessions; no one can sign in.
- **Set it:** Generate an RSA-2048 keypair and set its PKCS#8 private PEM as JWT_PRIVATE_KEY in the Convex deployment's environment.

### Convex URLs (web)

- **Variable:** `NEXT_PUBLIC_CONVEX_URL`
- **What it is:** The web app's addresses for the backend: NEXT_PUBLIC_CONVEX_URL for queries and websockets, NEXT_PUBLIC_CONVEX_SITE_URL for HTTP actions.
- **Published as:** Not present. No deployment URLs ship.
- **While unset:** The web app has no backend to talk to and fails to start.
- **Set it:** Set both to your Convex deployment's .convex.cloud and .convex.site URLs before building the web app.

### Dev sign-in secret (web)

- **Variable:** `NEXT_PUBLIC_DEV_LOGIN_SECRET`
- **What it is:** The web app's copy of DEV_TEST_LOGIN_SECRET, which the /dev-login page sends to the backend. It is compiled into the web bundle, so it is visible to anyone who can load the page.
- **Published as:** Not present. Secrets are never published.
- **While unset:** The /dev-login page cannot sign anyone in.
- **Set it:** Set NEXT_PUBLIC_DEV_LOGIN_SECRET in .env.local (or the web host's build environment) to the same value as DEV_TEST_LOGIN_SECRET. Set it only on local or throwaway deployments.

### Google Picker API key

- **Variable:** `NEXT_PUBLIC_GOOGLE_API_KEY`
- **What it is:** The browser API key the web Google Drive picker uses.
- **Published as:** Not present.
- **While unset:** The web Drive picker cannot open. Optional if you do not use the picker.
- **Set it:** Set NEXT_PUBLIC_GOOGLE_API_KEY at build time.

### Google Picker client id

- **Variable:** `NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID`
- **What it is:** The browser OAuth client id the web Google Drive picker uses.
- **Published as:** Not present.
- **While unset:** The web Drive picker cannot authorize. Optional if you do not use the picker.
- **Set it:** Set NEXT_PUBLIC_GOOGLE_OAUTH_CLIENT_ID at build time.

### Mapbox token (web)

- **Variable:** `NEXT_PUBLIC_MAPBOX_TOKEN`
- **What it is:** The Mapbox access token used to render maps in the web app.
- **Published as:** Not present. Adopters must supply their own; see NOTICE.
- **While unset:** Map surfaces render a tokenless empty state; the rest of the app works. Optional.
- **Set it:** Set NEXT_PUBLIC_MAPBOX_TOKEN at build time to your Mapbox token.

### Web app origin

- **Variable:** `NEXT_PUBLIC_SITE_URL`
- **What it is:** The web app's own public origin, used for page metadata and canonical links.
- **Published as:** Not present.
- **While unset:** Page metadata and absolute links point at the wrong or a missing origin.
- **Set it:** Set NEXT_PUBLIC_SITE_URL to your web app's public origin at build time.

### OpenAI API key

- **Variable:** `OPENAI_API_KEY`
- **What it is:** The key for OpenAI, used for voice transcription (Whisper), text-to-speech, and the charm-layer image generation that draws badges, flair, and manipulative sprites.
- **Published as:** Not present. Secrets are never published.
- **While unset:** Voice dictation, speech playback, and generated badge/flair/sprite art do not work; text still works.
- **Set it:** Set OPENAI_API_KEY in the Convex deployment's environment.

### Parent inbound domain

- **Variable:** `PARENT_INBOUND_DOMAIN`
- **What it is:** The email domain inbound parent messages are received on.
- **Published as:** Not present.
- **While unset:** Inbound parent email addressing does not resolve; nothing else is affected. Optional.
- **Set it:** Set PARENT_INBOUND_DOMAIN in the Convex deployment's environment if you use inbound parent email.

### Parent inbound secret

- **Variable:** `PARENT_INBOUND_SECRET`
- **What it is:** The secret validating inbound parent-message addresses.
- **Published as:** Not present.
- **While unset:** Inbound parent email validation is off; nothing else is affected. Optional.
- **Set it:** Set PARENT_INBOUND_SECRET in the Convex deployment's environment if you use inbound parent email.

### Family-facing sender

- **Variable:** `PARENT_MESSAGE_FROM`
- **What it is:** Optional mailbox for family-facing parent messages; AUTH_EMAIL_FROM_ADDRESS is an accepted alias. Defaults to a family-facing form of AUTH_EMAIL_FROM.
- **Published as:** Not present.
- **While unset:** Parent messages are sent from a family-facing form of AUTH_EMAIL_FROM. Optional.
- **Set it:** Set PARENT_MESSAGE_FROM (or AUTH_EMAIL_FROM_ADDRESS) in the Convex deployment's environment to override the sender mailbox.

### Passkey origin

- **Variable:** `PASSKEY_ORIGIN`
- **What it is:** The allowed WebAuthn origin(s) for passkey ceremonies, comma-separated.
- **Published as:** Not present. The code defaults to localhost origins.
- **While unset:** Passkey ceremonies are only accepted from localhost.
- **Set it:** Set PASSKEY_ORIGIN in the Convex deployment's environment to your production origin(s).

### Passkey relying-party id

- **Variable:** `PASSKEY_RP_ID`
- **What it is:** The WebAuthn relying-party id (a domain) passkeys are bound to.
- **Published as:** Not present. The code defaults to localhost.
- **While unset:** Passkeys register against localhost and will not work on your real domain.
- **Set it:** Set PASSKEY_RP_ID in the Convex deployment's environment to your production domain.

### Passkey display name

- **Variable:** `PASSKEY_RP_NAME`
- **What it is:** The human label shown in the operating system's passkey prompt.
- **Published as:** Not present. The code defaults to 'Rabbithole'.
- **While unset:** The passkey prompt shows 'Rabbithole' instead of your school's name.
- **Set it:** Set PASSKEY_RP_NAME in the Convex deployment's environment.

### Dev fixture switch

- **Variable:** `RABBITHOLE_ALLOW_DEV_FIXTURES`
- **What it is:** Lets development fixtures write to a deployment that Convex hosts or runs locally: the seed gives its fictional people the usernames /dev-login signs in by, and demo fixtures (sample skill progress, sample app logins) may run.
- **Published as:** Not present. Fixtures are refused unless this is exactly 'true'.
- **While unset:** The seed still creates the fictional school, but its people get no usernames, so /dev-login has no one to sign in as; demo fixtures refuse to run.
- **Set it:** For a local or throwaway trial only, set RABBITHOLE_ALLOW_DEV_FIXTURES to true in the Convex deployment's environment before seeding. Never set it where real children have records.

### Dev sign-in switch

- **Variable:** `RABBITHOLE_ALLOW_DEV_LOGIN`
- **What it is:** Turns on /dev-login, the no-password sign-in for seeded fictional users, on a deployment that Convex hosts or runs locally. It works only together with DEV_TEST_LOGIN_SECRET and NEXT_PUBLIC_DEV_LOGIN_SECRET.
- **Published as:** Not present. /dev-login is off unless this is exactly 'true'.
- **While unset:** /dev-login refuses every sign-in and lists no users. This is the right setting for any deployment with real people in it.
- **Set it:** For a local or throwaway trial only, set RABBITHOLE_ALLOW_DEV_LOGIN to true in the Convex deployment's environment. Never set it where real children have accounts.

### Resend receiving key

- **Variable:** `RESEND_RECEIVING_API_KEY`
- **What it is:** The Resend API key used to read inbound parent email.
- **Published as:** Not present. Secrets are never published.
- **While unset:** Inbound parent email cannot be fetched; nothing else is affected. Optional.
- **Set it:** Set RESEND_RECEIVING_API_KEY in the Convex deployment's environment if you use inbound parent email.

### Resend webhook secret

- **Variable:** `RESEND_WEBHOOK_SECRET`
- **What it is:** The secret verifying inbound Resend email webhooks for parent messaging.
- **Published as:** Not present.
- **While unset:** Inbound parent email is not processed; nothing else is affected. Optional.
- **Set it:** Set RESEND_WEBHOOK_SECRET in the Convex deployment's environment if you use inbound parent email.

### School WhatsApp number

- **Variable:** `SCHOOL_WHATSAPP_NUMBER`
- **What it is:** The WhatsApp number parent messages are sent from and received on.
- **Published as:** Not present.
- **While unset:** WhatsApp parent messaging stays off; nothing else is affected. Optional.
- **Set it:** Set SCHOOL_WHATSAPP_NUMBER in the Convex deployment's environment if you use WhatsApp messaging.

### SimpleMDM API key

- **Variable:** `SIMPLEMDM_API_KEY`
- **What it is:** The API key for the SimpleMDM device-management integration.
- **Published as:** Not present.
- **While unset:** Device-management features stay off; nothing else is affected. Optional.
- **Set it:** Set SIMPLEMDM_API_KEY in the Convex deployment's environment if you run a SimpleMDM tenant.

### Backend app origin

- **Variable:** `SITE_URL`
- **What it is:** The absolute origin the Convex backend uses to build links, such as invite and magic-link URLs.
- **Published as:** Not present.
- **While unset:** Any backend feature that emits a link throws when it runs; invites and magic links cannot be generated.
- **Set it:** Set SITE_URL in the Convex deployment's environment to your web app's public origin.

### Slack bot token

- **Variable:** `SLACK_BOT_TOKEN`
- **What it is:** The bot token used to call the Slack Web API.
- **Published as:** Not present.
- **While unset:** Slack calls are skipped and the bot stays off; nothing else is affected. Optional.
- **Set it:** Set SLACK_BOT_TOKEN in the Convex deployment's environment if you run the Slack bot.

### Slack signing secret

- **Variable:** `SLACK_SIGNING_SECRET`
- **What it is:** The signing secret that verifies inbound Slack event requests.
- **Published as:** Not present.
- **While unset:** The Slack events endpoint returns 503 and the bot stays off; nothing else is affected. Optional.
- **Set it:** Set SLACK_SIGNING_SECRET in the Convex deployment's environment if you run the Slack bot.

### Slack workshop channel

- **Variable:** `SLACK_WORKSHOP_CHANNEL_ID`
- **What it is:** The channel id the bot posts workshop notifications to.
- **Published as:** Not present.
- **While unset:** Workshop notifications are not posted; nothing else is affected. Optional.
- **Set it:** Set SLACK_WORKSHOP_CHANNEL_ID in the Convex deployment's environment if you run the Slack bot.

### WhatsApp credentials

- **Variable:** `WHATSAPP_ACCESS_TOKEN`
- **What it is:** The WhatsApp Cloud API credential and template settings: WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN, WHATSAPP_TEMPLATE_NAME, and WHATSAPP_TEMPLATE_LANG.
- **Published as:** Not present. Secrets are never published.
- **While unset:** WhatsApp parent messaging stays off; nothing else is affected. Optional.
- **Set it:** Set the WHATSAPP_* variables in the Convex deployment's environment if you use WhatsApp messaging.

## Files

### Institution seal

- **Path:** `convex/assets/seal/primaryInstitutionSeal.ts`
- **What it is:** The base64 PNG seal stamped on printed documents.
- **Published as:** A transparent one-pixel placeholder.
- **While unset:** Printed documents carry no seal.
- **Set it:** Replace primaryInstitutionSealPngBase64 with your school's seal as a base64 PNG.

### Institution print identity

- **Path:** `convex/lib/primaryInstitutionPrintIdentity.ts`
- **What it is:** The issuing authority named in the header of printed materials such as calculator licenses.
- **Published as:** 'Rabbithole' as the issuing authority.
- **While unset:** Printed materials are headed 'Rabbithole' rather than your school's name.
- **Set it:** Replace issuingAuthority in PRIMARY_INSTITUTION_PRINT_IDENTITY with your school's name.

### Institution prompt profile

- **Path:** `convex/lib/primaryInstitutionPromptProfile.ts`
- **What it is:** Your school's identity as the tutor and observer see it: name, short name, location, and time zone.
- **Published as:** A neutral 'Rabbithole' profile located nowhere, in UTC.
- **While unset:** The tutor refers to a generic school and reasons about time in UTC.
- **Set it:** Replace the values in PRIMARY_INSTITUTION_PROMPT_PROFILE with your school's identity and time zone.

### Institution brand

- **Path:** `lib/primaryInstitutionBrand.ts`
- **What it is:** Your school's name, logo, tagline, and contact details for printed materials.
- **Published as:** A neutral 'Rabbithole' identity with no logo or contact details.
- **While unset:** Printed forms and branded surfaces show 'Rabbithole' and omit your logo and contacts.
- **Set it:** Replace the values in PRIMARY_INSTITUTION_BRAND with your school's identity.

### Native app identity

- **Path:** `native/app.json`
- **What it is:** The iPad app's identity: bundle identifier, URL scheme, display name, and icons. Signing (team and credentials) is configured separately in your own build setup, not in this file.
- **Published as:** Neutral 'Rabbithole' values with the bundle id 'org.rabbithole.app' and no signing configuration.
- **While unset:** You cannot sign or distribute the app under your own identity, and you clash with the placeholder bundle id.
- **Set it:** Set ios.bundleIdentifier, scheme, name, and the icon assets in native/app.json, and configure iOS signing in your build pipeline.

## Values

### Device-unlock bundle namespace

- **Path:** `convex/deviceAppUnlock.ts`
- **What it is:** The app bundle-id namespace the device-management unlock logic treats as this deployment's own app.
- **Published as:** The 'org.rabbithole.app' namespace (base, .dev, .metro).
- **While unset:** Device-unlock recognizes only the 'org.rabbithole.app' namespace, so your own bundle id is not treated as the app.
- **Set it:** Set RABBITHOLE_BUNDLE_IDS to match your native/app.json bundle id and its dev/metro variants.

### Guest-tutor origins

- **Path:** `convex/lib/guestTutor.ts`
- **What it is:** The production and preview origins allowed to call the unauthenticated guest-tutor endpoint.
- **Published as:** Rabbithole's public origin and generic Rabbithole preview hosts.
- **While unset:** A separate school marketing site cannot call the endpoint directly, though the built-in Rabbithole page still can.
- **Set it:** Add your production and preview hosts to GUEST_ORIGIN_PATTERNS and GUEST_PREVIEW_ORIGIN_PATTERNS.

### Home-layout app bundle ids

- **Path:** `convex/lib/homeLayoutTiles.ts`
- **What it is:** The bundle ids recognized as this deployment's native app when projecting managed-device Home Screen layouts.
- **Published as:** The generic school.rabbithole bundle namespace.
- **While unset:** Devices built under another bundle namespace do not receive Rabbithole-first tile ordering.
- **Set it:** Add your production, development, and Metro bundle ids to RABBITHOLE_BUNDLE_IDS.

### Managed external apps

- **Path:** `convex/lib/managedNativeApps.ts`
- **What it is:** The bundle ids and URL schemes of third-party iPad apps the device integration can launch.
- **Published as:** Three fixed third-party apps (a spreadsheet, a robotics app, a stop-motion app).
- **While unset:** The device integration manages exactly those three apps. Change MANAGED_NATIVE_APPS to manage a different set.
- **Set it:** Edit MANAGED_NATIVE_APPS (and the matching LSApplicationQueriesSchemes in native/app.json) to your own managed apps.

### Dev-client bundle namespace

- **Path:** `native/modules/dev-client-safety/ios/DevClientSafetyModule.swift`
- **What it is:** The bundle-id namespace the native dev-client-safety module uses for its stored keys.
- **Published as:** The 'org.rabbithole.app' namespace.
- **While unset:** The dev-client-safety keys stay under the 'org.rabbithole.app' namespace regardless of your bundle id.
- **Set it:** Update the namespace in DevClientSafetyModule.swift to match your bundle id.

### Key-capture bundle namespace

- **Path:** `native/modules/key-capture/ios/KeyCaptureView.swift`
- **What it is:** The bundle-id namespace the native key-capture module uses for its notification name.
- **Published as:** The 'org.rabbithole.app' namespace.
- **While unset:** The key-capture notification stays under the 'org.rabbithole.app' namespace regardless of your bundle id.
- **Set it:** Update the namespace in KeyCaptureView.swift to match your bundle id.

### Universal-link hosts

- **Path:** `native/src/lib/universalLinks.ts`
- **What it is:** The web hostnames whose /open/* links the iPad app claims as Apple universal links.
- **Published as:** An empty list.
- **While unset:** Universal links are ignored. Everything else works.
- **Set it:** Add your hostname to UNIVERSAL_LINK_HOSTS, and to ios.associatedDomains in native/app.json.

### Default time zone

- **Path:** `shared/institutionDay.ts`
- **What it is:** The fallback calendar time zone for institutions with no time zone set. Sibling fallbacks appear in several schedule and scholar surfaces.
- **Published as:** 'Pacific/Honolulu'.
- **While unset:** Dates and day boundaries are computed in Pacific/Honolulu until you change DEFAULT_TIMEZONE and its siblings.
- **Set it:** Set DEFAULT_TIMEZONE in shared/institutionDay.ts to your region, and update the matching fallbacks noted in the file.

## Deliberately removed

- `.github/workflows/ci.yml` — Continuous-integration workflow for the public repository. Housekeeping, not a value to set.
- `.gitignore` — Repository ignore rules for the public tree. Housekeeping.
- `AGENTS.md` — The adopter agent guide itself. Documentation, not a configuration point.
- `CONTRIBUTING.md` — Contributor guide for the public repository. Documentation, not configurable.
- `LICENSE` — License for the public repository. Not configurable here.
- `NOTICE` — Third-party notices for the public repository. Not configurable here.
- `README.md` — Top-level readme for the public repository. Documentation, not configurable.
- `SECURITY.md` — Security policy for the public repository. Documentation, not configurable.
- `app/api/mcp/route.ts` — MCP route with the private admissions tools removed. The remaining tools register as before. No adopter action required.
- `app/page.tsx` — First-party landing-page branding, biographies, images, and links removed; public links stay neutral. No adopter action required.
- `app/parent/[[...tab]]/page.tsx` — First-party admissions tab title removed. No adopter action required.
- `app/school/__tests__/nav.test.ts` — Test file. Published and runnable; not a configuration point.
- `app/school/directory/staff/page.tsx` — Staff-capability description neutralized. No adopter action required.
- `app/school/layout.tsx` — School-directory layout rebuilt from a neutral template. No deployment-specific value.
- `app/school/nav.tsx` — School-directory navigation rebuilt from a neutral template. No deployment-specific value.
- `app/school/page.tsx` — School-directory index rebuilt from a neutral template. No deployment-specific value.
- `app/school/settings/page.tsx` — School settings with a private print-status surface removed. No adopter action required.
- `app/teacher/(dashboard)/_components/CommandPalette.test.ts` — Test file with the first-party admissions search cases removed. Published and runnable; not a configuration point.
- `components/BehindTheCurtain.tsx` — Published-prompts links neutralized to the public repository. No adopter action required.
- `components/CommandPalette.tsx` — Staff command palette with the first-party admissions search removed. No adopter action required.
- `components/ParentDashboard.tsx` — Parent dashboard with private surfaces removed. No adopter action required.
- `components/ScholarFeed.tsx` — Scholar feed with private surfaces removed. No adopter action required.
- `components/StaffShell.tsx` — Staff shell with the first-party admissions access check removed. No adopter action required.
- `convex/__tests__/activityResources.test.ts` — Test file. Published and runnable; not a configuration point.
- `convex/__tests__/alerts.test.ts` — Test file. Published and runnable; not a configuration point.
- `convex/__tests__/applicantParent.test.ts` — Test file. Published and runnable; not a configuration point.
- `convex/__tests__/calculatorLicense.test.ts` — Test file. Published and runnable; not a configuration point.
- `convex/__tests__/customAppTools.test.ts` — Test file. Published and runnable; not a configuration point.
- `convex/__tests__/customApps.test.ts` — Test file. Published and runnable; not a configuration point.
- `convex/__tests__/familyOnboarding.test.ts` — Test file. Published and runnable; not a configuration point.
- `convex/__tests__/googleTokenEncryption.test.ts` — Test file with the private migration case removed. Published and runnable; not a configuration point.
- `convex/__tests__/guestTutor.test.ts` — Test file with first-party origin cases removed. Published and runnable; not a configuration point.
- `convex/__tests__/institutionPromptProfile.test.ts` — Test file. Published and runnable; not a configuration point.
- `convex/__tests__/metaPrompts.test.ts` — Test file. Published and runnable; not a configuration point.
- `convex/__tests__/promptVersion.test.ts` — Test file. Published and runnable; not a configuration point.
- `convex/__tests__/scholarCodeTools.test.ts` — Test file. Published and runnable; not a configuration point.
- `convex/__tests__/slackBot.test.ts` — Test file. Published and runnable; not a configuration point.
- `convex/auth.ts` — Auth configuration with a private-deployment branch removed. The keys to set are listed as environment entries.
- `convex/calculatorLicenses.ts` — Calculator-license feature. A first-party physical-print pipeline removed; the rest is published as-is.
- `convex/crons.ts` — Scheduled jobs with private jobs removed. No adopter action required.
- `convex/externalApps.ts` — External-app catalog. Private, provider-specific registration removed; the rest is published as-is.
- `convex/http.ts` — HTTP routes with private endpoints removed. Optional-integration routes stay off until their environment variables are set.
- `convex/improvementTraces.ts` — Improvement-trace sources. Private trace sources removed; the rest is published as-is.
- `convex/institutions.ts` — Default-institution seed neutralized to a generic primary. Create institutions with institutions:ensureDefaults (see the external entry); identity lives in the brand and prompt-profile files.
- `convex/lib/aideTools.ts` — Staff-aide tools. Private, deployment-specific tools were removed; the rest is published as-is.
- `convex/lib/customAppTools.ts` — Custom-app tools. Private sections removed; the rest is published as-is.
- `convex/lib/googleDocsCommentTools.ts` — Google Docs comment tools. Published and inert unless the Google OAuth variables are set.
- `convex/lib/guardianFormTools.ts` — Guardian-form tools. Private sections removed; the rest is published as-is.
- `convex/lib/scholarCodeTools.ts` — Scholar code-explorer tools. Private sections removed; the rest is published as-is.
- `convex/lib/slackTools.ts` — Slack bot tools. Published and inert unless the SLACK_* variables are set (see the environment entries).
- `convex/mcp.ts` — MCP connector functions with the private admissions tools removed. No adopter action required.
- `convex/metaPrompts.ts` — Code-explorer repository URL neutralized to the public repository. No adopter action required.
- `convex/practiceDigest.ts` — Practice digest. A private weekly quality-pulse path removed; the rest is published as-is.
- `convex/schema.ts` — Data-model source of truth with a few private-feature tables removed. No adopter action required.
- `convex/scholarApps.ts` — Scholar-app wiring. A private-deployment branch removed; the rest is published as-is.
- `convex/scholarHealthRecords.ts` — Health-records feature. Published and functional; no deployment configuration required.
- `convex/seed/devPersonas.ts` — Development seed data. Published for local development; not a configuration point.
- `convex/seed/launchpadDemo.ts` — Development seed data. Published for local development; not a configuration point.
- `convex/seed/physicalEnvironment.ts` — Development seed data. Published for local development; not a configuration point.
- `convex/seedData.ts` — Development seed data. Private records removed; not a configuration point.
- `convex/seeds.ts` — Development seed data. Private records removed; not a configuration point.
- `convex/sessionHelpers.ts` — Session runtime with a first-party reading-program lookup removed. No adopter action required.
- `convex/sessions.ts` — Session runtime with a first-party reading-program lookup removed. No adopter action required.
- `convex/simplemdm.ts` — SimpleMDM device-management module. Published and inert unless SIMPLEMDM_API_KEY is set (see the environment entry).
- `convex/simulator.ts` — Curriculum simulator with a private-deployment detection branch removed. No adopter action required.
- `convex/slackBot.ts` — Slack bot module. Published and inert unless the SLACK_* variables are set (see the environment entries).
- `convex/slackInteractivity.ts` — Slack interactivity worker with the private admissions button and modal handlers removed. Inert unless the SLACK_* variables are set (see the environment entries).
- `convex/takeHomePlans.ts` — Take-home plans with the private special-delivery print signal disabled. No adopter action required.
- `convex/users.ts` — User functions with a private-deployment branch removed. Create the first admin with users:bootstrapFirstPlatformAdmin (see the external entry).
- `eslint.config.mjs` — ESLint configuration with a private repository-specific rule removed. No adopter action required.
- `lib/geomap/historicalBasemaps.ts` — Local-geography curriculum overlays neutralized to generic values. No adopter action required.
- `lib/geomap/registry/keys.ts` — Local-geography overlay identifiers neutralized to generic values. No adopter action required.
- `lib/passkeyClient.ts` — A legacy passkey origin specific to the originating school's migration, neutralized to an inert placeholder. Not relevant to a new deployment.
- `native/metro.config.js` — Metro bundler configuration for the native app. Housekeeping.
- `native/package.json` — Native app dependency and script manifest, regenerated for the published tree. Housekeeping.
- `native/src/app/how-it-works.tsx` — Native explainer copy neutralized. No adopter action required.
- `native/src/components/ExternalAppHost.tsx` — External-app embedding. Private sections removed; the rest is published as-is.
- `native/src/lib/externalAppBundledIcons.ts` — External-app icon bundle. Private icons removed; the rest is published as-is.
- `native/src/lib/externalAppIcon.ts` — External-app icon resolution. Private sections removed; the rest is published as-is.
- `native/vendor/geomap/historicalBasemaps.ts` — Vendored local-geography overlays neutralized to generic values. No adopter action required.
- `next.config.js` — Next.js build configuration. The published template carries no deployment-specific hosts.
- `package.json` — Root dependency and script manifest, regenerated without private packages and scripts. Housekeeping.
- `pnpm-lock.yaml` — Lockfile regenerated for the published dependency set. Housekeeping.
- `pnpm-workspace.yaml` — Workspace layout for the published tree. Housekeeping.
- `shared/tutorQualityRubric.ts` — A single rubric phrase neutralized to a generic wording. No adopter action required.
