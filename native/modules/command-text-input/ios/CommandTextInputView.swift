import ExpoModulesCore
import UIKit

private enum EditorCommand {
  case escape
  case commandReturn
}

private final class EditorTextView: UITextView {
  var capturesEditorCommands = false
  var onEditorCommand: ((EditorCommand) -> Void)?

  override var keyCommands: [UIKeyCommand]? {
    let inherited = super.keyCommands ?? []
    guard capturesEditorCommands else { return inherited }

    let escape = UIKeyCommand(
      input: UIKeyCommand.inputEscape,
      modifierFlags: [],
      action: #selector(handleEscape(_:))
    )
    let commandReturn = UIKeyCommand(
      input: "\r",
      modifierFlags: .command,
      action: #selector(handleCommandReturn(_:))
    )
    commandReturn.discoverabilityTitle = "Commit edit"
    let controlReturn = UIKeyCommand(
      input: "\r",
      modifierFlags: .control,
      action: #selector(handleCommandReturn(_:))
    )
    for command in [escape, commandReturn, controlReturn] {
      command.wantsPriorityOverSystemBehavior = true
    }
    // UITextView already advertises Return commands. Put editor-owned commands
    // first so UIKit invokes these selectors instead of an inherited command
    // that suppresses Return without committing the edit.
    return [escape, commandReturn, controlReturn] + inherited
  }

  @objc private func handleEscape(_ command: UIKeyCommand) {
    onEditorCommand?(.escape)
  }

  @objc private func handleCommandReturn(_ command: UIKeyCommand) {
    onEditorCommand?(.commandReturn)
  }
}

final class CommandTextInputView: ExpoView, UITextViewDelegate {
  let onTextChange = EventDispatcher()
  let onInputFocus = EventDispatcher()
  let onInputBlur = EventDispatcher()
  let onEscape = EventDispatcher()
  let onCommandReturn = EventDispatcher()

  private let textView = EditorTextView()
  private let placeholderLabel = UILabel()
  private var applyingText = false
  private var shouldAutoFocus = false
  private var maximumLength: Int?
  private var fontName: String?
  private var fontSize: CGFloat = 16
  private var insetHorizontal: CGFloat = 0
  private var insetVertical: CGFloat = 0

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)

    textView.backgroundColor = .clear
    textView.delegate = self
    textView.isScrollEnabled = true
    textView.textContainer.lineFragmentPadding = 0
    textView.onEditorCommand = { [weak self] command in
      switch command {
      case .escape:
        self?.onEscape([:])
      case .commandReturn:
        self?.onCommandReturn([:])
      }
    }

    placeholderLabel.backgroundColor = .clear
    placeholderLabel.isAccessibilityElement = false
    placeholderLabel.isUserInteractionEnabled = false
    placeholderLabel.numberOfLines = 0

    addSubview(textView)
    addSubview(placeholderLabel)
    applyFont()
    applyInsets()
    updatePlaceholder()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    textView.frame = bounds
    placeholderLabel.frame = bounds.inset(by: UIEdgeInsets(
      top: insetVertical,
      left: insetHorizontal,
      bottom: insetVertical,
      right: insetHorizontal
    ))
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    focusIfNeeded()
  }

  func setText(_ value: String) {
    guard textView.text != value else { return }
    applyingText = true
    let previousText = textView.text ?? ""
    let selection = textView.selectedRange
    textView.text = value
    let textLength = (value as NSString).length
    let isInitialValue = previousText.isEmpty
      && selection.location == 0
      && selection.length == 0
      && !textView.isFirstResponder
    let location = isInitialValue ? textLength : min(selection.location, textLength)
    textView.selectedRange = NSRange(
      location: location,
      length: min(selection.length, max(0, textLength - location))
    )
    applyingText = false
    updatePlaceholder()
  }

  func setEditable(_ value: Bool) {
    textView.isEditable = value
    textView.isSelectable = value
  }

  func setMaxLength(_ value: Int?) {
    maximumLength = value.flatMap { $0 > 0 ? $0 : nil }
  }

  func setPlaceholder(_ value: String?) {
    placeholderLabel.text = value
    updatePlaceholder()
  }

  func setPlaceholderTextColor(_ value: String?) {
    placeholderLabel.textColor = value.flatMap(UIColor.fromHex) ?? .placeholderText
  }

  func setTextColor(_ value: String?) {
    textView.textColor = value.flatMap(UIColor.fromHex) ?? .label
  }

  func setFontName(_ value: String?) {
    fontName = value
    applyFont()
  }

  func setFontSize(_ value: Double) {
    fontSize = max(1, CGFloat(value))
    applyFont()
  }

  func setContentInsetHorizontal(_ value: Double) {
    insetHorizontal = max(0, CGFloat(value))
    applyInsets()
  }

  func setContentInsetVertical(_ value: Double) {
    insetVertical = max(0, CGFloat(value))
    applyInsets()
  }

  func setAutoFocus(_ value: Bool) {
    shouldAutoFocus = value
    focusIfNeeded()
  }

  func setShowSoftInputOnFocus(_ value: Bool) {
    textView.inputView = value ? nil : UIView()
    if textView.isFirstResponder {
      textView.reloadInputViews()
    }
  }

  func setCaptureEditorCommands(_ value: Bool) {
    textView.capturesEditorCommands = value
  }

  func setInputAccessibilityLabel(_ value: String?) {
    textView.accessibilityLabel = value
  }

  func textViewDidBeginEditing(_ textView: UITextView) {
    onInputFocus([:])
  }

  func textViewDidEndEditing(_ textView: UITextView) {
    onInputBlur([:])
  }

  func textViewDidChange(_ textView: UITextView) {
    updatePlaceholder()
    guard !applyingText else { return }
    onTextChange(["text": textView.text ?? ""])
  }

  func textView(
    _ textView: UITextView,
    shouldChangeTextIn range: NSRange,
    replacementText replacement: String
  ) -> Bool {
    guard let maximumLength, textView.markedTextRange == nil,
      let current = textView.text as NSString? else {
      return true
    }
    return current.replacingCharacters(in: range, with: replacement).utf16.count
      <= maximumLength
  }

  private func applyFont() {
    let font = fontName.flatMap { UIFont(name: $0, size: fontSize) }
      ?? UIFont.systemFont(ofSize: fontSize)
    textView.font = font
    placeholderLabel.font = font
  }

  private func applyInsets() {
    textView.textContainerInset = UIEdgeInsets(
      top: insetVertical,
      left: insetHorizontal,
      bottom: insetVertical,
      right: insetHorizontal
    )
    setNeedsLayout()
  }

  private func updatePlaceholder() {
    placeholderLabel.isHidden = !(textView.text?.isEmpty ?? true)
  }

  private func focusIfNeeded() {
    guard shouldAutoFocus, window != nil, !textView.isFirstResponder else { return }
    DispatchQueue.main.async { [weak self] in
      guard let self, self.shouldAutoFocus, self.window != nil,
        !self.textView.isFirstResponder else {
        return
      }
      self.textView.becomeFirstResponder()
    }
  }
}

private extension UIColor {
  static func fromHex(_ raw: String) -> UIColor? {
    var hex = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if hex.hasPrefix("#") { hex.removeFirst() }
    guard hex.count == 6, let value = UInt32(hex, radix: 16) else { return nil }
    return UIColor(
      red: CGFloat((value & 0xFF0000) >> 16) / 255,
      green: CGFloat((value & 0x00FF00) >> 8) / 255,
      blue: CGFloat(value & 0x0000FF) / 255,
      alpha: 1
    )
  }
}
