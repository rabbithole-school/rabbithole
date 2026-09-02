import ExpoModulesCore
import SceneKit
import UIKit
import simd

// A self-contained SceneKit dice tray. Renders one or more dice (d6 or d20),
// throws them with real rigid-body physics, and reports the settled face-up
// values back to React Native via the `onSettled` event.
class SceneDiceView: ExpoView {
  let onSettled = EventDispatcher()

  // MARK: - Public props (set from JS)
  var throwX: Double = 0
  var throwY: Double = 0
  var throwPower: Double = 0

  // MARK: - Scene objects
  private let scnView = SCNView()
  private let scene = SCNScene()
  private var diceNodes: [SCNNode] = []
  // Per-die list of (local face normal, face value) for settle detection.
  private var diceFaces: [[(SIMD3<Float>, Int)]] = []

  // MARK: - State
  private var diceType = "d6"
  private var diceCount = 2
  private var themeColor = UIColor(red: 0.914, green: 0.337, blue: 0.247, alpha: 1) // #E9573F
  private var lastRollToken = 0

  private var sceneReady = false
  private var diceDirty = true
  private var rebuildScheduled = false
  private var didInitialRoll = false
  private var rolling = false
  private var suppressNextSettle = false
  private var stillFrames = 0
  private var rollStartTime: TimeInterval = 0

  // Direct-manipulation drag state. While `dragging`, the dice are pinned under
  // the finger (gravity off) and released with the swipe velocity on lift.
  private var dragging = false
  private var dragPX: CGFloat = 0 // finger x in view points (matches scnView bounds)
  private var dragPY: CGFloat = 0
  // Per-die in-hand state: a target position plus a gentle idle tumble so a
  // random face ends up pointing up on each die (keeps the roll fair).
  private var heldTarget: [SIMD3<Float>] = []
  private var heldSpinAxis: [SIMD3<Float>] = []
  private var heldSpinRate: [Float] = []
  private var heldAngle: [Float] = []
  private var lastDragTime: TimeInterval = 0

  private let trayHalf: Float = 3.6

  // MARK: - Init / layout
  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    setupScene()
    addSubview(scnView)
    clipsToBounds = true
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    scnView.frame = bounds
    if bounds.width > 0, bounds.height > 0, !didInitialRoll {
      didInitialRoll = true
      rebuildDice()
      performRoll(initial: true)
    }
  }

  // MARK: - Prop setters
  func setDiceType(_ type: String) {
    let normalized: String
    switch type {
    case "d20": normalized = "d20"
    case "coin": normalized = "coin"
    default: normalized = "d6"
    }
    guard normalized != diceType else { return }
    diceType = normalized
    scheduleRebuild()
  }

  func setDiceCount(_ count: Int) {
    let clamped = max(1, min(10, count))
    guard clamped != diceCount else { return }
    diceCount = clamped
    scheduleRebuild()
  }

  func setThemeColor(_ hex: String) {
    guard let color = UIColor(hexString: hex) else { return }
    themeColor = color
    scheduleRebuild()
  }

  func setRollToken(_ token: Int) {
    guard token != lastRollToken else { return }
    lastRollToken = token
    performRoll(initial: false)
  }

  // MARK: - Drag (direct manipulation)
  // The swipe drives these three props. `dragActive` toggles pickup/release;
  // `dragX`/`dragY` are the finger position in the tray's view-point coordinate
  // system (which equals scnView.bounds, since the SCNView fills the tray). We
  // unproject that onto the tray floor so the dice sit right under the finger.
  func setDragActive(_ active: Bool) {
    if active && !dragging {
      beginDrag()
    } else if !active && dragging {
      releaseFromDrag()
    }
  }

  func setDragX(_ value: Double) {
    dragPX = CGFloat(value)
    if dragging { positionHeldDice() }
  }

  func setDragY(_ value: Double) {
    dragPY = CGFloat(value)
    if dragging { positionHeldDice() }
  }

  private func beginDrag() {
    guard sceneReady else { return }
    if diceDirty { rebuildDice() }
    guard !diceNodes.isEmpty else { return }
    dragging = true
    rolling = false
    suppressNextSettle = false
    stillFrames = 0
    scnView.isPlaying = true
    scnView.rendersContinuously = true
    // Give each die/coin a random spin axis + start angle so it tumbles in hand
    // and a RANDOM face ends up pointing up the moment you pick it up — this
    // (plus the release below) is what makes the roll feel fair, not dropped.
    let n = diceNodes.count
    heldTarget = Array(repeating: SIMD3<Float>(0, 0.9, 0), count: n)
    heldSpinAxis = (0..<n).map { _ in randomUnitAxis() }
    heldSpinRate = (0..<n).map { _ in Float.random(in: 1.6...3.0) }
    heldAngle = (0..<n).map { _ in Float.random(in: 0...(2 * .pi)) }
    lastDragTime = 0
    for die in diceNodes {
      guard let body = die.physicsBody else { continue }
      body.isAffectedByGravity = false
      body.velocity = SCNVector3Zero
      body.angularVelocity = SCNVector4Zero
      body.clearAllForces()
    }
    positionHeldDice()
    triggerHaptic(.light)
  }

  // Pin every die under the finger, spread in a small centered grid so multiple
  // dice don't stack. Called on every drag update; the render loop also zeroes
  // velocity each frame so the solver can't nudge them while the finger holds.
  private func positionHeldDice() {
    guard dragging, !diceNodes.isEmpty else { return }
    let held: Float = 0.9
    let center = floorPointFromView(px: dragPX, py: dragPY, y: held)
    let n = diceNodes.count
    let cols = max(1, Int(ceil(Double(n).squareRoot())))
    let rows = Int(ceil(Double(n) / Double(cols)))
    let spacing: Float = 1.3
    let lim = trayHalf - 0.55
    if heldTarget.count != n { heldTarget = Array(repeating: SIMD3<Float>(0, held, 0), count: n) }
    for (i, die) in diceNodes.enumerated() {
      let col = i % cols
      let row = i / cols
      let ox = (Float(col) - Float(cols - 1) / 2.0) * spacing
      let oz = (Float(row) - Float(rows - 1) / 2.0) * spacing
      let x = min(lim, max(-lim, center.x + ox))
      let z = min(lim, max(-lim, center.z + oz))
      let pos = SIMD3<Float>(x, held + Float(i) * 0.02, z)
      heldTarget[i] = pos
      die.simdPosition = pos
      die.physicsBody?.resetTransform()
      die.physicsBody?.velocity = SCNVector3Zero
      die.physicsBody?.angularVelocity = SCNVector4Zero
    }
  }

  // Fling the dice from wherever the finger let go, along the swipe vector.
  private func releaseFromDrag() {
    dragging = false
    guard sceneReady, !diceNodes.isEmpty else { return }
    suppressNextSettle = false
    rolling = true
    stillFrames = 0
    rollStartTime = CACurrentMediaTime()
    scnView.isPlaying = true
    scnView.rendersContinuously = true

    // Velocity model (the "feels fair" fix): the swipe steers, but the throw
    // ALWAYS carries a substantial push deeper into the tray so the dice travel
    // and tumble instead of dropping in one spot.
    //   • X (screen left/right) tracks the hand.
    //   • Z (depth) is biased toward -Z (into the tray, away from the player)
    //     with a hard minimum; the swipe's near/far only modulates it.
    //   • Y gets an upward pop for airtime, and every die gets a strong RANDOM
    //     spin — spin is what actually makes a roll read as fair.
    let power = Float(throwPower <= 0 ? 0 : min(1.4, max(0, throwPower)))
    var hand = SIMD2<Float>(Float(throwX), Float(throwY))
    let handLen = simd_length(hand)
    hand = handLen > 0.001 ? hand / handLen : SIMD2<Float>(0, 0)
    let handSpeed = 7.0 * power
    let minForward: Float = 4.5
    for die in diceNodes {
      guard let body = die.physicsBody else { continue }
      body.isAffectedByGravity = true
      body.resetTransform()
      let vx = hand.x * handSpeed + Float.random(in: -1.4...1.4)
      // hand.y > 0 (swipe toward you) eases the forward push; hand.y < 0 (swipe
      // away) adds to it; clamp so it's always heading into the tray.
      let vz = min(-1.8, -minForward + hand.y * handSpeed + Float.random(in: -1.2...1.2))
      let vy = Float.random(in: 2.8...4.0)
      body.velocity = SCNVector3(vx, vy, vz)
      let axis = randomSpinAxis()
      let spin = Float.random(in: 18...30)
      body.angularVelocity = SCNVector4(axis.x, axis.y, axis.z, spin)
    }
    triggerHaptic(.medium)
  }

  // Unproject a finger point (view points) onto the tray floor plane at height y.
  private func floorPointFromView(px: CGFloat, py: CGFloat, y: Float) -> SIMD3<Float> {
    let b = scnView.bounds
    guard b.width > 1, b.height > 1 else { return SIMD3<Float>(0, y, 0) }
    let cx = Float(min(b.width, max(0, px)))
    let cy = Float(min(b.height, max(0, py)))
    let near = scnView.unprojectPoint(SCNVector3(cx, cy, 0))
    let far = scnView.unprojectPoint(SCNVector3(cx, cy, 1))
    let origin = SIMD3<Float>(near.x, near.y, near.z)
    var ray = SIMD3<Float>(far.x - near.x, far.y - near.y, far.z - near.z)
    if abs(ray.y) < 1e-5 { ray.y = ray.y < 0 ? -1e-5 : 1e-5 }
    let t = (y - origin.y) / ray.y
    var p = origin + ray * t
    let lim = trayHalf - 0.55
    p.x = min(lim, max(-lim, p.x))
    p.z = min(lim, max(-lim, p.z))
    p.y = y
    return p
  }

  // A uniformly-random unit axis (for tumbling dice / in-hand rotation).
  private func randomUnitAxis() -> SIMD3<Float> {
    var v = SIMD3<Float>(Float.random(in: -1...1), Float.random(in: -1...1), Float.random(in: -1...1))
    if simd_length(v) < 1e-4 { v = SIMD3<Float>(0, 1, 0) }
    return simd_normalize(v)
  }

  // Spin axis on release. Coins spin about a HORIZONTAL axis so they flip
  // heads/tails (a vertical axis would just spin them like a top); dice use a
  // fully-random axis.
  private func randomSpinAxis() -> SIMD3<Float> {
    if diceType == "coin" {
      let a = Float.random(in: 0...(2 * .pi))
      return SIMD3<Float>(cos(a), 0, sin(a))
    }
    return randomUnitAxis()
  }

  // Coalesce prop-driven rebuilds. Switching d6<->d20 changes two props at once
  // (diceType AND themeColor), which arrive as separate setter calls in the same
  // React commit; rebuilding on the first would flip `rolling` true and make the
  // second bail, so the change only showed up on the *next* roll. Instead we mark
  // dirty and rebuild exactly once on the next runloop tick — and deliberately do
  // NOT bail while a roll is in flight, so a switch takes effect immediately.
  private func scheduleRebuild() {
    diceDirty = true
    guard sceneReady, didInitialRoll, !rebuildScheduled else { return }
    rebuildScheduled = true
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.rebuildScheduled = false
      guard self.diceDirty else { return }
      self.rebuildDice()
      self.performRoll(initial: true)
    }
  }

  // MARK: - Scene setup
  private func setupScene() {
    scnView.scene = scene
    scnView.backgroundColor = .clear
    scnView.antialiasingMode = .multisampling4X
    scnView.autoenablesDefaultLighting = false
    scnView.isPlaying = false
    scnView.rendersContinuously = false
    scnView.delegate = self
    scnView.isUserInteractionEnabled = false

    scene.physicsWorld.gravity = SCNVector3(0, -28, 0)

    // Camera looking down into the tray.
    let cameraNode = SCNNode()
    let camera = SCNCamera()
    camera.fieldOfView = 42
    camera.zNear = 0.1
    camera.zFar = 200
    cameraNode.camera = camera
    cameraNode.position = SCNVector3(0, 13.5, 9.5)
    let lookAt = SCNLookAtConstraint(target: {
      let n = SCNNode(); n.position = SCNVector3(0, 0, 0); return n
    }())
    lookAt.isGimbalLockEnabled = true
    cameraNode.constraints = [lookAt]
    scene.rootNode.addChildNode(cameraNode)

    // Lighting: soft ambient + a key directional light that casts shadows.
    let ambient = SCNNode()
    ambient.light = SCNLight()
    ambient.light?.type = .ambient
    ambient.light?.intensity = 550
    ambient.light?.color = UIColor(white: 1.0, alpha: 1.0)
    scene.rootNode.addChildNode(ambient)

    let key = SCNNode()
    key.light = SCNLight()
    key.light?.type = .directional
    key.light?.intensity = 900
    key.light?.castsShadow = true
    key.light?.shadowMode = .deferred
    key.light?.shadowSampleCount = 16
    key.light?.shadowRadius = 6
    key.light?.shadowColor = UIColor(white: 0, alpha: 0.35)
    key.position = SCNVector3(6, 14, 8)
    key.eulerAngles = SCNVector3(-Float.pi / 3, Float.pi / 8, 0)
    scene.rootNode.addChildNode(key)

    // A soft studio environment (image-based lighting) so the metal coins have
    // something to reflect and their engraved relief catches a highlight that
    // sweeps as they flip. Kept subtle so the plastic dice look unchanged.
    scene.lightingEnvironment.contents = studioEnvironmentImage()
    scene.lightingEnvironment.intensity = 1.0

    // Floor.
    let floor = SCNFloor()
    floor.reflectivity = 0.04
    let floorMat = SCNMaterial()
    floorMat.diffuse.contents = UIColor(white: 0.97, alpha: 1.0)
    floorMat.lightingModel = .physicallyBased
    floorMat.roughness.contents = 0.9
    floor.materials = [floorMat]
    let floorNode = SCNNode(geometry: floor)
    floorNode.physicsBody = SCNPhysicsBody(type: .static, shape: nil)
    floorNode.physicsBody?.restitution = 0.3
    floorNode.physicsBody?.friction = 0.6
    scene.rootNode.addChildNode(floorNode)

    // Invisible walls to keep dice in the tray.
    addWall(position: SCNVector3(trayHalf, 2.5, 0), size: SCNVector3(0.2, 6, trayHalf * 2))
    addWall(position: SCNVector3(-trayHalf, 2.5, 0), size: SCNVector3(0.2, 6, trayHalf * 2))
    addWall(position: SCNVector3(0, 2.5, trayHalf), size: SCNVector3(trayHalf * 2, 6, 0.2))
    addWall(position: SCNVector3(0, 2.5, -trayHalf), size: SCNVector3(trayHalf * 2, 6, 0.2))

    sceneReady = true
  }

  private func addWall(position: SCNVector3, size: SCNVector3) {
    let box = SCNBox(width: CGFloat(size.x), height: CGFloat(size.y), length: CGFloat(size.z), chamferRadius: 0)
    let node = SCNNode(geometry: box)
    node.position = position
    node.opacity = 0
    node.physicsBody = SCNPhysicsBody(type: .static, shape: nil)
    node.physicsBody?.restitution = 0.2
    node.physicsBody?.friction = 0.5
    scene.rootNode.addChildNode(node)
  }

  // MARK: - Dice building
  private func rebuildDice() {
    for node in diceNodes { node.removeFromParentNode() }
    diceNodes.removeAll()
    diceFaces.removeAll()

    for _ in 0..<diceCount {
      let (node, faces): (SCNNode, [(SIMD3<Float>, Int)])
      switch diceType {
      case "d20": (node, faces) = makeD20()
      case "coin": (node, faces) = makeCoin()
      default: (node, faces) = makeD6()
      }
      scene.rootNode.addChildNode(node)
      diceNodes.append(node)
      diceFaces.append(faces)
    }
    diceDirty = false
  }

  // A rounded d6 with pip textures. Face/value mapping keeps opposite faces
  // summing to 7. SCNBox material order: +Z, +X, -Z, -X, +Y, -Y.
  private func makeD6() -> (SCNNode, [(SIMD3<Float>, Int)]) {
    let size: CGFloat = 1.0
    let box = SCNBox(width: size, height: size, length: size, chamferRadius: 0.14)
    let values = [1, 2, 6, 5, 3, 4] // +Z, +X, -Z, -X, +Y, -Y
    box.materials = values.map { materialForPips($0) }

    let node = SCNNode(geometry: box)
    let shape = SCNPhysicsShape(geometry: SCNBox(width: size, height: size, length: size, chamferRadius: 0),
                                options: [.type: SCNPhysicsShape.ShapeType.boundingBox])
    node.physicsBody = physicsBody(shape: shape)

    let faces: [(SIMD3<Float>, Int)] = [
      (SIMD3(0, 0, 1), 1),
      (SIMD3(1, 0, 0), 2),
      (SIMD3(0, 0, -1), 6),
      (SIMD3(-1, 0, 0), 5),
      (SIMD3(0, 1, 0), 3),
      (SIMD3(0, -1, 0), 4),
    ]
    return (node, faces)
  }

  // A flat coin (thin cylinder). Heads (+Y) reports 1 and tails (-Y) reports 0,
  // so the "total" across N coins is simply the number of heads — a clean
  // binomial for the histogram. SCNCylinder material order is [side, top, bottom].
  //
  // The faces use engraved gold textures (heads = Carl, tails = the school
  // seal) bundled with the module; if they can't be loaded we fall back to a
  // procedural H / T coin. A soft studio lighting environment (set up in the
  // scene) gives the gold its shine, which sweeps across the relief as it flips.
  private func makeCoin() -> (SCNNode, [(SIMD3<Float>, Int)]) {
    let radius: CGFloat = 0.92
    let thickness: CGFloat = 0.22
    let cyl = SCNCylinder(radius: radius, height: thickness)
    cyl.radialSegmentCount = 48

    let edge = SCNMaterial()
    edge.lightingModel = .physicallyBased
    let heads = SCNMaterial()
    heads.lightingModel = .physicallyBased
    let tails = SCNMaterial()
    tails.lightingModel = .physicallyBased

    // SCNCylinder's bottom cap samples its texture mirrored in u relative to the
    // top cap, so tails art (the seal text) comes out backwards. Flip it back.
    tails.diffuse.contentsTransform = SCNMatrix4MakeScale(-1, 1, 1)
    tails.diffuse.wrapS = .repeat
    tails.diffuse.wrapT = .repeat

    let gold = UIColor(red: 0.93, green: 0.74, blue: 0.33, alpha: 1)
    if let hImg = bundledImage("coin-heads"), let tImg = bundledImage("coin-tails") {
      heads.diffuse.contents = hImg
      tails.diffuse.contents = tImg
      for m in [heads, tails] {
        m.metalness.contents = 0.2
        m.roughness.contents = 0.4
      }
      edge.diffuse.contents = gold
      edge.metalness.contents = 0.9
      edge.roughness.contents = 0.3
    } else {
      // Procedural H / T fallback (art not bundled).
      heads.diffuse.contents = coinFaceTexture(symbol: "H")
      tails.diffuse.contents = coinFaceTexture(symbol: "T")
      for m in [heads, tails] {
        m.metalness.contents = 0.25
        m.roughness.contents = 0.3
      }
      edge.diffuse.contents = themeColor
      edge.metalness.contents = 0.45
      edge.roughness.contents = 0.3
    }

    cyl.materials = [edge, heads, tails]

    let node = SCNNode(geometry: cyl)
    let shape = SCNPhysicsShape(geometry: SCNCylinder(radius: radius, height: thickness),
                                options: [.type: SCNPhysicsShape.ShapeType.convexHull])
    node.physicsBody = physicsBody(shape: shape)

    let faces: [(SIMD3<Float>, Int)] = [
      (SIMD3(0, 1, 0), 1),  // heads
      (SIMD3(0, -1, 0), 0), // tails
    ]
    return (node, faces)
  }

  // Loads a PNG from the module's bundled resources (SceneDiceAssets.bundle).
  private func bundledImage(_ name: String) -> UIImage? {
    let moduleBundle = Bundle(for: SceneDiceView.self)
    if let url = moduleBundle.url(forResource: "SceneDiceAssets", withExtension: "bundle"),
       let assets = Bundle(url: url),
       let path = assets.path(forResource: name, ofType: "png") {
      return UIImage(contentsOfFile: path)
    }
    return UIImage(named: name, in: moduleBundle, compatibleWith: nil)
  }

  // A cheap equirectangular studio backdrop: a bright-to-dim vertical gradient
  // with a soft overhead "softbox". Gives metals a directional reflection that
  // slides across the relief as a coin tumbles.
  private func studioEnvironmentImage() -> UIImage {
    let size = CGSize(width: 512, height: 256)
    return UIGraphicsImageRenderer(size: size).image { ctx in
      let cg = ctx.cgContext
      let space = CGColorSpaceCreateDeviceRGB()
      let grad = CGGradient(colorsSpace: space,
                            colors: [UIColor(white: 1.0, alpha: 1).cgColor,
                                     UIColor(white: 0.68, alpha: 1).cgColor,
                                     UIColor(white: 0.34, alpha: 1).cgColor] as CFArray,
                            locations: [0.0, 0.5, 1.0])!
      cg.drawLinearGradient(grad,
                            start: CGPoint(x: 0, y: 0),
                            end: CGPoint(x: 0, y: size.height),
                            options: [])
      cg.setFillColor(UIColor(white: 1.0, alpha: 0.85).cgColor)
      cg.fillEllipse(in: CGRect(x: size.width * 0.22, y: size.height * 0.06,
                                width: size.width * 0.56, height: size.height * 0.26))
    }
  }

  // A procedural icosahedron (d20). Flat-shaded body with a number label at
  // each face centroid; antipodal faces sum to 21.
  private func makeD20() -> (SCNNode, [(SIMD3<Float>, Int)]) {
    let radius: Float = 0.92
    let t = Float((1.0 + sqrt(5.0)) / 2.0)
    var baseVerts: [SIMD3<Float>] = [
      SIMD3(-1, t, 0), SIMD3(1, t, 0), SIMD3(-1, -t, 0), SIMD3(1, -t, 0),
      SIMD3(0, -1, t), SIMD3(0, 1, t), SIMD3(0, -1, -t), SIMD3(0, 1, -t),
      SIMD3(t, 0, -1), SIMD3(t, 0, 1), SIMD3(-t, 0, -1), SIMD3(-t, 0, 1),
    ]
    for i in 0..<baseVerts.count {
      baseVerts[i] = simd_normalize(baseVerts[i]) * radius
    }
    let faceIndices: [[Int]] = [
      [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
      [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
      [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
      [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
    ]

    // Per-face centroids (direction) plus the distance from the die center to
    // each face plane — the icosahedron inradius, which is smaller than the
    // vertex radius. Labels get placed at that distance so they sit flush on the
    // face instead of floating above it.
    var centroids: [SIMD3<Float>] = []
    var faceDists: [Float] = []
    for f in faceIndices {
      let raw = (baseVerts[f[0]] + baseVerts[f[1]] + baseVerts[f[2]]) / 3.0
      faceDists.append(simd_length(raw))
      centroids.append(simd_normalize(raw))
    }

    // Assign numbers so antipodal faces sum to 21.
    var numbers = [Int](repeating: 0, count: 20)
    var assigned = [Bool](repeating: false, count: 20)
    var next = 1
    for i in 0..<20 where !assigned[i] {
      // find the antipodal face (most opposite centroid)
      var antipode = -1
      var minDot = Float.greatestFiniteMagnitude
      for j in 0..<20 where j != i && !assigned[j] {
        let d = simd_dot(centroids[i], centroids[j])
        if d < minDot { minDot = d; antipode = j }
      }
      numbers[i] = next
      assigned[i] = true
      if antipode >= 0 {
        numbers[antipode] = 21 - next
        assigned[antipode] = true
      }
      next += 1
    }

    // Flat-shaded geometry: unique verts per face.
    var positions: [SCNVector3] = []
    var normals: [SCNVector3] = []
    var indices: [Int32] = []
    for (fi, f) in faceIndices.enumerated() {
      let a = baseVerts[f[0]], b = baseVerts[f[1]], c = baseVerts[f[2]]
      var n = simd_normalize(simd_cross(b - a, c - a))
      if simd_dot(n, centroids[fi]) < 0 { n = -n } // outward
      let base = Int32(fi * 3)
      positions.append(SCNVector3(a)); positions.append(SCNVector3(b)); positions.append(SCNVector3(c))
      normals.append(SCNVector3(n)); normals.append(SCNVector3(n)); normals.append(SCNVector3(n))
      indices.append(base); indices.append(base + 1); indices.append(base + 2)
    }

    let vSource = SCNGeometrySource(vertices: positions)
    let nSource = SCNGeometrySource(normals: normals)
    let element = SCNGeometryElement(indices: indices, primitiveType: .triangles)
    let geometry = SCNGeometry(sources: [vSource, nSource], elements: [element])

    let bodyMat = SCNMaterial()
    bodyMat.diffuse.contents = themeColor
    bodyMat.lightingModel = .physicallyBased
    bodyMat.roughness.contents = 0.35
    bodyMat.metalness.contents = 0.0
    geometry.materials = [bodyMat]

    let node = SCNNode(geometry: geometry)

    // Number labels.
    var faces: [(SIMD3<Float>, Int)] = []
    for (fi, c) in centroids.enumerated() {
      faces.append((c, numbers[fi]))
      let label = numberLabelNode(numbers[fi])
      label.simdPosition = c * (faceDists[fi] + 0.004)
      label.simdOrientation = simd_quatf(from: SIMD3(0, 0, 1), to: c)
      node.addChildNode(label)
    }

    let shape = SCNPhysicsShape(geometry: geometry, options: [.type: SCNPhysicsShape.ShapeType.convexHull])
    node.physicsBody = physicsBody(shape: shape)
    return (node, faces)
  }

  private func physicsBody(shape: SCNPhysicsShape) -> SCNPhysicsBody {
    let body = SCNPhysicsBody(type: .dynamic, shape: shape)
    body.mass = 1.0
    body.restitution = 0.35
    body.friction = 0.55
    body.rollingFriction = 0.08
    body.damping = 0.12
    body.angularDamping = 0.16
    return body
  }

  private func numberLabelNode(_ value: Int) -> SCNNode {
    let plane = SCNPlane(width: 0.62, height: 0.62)
    let mat = SCNMaterial()
    mat.diffuse.contents = numberTexture(value)
    // Smooth filtering + anisotropy so the glyph stays crisp (not aliased) when
    // the face is small, far, or tilted away from the camera.
    mat.diffuse.magnificationFilter = .linear
    mat.diffuse.minificationFilter = .linear
    mat.diffuse.mipFilter = .linear
    mat.diffuse.maxAnisotropy = 16
    mat.isDoubleSided = true
    mat.lightingModel = .constant
    mat.blendMode = .alpha
    mat.writesToDepthBuffer = false
    plane.materials = [mat]
    let node = SCNNode(geometry: plane)
    node.renderingOrder = 10
    return node
  }

  // MARK: - Texture drawing
  private func materialForPips(_ value: Int) -> SCNMaterial {
    let mat = SCNMaterial()
    mat.diffuse.contents = pipTexture(value)
    mat.lightingModel = .physicallyBased
    mat.roughness.contents = 0.4
    mat.metalness.contents = 0.0
    return mat
  }

  private func pipTexture(_ value: Int) -> UIImage {
    let dimension: CGFloat = 256
    let size = CGSize(width: dimension, height: dimension)
    let renderer = UIGraphicsImageRenderer(size: size)
    let layouts: [Int: [(CGFloat, CGFloat)]] = [
      1: [(0.5, 0.5)],
      2: [(0.28, 0.28), (0.72, 0.72)],
      3: [(0.28, 0.28), (0.5, 0.5), (0.72, 0.72)],
      4: [(0.28, 0.28), (0.72, 0.28), (0.28, 0.72), (0.72, 0.72)],
      5: [(0.28, 0.28), (0.72, 0.28), (0.5, 0.5), (0.28, 0.72), (0.72, 0.72)],
      6: [(0.28, 0.26), (0.28, 0.5), (0.28, 0.74), (0.72, 0.26), (0.72, 0.5), (0.72, 0.74)],
    ]
    let pips = layouts[value] ?? []
    return renderer.image { ctx in
      themeColor.setFill()
      ctx.fill(CGRect(origin: .zero, size: size))
      let pipRadius: CGFloat = 26
      UIColor.white.setFill()
      for (px, py) in pips {
        let rect = CGRect(x: px * dimension - pipRadius,
                          y: py * dimension - pipRadius,
                          width: pipRadius * 2, height: pipRadius * 2)
        ctx.cgContext.fillEllipse(in: rect)
      }
    }
  }

  private func numberTexture(_ value: Int) -> UIImage {
    let dimension: CGFloat = 512
    let size = CGSize(width: dimension, height: dimension)
    let renderer = UIGraphicsImageRenderer(size: size)
    return renderer.image { ctx in
      let cg = ctx.cgContext
      let text = "\(value)"
      let font = UIFont.systemFont(ofSize: 276, weight: .heavy)
      let paragraph = NSMutableParagraphStyle()
      paragraph.alignment = .center
      // A soft, symmetric shadow gives the white glyph contrast on any face and
      // reads as engraving depth. Unlike the old thin translucent stroke it stays
      // smooth when the texture is minified (small/far/tilted faces), so there's
      // no jaggy dark fringe around the numbers.
      cg.setShadow(offset: .zero, blur: 14, color: UIColor(white: 0, alpha: 0.5).cgColor)
      let attrs: [NSAttributedString.Key: Any] = [
        .font: font,
        .foregroundColor: UIColor.white,
        .paragraphStyle: paragraph,
      ]
      let attributed = NSAttributedString(string: text, attributes: attrs)
      let textSize = attributed.size()
      let rect = CGRect(x: 0,
                        y: (dimension - textSize.height) / 2,
                        width: dimension,
                        height: textSize.height)
      attributed.draw(in: rect)
      // Underline 6 and 9 so orientation reads unambiguously.
      if value == 6 || value == 9 {
        let barWidth: CGFloat = 180
        let bar = CGRect(x: (dimension - barWidth) / 2, y: dimension - 112, width: barWidth, height: 22)
        UIColor.white.setFill()
        UIBezierPath(roundedRect: bar, cornerRadius: 10).fill()
      }
    }
  }

  // Coin face: theme-colored disc with a subtle rim ring and a big H / T.
  private func coinFaceTexture(symbol: String) -> UIImage {
    let dimension: CGFloat = 256
    let size = CGSize(width: dimension, height: dimension)
    let renderer = UIGraphicsImageRenderer(size: size)
    return renderer.image { ctx in
      let cg = ctx.cgContext
      themeColor.setFill()
      cg.fillEllipse(in: CGRect(x: 4, y: 4, width: dimension - 8, height: dimension - 8))
      UIColor(white: 1, alpha: 0.30).setStroke()
      let ring = UIBezierPath(ovalIn: CGRect(x: 26, y: 26, width: dimension - 52, height: dimension - 52))
      ring.lineWidth = 8
      ring.stroke()
      let font = UIFont.systemFont(ofSize: 150, weight: .heavy)
      let paragraph = NSMutableParagraphStyle()
      paragraph.alignment = .center
      let attrs: [NSAttributedString.Key: Any] = [
        .font: font,
        .foregroundColor: UIColor.white,
        .strokeColor: UIColor(white: 0, alpha: 0.5),
        .strokeWidth: -3.0,
        .paragraphStyle: paragraph,
      ]
      let attributed = NSAttributedString(string: symbol, attributes: attrs)
      let textSize = attributed.size()
      attributed.draw(in: CGRect(x: 0, y: (dimension - textSize.height) / 2, width: dimension, height: textSize.height))
    }
  }

  // MARK: - Rolling
  private func performRoll(initial: Bool) {
    guard sceneReady else { return }
    if diceDirty { rebuildDice() }
    guard !diceNodes.isEmpty else { return }

    suppressNextSettle = initial
    rolling = true
    stillFrames = 0
    rollStartTime = CACurrentMediaTime()
    scnView.isPlaying = true
    scnView.rendersContinuously = true

    let count = diceNodes.count
    let power = Float(throwPower <= 0 ? 0.6 : min(1.4, max(0.35, throwPower)))

    // Horizontal throw direction in WORLD space. Under this camera, screen-right
    // maps to +X and screen-down (toward the viewer) maps to +Z, which is exactly
    // the (throwX, throwY) vector the swipe sends — so the dice launch the way you
    // flick. To read as a direct flick rather than a top-drop, dice spawn LOW and
    // just behind center (opposite the throw) and are launched horizontally along
    // the swipe, tumbling forward.
    var dir = SIMD2<Float>(Float(throwX), Float(throwY == 0 ? -0.6 : throwY))
    let dirLen = simd_length(dir)
    dir = dirLen > 0.001 ? dir / dirLen : SIMD2<Float>(0, -1)
    let perp = SIMD2<Float>(-dir.y, dir.x)
    let launchSpeed = 7.0 * power + 2.6

    for (i, die) in diceNodes.enumerated() {
      let lateral = (Float(i) - Float(count - 1) / 2.0) * 1.5
      let base = -dir * 1.7 + perp * lateral
      die.position = SCNVector3(base.x + Float.random(in: -0.2...0.2),
                                1.7 + Float.random(in: 0...0.5),
                                base.y + Float.random(in: -0.2...0.2))
      die.eulerAngles = SCNVector3(Float.random(in: 0...(2 * .pi)),
                                   Float.random(in: 0...(2 * .pi)),
                                   Float.random(in: 0...(2 * .pi)))
      guard let body = die.physicsBody else { continue }
      body.resetTransform()
      body.velocity = SCNVector3(dir.x * launchSpeed + Float.random(in: -0.5...0.5),
                                 -2.0,
                                 dir.y * launchSpeed + Float.random(in: -0.5...0.5))
      // Tumble mostly about the horizontal axis perpendicular to travel, so the
      // die rolls forward along its flight (with a little randomness for variety).
      let tumbleAxis = simd_normalize(SIMD3<Float>(perp.x + Float.random(in: -0.3...0.3),
                                                   Float.random(in: -0.3...0.3),
                                                   perp.y + Float.random(in: -0.3...0.3)))
      let spin = Float.random(in: 10...18)
      body.angularVelocity = SCNVector4(tumbleAxis.x, tumbleAxis.y, tumbleAxis.z, spin)
    }
    triggerHaptic(.light)
  }

  private func finishRoll() {
    scnView.isPlaying = false
    scnView.rendersContinuously = false
    var results: [Int] = []
    for (i, die) in diceNodes.enumerated() {
      results.append(faceUpValue(die, faces: diceFaces[i]))
    }
    triggerHaptic(.medium)
    if suppressNextSettle {
      suppressNextSettle = false
      return
    }
    onSettled([
      "results": results,
      "total": results.reduce(0, +),
    ])
  }

  private func faceUpValue(_ die: SCNNode, faces: [(SIMD3<Float>, Int)]) -> Int {
    let world = die.presentation.simdWorldTransform
    let rotation = simd_float3x3(
      SIMD3(world.columns.0.x, world.columns.0.y, world.columns.0.z),
      SIMD3(world.columns.1.x, world.columns.1.y, world.columns.1.z),
      SIMD3(world.columns.2.x, world.columns.2.y, world.columns.2.z)
    )
    var bestDot = -Float.greatestFiniteMagnitude
    var value = faces.first?.1 ?? 0
    for (normal, faceValue) in faces {
      let worldNormal = simd_normalize(rotation * normal)
      if worldNormal.y > bestDot {
        bestDot = worldNormal.y
        value = faceValue
      }
    }
    return value
  }

  // MARK: - Haptics (no-op on iPad, felt on iPhone)
  private func triggerHaptic(_ style: UIImpactFeedbackGenerator.FeedbackStyle) {
    DispatchQueue.main.async {
      let generator = UIImpactFeedbackGenerator(style: style)
      generator.prepare()
      generator.impactOccurred()
    }
  }
}

// MARK: - Settle detection
extension SceneDiceView: SCNSceneRendererDelegate {
  func renderer(_ renderer: SCNSceneRenderer, updateAtTime time: TimeInterval) {
    // While held, spin each die/coin in place (random face ends up up) and keep
    // it pinned under the finger; zero physics so contacts can't nudge it.
    if dragging {
      let dt: Float = lastDragTime == 0 ? Float(1.0 / 60.0) : Float(min(0.05, time - lastDragTime))
      lastDragTime = time
      for (i, die) in diceNodes.enumerated() {
        if i < heldAngle.count {
          heldAngle[i] += heldSpinRate[i] * dt
          let axis = i < heldSpinAxis.count ? heldSpinAxis[i] : SIMD3<Float>(0, 1, 0)
          die.simdOrientation = simd_quatf(angle: heldAngle[i], axis: axis)
        }
        if i < heldTarget.count { die.simdPosition = heldTarget[i] }
        die.physicsBody?.resetTransform()
        die.physicsBody?.velocity = SCNVector3Zero
        die.physicsBody?.angularVelocity = SCNVector4Zero
      }
      return
    }
    guard rolling else { return }

    var moving = false
    for die in diceNodes {
      guard let body = die.physicsBody else { continue }
      let v = body.velocity
      let speed = sqrt(v.x * v.x + v.y * v.y + v.z * v.z)
      let spin = abs(body.angularVelocity.w)
      if speed > 0.08 || spin > 0.18 {
        moving = true
        break
      }
    }

    let elapsed = time - rollStartTime
    if moving && elapsed < 6.0 {
      stillFrames = 0
      return
    }

    stillFrames += 1
    if stillFrames >= 12 || elapsed >= 6.0 {
      rolling = false
      stillFrames = 0
      DispatchQueue.main.async { [weak self] in
        self?.finishRoll()
      }
    }
  }
}

// MARK: - Hex color parsing
private extension UIColor {
  convenience init?(hexString: String) {
    var hex = hexString.trimmingCharacters(in: .whitespacesAndNewlines)
    if hex.hasPrefix("#") { hex.removeFirst() }
    guard hex.count == 6, let value = UInt32(hex, radix: 16) else { return nil }
    let r = CGFloat((value >> 16) & 0xFF) / 255.0
    let g = CGFloat((value >> 8) & 0xFF) / 255.0
    let b = CGFloat(value & 0xFF) / 255.0
    self.init(red: r, green: g, blue: b, alpha: 1.0)
  }
}
