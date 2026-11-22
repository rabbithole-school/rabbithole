import ExpoModulesCore
import GameController
import UIKit

// Reports whether a physical (hardware) keyboard is connected to the device and
// emits an `onChange` event whenever that changes. Uses the GameController
// framework's `GCKeyboard` API (iOS 14+), which — unlike anything reachable from
// JS — can tell an attached Magic Keyboard from the on-screen soft keyboard.
//
// The voice key (src/lib/voiceKey.ts) adds two input streams, both independent
// of which view is first responder:
//
// - `setWatchedKeys([hid])` → `onWatchedKey`: ordinary keyboard keys, as raw HID
//   usages from `GCKeyboard` (down/up, plus `chorded` when any other key went
//   down during the hold). Only the listed usages cross the bridge.
// - `setWatchedPressTypes([type])` → `onWatchedPress`: system buttons that carry
//   no key code. The Magic Keyboard Folio's top-row mic key is one: on a real
//   BunnyPad (2026-11-11) it reached the app only as a `UIPress` of the
//   undocumented type 504 with `key == nil`, never through GameController, with
//   or without a text field focused. With Siri allowed, iPadOS also opens a
//   "Turn on Siri" prompt; the student MDM profile blocks Siri, and then the
//   press is the app's alone. These presses are read at
//   `UIApplication.sendEvent`, through a swizzle.
// - `setClaimedPressTypes([type])`: keyless presses UIKit must not see. The
//   swizzle drops them instead of forwarding them, so a focused text field
//   cannot take the mic key for its Dictation key and open iOS dictation over
//   the app's own recorder (2026-11-14: the chat composer, which is focused
//   most of the time). Unclaimed presses are forwarded untouched.
// - `setWatchedCommands(["cmd+/"])` → `onWatchedCommand`: app-wide chords, heard
//   two ways and reported once. GameController hears them whatever has focus,
//   including nothing: on a real BunnyPad (2026-11-11) a `UIKeyCommand` alone
//   never fired with nothing focused, the builder's usual state. A
//   `UIKeyCommand` on the key window's root view controller is kept because it
//   CONSUMES the chord when a text field is focused, so ⌘/ never types a "/".
//
// `setProbe(true)` (dev only, /dev-key-probe) emits `onKeyProbe` for every key
// from GameController and every press `sendEvent` sees. Ordinary letter and
// modifier keys did NOT show up at `sendEvent` on the device even though text
// fields receive them, so absence there proves nothing about UIKit delivery.
public class HardwareKeyboardModule: Module {
  private var connectObserver: NSObjectProtocol?
  private var disconnectObserver: NSObjectProtocol?

  private var watchedKeys: Set<Int> = []
  private var probing = false
  private var heldKeys: Set<Int> = []
  // Watched keys currently held, and whether anything else went down meanwhile.
  private var chordedWhileHeld: [Int: Bool] = [:]
  private var heldSince: [Int: CFAbsoluteTime] = [:]

  private func keyboardConnected() -> Bool {
    if #available(iOS 14.0, *) {
      return GCKeyboard.coalesced != nil
    }
    return false
  }

  private func attachKeyHandler() {
    guard #available(iOS 14.0, *) else { return }
    guard let input = GCKeyboard.coalesced?.keyboardInput else { return }
    input.keyChangedHandler = { [weak self] _, _, keyCode, pressed in
      self?.handleGCKey(Int(keyCode.rawValue), pressed: pressed)
    }
  }

  private func handleGCKey(_ code: Int, pressed: Bool) {
    if pressed {
      for held in chordedWhileHeld.keys where held != code {
        chordedWhileHeld[held] = true
      }
      heldKeys.insert(code)
    } else {
      heldKeys.remove(code)
    }

    if probing {
      sendEvent("onKeyProbe", [
        "channel": "gc",
        "hid": code,
        "phase": pressed ? "down" : "up",
      ])
    }

    if pressed { AppKeyCommands.handleGCKey(code, held: heldKeys) }

    guard watchedKeys.contains(code) else { return }
    if pressed {
      // Already holding another key (e.g. Shift+Return): a chord from the start.
      chordedWhileHeld[code] = heldKeys.count > 1
      heldSince[code] = CFAbsoluteTimeGetCurrent()
      sendEvent("onWatchedKey", ["hid": code, "phase": "down", "chorded": chordedWhileHeld[code] ?? false])
    } else {
      let chorded = chordedWhileHeld.removeValue(forKey: code) ?? false
      let since = heldSince.removeValue(forKey: code) ?? CFAbsoluteTimeGetCurrent()
      sendEvent("onWatchedKey", [
        "hid": code,
        "phase": "up",
        "chorded": chorded,
        "heldMs": Int((CFAbsoluteTimeGetCurrent() - since) * 1000),
      ])
    }
  }

  public func definition() -> ModuleDefinition {
    Name("HardwareKeyboard")

    Events("onChange", "onWatchedKey", "onWatchedPress", "onWatchedCommand", "onKeyProbe")

    // Synchronous point-in-time check, so JS can seed initial state.
    Function("isConnected") { () -> Bool in
      return self.keyboardConnected()
    }

    // JS checks these before subscribing, so a dev client built before a
    // capability existed degrades to "no voice key" instead of a silent no-op.
    Function("supportsKeyEvents") { () -> Bool in
      true
    }
    Function("supportsPressEvents") { () -> Bool in
      true
    }

    Function("setWatchedKeys") { (codes: [Int]) in
      DispatchQueue.main.async {
        self.watchedKeys = Set(codes)
        self.attachKeyHandler()
      }
    }

    Function("setWatchedPressTypes") { (types: [Int]) in
      DispatchQueue.main.async {
        PressSpy.watchedTypes = Set(types)
        PressSpy.onWatched = types.isEmpty ? nil : { [weak self] type, phase in
          self?.sendEvent("onWatchedPress", ["type": type, "phase": phase])
        }
        if !types.isEmpty { PressSpy.install() }
      }
    }

    Function("supportsPressClaims") { () -> Bool in
      true
    }

    Function("setClaimedPressTypes") { (types: [Int]) in
      DispatchQueue.main.async {
        PressSpy.claimedTypes = Set(types)
        if !types.isEmpty { PressSpy.install() }
      }
    }

    Function("supportsCommandEvents") { () -> Bool in
      true
    }

    Function("setWatchedCommands") { (chords: [String]) in
      DispatchQueue.main.async {
        self.attachKeyHandler()
        AppKeyCommands.onCommand = chords.isEmpty ? nil : { [weak self] chord in
          self?.sendEvent("onWatchedCommand", ["chord": chord])
        }
        AppKeyCommands.set(chords)
      }
    }

    // Is anything taking typed text right now: a React Native field, or an
    // input inside a web view (the builder's live app)? Read from UIKit's first
    // responder, which React Native's own focus tracking cannot see into.
    AsyncFunction("isEditingText") { () -> Bool in
      return FirstResponder.current() is UIKeyInput
    }.runOnQueue(.main)

    // Resign whatever has keyboard focus, web views included.
    AsyncFunction("endEditing") { () in
      UIApplication.shared.sendAction(
        #selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }.runOnQueue(.main)

    Function("setProbe") { (enabled: Bool) in
      DispatchQueue.main.async {
        self.probing = enabled
        self.attachKeyHandler()
        PressSpy.onProbe = enabled ? { [weak self] payload in
          self?.sendEvent("onKeyProbe", payload)
        } : nil
        if enabled { PressSpy.install() }
      }
    }

    OnStartObserving {
      guard #available(iOS 14.0, *) else { return }
      self.attachKeyHandler()
      self.connectObserver = NotificationCenter.default.addObserver(
        forName: .GCKeyboardDidConnect,
        object: nil,
        queue: .main
      ) { [weak self] _ in
        guard let self = self else { return }
        self.attachKeyHandler()
        self.sendEvent("onChange", ["connected": self.keyboardConnected()])
      }
      self.disconnectObserver = NotificationCenter.default.addObserver(
        forName: .GCKeyboardDidDisconnect,
        object: nil,
        queue: .main
      ) { [weak self] _ in
        guard let self = self else { return }
        self.heldKeys.removeAll()
        self.chordedWhileHeld.removeAll()
        self.heldSince.removeAll()
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

// Reads UIKit presses at `UIApplication.sendEvent`. Installed once, on first
// use. It forwards every event untouched except one made only of claimed
// keyless presses, which UIKit never sees.
enum PressSpy {
  static var watchedTypes: Set<Int> = []
  static var claimedTypes: Set<Int> = []
  static var onWatched: ((Int, String) -> Void)?
  static var onProbe: (([String: Any]) -> Void)?
  private static var installed = false
  // Presses whose began UIKit never saw. A press keeps the fate of its first
  // phase, so UIKit never gets half of one when the claim changes mid-press
  // (focus moving while the key is held, or a press older than the claim).
  private static let dropped = NSHashTable<UIPress>(options: [.weakMemory, .objectPointerPersonality])

  // Keep the event from UIKit when every press that changed in it is claimed.
  // An event is dropped or forwarded whole, so a claimed press that changes in
  // the same event as an unclaimed one reaches UIKit with it. Accepted: on the
  // device, keyed presses never pass through sendEvent (see the header), so
  // the mic key has had nothing to share an event with.
  static func shouldDrop(_ event: UIEvent) -> Bool {
    guard event.type == .presses, let presses = event as? UIPressesEvent else { return false }
    let changed = presses.allPresses.filter { $0.phase != .stationary }
    guard !changed.isEmpty else { return false }
    let drop = changed.allSatisfy { press in
      press.phase == .began
        ? press.key == nil && claimedTypes.contains(press.type.rawValue)
        : dropped.contains(press)
    }
    for press in changed {
      if press.phase == .ended || press.phase == .cancelled {
        dropped.remove(press)
      } else if drop, press.phase == .began {
        dropped.add(press)
      }
    }
    return drop
  }

  static func install() {
    guard !installed else { return }
    installed = true
    guard
      let original = class_getInstanceMethod(UIApplication.self, #selector(UIApplication.sendEvent(_:))),
      let spy = class_getInstanceMethod(UIApplication.self, #selector(UIApplication.rh_spySendEvent(_:)))
    else { return }
    method_exchangeImplementations(original, spy)
  }

  static func report(_ event: UIEvent) {
    guard onWatched != nil || onProbe != nil,
      event.type == .presses, let presses = event as? UIPressesEvent else { return }
    for press in presses.allPresses {
      let phase: String
      switch press.phase {
      case .began: phase = "down"
      case .ended: phase = "up"
      case .cancelled: phase = "cancelled"
      case .changed: phase = "changed"
      case .stationary: continue
      @unknown default: phase = "other"
      }
      let type = press.type.rawValue
      if press.key == nil, watchedTypes.contains(type), let onWatched = onWatched {
        onWatched(type, phase)
      }
      guard let onProbe = onProbe else { continue }
      var payload: [String: Any] = ["channel": "uikit", "phase": phase, "pressType": type]
      if let key = press.key {
        payload["hid"] = key.keyCode.rawValue
        payload["chars"] = key.charactersIgnoringModifiers
        payload["mods"] = key.modifierFlags.rawValue
      }
      payload["firstResponder"] = UIApplication.shared.connectedScenes
        .compactMap { ($0 as? UIWindowScene)?.keyWindow }
        .first?.rh_firstResponderDescription ?? "none"
      onProbe(payload)
    }
  }
}

extension UIApplication {
  @objc func rh_spySendEvent(_ event: UIEvent) {
    PressSpy.report(event)
    if PressSpy.shouldDrop(event) { return }
    // After the exchange this selector points at UIKit's original sendEvent.
    rh_spySendEvent(event)
  }
}

// App-wide key commands ("cmd+/"), hosted on the key window's root view
// controller so every responder chain reaches them: a focused text view hands an
// unhandled chord up through its screen, and a presented view controller's next
// responder is the one that presented it. Only the app's own interactive scene
// hosts them (never the external-display scene the classroom TV gets), and they
// are re-homed when another window of that scene becomes key.
enum AppKeyCommands {
  static var onCommand: ((String) -> Void)?
  private static var chords: [String] = []
  private static var installed: [(UIKeyCommand, String)] = []
  private static weak var host: UIViewController?
  private static var keyObserver: NSObjectProtocol?

  static func set(_ next: [String]) {
    chords = next
    reinstall()
    if keyObserver == nil {
      keyObserver = NotificationCenter.default.addObserver(
        forName: UIWindow.didBecomeKeyNotification, object: nil, queue: .main
      ) { note in
        guard let window = note.object as? UIWindow, isAppWindow(window) else { return }
        reinstall()
      }
    }
  }

  static func handle(_ command: UIKeyCommand) {
    guard let match = installed.first(where: { $0.0 === command }) else { return }
    emit(match.1)
  }

  // HID usages (keyboard page) for the chord inputs GameController can match.
  private static let gcUsage: [String: Int] = ["/": 0x38]
  private static let commandKeys: Set<Int> = [0xE3, 0xE7] // left, right ⌘

  // The GameController half: the input key went down while ⌘ (and no other
  // key) is held. Only "cmd+<key>" chords are matched this way.
  static func handleGCKey(_ code: Int, held: Set<Int>) {
    for chord in chords {
      var parts = chord.lowercased().split(separator: "+").map(String.init)
      guard let input = parts.popLast(), parts == ["cmd"],
        gcUsage[input] == code else { continue }
      let others = held.subtracting([code])
      guard !others.isEmpty, others.isSubset(of: commandKeys) else { continue }
      emit(chord)
    }
  }

  // Both halves see the same press while a text field is focused; report it once.
  private static var lastEmit: (chord: String, at: CFAbsoluteTime)?
  private static func emit(_ chord: String) {
    let now = CFAbsoluteTimeGetCurrent()
    if let last = lastEmit, last.chord == chord, now - last.at < 0.3 { return }
    lastEmit = (chord, now)
    onCommand?(chord)
  }

  private static func isAppWindow(_ window: UIWindow) -> Bool {
    window.windowScene?.session.role == .windowApplication
  }

  private static func rootViewController() -> UIViewController? {
    let windows = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .filter { $0.session.role == .windowApplication }
      .flatMap { $0.windows }
    return (windows.first(where: { $0.isKeyWindow }) ?? windows.first)?.rootViewController
  }

  private static func reinstall() {
    if let old = host {
      for (command, _) in installed { old.removeKeyCommand(command) }
    }
    installed = []
    host = nil
    guard !chords.isEmpty else { return }
    guard let root = rootViewController() else {
      // Called before the first window exists: try again shortly.
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { reinstall() }
      return
    }
    let selector = #selector(UIViewController.rh_handleAppKeyCommand(_:))
    for chord in chords {
      guard let command = keyCommand(for: chord, action: selector) else { continue }
      command.wantsPriorityOverSystemBehavior = true
      root.addKeyCommand(command)
      installed.append((command, chord))
    }
    host = root
  }

  // "cmd+/", "ctrl+shift+k": modifiers, then one input character.
  private static func keyCommand(for chord: String, action: Selector) -> UIKeyCommand? {
    var parts = chord.split(separator: "+").map(String.init)
    guard let input = parts.popLast(), !input.isEmpty else { return nil }
    var flags: UIKeyModifierFlags = []
    for modifier in parts {
      switch modifier.lowercased() {
      case "cmd": flags.insert(.command)
      case "ctrl": flags.insert(.control)
      case "alt", "opt": flags.insert(.alternate)
      case "shift": flags.insert(.shift)
      default: return nil
      }
    }
    return UIKeyCommand(input: input, modifierFlags: flags, action: action)
  }
}

// The current first responder: an action sent to nil goes to it.
enum FirstResponder {
  fileprivate static weak var found: UIResponder?

  static func current() -> UIResponder? {
    found = nil
    UIApplication.shared.sendAction(
      #selector(UIResponder.rh_captureFirstResponder(_:)), to: nil, from: nil, for: nil)
    return found
  }
}

extension UIResponder {
  @objc func rh_captureFirstResponder(_ sender: Any?) {
    FirstResponder.found = self
  }
}

extension UIViewController {
  @objc func rh_handleAppKeyCommand(_ command: UIKeyCommand) {
    AppKeyCommands.handle(command)
  }
}

private extension UIView {
  var rh_firstResponderDescription: String? {
    if isFirstResponder { return String(describing: type(of: self)) }
    for sub in subviews {
      if let found = sub.rh_firstResponderDescription { return found }
    }
    return nil
  }
}
