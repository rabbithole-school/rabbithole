import AVFoundation
import CoreMedia
import ImageIO
import Vision

// Reads a presenter's head direction out of a recorded video, a few frames a
// second, with Apple Vision's face detector. Audience mode runs it on the back
// BunnyPad's video of a take, so the review can mark when the presenter turned
// away from the room or looked down.
//
// Head direction only. From the back of a room the presenter's eyes are a few
// pixels across (an 8 × 2 px eye at 720p in the first real take), far too small
// to say where they point.
//
// Kept free of ExpoModulesCore so the same file compiles into a command-line
// check on a Mac.
enum HeadPoseReader {
  struct Sample {
    /// Degrees; + is toward the presenter's left (the right of the picture).
    let yaw: Double
    /// Degrees; + is chin down.
    let pitch: Double
    /// The face box's width in the upright picture, in pixels.
    let faceWidth: Double
  }

  struct Input {
    let asset: AVURLAsset
    let track: AVAssetTrack
    let orientation: CGImagePropertyOrientation
    let start: CMTime
    let durationMs: Double
    let uprightWidth: Double
  }

  enum ReadError: Error, LocalizedError {
    case noVideoTrack
    case unreadable(String)

    var errorDescription: String? {
      switch self {
      case .noVideoTrack: return "The file has no video."
      case .unreadable(let why): return "The video couldn't be read: \(why)"
      }
    }
  }

  static func load(url: URL) async throws -> Input {
    let asset = AVURLAsset(url: url)
    guard let track = try await asset.loadTracks(withMediaType: .video).first else {
      throw ReadError.noVideoTrack
    }
    let (transform, size, range) = try await track.load(.preferredTransform, .naturalSize, .timeRange)
    let orientation = orientation(of: transform)
    let quarterTurn = orientation == .left || orientation == .right
    return Input(
      asset: asset,
      track: track,
      orientation: orientation,
      start: range.start,
      durationMs: range.duration.seconds * 1000,
      uprightWidth: Double(quarterTurn ? size.height : size.width)
    )
  }

  /// One sample every `frameMs` from the video's start: the largest face's
  /// pose, or nil where no face was found (turned away from the camera, or
  /// out of the picture). Runs synchronously; call it off the main thread.
  static func read(_ input: Input, frameMs: Double) throws -> [Sample?] {
    let reader: AVAssetReader
    do {
      reader = try AVAssetReader(asset: input.asset)
    } catch {
      throw ReadError.unreadable(error.localizedDescription)
    }
    let output = AVAssetReaderTrackOutput(
      track: input.track,
      outputSettings: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
      ]
    )
    output.alwaysCopiesSampleData = false
    reader.add(output)
    guard reader.startReading() else {
      throw ReadError.unreadable(reader.error?.localizedDescription ?? "unknown")
    }

    let request = faceRequest()

    var samples: [Sample?] = []
    // One sample per frameMs of the video, however its timestamps run.
    let most = Int((input.durationMs / frameMs).rounded(.up)) + 1
    var failure: Error?
    // Every frame has to be decoded to reach the next one, so the reader runs
    // through all of them and Vision only looks at one per `frameMs`.
    while failure == nil, samples.count < most, let buffer = output.copyNextSampleBuffer() {
      autoreleasepool {
        guard let pixels = CMSampleBufferGetImageBuffer(buffer) else { return }
        let atMs = (CMSampleBufferGetPresentationTimeStamp(buffer) - input.start).seconds * 1000
        guard atMs + 1 >= Double(samples.count) * frameMs else { return }
        do {
          let sample = try largestFace(
            in: pixels,
            orientation: input.orientation,
            uprightWidth: input.uprightWidth,
            request: request
          )
          // A dropped frame can skip a sample time: repeat this one for it.
          while samples.count < most, Double(samples.count) * frameMs <= atMs + 1 { samples.append(sample) }
        } catch {
          failure = error
        }
      }
    }
    reader.cancelReading()
    if let failure { throw failure }
    if reader.status == .failed {
      throw ReadError.unreadable(reader.error?.localizedDescription ?? "unknown")
    }
    return samples
  }

  /// A face request that reports a continuous yaw, pitch and roll. Revision 3
  /// does; the landmarks request alone only gives coarse bins (a 0° or 45°
  /// turn, no tilt). One request per thread.
  static func faceRequest() -> VNDetectFaceRectanglesRequest {
    let request = VNDetectFaceRectanglesRequest()
    request.revision = VNDetectFaceRectanglesRequestRevision3
    return request
  }

  /// The largest face's pose in one frame, or nil where there's none. Shared
  /// by the reader above and the live camera (FacingRoomCameraView).
  static func largestFace(
    in pixels: CVPixelBuffer,
    orientation: CGImagePropertyOrientation,
    uprightWidth: Double,
    request: VNDetectFaceRectanglesRequest
  ) throws -> Sample? {
    let handler = VNImageRequestHandler(cvPixelBuffer: pixels, orientation: orientation, options: [:])
    try handler.perform([request])
    let face = (request.results ?? []).max { $0.boundingBox.width < $1.boundingBox.width }
    guard let face, let yaw = face.yaw?.doubleValue, let pitch = face.pitch?.doubleValue else {
      return nil
    }
    return Sample(
      yaw: yaw * 180 / .pi,
      pitch: pitch * 180 / .pi,
      faceWidth: Double(face.boundingBox.width) * uprightWidth
    )
  }

  /// How Vision should turn the decoded frames to see them upright. The
  /// front camera records landscape frames and stores the turn in the
  /// track's transform (180° on the first real take).
  static func orientation(of transform: CGAffineTransform) -> CGImagePropertyOrientation {
    let degrees = Int((atan2(transform.b, transform.a) * 180 / .pi).rounded())
    switch degrees {
    case 90: return .right
    case -90: return .left
    case 180, -180: return .down
    default: return .up
    }
  }
}
