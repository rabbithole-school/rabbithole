# expo-math-view

A local Expo native module that renders a **constrained-LaTeX subset** natively
on iPad via [SwiftMath](https://github.com/mgriebling/SwiftMath)'s
`MTMathUILabel` — proper stacked fractions (vinculum), mixed numbers, and blanks,
with **no WebView**. It consumes the *same* generated LaTeX string as the web
KaTeX renderer and the cross-platform lite renderer (`shared/mathLatex.ts`), so
one string drives every surface.

## Status: shipped (PR #635)

This module is wired and live on the iPad tutor-prose path (`Markdown.tsx` →
`MathFlow` → `MathView`), with a rendering gallery at `native:///dev-latex`.
Rendering is verified on iPad hardware.

## How it's wired

SwiftMath is **SPM-only**, and Expo modules have no SPM ingestion path (the
[`expo-module.config.json` reference](https://docs.expo.dev/modules/module-config.md)'s
`apple` options are only `modules` / `appDelegateSubscribers`; CocoaPods 1.16.2
has no `spm_dependency`). So SwiftMath's Swift **source is vendored directly
into this pod** (`ios/vendor/SwiftMath/**`, picked up by the podspec's
`source_files`) and compiles as part of the ExpoMathView module — no
`import SwiftMath`, no binary artifacts in the repo.

Two supporting pieces (see the podspec comments):

- **Fonts:** a trimmed `mathFonts.bundle` (Fira Math only) ships via
  `s.resource_bundles` as `SwiftMathFonts.bundle`.
- **`Bundle.module` shim:** SwiftMath's font loader calls the SPM-synthesized
  `Bundle.module`, which doesn't exist in a CocoaPods build — the vendored
  `BundleModule.swift` provides it, resolving whichever bundle actually holds
  `mathFonts.bundle`.

**Declined alternatives:** a vendored `SwiftMath.xcframework`
(`s.vendored_frameworks`) — works per the Expo docs but commits a binary blob
and makes the `Bundle.module` resource packaging the fiddly part; and injecting
the SPM package via a config plugin — no first-party helper exists, so it means
hand-writing raw `XCRemoteSwiftPackageReference` pbxproj nodes (brittle,
undocumented).

Pin: `https://github.com/mgriebling/SwiftMath.git` **exact 1.7.3** (the vendored
sources are byte-identical to that tag; `BundleModule.swift` is the only local
addition). As of 2026-07-17 there is **no upstream release after 1.7.3**, but
upstream `main` carries unreleased fixes for both authoring quirks below
(mgriebling/SwiftMath#52 single-column `cases`, #57 stretchy `\overrightarrow`)
plus typesetting/perf fixes (#55, #60, #63, #67, #69, #70). Decision (Andy,
2026-07-17): **wait for the next tagged upstream release** rather than vendor an
untagged `main` snapshot; the upgrade runbook + ecosystem watch-list live in
`TODO.html#swiftmath-release-pin`.

## Usage

```tsx
import { MathView } from '@/modules/expo-math-view'; // native
// or from the module path

<MathView latex="9\\frac{4}{9}" fontSize={32} typesettingStyle="text" />
```

On web (`react-native-web` / Expo web) this resolves to `MathView.web.tsx`,
which delegates to the lite `MathText` renderer for visual parity.

## Why SwiftMath (not swiftui-math / LaTeXSwiftUI)

All three compile on our toolchain. SwiftMath (`MTMathUILabel`) is UIKit, so it
drops straight into an `ExpoView` (a `UIView`) with no `UIHostingController`; it
is the community-preferred *native-vector* renderer for performance-heavy
education apps, has zero transitive dependencies, and is actively maintained.
`swiftui-math` is the SwiftUI-API sibling (also zero-dep, needs hosting);
`LaTeXSwiftUI` is MathJax→SVG (VoiceOver built in, but pulls a JS engine +
SVG rasterizer). See the spike writeup (PR #618, closed as superseded).

**Font note:** this module typesets in **Fira Math** (`ExpoMathView.applyFont`)
— the on-brand geometric sans that pairs with Hanken Grotesk. Still, pass only
the *math* to `MathView` and keep surrounding prose in the app's Hanken Grotesk
`Text` — don't wrap whole sentences in `\text{}`, or the words render in the
math face too.

## Two SwiftMath 1.7.3 authoring quirks

Found in the SwiftMath rendering spike (PR #618, closed as superseded by this
module); both are authoring-time constraints, not blockers:

1. **Single-column aligned environments render blank.** `\begin{cases}a\\b\end{cases}`
   (no `&`) typesets to nothing — no parse error, just empty. Adding a trailing
   `&` per row (an empty second column) fixes it: `\begin{cases}a &\\ b &\end{cases}`.
   Two-column `cases` and all `matrix` variants work fine.
2. **Stretchy `\overrightarrow` renders blank** with the bundled fonts, while the
   fixed-size `\vec{AB}` renders correctly — use `\vec` for rays. (The segment
   over-bar `\overline{AB}` works.)
