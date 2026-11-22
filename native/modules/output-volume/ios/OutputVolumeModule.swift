import AVFoundation
import ExpoModulesCore

// Reports the iPad's system OUTPUT volume (0…1, the hardware volume buttons /
// Control Center slider) and emits `onChange` when it moves. Pre-reader voice
// mode uses it to show "turn up this iPad's volume" when the volume is down
// (TRA-492) — nothing else installed can read it (expo-audio has no getter).
//
// AVAudioSession.outputVolume is the same value whatever the route (speaker,
// wired or Bluetooth headphones). iOS only refreshes it — and only fires KVO —
// while the app's audio session is active, so reading or observing activates
// the shared session. That changes no category or options: voice mode is about
// to play speech through this same session anyway (expo-audio / WebRTC
// configure it).
//
// Known gap (TRA-642): expo-audio deactivates the shared session ~100 ms after
// any of its players pauses or finishes, which stops the KVO until something
// re-activates audio.
public class OutputVolumeModule: Module {
  private var observation: NSKeyValueObservation?

  public func definition() -> ModuleDefinition {
    Name("OutputVolume")

    Events("onChange")

    // Synchronous point-in-time read so JS can seed its state. Activates first:
    // an inactive session's value is stale.
    Function("getVolume") { () -> Double in
      let session = AVAudioSession.sharedInstance()
      Self.activate(session)
      return Double(session.outputVolume)
    }

    OnStartObserving {
      let session = AVAudioSession.sharedInstance()
      Self.activate(session)
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

  private static func activate(_ session: AVAudioSession) {
    do {
      try session.setActive(true)
    } catch {
      // Not fatal, but say so: a swallowed failure here leaves a stale reading
      // with nothing in the log to explain it.
      NSLog("[OutputVolume] setActive(true) failed: %@", error.localizedDescription)
    }
  }
}
