import ExpoModulesCore

// Registers the off-screen `MathKeypadKeyCaptureView` first responder (see
// MathKeypadKeyCaptureView.swift) with events for a normalized editor key and
// Return. `active` toggles capture.
public class MathKeypadKeyCaptureModule: Module {
  public func definition() -> ModuleDefinition {
    Name("MathKeypadKeyCapture")

    View(MathKeypadKeyCaptureView.self) {
      Events("onKey", "onSubmit")

      Prop("active") { (view: MathKeypadKeyCaptureView, value: Bool) in
        view.setActive(value)
      }
    }
  }
}
