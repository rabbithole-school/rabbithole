import ExpoModulesCore
import GameController

// Reports whether a physical (hardware) keyboard is connected to the device and
// emits an `onChange` event whenever that changes. Uses the GameController
// framework's `GCKeyboard` API (iOS 14+), which — unlike anything reachable from
// JS — can tell an attached Magic Keyboard from the on-screen soft keyboard.
public class HardwareKeyboardModule: Module {
  private var connectObserver: NSObjectProtocol?
  private var disconnectObserver: NSObjectProtocol?

  private func keyboardConnected() -> Bool {
    if #available(iOS 14.0, *) {
      return GCKeyboard.coalesced != nil
    }
    return false
  }

  public func definition() -> ModuleDefinition {
    Name("HardwareKeyboard")

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
