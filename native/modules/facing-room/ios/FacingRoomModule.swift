import AVFoundation
import ExpoModulesCore

// Hands HeadPoseReader to JS. See HeadPoseReader.swift for what it measures
// and why it stops at head direction.
public class FacingRoomModule: Module {
  public func definition() -> ModuleDefinition {
    Name("FacingRoom")

    // Copies a recorded take's sound into an .m4a beside the video and
    // resolves its file URL. The video itself is too big to transcribe
    // (Whisper takes 25 MB; a minute of video is about 19 MB), and the sound
    // alone is about a megabyte a minute.
    AsyncFunction("extractAudio") { (uri: String) async throws -> String in
      let url = uri.hasPrefix("file://") ? URL(string: uri) : URL(fileURLWithPath: uri)
      guard let url else {
        throw Exception(name: "ERR_URI", description: "That isn't a file.")
      }
      let asset = AVURLAsset(url: url)
      guard try await !asset.loadTracks(withMediaType: .audio).isEmpty else {
        throw Exception(name: "ERR_NO_AUDIO", description: "That video has no sound.")
      }
      guard let session = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetAppleM4A) else {
        throw Exception(name: "ERR_EXPORT", description: "This BunnyPad can't copy that sound.")
      }
      let out = url.deletingPathExtension().appendingPathExtension("m4a")
      try? FileManager.default.removeItem(at: out)
      if #available(iOS 18.0, *) {
        try await session.export(to: out, as: .m4a)
      } else {
        session.outputURL = out
        session.outputFileType = .m4a
        await session.export()
        if session.status != .completed {
          throw Exception(
            name: "ERR_EXPORT",
            description: session.error?.localizedDescription ?? "Copying the sound failed."
          )
        }
      }
      return out.absoluteString
    }

    // Resolves { durationMs, frameMs, frames }, where each frame is
    // [yaw, pitch, faceWidth] (degrees, degrees, pixels) or null.
    AsyncFunction("readHeadPose") { (uri: String, frameMs: Double) async throws -> [String: Any] in
      guard frameMs >= 50 else {
        throw Exception(name: "ERR_FRAME_MS", description: "Read at most 20 frames a second.")
      }
      let url = uri.hasPrefix("file://") ? URL(string: uri) : URL(fileURLWithPath: uri)
      guard let url else {
        throw Exception(name: "ERR_URI", description: "That isn't a file.")
      }
      let input = try await HeadPoseReader.load(url: url)
      let samples = try await withCheckedThrowingContinuation { continuation in
        DispatchQueue.global(qos: .utility).async {
          continuation.resume(with: Result { try HeadPoseReader.read(input, frameMs: frameMs) })
        }
      }
      let frames: [Any] = samples.map { sample -> Any in
        guard let sample else { return NSNull() }
        return [round1(sample.yaw), round1(sample.pitch), sample.faceWidth.rounded()]
      }
      return ["durationMs": input.durationMs, "frameMs": frameMs, "frames": frames]
    }

    // The meter's camera: records takes and reads head direction live.
    View(FacingRoomCameraView.self) {
      Events("onReady", "onMountError", "onHeadPose")

      Prop("poseFrameMs") { (view: FacingRoomCameraView, ms: Double) in
        view.poseFrameMs = max(50, ms)
      }
      Prop("videoBitrate") { (view: FacingRoomCameraView, bitrate: Int) in
        view.videoBitrate = bitrate
      }

      AsyncFunction("record") { (view: FacingRoomCameraView, promise: Promise) in
        view.record(promise: promise)
      }
      AsyncFunction("stopRecording") { (view: FacingRoomCameraView) in
        view.stopRecording()
      }
    }
  }
}

func round1(_ value: Double) -> Double {
  (value * 10).rounded() / 10
}
