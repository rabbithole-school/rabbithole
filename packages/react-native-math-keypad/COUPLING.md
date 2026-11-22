# Coupling report

What it took to pull the iPad math keypad out of Rabbithole, what was cut, what
is still hard, and what publishing it for real would cost. Written for whoever
picks this up next. PR numbers refer to Rabbithole's private development
repository, as in the README; `#13`-style numbers refer to the table below.

## What the stack was

| Piece | Rabbithole path | Role | In the package? |
|---|---|---|---|
| 2-D builder model | `shared/expressionTemplateInput.ts` | input model | yes, `src/model/expressionTemplate.ts` |
| Burst-safe controller | `shared/useExpressionTemplateController.ts` | input model (React) | yes |
| Flat pad rules | `shared/practiceLoop.ts` (pad section) + `native/src/lib/practicePad.ts` + `shared/mathNotation.ts` | input model | yes, `src/model/flatPad.ts` |
| Root-index rules | `shared/staticRadicals.ts` (2 of 6 exports) | input model | yes, `src/model/rootIndex.ts` |
| Box size floors, radical geometry | `shared/expressionEditorBoxMetrics.ts`, `shared/radicalGeometry.ts` | rendering | yes |
| Box editor view | `native/src/components/practice/ExpressionEditor.tsx` | rendering | yes |
| Pad, glyph keys, unit keys, answer field | `native/src/components/practice/NativePracticeControls.tsx`, `native/src/components/manipulatives/NumberPad.tsx` | keyboard | yes, split into `Keypads.tsx`, `PadKey.tsx`, `MathAnswerInput.tsx` |
| Return-to-advance, off-screen capture field | `HardwareReturnAdvance.tsx`, `TextKeyCapture` | keyboard | yes |
| Hardware keyboard detection | `native/modules/hardware-keyboard` | keyboard (native) | yes, trimmed |
| Tab/arrow capture | `native/modules/key-capture` | keyboard (native) | yes, trimmed |
| LaTeX renderer | `native/modules/expo-math-view` (vendored SwiftMath) | read-only display | **no** (see below) |
| `shared/mathLatex.ts` | | parser for display LaTeX | **no** |
| Web twins: `components/practice/ExpressionKeypad.tsx`, `FractionKey.tsx`, `UnitKeys.tsx`, `shared/appKitWidgets/expressionEditor/*` | | web/DOM renderers of the same model | **no** |
| `PracticePrimaryAction`, `useGuardedPracticeAction` | `NativePracticeControls.tsx` | the app's Check button | **no**, app code |

SwiftMath is not part of the input. The box editor draws React Native views and
one SVG path; `ExpressionEditor.tsx` mentions MathView only in a comment
explaining why it is not used. The keypad needs no native code at all to work;
the two iOS modules only add hardware-keyboard behavior.

## Measured coupling

Method: bundle the original entry points
(`NativePracticeControls.tsx` + `NumberPad.tsx`) with esbuild, externals only
for npm packages, and read the metafile. Then the same for `src/index.ts` here.

| | Before (in Rabbithole) | After (this package) |
|---|---|---|
| Source files reached | 26 | 16 |
| Source bytes reached | 243 KB | 134 KB |
| App-owned modules imported | 4, at 7 import sites | 0 |
| External packages | `react`, `react-native`, `react-native-svg`, `expo`, `expo-modules-core`, `expo-haptics`, `react-native-reanimated` | `react`, `react-native`, `react-native-svg`, `expo-modules-core` |
| Bundle | n/a | 72.5 KB ESM, no unresolved imports |

Esbuild proof command (from the repo root):

```sh
node_modules/.bin/esbuild packages/react-native-math-keypad/src/index.ts \
  --bundle --format=esm --platform=neutral --jsx=automatic \
  --external:react --external:react-native --external:react-native-svg \
  --external:'expo*' --outfile=/tmp/keypad.mjs --metafile=/tmp/keypad.json
```

All 16 inputs are under `packages/react-native-math-keypad/src/`; the only
external imports are `react`, `react/jsx-runtime`, `react-native`,
`react-native-svg` and `expo-modules-core`.

## Every coupling cut, and its replacement

19 in all. Numbers 1–4 are imports into app code, 5–7 avoidable dependencies,
8–9 plumbing, 10–19 practice-specific behavior in props or native code.

| # | Coupling | Where | Replacement |
|---|---|---|---|
| 1 | `@/theme` (`useColors`, `fonts`, `Colors`), which pulls `vendor/shared/brand.ts` and `skyTiers.ts` | `ExpressionEditor`, `NativePracticeControls`, `NumberPad` | `src/theme.ts`: an explicit `MathKeypadTheme` (11 colors, 3 fonts), light and dark defaults from the same palette, a provider, and a per-component `theme` override |
| 2 | `@/lib/deviceActivityQueue` `recordInteraction()` (a presence clock fed by hardware keys) | `src/lib/keyCapture.tsx` seam | dropped; `onChange` fires on every edit including navigation keys, and `onKeyPress` on every on-screen key, so an app can feed its own clock |
| 3 | `vendor/shared/practiceLoop.ts`: a 1,418-line practice engine (breakers, placement, story streaming) of which the pad uses ~12 functions; `practicePad.ts` also re-exported placement copy and stream helpers | `practicePad.ts`, `NumberPad` | `src/model/flatPad.ts`: the pad functions only, code unchanged |
| 4 | `@/components/AppTextInput` (TextInput with `disableKeyboardShortcuts`) | answer field, `TextKeyCapture`, `HardwareReturnAdvance` | plain `TextInput` with the prop set inline |
| 5 | `expo-haptics` `selectionAsync()` on unit keys | `NativePracticeControls` | `onKeyPress` prop; the caller plays haptics |
| 6 | `react-native-reanimated` for the springy key | `PadKey` | React Native `Animated` with the native driver; Reduce Motion via `AccessibilityInfo` |
| 7 | `expo` (only for `requireNativeView`) | `KeyCaptureView` | `requireNativeViewManager` from `expo-modules-core` (what `expo` re-exports) |
| 8 | `@/` path alias + 7 re-export seams under `native/src/lib/` | everywhere | relative imports |
| 9 | 7 vendored copies under `native/vendor/shared/`, kept in sync with `shared/` by `native/scripts/sync-vendor.js` | model files | one copy |
| 10 | `EXPO_PUBLIC_DEV_AUTOLOGIN` env check that kept the digit grid visible for Appium | builder | `numberPad="always"` prop |
| 11 | `PracticeControlStyles` object passed down from `native/src/app/practice.tsx` | answer field, pad | `makeKeyStyles(theme)` with the same values |
| 12 | `focusKey` = `` `${itemId}:${phase}` `` with a `:answering` suffix that decided when to reseed | builder | `resetKey` prop; `enabled={false}` keeps the answer visible |
| 13 | `onRetryIntent`: on a first miss, a tap or keystroke starts a retry and the key is replayed into the new attempt | answer field | **cut** (a practice-loop feature; see "Left behind") |
| 14 | `unitNudge` + `UNIT_MISSING_NUDGE` copy | flat field | **cut**; the caller renders its own message |
| 15 | `answerShape: "twoD"` / `answerFormat` / L1 / L3 server-contract names | builder | `kind: "builder"` and `template` |
| 16 | `PracticePrimaryAction` / `useGuardedPracticeAction` living in the same file | `NativePracticeControls` | left in the app; `HardwareReturnAdvance` is exported for the same job |
| 17 | Branded native identifiers: `org.rabbithole.app.keyCaptureCommand` notification, `rabbitholeHandleKeyCaptureCommand` selector, module names `HardwareKeyboard`, `KeyCapture`, pod author "Rabbithole" | Swift | removed with chord mode; modules renamed `MathKeypadHardwareKeyboard`, `MathKeypadKeyCapture`, one pod `MathKeypad` |
| 18 | Voice-key features in the hardware-keyboard module: raw HID key watching, the Folio mic key (an undocumented press type 504) claimed by swizzling `UIApplication.sendEvent`, app-wide ⌘ chords, a dev key probe | `HardwareKeyboardModule.swift` (457 lines) | trimmed to `isConnected` + `onChange` (~70 lines) |
| 19 | Chord mode in key capture (Escape and Cmd/Ctrl+Enter as `UIKeyCommand`s for a slides editor) | `KeyCaptureView.swift`, `.tsx` | removed |

Smaller adaptations: accessibility labels for grid keys now use the
manipulative pad's wording everywhere ("key fraction bar" rather than "key /");
comments that named app files, the grader, or "scholars" were generalized;
`EXPR_DIGIT_ADVANCE_EM`'s comment now says which font it was measured for.

## Left behind on purpose

- **Implicit retry** (#13). In Rabbithole, after a first wrong answer the field
  stays editable under the feedback; the first keystroke both starts the retry
  and is kept. It is a good pattern, but it needs a contract with the caller's
  attempt state machine. Add it back as an `onRetryIntent` prop if someone asks.
- **The LaTeX renderer** (`expo-math-view`). It renders read-only math in prose
  and is a separate concern. As a sibling package it would bring: SwiftMath
  1.7.3 Swift sources vendored into the pod (MIT, © 2023 Computer
  Inspirations), because SwiftMath is SwiftPM-only and Expo modules can't
  consume SwiftPM; a `Bundle.module` shim, because SwiftPM's synthesized
  accessor doesn't exist in a CocoaPods build; and `mathFonts.bundle` (MIT,
  © 2013 MathChat) trimmed to Fira Math. Fira Math is under the SIL Open Font
  License 1.1 (© 2018–2020 Xiangdong Zeng, per the font's own name table): it
  may be bundled and redistributed with software but not sold on its own.
  **License gap found in passing:** the bundle's `OFL.txt` is the STIX Fonts
  license (STI Pub Companies, reserved name "TM Math"), left over from
  SwiftMath's full font set. The font's name table does carry its copyright
  and a pointer to the OFL, which OFL accepts as metadata, but the stand-alone
  license file names the wrong font. Replace it with Fira Math's OFL text
  before Rabbithole (or a sibling package) is published. Rabbithole also hit a crash
  where SwiftMath eagerly loaded a missing Latin Modern font and force-unwrapped
  it (PR #1122); the module defaults to Fira Math for that reason. Upstream has
  unreleased fixes after 1.7.3; Rabbithole chose to wait for a tagged release.
- **The web renderers.** The model and controller already run on the web.
  Rabbithole's React DOM editor uses Chakra UI and its vanilla-DOM widget
  (`shared/appKitWidgets/expressionEditor/`) needs nothing but the model; the
  widget would be the natural `react-native-math-keypad/dom` entry later.

## What is still hard

- **Native modules need a development build.** Expo Go can't load them;
  `npx expo prebuild` / `expo run:ios` (which run `pod install`) can. No config
  plugin is needed: there are no Info.plist keys or entitlements, and the
  podspec links GameController itself. The JS degrades cleanly when the modules
  are missing, which is the path Expo Go users get.
- **The Swift was syntax-checked, not compiled.** `swiftc -parse` passes on all
  three files. The hardware-keyboard module is a strict subset of the shipped
  one; the key-capture view is the shipped one with chord mode deleted. A real
  build against ExpoModulesCore is the first thing to do.
- **Autolinking from a non-Expo-named package is unverified.** The package has
  `expo-module.config.json` at its root and `ios/MathKeypad.podspec`; that is
  the documented layout, but it hasn't been run through `expo-modules-autolinking`.
- **Peer dependency minimums are unknown.** The code came from React Native
  0.86.2, React 19.2, Expo SDK 57 (`expo-modules-core` 57.0.9) and
  `react-native-svg` 15.15. `disableKeyboardShortcuts` and `submitBehavior` are
  recent TextInput props; the oldest React Native that has both needs checking
  before the peer ranges (currently `*`) are narrowed.
- **Partly run as a package.** Rabbithole's iPad app renders this package's
  `ExpressionEditor` and key faces, but the composed `MathAnswerInput` is new
  wiring that no app runs yet. It needs a
  pass on an iPad simulator and on a real iPad with a Folio: tap-to-place,
  burst typing, Tab/arrows, Return, keyboard attach and detach.
- **Android and react-native-web** are untested. Nothing in the JS is
  iOS-only, but every measurement in the README was taken on iPadOS.

### How Rabbithole consumes it

This package is now the one copy of the answer-entry model in Rabbithole.

- `shared/expressionTemplateInput.ts`, `useExpressionTemplateController.ts`,
  `expressionEditorBoxMetrics.ts`, `radicalGeometry.ts` and `mathNotation.ts`
  are one-line re-exports of `src/`, and `shared/practiceLoop.ts` and
  `shared/staticRadicals.ts` re-export the pad and root-index rules, so the web
  app, the Convex server and the app-kit DOM widget all run this code.
- The iPad app is its own npm project and its Metro never reads outside
  `native/`, so `native/scripts/sync-vendor.js` copies the model, the
  controller, `theme.ts`, `components/ExpressionEditor.tsx`,
  `components/Glyphs.tsx` and `LICENSE` into
  `native/vendor/react-native-math-keypad/`, and rewrites the shims' import
  path. CI reruns that script and fails if the committed copy differs, so the
  vendored files can't drift.
- The app draws the 2-D builder with this package's `ExpressionEditor` (its
  `native/src/components/practice/ExpressionEditor.tsx` only maps the app's
  theme tokens) and the structure keys with `Glyphs.tsx`.
- The app keeps its own practice wrapper (`NativePracticeControls.tsx`): the
  implicit retry (#13), the unit nudge (#14), haptics, the Reanimated springy
  key, the caller-supplied key styles and the Check button. It also keeps its
  own `hardware-keyboard` and `key-capture` native modules, which carry the
  voice-key and chord features this package dropped (#17–#19). So
  `MathAnswerInput`, `NumberPad`, `StructureKeys`, `PadKey`, `TextKeyCapture`
  and the Swift modules here are not exercised by Rabbithole.
- The root `tsconfig.json` excludes `packages/` (the web project has no React
  Native types); the root Vitest project runs `packages/**/*.test.ts`, which
  replaced the five duplicate suites under `shared/`.
- `foundation/public-files.txt` lists every file here, so the package reaches
  the public repository at the next Foundation release.
- **License.** `foundation/README.md` says the public snapshot is
  source-available under an all-rights-reserved notice, "unless a file or
  component states otherwise". This package states otherwise: its own
  `LICENSE` is MIT, copyright "The Rabbithole authors".

## Effort to publish for real: M

Roughly in order:

1. **S** – compile and run it: a bare Expo example app, a development build on
   an iPad simulator and a real iPad with a keyboard case, fix what breaks.
2. **S** – packaging: build `lib/` with react-native-builder-bob or `tsc`,
   ship types, narrow the peer ranges, CI that runs the 277 tests and a
   typecheck.
3. **S** – screenshots and a short video for the README; an npm name (
   `react-native-math-keypad` was free on npm on 2026-11-20).
4. **M** – move Rabbithole's practice screen onto the composed pieces too:
   add `onRetryIntent`, let `NumberPad` take caller key styles, and decide
   between Reanimated and `Animated` for the springy key. Until then those
   pieces have no production user.
5. **S** – a Foundation release, so the files appear in the public repository
   that `package.json` points at.

## What a maintainer would own afterward

- **iPadOS behavior changes.** The AutoFill bubble, the shortcut pill and the
  `onKeyPress` limits are all OS behavior, measured on iOS 26. Each new iPadOS
  release can move them; the README's measurements are the regression list.
- **Expo and React Native upgrades**, especially `expo-modules-core`'s native
  view API, which has been renamed before (`requireNativeViewManager` /
  `requireNativeView`).
- **The model's invariants.** Most feature requests will be grammar changes
  (operators first). The fuzzer and the "name the invariant first" rule are what
  keep those from reintroducing the nonsense states PR #1136 closed.
- **Platform reports** from Android and web users, which Rabbithole never had.
- **Accessibility**, which has labels but no end-to-end VoiceOver pass.
