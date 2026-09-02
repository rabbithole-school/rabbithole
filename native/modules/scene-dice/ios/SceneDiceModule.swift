import ExpoModulesCore

public class SceneDiceModule: Module {
  public func definition() -> ModuleDefinition {
    Name("SceneDice")

    View(SceneDiceView.self) {
      Events("onSettled")

      Prop("diceType") { (view: SceneDiceView, type: String) in
        view.setDiceType(type)
      }
      Prop("diceCount") { (view: SceneDiceView, count: Int) in
        view.setDiceCount(count)
      }
      Prop("themeColor") { (view: SceneDiceView, hex: String) in
        view.setThemeColor(hex)
      }
      Prop("throwX") { (view: SceneDiceView, value: Double) in
        view.throwX = value
      }
      Prop("throwY") { (view: SceneDiceView, value: Double) in
        view.throwY = value
      }
      Prop("throwPower") { (view: SceneDiceView, value: Double) in
        view.throwPower = value
      }
      Prop("rollToken") { (view: SceneDiceView, token: Int) in
        view.setRollToken(token)
      }
      Prop("dragActive") { (view: SceneDiceView, active: Bool) in
        view.setDragActive(active)
      }
      Prop("dragX") { (view: SceneDiceView, value: Double) in
        view.setDragX(value)
      }
      Prop("dragY") { (view: SceneDiceView, value: Double) in
        view.setDragY(value)
      }
    }
  }
}
