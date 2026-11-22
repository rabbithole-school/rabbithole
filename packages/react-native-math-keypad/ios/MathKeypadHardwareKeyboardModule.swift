import ExpoModulesCore
import GameController

// Reports whether a physical (hardware) keyboard is connected and emits
// `onChange` when that changes. Uses GameController's `GCKeyboard` (iOS 14+),
// which — unlike anything reachable from JavaScript — can tell an attached
// Magic Keyboard from the on-screen soft keyboard.
//
// Extracted from Rabbithole's native/modules/hardware-keyboard, trimmed to the
// connection check. (The app's module also watches raw HID keys, the Magic
// Keyboard Folio's mic key and app-wide chords for a voice feature.)
//
// Simulator caveat: toggling "Connect Hardware Keyboard" on a running
// simulator does not post GCKeyboardDidDisconnect; real hardware does.
public class MathKeypadHardwareKeyboardModule: Module {
  private var connectObserver: NSObjectProtocol?
  private var disconnectObserver: NSObjectProtocol?

  private func keyboardConnected() -> Bool {
    if #available(iOS 14.0, *) {
      return GCKeyboard.coalesced != nil
    }
    return false
  }

  public func definition() -> ModuleDefinition {
    Name("MathKeypadHardwareKeyboard")

    Events("onChange")

    // Synchronous point-in-time check, so JS can seed initial state.
    Function("isConnected") { () -> Bool in
      return self.keyboardConnected()
    }

    OnStartObserving {
      guard #available(iOS 14.0, *) else { return }
      self.connectObserver = NotificationCenter.default.addObserver(
        forName: .GCKeyboardDidConnect,
        object: nil,
        queue: .main
      ) { [weak self] _ in
        guard let self = self else { return }
        self.sendEvent("onChange", ["connected": self.keyboardConnected()])
      }
      self.disconnectObserver = NotificationCenter.default.addObserver(
        forName: .GCKeyboardDidDisconnect,
        object: nil,
        queue: .main
      ) { [weak self] _ in
        guard let self = self else { return }
        self.sendEvent("onChange", ["connected": self.keyboardConnected()])
      }
    }

    OnStopObserving {
      if let observer = self.connectObserver {
        NotificationCenter.default.removeObserver(observer)
        self.connectObserver = nil
      }
      if let observer = self.disconnectObserver {
        NotificationCenter.default.removeObserver(observer)
        self.disconnectObserver = nil
      }
    }
  }
}
