import ExpoModulesCore
import UIKit

private let keyCaptureCommandNotification =
  Notification.Name("org.rabbithole.app.keyCaptureCommand")

private extension UIViewController {
  @objc func rabbitholeHandleKeyCaptureCommand(_ command: UIKeyCommand) {
    NotificationCenter.default.post(
      name: keyCaptureCommandNotification,
      object: self,
      userInfo: ["command": command]
    )
  }
}

// A hardware-keyboard capture view with two deliberately separate modes:
//
// 1. The legacy 2-D expression-editor mode makes this off-screen view first
//    responder and forwards every normalized editor key through `pressesBegan`.
// 2. Supplying `onChord` selects controller-level `UIKeyCommand`s for Escape
//    and Command/Control+Enter. That leaves a text editor's TextInput first
//    responder, so ordinary text input keeps working while UIKit routes the
//    command chords up to the owning view controller.
//
// WHY a native module is needed at all: RN's iOS `onKeyPress` is driven by
// `textField(_:shouldChangeCharactersIn:replacementString:)`, which only fires
// for TEXT-producing keystrokes (plus a special-cased Backspace). Tab and the
// arrows are handled by UIKit as focus / cursor movement and never produce a
// text-replacement callback, so RN surfaces no JS event for them — there is no
// JS-only fix at the TextInput layer. A `UIResponder` that overrides
// `pressesBegan(_:with:)` DOES receive every physical key (iOS 13.4+ `UIKey`),
// while `UIKeyCommand` is the native route for command chords when a TextInput
// must retain focus.
//
// Scoped by construction: both modes install capture ONLY while `active` is
// true. The legacy mode emits keys matching the web keyboard hook's vocabulary
// exactly (digits, "x", "/", "^", the ⌫ glyph, "Tab"/"ShiftTab", "Arrow*").
//
// IMPORTANT: Any change to this Swift module takes effect only after rebuilding
// the dev client. The native-dependency fingerprint does NOT detect these edits
// because native/package.json dependencies are unchanged, so another worktree
// can silently reuse a cached app that predates the change.
class KeyCaptureView: ExpoView {
  // JS-facing events. `onKey` carries a normalized editor key; `onSubmit` fires
  // on bare Return/Enter; `onChord` carries Escape or modified Enter.
  let onKey = EventDispatcher()
  let onSubmit = EventDispatcher()
  let onChord = EventDispatcher()

  private var active = false
  private var captureChords = false
  private weak var chordHost: UIViewController?
  private var chordCommands: [UIKeyCommand] = []
  private var chordObserver: NSObjectProtocol?

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    isUserInteractionEnabled = true
  }

  // Only a legitimate focus target while the editor wants the keys. Off the
  // answering phase this is false, so the view yields first responder cleanly.
  override var canBecomeFirstResponder: Bool { active && !captureChords }

  func setActive(_ value: Bool) {
    guard value != active else { return }
    active = value
    if value {
      if captureChords {
        installChordCommands()
      } else {
        focusSoon()
      }
    } else if isFirstResponder {
      resignFirstResponder()
    }
    if !value {
      removeChordCommands()
    }
  }

  func setCaptureChords(_ value: Bool) {
    guard value != captureChords else { return }
    captureChords = value
    if value {
      if isFirstResponder {
        resignFirstResponder()
      }
      if active {
        installChordCommands()
      }
    } else {
      removeChordCommands()
      if active {
        focusSoon()
      }
    }
  }

  // A view can only become first responder once it is in the window hierarchy;
  // on the initial mount `active` is set before that happens, so re-try here.
  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil {
      removeChordCommands()
    } else if active && captureChords {
      installChordCommands()
    } else if active && !isFirstResponder {
      focusSoon()
    }
  }

  private func focusSoon() {
    DispatchQueue.main.async { [weak self] in
      guard let self = self, self.active, !self.captureChords,
        self.window != nil, !self.isFirstResponder else {
        return
      }
      self.becomeFirstResponder()
    }
  }

  private var nearestViewController: UIViewController? {
    var responder: UIResponder? = self
    while let current = responder {
      if let viewController = current as? UIViewController {
        return viewController
      }
      responder = current.next
    }
    return nil
  }

  private func installChordCommands() {
    guard active, captureChords, window != nil,
      let host = nearestViewController else {
      return
    }
    if chordHost === host, !chordCommands.isEmpty {
      return
    }
    removeChordCommands()

    let selector = #selector(UIViewController.rabbitholeHandleKeyCaptureCommand(_:))
    let commands = [
      UIKeyCommand(input: UIKeyCommand.inputEscape, modifierFlags: [], action: selector),
      UIKeyCommand(input: "\r", modifierFlags: .command, action: selector),
      UIKeyCommand(input: "\r", modifierFlags: .control, action: selector),
    ]
    for command in commands {
      command.wantsPriorityOverSystemBehavior = true
      host.addKeyCommand(command)
    }

    chordHost = host
    chordCommands = commands
    chordObserver = NotificationCenter.default.addObserver(
      forName: keyCaptureCommandNotification,
      object: host,
      queue: .main
    ) { [weak self] notification in
      guard let self = self, self.active, self.captureChords,
        let command = notification.userInfo?["command"] as? UIKeyCommand,
        self.chordCommands.contains(where: { $0 === command }) else {
        return
      }
      let modifiedEnter =
        command.modifierFlags.contains(.command) || command.modifierFlags.contains(.control)
      self.onChord(["chord": modifiedEnter ? "Cmd+Enter" : "Escape"])
    }
  }

  private func removeChordCommands() {
    if let host = chordHost {
      for command in chordCommands {
        host.removeKeyCommand(command)
      }
    }
    if let observer = chordObserver {
      NotificationCenter.default.removeObserver(observer)
    }
    chordHost = nil
    chordCommands = []
    chordObserver = nil
  }

  deinit {
    removeChordCommands()
  }

  private enum Mapped {
    case key(String)
    case submit
    case chord(String)
  }

  /// Normalize a physical key to the shared editor vocabulary, or nil to let
  /// UIKit handle it (so we never swallow keys the editor doesn't own).
  private func mapped(for key: UIKey) -> Mapped? {
    switch key.keyCode {
    case .keyboardTab:
      // Shift-Tab is indistinguishable in RN's onKeyPress (no modifier state);
      // here the modifier flags make prev-box navigation possible.
      return .key(key.modifierFlags.contains(.shift) ? "ShiftTab" : "Tab")
    case .keyboardLeftArrow:
      return .key("ArrowLeft")
    case .keyboardRightArrow:
      return .key("ArrowRight")
    case .keyboardUpArrow:
      return .key("ArrowUp")
    case .keyboardDownArrow:
      return .key("ArrowDown")
    case .keyboardDeleteOrBackspace:
      return .key("\u{232B}") // ⌫ — the glyph the shared key map also accepts
    case .keyboardEscape:
      return captureChords ? .chord("Escape") : nil
    case .keyboardReturnOrEnter, .keypadEnter:
      if captureChords
        && (key.modifierFlags.contains(.command) || key.modifierFlags.contains(.control)) {
        // Normalize both Magic Keyboard modifier variants to one public chord.
        return .chord("Cmd+Enter")
      }
      return .submit
    default:
      break
    }
    // Text-producing keys the editor accepts: digits, the variable `x`, and the
    // structural `/` and `^`. Match from the MODIFIED characters so Shift+6 → ^.
    guard key.characters.count == 1, let ch = key.characters.first else { return nil }
    if ch >= "0" && ch <= "9" { return .key(String(ch)) }
    switch ch {
    case "/": return .key("/")
    case "^": return .key("^")
    case "x", "X": return .key("x")
    default: return nil
    }
  }

  override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
    var unhandled = Set<UIPress>()
    for press in presses {
      guard let key = press.key, let mapped = mapped(for: key) else {
        unhandled.insert(press)
        continue
      }
      switch mapped {
      case .key(let k):
        onKey(["key": k])
      case .submit:
        onSubmit([:])
      case .chord(let chord):
        onChord(["chord": chord])
      }
    }
    // Forward anything we didn't consume so system key handling is intact.
    if !unhandled.isEmpty {
      super.pressesBegan(unhandled, with: event)
    }
  }
}
