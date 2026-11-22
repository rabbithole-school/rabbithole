import ExpoModulesCore
import ObjectiveC
import UIKit

// React Native closes a <Modal> by calling `dismissViewControllerAnimated:` on
// the modal's own view controller. When that controller is itself presenting
// something (the camera, a photo picker, an action sheet), UIKit dismisses only
// that child. The modal stays on screen with its React content unmounted: an
// empty full-screen view that takes every touch, and the app looks frozen.
//
// That is how a BunnyPad froze when a scholar rotated it mid-photo: the rotation
// swapped the session layout, which unmounted the slide editor's Modal while
// the camera was open on top of it.
//
// React Native fixed this on main in facebook/react-native#58364 (2026-09-11).
// We build against React Native's precompiled framework, so a source patch
// would never reach the binary; this applies the same change at launch instead.
// Delete this module once Expo ships a React Native that includes #58364. If
// the method is ever renamed, the lookup fails and this does nothing.
public final class ModalDismissFix: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    _ = Self.installOnce
    return true
  }

  private typealias Completion = @convention(block) () -> Void
  private typealias DismissIMP = @convention(c) (AnyObject, Selector, UIViewController, Bool, Completion?) -> Void
  private typealias DismissBlock = @convention(block) (AnyObject, UIViewController, Bool, Completion?) -> Void

  private static let installOnce: Void = {
    let selector = NSSelectorFromString("dismissViewController:animated:completion:")
    guard
      let hostClass = NSClassFromString("RCTModalHostViewComponentView"),
      let method = class_getInstanceMethod(hostClass, selector)
    else {
      NSLog("[ModalDismissFix] RCTModalHostViewComponentView dismissal not found; leaving React Native as is")
      return
    }

    let original = unsafeBitCast(method_getImplementation(method), to: DismissIMP.self)
    let replacement: DismissBlock = { host, modal, animated, completion in
      // React Native mounts and unmounts views on the main thread.
      MainActor.assumeIsolated {
        guard modal.presentedViewController != nil else {
          original(host, selector, modal, animated, completion)
          return
        }
        // Dismissing from the presenter closes the modal and everything above it.
        (modal.presentingViewController ?? modal).dismiss(animated: animated) { completion?() }
      }
    }
    method_setImplementation(method, imp_implementationWithBlock(replacement))
  }()
}
