import ExpoModulesCore
import Foundation

public class ManagedConfigModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ManagedConfig")

    Function("getManagedConfig") { () -> [String: Any]? in
      // CFPreferences keeps an in-process cache, so a running app goes on
      // serving the claim it read at launch long after MDM replaced it. That is
      // what made a re-paired iPad inert in the field: the app reconciles on
      // every foreground, and every one of those re-read the stale cached claim
      // and correctly concluded nothing had changed. Verified on a leased
      // simulator 2026-08-19 — an external write to
      // `com.apple.configuration.managed` stayed invisible to the running app
      // indefinitely, and appeared the instant it was relaunched.
      //
      // Synchronizing before each read is the whole fix. Deliberately NOT built
      // on UserDefaults.didChangeNotification: Apple documents that it is not
      // posted for changes made outside the current process, and a probe on the
      // simulator confirmed it never fired for exactly this write — so an
      // implementation that leaned on it would look event-driven and never run.
      // Reads happen on launch and on foreground, so the cost is negligible.
      CFPreferencesAppSynchronize(kCFPreferencesCurrentApplication)
      return UserDefaults.standard.dictionary(
        forKey: "com.apple.configuration.managed"
      )
    }
  }
}
