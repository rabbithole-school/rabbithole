import Foundation

private final class SwiftMathBundleToken {}

// SwiftMath's font loader (MathFont.swift / MTFont.swift) calls the SPM-synthesized
// `Bundle.module.url(forResource: "mathFonts", withExtension: "bundle")`. When the
// package is vendored into a CocoaPods pod (not built by SwiftPM), that accessor
// doesn't exist — so we provide it here, resolving whichever bundle actually holds
// `mathFonts.bundle`. This handles both CocoaPods layouts:
//   • `resource_bundles` → nested inside `SwiftMathFonts.bundle`
//   • a dynamic framework  → `mathFonts.bundle` sits directly in the module bundle
extension Bundle {
  static let module: Bundle = {
    let candidates: [Bundle] = [Bundle(for: SwiftMathBundleToken.self), .main]
    for base in candidates {
      if let url = base.url(forResource: "SwiftMathFonts", withExtension: "bundle"),
         let nested = Bundle(url: url),
         nested.url(forResource: "mathFonts", withExtension: "bundle") != nil {
        return nested
      }
      if base.url(forResource: "mathFonts", withExtension: "bundle") != nil {
        return base
      }
    }
    return Bundle(for: SwiftMathBundleToken.self)
  }()
}
