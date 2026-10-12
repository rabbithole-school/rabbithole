import AVFoundation
import ExpoModulesCore

// Reports the iPad's system OUTPUT volume (0…1, the hardware volume buttons /
// Control Center slider) and emits `onChange` when it moves. Pre-reader voice
// mode uses it to show "turn up this iPad's volume" when the volume is down
// (TRA-492) — nothing else installed can read it (expo-audio has no getter).
//
// AVAudioSession.outputVolume is the same value whatever the route (speaker,
// wired or Bluetooth headphones). iOS only refreshes it — and only fires KVO —
// while the app's audio session is active, so observing activates the shared
// session. That changes no category or options: voice mode is about to play
// speech through this same session anyway (expo-audio / WebRTC configure it).
public class OutputVolumeModule: Module {
  private var observation: NSKeyValueObservation?

  public func definition() -> ModuleDefinition {
    Name("OutputVolume")

    Events("onChange")

    // Synchronous point-in-time read so JS can seed its state.
    Function("getVolume") { () -> Double in
      return Double(AVAudioSession.sharedInstance().outputVolume)
    }

    OnStartObserving {
      let session = AVAudioSession.sharedInstance()
      try? session.setActive(true)
      self.observation = session.observe(\.outputVolume, options: [.new]) { [weak self] observed, _ in
        self?.sendEvent("onChange", ["volume": Double(observed.outputVolume)])
      }
      // Re-emit once after activating: the value may have been stale before.
      self.sendEvent("onChange", ["volume": Double(session.outputVolume)])
    }

    OnStopObserving {
      self.observation?.invalidate()
      self.observation = nil
    }
  }
}
