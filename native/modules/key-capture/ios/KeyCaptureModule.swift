import ExpoModulesCore

// Registers the off-screen `KeyCapture` first-responder view (see
// KeyCaptureView.swift) with events for a normalized editor key, Return, and
// editor command chords. `active` toggles capture; `captureChords` selects the
// controller-level key-command mode that leaves a TextInput first responder.
public class KeyCaptureModule: Module {
  public func definition() -> ModuleDefinition {
    Name("KeyCapture")

    // JS probes this before passing `onChord`, so an older cached dev client
    // never receives a native event prop it does not know about.
    Function("supportsChords") { () -> Bool in
      true
    }

    View(KeyCaptureView.self) {
      Events("onKey", "onSubmit", "onChord")

      Prop("active") { (view: KeyCaptureView, value: Bool) in
        view.setActive(value)
      }

      Prop("captureChords") { (view: KeyCaptureView, value: Bool) in
        view.setCaptureChords(value)
      }
    }
  }
}
