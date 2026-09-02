import ExpoModulesCore

public class CommandTextInputModule: Module {
  public func definition() -> ModuleDefinition {
    Name("CommandTextInput")

    View(CommandTextInputView.self) {
      Events(
        "onTextChange",
        "onInputFocus",
        "onInputBlur",
        "onEscape",
        "onCommandReturn"
      )

      Prop("text") { (view: CommandTextInputView, value: String) in
        view.setText(value)
      }
      Prop("editable") { (view: CommandTextInputView, value: Bool) in
        view.setEditable(value)
      }
      Prop("maxLength") { (view: CommandTextInputView, value: Int?) in
        view.setMaxLength(value)
      }
      Prop("placeholder") { (view: CommandTextInputView, value: String?) in
        view.setPlaceholder(value)
      }
      Prop("placeholderTextColor") { (view: CommandTextInputView, value: String?) in
        view.setPlaceholderTextColor(value)
      }
      Prop("textColor") { (view: CommandTextInputView, value: String?) in
        view.setTextColor(value)
      }
      Prop("fontName") { (view: CommandTextInputView, value: String?) in
        view.setFontName(value)
      }
      Prop("fontSize") { (view: CommandTextInputView, value: Double) in
        view.setFontSize(value)
      }
      Prop("contentInsetHorizontal") { (view: CommandTextInputView, value: Double) in
        view.setContentInsetHorizontal(value)
      }
      Prop("contentInsetVertical") { (view: CommandTextInputView, value: Double) in
        view.setContentInsetVertical(value)
      }
      Prop("autoFocus") { (view: CommandTextInputView, value: Bool) in
        view.setAutoFocus(value)
      }
      Prop("showSoftInputOnFocus") { (view: CommandTextInputView, value: Bool) in
        view.setShowSoftInputOnFocus(value)
      }
      Prop("captureEditorCommands") { (view: CommandTextInputView, value: Bool) in
        view.setCaptureEditorCommands(value)
      }
      Prop("inputAccessibilityLabel") { (view: CommandTextInputView, value: String?) in
        view.setInputAccessibilityLabel(value)
      }
    }
  }
}
