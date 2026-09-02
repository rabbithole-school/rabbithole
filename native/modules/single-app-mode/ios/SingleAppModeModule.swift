import ExpoModulesCore
import UIKit

// Bridges iOS **Autonomous Single App Mode (ASAM)** to JS. The app can lock
// ITSELF into single-app mode — the same "Guided Access" lockdown, but initiated
// by the app rather than a triple-click — via
// `UIAccessibility.requestGuidedAccessSession(enabled:completionHandler:)`.
//
// This ONLY succeeds when the bundle is whitelisted for ASAM by MDM
// (Configuration profile → "Autonomous Single App Mode" listing this bundle id).
// On any other device — an unmanaged iPad, the Simulator, a non-whitelisted
// build — the API simply completes with `false`; it never throws or crashes. So
// every entry point here NO-OP-fails gracefully and the JS side degrades to
// "not locked".
//
// UIAccessibility is main-thread-only, so both transitions hop to the main queue
// before touching it.
public class SingleAppModeModule: Module {
  // Keep the original key so an upgrade can restore brightness captured by the
  // first brightness-pinning implementation.
  private let brightnessBeforeControlKey = "school.rabbithole.asam.brightnessBeforePin"
  private var brightnessBeforeControl: CGFloat?

  private func storedBrightnessBeforeControl() -> CGFloat? {
    guard
      let stored = UserDefaults.standard.object(forKey: self.brightnessBeforeControlKey)
        as? NSNumber
    else {
      return nil
    }
    let brightness = CGFloat(stored.doubleValue)
    guard (0.0...1.0).contains(brightness) else {
      UserDefaults.standard.removeObject(forKey: self.brightnessBeforeControlKey)
      return nil
    }
    return brightness
  }

  private func setManagedMaximumBrightness(_ enabled: Bool) {
    if enabled {
      if self.brightnessBeforeControl == nil {
        if let storedBrightness = self.storedBrightnessBeforeControl() {
          self.brightnessBeforeControl = storedBrightness
        } else {
          let currentBrightness = UIScreen.main.brightness
          self.brightnessBeforeControl = currentBrightness
          UserDefaults.standard.set(
            Double(currentBrightness),
            forKey: self.brightnessBeforeControlKey
          )
        }
      }
      UIScreen.main.brightness = 1.0
      return
    }

    if let previousBrightness =
      self.brightnessBeforeControl ?? self.storedBrightnessBeforeControl()
    {
      UIScreen.main.brightness = previousBrightness
    }
    self.brightnessBeforeControl = nil
    UserDefaults.standard.removeObject(forKey: self.brightnessBeforeControlKey)
  }

  public func definition() -> ModuleDefinition {
    Name("SingleAppMode")

    // Synchronous point-in-time read of the OS truth, so JS can seed state.
    // False on the Simulator / any non-managed device.
    Function("isActive") { () -> Bool in
      return UIAccessibility.isGuidedAccessEnabled
    }

    // Lock the app into Single App Mode. Resolves the OS-reported success flag
    // (false when the app isn't ASAM-permitted) — never rejects.
    AsyncFunction("enter") { (promise: Promise) in
      DispatchQueue.main.async {
        UIAccessibility.requestGuidedAccessSession(enabled: true) { success in
          promise.resolve(success)
        }
      }
    }

    // Release Single App Mode so the surrounding kiosk (and Settings → Wi-Fi)
    // is reachable again. Resolves the OS-reported success flag — never rejects.
    AsyncFunction("exit") { (promise: Promise) in
      DispatchQueue.main.async {
        UIAccessibility.requestGuidedAccessSession(enabled: false) { success in
          promise.resolve(success)
        }
      }
    }

    AsyncFunction("setManagedMaximumBrightness") { (enabled: Bool, promise: Promise) in
      DispatchQueue.main.async {
        self.setManagedMaximumBrightness(enabled)
        promise.resolve(nil)
      }
    }
  }
}
