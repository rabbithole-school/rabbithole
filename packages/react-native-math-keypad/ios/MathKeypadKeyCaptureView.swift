import ExpoModulesCore
import UIKit

// An off-screen first responder that forwards hardware-keyboard keys to JS.
//
// WHY a native view is needed at all: React Native's iOS `onKeyPress` is driven
// by `textField(_:shouldChangeCharactersIn:replacementString:)`, which only
// fires for TEXT-producing keystrokes (plus a special-cased Backspace). Tab and
// the arrows are handled by UIKit as focus / cursor movement and never produce
// a text-replacement callback, so RN surfaces no JS event for them — there is
// no JS-only fix at the TextInput layer. A `UIResponder` that overrides
// `pressesBegan(_:with:)` DOES receive every physical key (iOS 13.4+ `UIKey`).
//
// Scoped by construction: capture is installed ONLY while `active` is true, and
// keys the editor doesn't own are forwarded to `super`, so system handling is
// intact. Emitted keys match the editor vocabulary exactly: digits, "x", "/",
// "^", the ⌫ glyph, "Tab"/"ShiftTab", "Arrow*".
//
// Extracted from Rabbithole's native/modules/key-capture, without its second
// "chord" mode (UIKeyCommands for Escape and Cmd/Ctrl+Enter, used by a slides
// editor so a TextInput could keep focus).
//
// Any change here takes effect only after rebuilding the app binary.
class MathKeypadKeyCaptureView: ExpoView {
  // `onKey` carries a normalized editor key; `onSubmit` fires on Return/Enter.
  let onKey = EventDispatcher()
  let onSubmit = EventDispatcher()

  private var active = false

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    isUserInteractionEnabled = true
  }

  // Only a legitimate focus target while the editor wants the keys, so the
  // view yields first responder cleanly when capture ends.
  override var canBecomeFirstResponder: Bool { active }

  func setActive(_ value: Bool) {
    guard value != active else { return }
    active = value
    if value {
      focusSoon()
    } else if isFirstResponder {
      resignFirstResponder()
    }
  }

  // A view can only become first responder once it is in the window hierarchy;
  // on the initial mount `active` is set before that happens, so re-try here.
  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window != nil && active && !isFirstResponder {
      focusSoon()
    }
  }

  private func focusSoon() {
    DispatchQueue.main.async { [weak self] in
      guard let self = self, self.active, self.window != nil, !self.isFirstResponder else {
        return
      }
      self.becomeFirstResponder()
    }
  }

  private enum Mapped {
    case key(String)
    case submit
  }

  /// Normalize a physical key to the editor vocabulary, or nil to let UIKit
  /// handle it (so we never swallow keys the editor doesn't own).
  private func mapped(for key: UIKey) -> Mapped? {
    switch key.keyCode {
    case .keyboardTab:
      // Shift-Tab is indistinguishable in RN's onKeyPress (no modifier state);
      // here the modifier flags make previous-box navigation possible.
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
      return .key("\u{232B}") // ⌫ — the glyph the editor's key map accepts
    case .keyboardReturnOrEnter, .keypadEnter:
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
      }
    }
    // Forward anything we didn't consume so system key handling is intact.
    if !unhandled.isEmpty {
      super.pressesBegan(unhandled, with: event)
    }
  }
}
