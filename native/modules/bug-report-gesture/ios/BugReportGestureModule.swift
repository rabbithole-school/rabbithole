import ExpoModulesCore
import UIKit

private let requiredTouches = 3
private let minimumPressDuration = 1.5
private let allowableMovement: CGFloat = 24

private final class ExactTouchLongPressGestureRecognizer: UILongPressGestureRecognizer {
  let exactTouchCount: Int

  init(
    exactTouchCount: Int,
    target: Any?,
    action: Selector?
  ) {
    self.exactTouchCount = exactTouchCount
    super.init(target: target, action: action)
    numberOfTouchesRequired = exactTouchCount
  }

  override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
    super.touchesBegan(touches, with: event)
    guard numberOfTouches > exactTouchCount else { return }
    state = state == .began || state == .changed ? .cancelled : .failed
  }

  override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
    let remainingTouches = max(0, numberOfTouches - touches.count)
    if (state == .began || state == .changed) && remainingTouches < exactTouchCount {
      state = .ended
      return
    }
    super.touchesEnded(touches, with: event)
  }
}

private final class BugReportGestureCoordinator: NSObject, UIGestureRecognizerDelegate {
  typealias Emitter = (_ phase: String, _ sequence: Int, _ touches: Int) -> Void

  private weak var installedWindow: UIWindow?
  private var recognizer: UILongPressGestureRecognizer?
  private var notificationObservers: [NSObjectProtocol] = []
  private var emitter: Emitter?
  private var nextSequence = 0
  private var activeSequence: Int?

  func start(emitter: @escaping Emitter) {
    stop()
    self.emitter = emitter
    installOnKeyWindow()
    let center = NotificationCenter.default
    notificationObservers = [
      center.addObserver(
        forName: UIWindow.didBecomeKeyNotification,
        object: nil,
        queue: .main
      ) { [weak self] _ in
        self?.installOnKeyWindow()
      },
      center.addObserver(
        forName: UIScene.didActivateNotification,
        object: nil,
        queue: .main
      ) { [weak self] _ in
        self?.installOnKeyWindow()
      },
    ]
  }

  func stop() {
    notificationObservers.forEach(NotificationCenter.default.removeObserver)
    notificationObservers.removeAll()
    if let recognizer {
      cancelActiveGesture(touches: recognizer.numberOfTouches)
      recognizer.view?.removeGestureRecognizer(recognizer)
    }
    recognizer = nil
    installedWindow = nil
    activeSequence = nil
    emitter = nil
  }

  func installOnKeyWindow() {
    dispatchPrecondition(condition: .onQueue(.main))
    guard let window = keyWindow() else { return }
    if installedWindow === window, recognizer?.view === window { return }

    if let recognizer {
      cancelActiveGesture(touches: recognizer.numberOfTouches)
      recognizer.view?.removeGestureRecognizer(recognizer)
    }

    let recognizer = ExactTouchLongPressGestureRecognizer(
      exactTouchCount: requiredTouches,
      target: self,
      action: #selector(handleGesture(_:))
    )
    recognizer.minimumPressDuration = minimumPressDuration
    recognizer.allowableMovement = allowableMovement
    recognizer.cancelsTouchesInView = false
    recognizer.delaysTouchesBegan = false
    recognizer.delaysTouchesEnded = false
    recognizer.delegate = self
    window.addGestureRecognizer(recognizer)
    self.recognizer = recognizer
    installedWindow = window
    NSLog("[BugReportGesture] installed on \(type(of: window))")
  }

  @objc
  private func handleGesture(_ gesture: UILongPressGestureRecognizer) {
    switch gesture.state {
    case .began:
      nextSequence += 1
      activeSequence = nextSequence
      emit("began", gesture: gesture, sequence: nextSequence)
    case .ended:
      guard let sequence = activeSequence else { return }
      activeSequence = nil
      emit("ended", gesture: gesture, sequence: sequence)
    case .cancelled:
      cancelActiveGesture(touches: gesture.numberOfTouches)
    default:
      break
    }
  }

  private func emit(
    _ phase: String,
    gesture: UILongPressGestureRecognizer,
    sequence: Int
  ) {
    let touches = gesture.numberOfTouches
    NSLog("[BugReportGesture] phase=\(phase) sequence=\(sequence) touches=\(touches)")
    emitter?(phase, sequence, touches)
  }

  private func cancelActiveGesture(touches: Int) {
    guard let sequence = activeSequence else { return }
    activeSequence = nil
    NSLog("[BugReportGesture] phase=cancelled sequence=\(sequence) touches=\(touches)")
    emitter?("cancelled", sequence, touches)
  }

  func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
    if accessibilityGestureOwnerActive {
      NSLog("[BugReportGesture] yielding to VoiceOver or Switch Control")
      return false
    }
    return true
  }

  func gestureRecognizer(
    _ gestureRecognizer: UIGestureRecognizer,
    shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
  ) -> Bool {
    return true
  }

  private var accessibilityGestureOwnerActive: Bool {
    return UIAccessibility.isVoiceOverRunning || UIAccessibility.isSwitchControlRunning
  }

  private func keyWindow() -> UIWindow? {
    let scenes = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .sorted { lhs, rhs in
        sceneRank(lhs.activationState) < sceneRank(rhs.activationState)
      }
    for scene in scenes {
      if let window = scene.windows.first(where: \.isKeyWindow) {
        return window
      }
    }
    return scenes.lazy.flatMap(\.windows).first(where: { !$0.isHidden })
  }

  private func sceneRank(_ state: UIScene.ActivationState) -> Int {
    switch state {
    case .foregroundActive:
      return 0
    case .foregroundInactive:
      return 1
    case .background:
      return 2
    case .unattached:
      return 3
    @unknown default:
      return 4
    }
  }
}

public class BugReportGestureModule: Module {
  private let coordinator = BugReportGestureCoordinator()

  public func definition() -> ModuleDefinition {
    Name("BugReportGesture")

    Events("onGesture")

    OnStartObserving {
      DispatchQueue.main.async {
        self.coordinator.start { [weak self] phase, sequence, touches in
          self?.sendEvent("onGesture", [
            "phase": phase,
            "sequence": sequence,
            "touches": touches,
          ])
        }
      }
    }

    OnStopObserving {
      DispatchQueue.main.async {
        self.coordinator.stop()
      }
    }
  }
}
