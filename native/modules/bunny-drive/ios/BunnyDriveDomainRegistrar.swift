import ExpoModulesCore
import FileProvider

// A replicated file provider has no location until its containing app adds a
// domain. Adding one that already exists is a no-op, so this runs every launch.
public final class BunnyDriveDomainRegistrar: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let domain = NSFileProviderDomain(
      identifier: NSFileProviderDomainIdentifier("bunny-drive"),
      displayName: "Bunny Drive"
    )
    NSFileProviderManager.add(domain) { error in
      if let error {
        NSLog("[BunnyDrive] could not add the Files location: %@", error.localizedDescription)
      }
    }
    return true
  }
}
