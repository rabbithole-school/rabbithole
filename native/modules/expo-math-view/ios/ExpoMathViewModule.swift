import ExpoModulesCore

public class ExpoMathViewModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoMathView")

    View(ExpoMathView.self) {
      // Fired whenever the typeset content's measured size changes, so the RN
      // wrapper can size itself to the glyphs (native views don't auto-size).
      Events("onSizeChange")

      Prop("latex") { (view: ExpoMathView, latex: String) in
        view.setLatex(latex)
      }
      Prop("fontSize") { (view: ExpoMathView, size: Double) in
        view.setFontSize(size)
      }
      Prop("color") { (view: ExpoMathView, hex: String) in
        view.setColor(hex)
      }
      Prop("typesettingStyle") { (view: ExpoMathView, style: String) in
        view.setTypesettingStyle(style)
      }
    }
  }
}
