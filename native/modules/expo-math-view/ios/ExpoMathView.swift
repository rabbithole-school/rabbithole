import ExpoModulesCore

// SwiftMath (github.com/mgriebling/SwiftMath, 1.7.3, MIT) is vendored directly
// into this pod (see ios/vendor/SwiftMath/), so its types compile as part of the
// ExpoMathView module — no `import SwiftMath` needed.
//
// This hosts SwiftMath's `MTMathUILabel` (a UIView) as a subview and renders a
// constrained-LaTeX string (the SAME interchange the web KaTeX renderer
// consumes) in the on-brand sans-serif **Fira Math** face. Because a native
// view doesn't auto-size in React Native's Yoga layout, we measure the typeset
// content and report it back to JS via `onSizeChange` so the RN view can size
// itself to the glyphs (and flow inline within tutor prose).
class ExpoMathView: ExpoView {
  private let label = MTMathUILabel()
  private let onSizeChange = EventDispatcher()
  private var lastReportedSize: CGSize = .zero
  private var currentFontSize: CGFloat = 20

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = false
    label.textAlignment = .left
    label.labelMode = .text
    // Never paint SwiftMath's red parser-error string into a child's chat: a
    // malformed run collapses to nothing (intrinsicContentSize .zero) and the
    // MathFlow wrapper's latexToSpeech accessibilityLabel still speaks intent.
    label.displayErrorInline = false
    label.contentInsets = MTEdgeInsets(top: 0, left: 0, bottom: 0, right: 0)
    applyFont()
    addSubview(label)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    label.frame = bounds
  }

  // MARK: - Prop setters (called from ExpoMathViewModule)

  func setLatex(_ latex: String) {
    label.latex = latex
    reportSize()
  }

  func setFontSize(_ size: Double) {
    currentFontSize = CGFloat(size)
    applyFont()
    reportSize()
  }

  func setColor(_ hex: String) {
    if let c = Self.color(fromHex: hex) { label.textColor = c }
  }

  func setTypesettingStyle(_ style: String) {
    label.labelMode = (style == "display") ? .display : .text
    reportSize()
  }

  // MARK: - Helpers

  private func applyFont() {
    label.fontSize = currentFontSize
    // Fira Math is bundled in mathFonts.bundle; fall back to Latin Modern only
    // if the font resource can't be located.
    label.font = MTFontManager.manager.firaRegularFont(withSize: currentFontSize)
      ?? MTFontManager.manager.latinModernFont(withSize: currentFontSize)
  }

  /// Measure the typeset content and, when it changes meaningfully, tell JS so
  /// the RN view can size itself to the glyphs. `intrinsicContentSize` returns
  /// `.zero` for empty / invalid LaTeX, which is safe.
  private func reportSize() {
    setNeedsLayout()
    let size = label.intrinsicContentSize
    guard size.width.isFinite, size.height.isFinite else { return }
    if abs(size.width - lastReportedSize.width) < 0.5,
       abs(size.height - lastReportedSize.height) < 0.5 { return }
    lastReportedSize = size
    onSizeChange([
      "width": Double(size.width),
      "height": Double(size.height),
    ])
  }

  private static func color(fromHex hex: String) -> UIColor? {
    var s = hex.trimmingCharacters(in: .whitespacesAndNewlines)
    if s.hasPrefix("#") { s.removeFirst() }
    guard s.count == 6, let v = UInt32(s, radix: 16) else { return nil }
    return UIColor(
      red: CGFloat((v & 0xFF0000) >> 16) / 255,
      green: CGFloat((v & 0x00FF00) >> 8) / 255,
      blue: CGFloat(v & 0x0000FF) / 255,
      alpha: 1
    )
  }
}
