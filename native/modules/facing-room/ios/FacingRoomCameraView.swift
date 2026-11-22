import AVFoundation
import ExpoModulesCore
import UIKit
import Vision

// The back BunnyPad's camera in audience mode (the decibel meter). It shows
// what the front camera sees, records a take with its sound when asked, and
// reads the presenter's head direction from the same frames as they arrive,
// a few times a second, so the meter can show it live.
//
// expo-camera's CameraView records straight to a movie file and hands its
// frames to nothing else, which is why this view exists. A take is written
// here frame by frame (AVAssetWriter), in HEVC at the bitrate the screen asks
// for, as CameraView recorded it.
final class FacingRoomCameraView: ExpoView {
  let onReady = EventDispatcher()
  let onMountError = EventDispatcher()
  let onHeadPose = EventDispatcher()

  /// How often to read head direction from the live frames.
  var poseFrameMs: Double = 250
  /// A take's average video bitrate, in bits a second.
  var videoBitrate: Int = 2_500_000

  private let session = AVCaptureSession()
  private let previewLayer = AVCaptureVideoPreviewLayer()
  private let videoOutput = AVCaptureVideoDataOutput()
  private let audioOutput = AVCaptureAudioDataOutput()
  /// Configuring, starting and stopping the session.
  private let sessionQueue = DispatchQueue(label: "school.rabbithole.facing-room.session")
  /// Every frame and sound buffer, and the take that writes them. `take`,
  /// `readingPose` and `lastPoseAt` belong to this queue.
  private let captureQueue = DispatchQueue(label: "school.rabbithole.facing-room.capture")
  /// Reading head direction, one frame at a time.
  private let visionQueue = DispatchQueue(label: "school.rabbithole.facing-room.vision", qos: .userInitiated)
  private let poseRequest = HeadPoseReader.faceRequest()

  private var configured = false
  private var hasMicrophone = false
  /// The picture should be showing (on main), so a session iOS reset is restarted.
  private var wantsRunning = false
  private var runtimeErrorObserver: NSObjectProtocol?
  /// The frames' rotation to apply once a take ends, if the BunnyPad turned
  /// during it (captureQueue).
  private var pendingRotation: ((AVCaptureConnection) -> Void)?
  private var take: Take?
  private var readingPose = false
  private var lastPoseAt = CMTime.invalid
  /// An AVCaptureDevice.RotationCoordinator (iOS 17) and what watches it.
  private var rotationCoordinator: AnyObject?
  private var rotationObservations: [NSKeyValueObservation] = []

  private final class Take {
    let url: URL
    let promise: Promise
    var writer: AVAssetWriter?
    var video: AVAssetWriterInput?
    var audio: AVAssetWriterInput?
    var startTime = CMTime.invalid

    init(url: URL, promise: Promise) {
      self.url = url
      self.promise = promise
    }
  }

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    backgroundColor = .black
    previewLayer.videoGravity = .resizeAspectFill
    layer.addSublayer(previewLayer)
  }

  deinit {
    if let runtimeErrorObserver { NotificationCenter.default.removeObserver(runtimeErrorObserver) }
    let session = self.session
    sessionQueue.async { session.stopRunning() }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    previewLayer.frame = bounds
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    wantsRunning = window != nil
    if window != nil {
      start()
    } else {
      stopRecording()
      let session = self.session
      sessionQueue.async { session.stopRunning() }
    }
  }

  // MARK: - Session

  private func start() {
    guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized else {
      onMountError(["message": "The camera isn't allowed."])
      return
    }
    sessionQueue.async { [weak self] in
      guard let self else { return }
      if !self.configured {
        let device: AVCaptureDevice
        do {
          device = try self.configure()
        } catch {
          let message = error.localizedDescription
          DispatchQueue.main.async { self.onMountError(["message": message]) }
          return
        }
        self.configured = true
        DispatchQueue.main.async {
          self.attachPreview(to: device)
          self.restartAfterReset()
        }
      }
      if !self.session.isRunning { self.session.startRunning() }
      let running = self.session.isRunning
      DispatchQueue.main.async {
        if running {
          self.onReady()
        } else {
          self.onMountError(["message": "The camera wouldn't start."])
        }
      }
    }
  }

  private enum SetupError: Error, LocalizedError {
    case noCamera
    case unusable(String)

    var errorDescription: String? {
      switch self {
      case .noCamera: return "This BunnyPad has no front camera."
      case .unusable(let what): return "The camera couldn't use \(what)."
      }
    }
  }

  /// Front camera at 720p, the microphone when it's allowed (a take without
  /// sound is still a take), and outputs that hand every frame and sound
  /// buffer to `captureQueue`.
  private func configure() throws -> AVCaptureDevice {
    session.beginConfiguration()
    defer { session.commitConfiguration() }
    // Start clean: a setup that failed halfway left inputs a retry can't add again.
    session.inputs.forEach { session.removeInput($0) }
    session.outputs.forEach { session.removeOutput($0) }
    hasMicrophone = false
    if session.canSetSessionPreset(.hd1280x720) {
      session.sessionPreset = .hd1280x720
    }
    guard let camera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front) else {
      throw SetupError.noCamera
    }
    let cameraInput = try AVCaptureDeviceInput(device: camera)
    guard session.canAddInput(cameraInput) else { throw SetupError.unusable("the front camera") }
    session.addInput(cameraInput)

    if AVCaptureDevice.authorizationStatus(for: .audio) == .authorized,
       let mic = AVCaptureDevice.default(for: .audio),
       let micInput = try? AVCaptureDeviceInput(device: mic),
       session.canAddInput(micInput) {
      session.addInput(micInput)
      hasMicrophone = true
    }

    videoOutput.videoSettings = [
      kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
    ]
    videoOutput.alwaysDiscardsLateVideoFrames = true
    videoOutput.setSampleBufferDelegate(self, queue: captureQueue)
    guard session.canAddOutput(videoOutput) else { throw SetupError.unusable("its frames") }
    session.addOutput(videoOutput)
    if hasMicrophone {
      audioOutput.setSampleBufferDelegate(self, queue: captureQueue)
      if session.canAddOutput(audioOutput) { session.addOutput(audioOutput) }
    }

    // The picture as the camera sees the room, unmirrored, as CameraView
    // recorded it: a turn reads the same live and in the take.
    if let connection = videoOutput.connection(with: .video), connection.isVideoMirroringSupported {
      connection.automaticallyAdjustsVideoMirroring = false
      connection.isVideoMirrored = false
    }
    return camera
  }

  /// Shows the session, and keeps the preview and the frames upright as the
  /// BunnyPad turns. Frames are turned upright before they arrive, so Vision
  /// reads them as they are and a take needs no turn of its own.
  private func attachPreview(to device: AVCaptureDevice) {
    previewLayer.session = session
    // The picture shows as in a mirror, like the head the meter draws beside
    // it. The frames Vision reads and the take stay unmirrored.
    if let connection = previewLayer.connection, connection.isVideoMirroringSupported {
      connection.automaticallyAdjustsVideoMirroring = false
      connection.isVideoMirrored = true
    }
    if #available(iOS 17.0, *) {
      let coordinator = AVCaptureDevice.RotationCoordinator(device: device, previewLayer: previewLayer)
      rotationCoordinator = coordinator
      applyRotation(coordinator)
      rotationObservations = [
        coordinator.observe(\.videoRotationAngleForHorizonLevelPreview) { [weak self] coordinator, _ in
          DispatchQueue.main.async { self?.applyRotation(coordinator) }
        },
        coordinator.observe(\.videoRotationAngleForHorizonLevelCapture) { [weak self] coordinator, _ in
          DispatchQueue.main.async { self?.applyRotation(coordinator) }
        },
      ]
    } else {
      applyInterfaceOrientation()
    }
  }

  @available(iOS 17.0, *)
  private func applyRotation(_ coordinator: AVCaptureDevice.RotationCoordinator) {
    let previewAngle = coordinator.videoRotationAngleForHorizonLevelPreview
    if let connection = previewLayer.connection, connection.isVideoRotationAngleSupported(previewAngle) {
      connection.videoRotationAngle = previewAngle
    }
    let captureAngle = coordinator.videoRotationAngleForHorizonLevelCapture
    rotateFrames { connection in
      if connection.isVideoRotationAngleSupported(captureAngle) {
        connection.videoRotationAngle = captureAngle
      }
    }
  }

  /// iOS 16: upright for the way the screen faces when the camera opens.
  private func applyInterfaceOrientation() {
    let orientation: AVCaptureVideoOrientation
    switch window?.windowScene?.interfaceOrientation ?? .landscapeRight {
    case .portrait: orientation = .portrait
    case .portraitUpsideDown: orientation = .portraitUpsideDown
    case .landscapeLeft: orientation = .landscapeLeft
    default: orientation = .landscapeRight
    }
    if let connection = previewLayer.connection, connection.isVideoOrientationSupported {
      connection.videoOrientation = orientation
    }
    rotateFrames { connection in
      if connection.isVideoOrientationSupported {
        connection.videoOrientation = orientation
      }
    }
  }

  /// Turns the frames now, or once the take in progress ends: a take keeps
  /// the shape it started with.
  private func rotateFrames(_ apply: @escaping (AVCaptureConnection) -> Void) {
    captureQueue.async { [weak self] in
      guard let self else { return }
      if self.take == nil, let connection = self.videoOutput.connection(with: .video) {
        apply(connection)
        self.pendingRotation = nil
      } else {
        self.pendingRotation = apply
      }
    }
  }

  /// expo-camera did this too: when iOS resets its media services the session
  /// stops for good, so start it again while the picture should be showing.
  private func restartAfterReset() {
    guard runtimeErrorObserver == nil else { return }
    runtimeErrorObserver = NotificationCenter.default.addObserver(
      forName: AVCaptureSession.runtimeErrorNotification,
      object: session,
      queue: .main
    ) { [weak self] note in
      guard let self, self.wantsRunning,
            let error = note.userInfo?[AVCaptureSessionErrorKey] as? AVError,
            error.code == .mediaServicesWereReset else { return }
      let session = self.session
      self.sessionQueue.async {
        if !session.isRunning { session.startRunning() }
      }
    }
  }

  // MARK: - Recording

  /// Starts a take. The promise resolves with `{ uri }` once `stopRecording`
  /// has finished the file, and rejects if nothing could be recorded.
  func record(promise: Promise) {
    captureQueue.async { [weak self] in
      guard let self else { return }
      guard self.take == nil else {
        promise.reject("ERR_RECORDING", "The camera is already recording.")
        return
      }
      // Under Caches, where expo-file-system can delete it later.
      let folder = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("FacingRoom", isDirectory: true)
      try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
      let url = folder.appendingPathComponent(UUID().uuidString).appendingPathExtension("mov")
      self.take = Take(url: url, promise: promise)
    }
  }

  func stopRecording() {
    // Holds the view until this runs, so a view closed mid-take still
    // finishes its file and settles the take's promise.
    captureQueue.async { [self] in
      guard let take = self.take else { return }
      self.take = nil
      if let pendingRotation, let connection = videoOutput.connection(with: .video) {
        pendingRotation(connection)
        self.pendingRotation = nil
      }
      guard let writer = take.writer else {
        take.promise.reject("ERR_RECORDING", "The camera stopped before it recorded anything.")
        return
      }
      take.video?.markAsFinished()
      take.audio?.markAsFinished()
      writer.finishWriting {
        if writer.status == .completed {
          take.promise.resolve(["uri": take.url.absoluteString])
        } else {
          take.promise.reject("ERR_RECORDING", writer.error?.localizedDescription ?? "The take couldn't be saved.")
        }
      }
    }
  }

  /// Opens the file at the take's first frame, sized to it.
  private func begin(_ take: Take, with buffer: CMSampleBuffer) throws {
    guard let pixels = CMSampleBufferGetImageBuffer(buffer) else {
      throw SetupError.unusable("its first frame")
    }
    let writer = try AVAssetWriter(outputURL: take.url, fileType: .mov)
    let codec: AVVideoCodecType =
      videoOutput.availableVideoCodecTypesForAssetWriter(writingTo: .mov).contains(.hevc) ? .hevc : .h264
    let video = AVAssetWriterInput(mediaType: .video, outputSettings: [
      AVVideoCodecKey: codec,
      AVVideoWidthKey: CVPixelBufferGetWidth(pixels),
      AVVideoHeightKey: CVPixelBufferGetHeight(pixels),
      AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: videoBitrate],
    ])
    video.expectsMediaDataInRealTime = true
    guard writer.canAdd(video) else { throw SetupError.unusable("its video for a take") }
    writer.add(video)
    if hasMicrophone,
       let settings = audioOutput.recommendedAudioSettingsForAssetWriter(writingTo: .mov) as? [String: Any] {
      let audio = AVAssetWriterInput(mediaType: .audio, outputSettings: settings)
      audio.expectsMediaDataInRealTime = true
      if writer.canAdd(audio) {
        writer.add(audio)
        take.audio = audio
      }
    }
    guard writer.startWriting() else {
      throw writer.error ?? SetupError.unusable("the file for a take")
    }
    let start = CMSampleBufferGetPresentationTimeStamp(buffer)
    writer.startSession(atSourceTime: start)
    take.writer = writer
    take.video = video
    take.startTime = start
  }

  private func writeVideo(_ buffer: CMSampleBuffer) {
    guard let take else { return }
    if take.writer == nil {
      do {
        try begin(take, with: buffer)
      } catch {
        fail(take, error)
        return
      }
    }
    guard let writer = take.writer, writer.status == .writing else {
      fail(take, take.writer?.error)
      return
    }
    if let video = take.video, video.isReadyForMoreMediaData {
      video.append(buffer)
    }
  }

  private func writeAudio(_ buffer: CMSampleBuffer) {
    guard let take, let writer = take.writer, writer.status == .writing,
          let audio = take.audio, audio.isReadyForMoreMediaData,
          // Sound from before the first frame would start the file early.
          CMSampleBufferGetPresentationTimeStamp(buffer) >= take.startTime else { return }
    audio.append(buffer)
  }

  private func fail(_ take: Take, _ error: Error?) {
    self.take = nil
    if let pendingRotation, let connection = videoOutput.connection(with: .video) {
      pendingRotation(connection)
      self.pendingRotation = nil
    }
    take.writer?.cancelWriting()
    take.promise.reject("ERR_RECORDING", error?.localizedDescription ?? "The take couldn't be saved.")
  }

  // MARK: - Head direction

  /// Reads the largest face in this frame when one is due and the last read
  /// has finished, and sends `{ face: true, yaw, pitch, faceWidth }` or
  /// `{ face: false }` (degrees, degrees, pixels; see HeadPoseReader.Sample).
  private func readPoseIfDue(_ buffer: CMSampleBuffer) {
    guard !readingPose else { return }
    let at = CMSampleBufferGetPresentationTimeStamp(buffer)
    if lastPoseAt.isValid, (at - lastPoseAt).seconds * 1000 < poseFrameMs - 1 { return }
    guard let pixels = CMSampleBufferGetImageBuffer(buffer) else { return }
    readingPose = true
    lastPoseAt = at
    let width = Double(CVPixelBufferGetWidth(pixels))
    visionQueue.async { [weak self] in
      guard let self else { return }
      var payload: [String: Any]?
      do {
        if let sample = try HeadPoseReader.largestFace(
          in: pixels, orientation: .up, uprightWidth: width, request: self.poseRequest
        ) {
          payload = [
            "face": true,
            "yaw": round1(sample.yaw),
            "pitch": round1(sample.pitch),
            "faceWidth": sample.faceWidth.rounded(),
          ]
        } else {
          payload = ["face": false]
        }
      } catch {
        payload = nil
      }
      self.captureQueue.async { self.readingPose = false }
      if let payload {
        DispatchQueue.main.async { self.onHeadPose(payload) }
      }
    }
  }
}

extension FacingRoomCameraView: AVCaptureVideoDataOutputSampleBufferDelegate,
  AVCaptureAudioDataOutputSampleBufferDelegate {
  func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
    if output === videoOutput {
      readPoseIfDue(sampleBuffer)
      writeVideo(sampleBuffer)
    } else {
      writeAudio(sampleBuffer)
    }
  }
}
