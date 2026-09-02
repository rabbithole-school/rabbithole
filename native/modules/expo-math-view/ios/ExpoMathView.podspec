Pod::Spec.new do |s|
  s.name           = 'ExpoMathView'
  s.version        = '1.0.0'
  s.summary        = 'Native iOS LaTeX renderer for Rabbithole tutor prose'
  s.description    = 'A local Expo module that renders a constrained-LaTeX subset natively via SwiftMath (MTMathUILabel) in the Fira Math face — no WebView. Consumes the same generated LaTeX string as the web KaTeX renderer.'
  s.author         = 'Rabbithole'
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '16.4'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # ── SwiftMath (github.com/mgriebling/SwiftMath 1.7.3, MIT) ──────────────────
  # SwiftMath is SPM-only, and neither Expo's module config nor CocoaPods can
  # autolink a SwiftPM package into this pod target. Rather than a binary
  # xcframework (repo-hygiene: no committed blobs) or fragile SPM↔pod
  # cross-linking, we VENDOR its Swift source directly into this pod
  # (ios/vendor/SwiftMath/**). The sources then compile as part of the
  # ExpoMathView module, so ExpoMathView.swift uses MTMathUILabel with no
  # `import SwiftMath`. See ios/vendor/SwiftMath/LICENSE for attribution.
  #
  # The math fonts (incl. Fira Math) ship as a resource bundle; the vendored
  # BundleModule.swift shim resolves SwiftMath's `Bundle.module` font lookups to
  # it (SwiftPM's synthesized accessor is absent in a CocoaPods build).
  s.resource_bundles = {
    'SwiftMathFonts' => ['vendor/SwiftMath/mathFonts.bundle']
  }

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  # Globs this dir recursively, so both the module sources and the vendored
  # SwiftMath sources under vendor/SwiftMath/** are compiled into the pod.
  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
