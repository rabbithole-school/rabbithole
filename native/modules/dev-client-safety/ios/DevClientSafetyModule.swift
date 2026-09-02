import ExpoModulesCore
import Foundation

public class DevClientSafetyModule: Module {
  private let recentAppsKey = "expo.devlauncher.recentlyopenedapps"
  private let resumeLastBundleKey = "EXDevLauncherTryToLaunchLastBundle"
  private let guardedServerKey = "org.rabbithole.app.devClientSafety.guardedServer"
  private let guardedAtKey = "org.rabbithole.app.devClientSafety.guardedAt"

  private func result(
    guarded: Bool,
    serverUrl: String?,
    before: [String],
    after: [String]
  ) -> [String: Any] {
    [
      "guarded": guarded,
      "serverUrl": serverUrl ?? NSNull(),
      "before": before,
      "after": after,
    ]
  }

  private func registryEntry(for serverUrl: String) -> [String: Any] {
    [
      "isEASUpdate": false,
      "timestamp": Int64(Date().timeIntervalSince1970 * 1_000),
      "url": serverUrl,
    ]
  }

  private func probeMetro(_ serverUrl: String, completion: @escaping (Bool) -> Void) {
    guard let baseUrl = URL(string: serverUrl),
          let statusUrl = URL(string: "status", relativeTo: baseUrl) else {
      completion(false)
      return
    }

    var request = URLRequest(url: statusUrl)
    request.timeoutInterval = 4
    URLSession.shared.dataTask(with: request) { data, response, _ in
      let statusCode = (response as? HTTPURLResponse)?.statusCode
      let body = data.flatMap { String(data: $0, encoding: .utf8) }?
        .trimmingCharacters(in: .whitespacesAndNewlines)
      completion(statusCode == 200 && body == "packager-status:running")
    }.resume()
  }

  public func definition() -> ModuleDefinition {
    Name("DevClientSafety")

    AsyncFunction("guardCurrentServer") { (preferredUrl: String, promise: Promise) in
      #if DEBUG
      let defaults = UserDefaults.standard
      let recentApps = defaults.dictionary(forKey: self.recentAppsKey) ?? [:]
      let before = recentApps.keys.sorted()
      // Expo's picker can receive localhost while the loaded bundle reports
      // 127.0.0.1. After that mismatch, the launcher has not recorded the live
      // URL yet even though this process is already running its bundle.
      let current = recentApps[preferredUrl] ?? self.registryEntry(for: preferredUrl)

      self.probeMetro(preferredUrl) { reachable in
        guard reachable else {
          promise.resolve(self.result(
            guarded: false,
            serverUrl: preferredUrl,
            before: before,
            after: before
          ))
          return
        }

        defaults.set([preferredUrl: current], forKey: self.recentAppsKey)
        defaults.set(true, forKey: self.resumeLastBundleKey)
        defaults.set(preferredUrl, forKey: self.guardedServerKey)
        defaults.set(
          Int64(Date().timeIntervalSince1970 * 1_000),
          forKey: self.guardedAtKey
        )
        defaults.synchronize()

        let after = (defaults.dictionary(forKey: self.recentAppsKey) ?? [:]).keys.sorted()
        promise.resolve(self.result(
          guarded: after == [preferredUrl],
          serverUrl: preferredUrl,
          before: before,
          after: after
        ))
      }
      #else
      promise.resolve(self.result(
        guarded: false,
        serverUrl: nil,
        before: [],
        after: []
      ))
      #endif
    }
  }
}
