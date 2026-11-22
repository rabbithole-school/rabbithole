import CryptoKit
import ExpoModulesCore
import FileProvider
import Security
import UniformTypeIdentifiers

private let domainIdentifier = NSFileProviderDomainIdentifier("bunny-drive")
private let keychainService = "school.rabbithole.bunny-drive"
private let keychainAccount = "files-holder"

/// One walk's patience with iOS. A stuck save leaves every undelivered file's lookup
/// unanswered, so after the first the rest get a moment, or a card's worth of them
/// would run the rescue out of time.
private final class LookupLimit {
  var seconds: TimeInterval = 5
}

private struct Tally {
  var rescued = 0
  var unreadable = 0
  var blocked = 0
  /// Every path the walk found that the extension hasn't taken.
  var untaken: [String] = []
  /// Something couldn't be looked at, so `untaken` can't be the whole list.
  var incomplete = false
}

// The app's half of the Files location. It keeps no state and makes no decisions:
// src/lib/bunnyDrive/filesLocationRunner.ts says when to do each of these. The
// holder is JSON the extension reads from the shared keychain group, so writing
// it, including writing one with no token, is one atomic step.
public final class BunnyDriveFilesModule: Module {
  public func definition() -> ModuleDefinition {
    Name("BunnyDriveFiles")

    AsyncFunction("readHolder") { () -> String? in
      try Self.readHolder()
    }

    AsyncFunction("writeHolder") { (json: String) in
      try Self.writeHolder(json)
    }

    AsyncFunction("holderTag") { (holderKey: String) -> String in
      // The extension's own tag: `Holder.read` in FileProviderExtension.swift.
      SHA256.hash(data: Data(holderKey.utf8)).prefix(8).map { String(format: "%02x", $0) }.joined()
    }

    AsyncFunction("listSpool") { () -> [[String: Any]] in
      guard let directory = Self.spoolDirectory() else { return [] }
      // These calls run at once, and a removal's record taken aside mustn't look
      // like one left by a stopped app.
      Self.spoolLock.lock()
      defer { Self.spoolLock.unlock() }
      var names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
      // A removal that stopped with a record taken aside. Put it back first, or the
      // sweep would take a save nothing uploaded.
      let stray = names.filter { $0.hasSuffix(".taking") }
      for name in stray {
        let id = String(name.prefix { $0 != "." })
        Self.settleTaken(directory.appendingPathComponent(name), id: id, removing: nil, in: directory)
      }
      if !stray.isEmpty {
        names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
      }
      Self.sweepSpool(directory, names: names)
      return names.filter { $0.hasSuffix(".json") }.compactMap { name in
        (try? Data(contentsOf: directory.appendingPathComponent(name)))
          .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
      }
    }

    // A clone into Documents, where the upload queue keeps its files. The spool's
    // copy stays until the store confirms, because the extension still lists it.
    AsyncFunction("stageSpool") { (id: String, destination: URL) in
      guard let directory = Self.spoolDirectory() else {
        throw Exception(name: "ERR_BUNNY_DRIVE_SPOOL", description: "No App Group.")
      }
      let manager = FileManager.default
      try manager.createDirectory(
        at: destination.deletingLastPathComponent(),
        withIntermediateDirectories: true
      )
      if manager.fileExists(atPath: destination.path) {
        try manager.removeItem(at: destination)
      }
      try manager.copyItem(at: directory.appendingPathComponent(Self.dataName(directory, id)), to: destination)
    }

    // Only the version that was uploaded: an app can save over the file in place
    // after the caller listed it, and that newer save must stay. So the record is
    // taken aside in one step, checked, and put back if it's a newer one.
    AsyncFunction("removeSpool") { (id: String, sha256: String) in
      guard let directory = Self.spoolDirectory() else { return }
      let manager = FileManager.default
      let record = directory.appendingPathComponent("\(id).json")
      let taken = directory.appendingPathComponent("\(id).\(UUID().uuidString).taking")
      Self.spoolLock.lock()
      defer { Self.spoolLock.unlock() }
      guard rename(record.path, taken.path) == 0 else { return }
      Self.settleTaken(taken, id: id, removing: sha256, in: directory)
    }

    // Removing a domain takes anything iOS hasn't given the extension yet, and iOS
    // has no mode that keeps it. So this comes first. It ends when the extension
    // has taken every save, or not at all, which is why the caller bounds it.
    AsyncFunction("flushLocation") { (promise: Promise) in
      let domain = NSFileProviderDomain(identifier: domainIdentifier, displayName: "Bunny Drive")
      guard let manager = NSFileProviderManager(for: domain) else {
        promise.resolve(nil)
        return
      }
      manager.waitForChanges(below: .rootContainer) { error in
        if let error {
          NSLog("[BunnyDrive] flush: %@", error.localizedDescription)
        }
        promise.resolve(nil)
      }
    }

    // For saves iOS is still holding when the domain has to go. Only the app can
    // reach them: the extension never gets a user-visible URL. iOS's pending list
    // came back empty with a save stuck, and its uploaded flag said yes for one the
    // extension was still taking. So this reads My files and goes by the one thing
    // iOS can't get wrong: an item the extension took has our identifier. Each other
    // one goes into the spool under the folder's sign-in, the same record the
    // extension would have written, so a late delivery lands on the same one.
    AsyncFunction("rescueSaves") { () async throws -> [String: Int] in
      guard let (manager, directory, enabled) = try await Self.liveDomain(includingOff: true) else {
        return Self.nothing
      }
      // Turned off in Files isn't empty: a save can still be waiting in it. Not getting
      // in proves nothing, so that holds the hand-over too, until staff turn it back on.
      let root: URL
      do {
        root = try await manager.getUserVisibleURL(for: .rootContainer)
      } catch {
        if !enabled { NSLog("[BunnyDrive] rescue couldn't get into a turned-off location: %@", error.localizedDescription) }
        throw error
      }
      let found = try await Self.rescueSaves(root, directory)
      if !enabled { NSLog("[BunnyDrive] rescue of a turned-off location: %@", found.description) }
      return found
    }

    // For a reset that has to wait: iOS has no way to hide a domain, so while one
    // waits the next scholar could open whatever is downloaded in it. This takes
    // every downloaded copy that's safe elsewhere. Names stay listed, and with nobody
    // holding the iPad nothing can come back. The save being kept stays readable.
    AsyncFunction("evictTaken") { () async throws in
      guard let (manager, _) = try await Self.liveDomain() else { return }
      let root = try await manager.getUserVisibleURL(for: .rootContainer)
      let scoped = root.startAccessingSecurityScopedResource()
      defer { if scoped { root.stopAccessingSecurityScopedResource() } }
      if Self.isDataless(root) { return }
      await Self.evict(folder: root, manager: manager)
    }

    AsyncFunction("resetLocation") { (promise: Promise) in
      // Takes every listing, download and thumbnail request with it, because
      // those belong to the domain. Adding it back is what shows a location again.
      let domain = NSFileProviderDomain(identifier: domainIdentifier, displayName: "Bunny Drive")
      NSFileProviderManager.remove(domain, mode: .removeAll) { _, removeError in
        // Failing here matters: the next scholar's grant must not go in over this
        // scholar's listings. Only a domain that was never there is fine.
        if let removeError, !Self.isMissingDomain(removeError) {
          promise.reject("ERR_BUNNY_DRIVE_REMOVE", removeError.localizedDescription)
          return
        }
        if let directory = Self.spoolDirectory() {
          try? FileManager.default.removeItem(at: directory.appendingPathComponent(Self.notedPaths))
        }
        NSFileProviderManager.add(domain) { addError in
          if let addError {
            promise.reject("ERR_BUNNY_DRIVE_ADD", addError.localizedDescription)
          } else {
            promise.resolve(nil)
          }
        }
      }
    }

    AsyncFunction("signal") { (promise: Promise) in
      let domain = NSFileProviderDomain(identifier: domainIdentifier, displayName: "Bunny Drive")
      guard let manager = NSFileProviderManager(for: domain) else {
        promise.resolve(nil)
        return
      }
      manager.signalEnumerator(for: .workingSet) { error in
        if let error {
          NSLog("[BunnyDrive] signal: %@", error.localizedDescription)
        }
        promise.resolve(nil)
      }
    }
  }

  private static let nothing = ["rescued": 0, "unreadable": 0, "blocked": 0]

  private static func rescueSaves(_ root: URL, _ directory: URL) async throws -> [String: Int] {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let scoped = root.startAccessingSecurityScopedResource()
    defer { if scoped { root.stopAccessingSecurityScopedResource() } }
    if Self.isDataless(root) { return Self.nothing }
    // Sealed, only what the first walk noted is the owner's, and the rest was refused.
    // With no complete list this keeps everything: a save can land with the wrong
    // scholar, but none is lost. The list starts with this hold's name, so one
    // left by an earlier hand-over is never used.
    let noted = directory.appendingPathComponent(Self.notedPaths)
    let (sealed, hold) = try Self.currentHold()
    guard let (myFiles, tag) = try await Self.writableFolder(in: root) else { return Self.nothing }
    if Self.isDataless(myFiles) { return Self.nothing }
    let lines = sealed
      ? (try? String(contentsOf: noted, encoding: .utf8))?.components(separatedBy: "\n")
      : nil
    let owned = lines?.first == hold ? lines.map { Set($0.dropFirst()) } : nil
    let tally = await Self.rescue(
      folder: myFiles, path: "", tag: tag, into: directory, owned: owned
    )
    if !sealed, !tally.incomplete {
      try ([hold] + tally.untaken).joined(separator: "\n").write(to: noted, atomically: true, encoding: .utf8)
    }
    return ["rescued": tally.rescued, "unreadable": tally.unreadable, "blocked": tally.blocked]
  }

  /// The domain, if there's one that can hold anything. Never added, or turned off
  /// in Files, reads as nothing saved, which a first grant relies on; only the rescue
  /// asks for one that's off. One that's there and can't be reached throws.
  private static func liveDomain() async throws -> (NSFileProviderManager, URL)? {
    try await liveDomain(includingOff: false).map { ($0.0, $0.1) }
  }

  private static func liveDomain(includingOff: Bool) async throws -> (NSFileProviderManager, URL, Bool)? {
    let domains = try await NSFileProviderManager.domains()
    guard
      let domain = domains.first(where: { $0.identifier == domainIdentifier }),
      domain.userEnabled || includingOff
    else { return nil }
    guard let manager = NSFileProviderManager(for: domain), let directory = spoolDirectory() else {
      throw Exception(name: "ERR_BUNNY_DRIVE_DOMAIN", description: "Couldn't reach the location.")
    }
    return (manager, directory, domain.userEnabled)
  }

  /// My files in the domain's folder, with its sign-in. The server names the folder,
  /// so it's found by its identifier. A lookup that failed isn't an empty location,
  /// so that throws: an empty answer here lets the domain go with its saves.
  private static func writableFolder(in root: URL) async throws -> (URL, String)? {
    let children = try FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
    var unknown = false
    for child in children {
      let found = await identifier(of: child)
      if let raw = found, let marker = raw.range(of: ".d|files|") {
        return (child, String(raw[..<marker.lowerBound]))
      }
      if found == nil { unknown = true }
    }
    if unknown {
      throw Exception(name: "ERR_BUNNY_DRIVE_LOOKUP", description: "Couldn't identify a folder.")
    }
    return nil
  }

  private static func identifier(of url: URL, limit: LookupLimit = LookupLimit()) async -> String? {
    await withCheckedContinuation { done in
      // iOS can leave this unanswered with a save stuck, and one file can't hold up
      // the rest. No answer reads as no identifier: the file gets kept.
      let once = NSLock()
      var answered = false
      let answer = { (identifier: String?) in
        once.lock()
        defer { once.unlock() }
        if answered { return }
        answered = true
        done.resume(returning: identifier)
      }
      NSFileProviderManager.getIdentifierForUserVisibleFile(at: url) { identifier, _, _ in
        answer(identifier?.rawValue)
      }
      DispatchQueue.global().asyncAfter(deadline: .now() + limit.seconds) {
        limit.seconds = 0.25
        answer(nil)
      }
    }
  }

  private static let walkKeys: Set<URLResourceKey> = [.isDirectoryKey, .fileSizeKey]
  /// The extension's `Spool.maxBytes`. What it refused has a `.refused` mark naming the
  /// bytes, so its owner was told. Any other big file hasn't been refused yet: kept.
  private static let maxBytes = 500 * 1024 * 1024
  private static let notedPaths = "noted-paths.txt"

  private static func currentHold() throws -> (sealed: Bool, hold: String) {
    guard
      let data = try readHolder()?.data(using: .utf8),
      let holder = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return (false, "") }
    return (holder["sealed"] as? Bool == true, holder["hold"] as? String ?? "")
  }

  /// Nothing on the iPad but a name. Touching one asks the extension, which has
  /// nobody to answer for at a hand-over, so a listing or read just hangs. iOS's
  /// downloading status doesn't say this: a folder can read as anything.
  private static func wasRefusedForSize(_ file: URL, path: String, tag: String, in directory: URL) -> Bool {
    let mark = directory.appendingPathComponent("\(recordId(tag: tag, path: path)).refused")
    guard let refused = try? String(contentsOf: mark, encoding: .utf8) else { return false }
    return (try? sha256(file)) == refused
  }

  private static func isDataless(_ url: URL) -> Bool {
    let SF_DATALESS: UInt32 = 0x4000_0000
    var info = stat()
    return lstat(url.path, &info) == 0 && info.st_flags & SF_DATALESS != 0
  }

  private static func isTaken(_ id: String) -> Bool {
    id.contains(".f|") || id.contains(".d|")
  }

  /// One level at a time, past anything dataless: nothing unsaved can be inside it.
  private static func rescue(
    folder: URL,
    path: String,
    tag: String,
    into directory: URL,
    owned: Set<String>? = nil,
    limit: LookupLimit = LookupLimit()
  ) async -> Tally {
    var tally = Tally()
    let children: [URL]
    do {
      children = try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: Array(walkKeys))
    } catch {
      // Says nothing about what's inside, so the reset has to wait for it.
      NSLog("[BunnyDrive] rescue: %@", error.localizedDescription)
      tally.blocked += 1
      tally.incomplete = true
      return tally
    }
    for child in children where !isDataless(child) {
      // Unknown means it could be a folder with anything inside, so nothing here
      // can say the location is safe to remove.
      guard
        let values = try? child.resourceValues(forKeys: walkKeys),
        let isDirectory = values.isDirectory
      else {
        tally.blocked += 1
        tally.incomplete = true
        continue
      }
      let name = child.lastPathComponent.precomposedStringWithCanonicalMapping
      let childPath = path.isEmpty ? name : "\(path)/\(name)"
      // A save iOS hasn't delivered can have no identifier at all. A lookup that just
      // failed looks the same, and keeping that file again costs nothing.
      let id = await identifier(of: child, limit: limit)
      let taken = id.map(isTaken) ?? false
      // Not noted means the extension refused it, so its owner was told. A folder is
      // walked anyway: a failed lookup looks the same, and what's noted can be inside.
      let refused = !taken
        && (owned?.contains(childPath) == false
          || ((values.fileSize ?? 0) > maxBytes && wasRefusedForSize(child, path: childPath, tag: tag, in: directory)))
      if !taken, !refused { tally.untaken.append(childPath) }
      if isDirectory {
        if !taken, !refused {
          keep(nil, path: "\(childPath)/.bunny-folder", tag: tag, into: directory, tally: &tally)
        }
        let inside = await rescue(
          folder: child, path: childPath, tag: tag, into: directory, owned: owned, limit: limit
        )
        tally.rescued += inside.rescued
        tally.unreadable += inside.unreadable
        tally.blocked += inside.blocked
        tally.untaken += inside.untaken
        tally.incomplete = tally.incomplete || inside.incomplete
      } else if !taken, !refused {
        keep(child, path: childPath, tag: tag, into: directory, tally: &tally)
      }
    }
    return tally
  }

  private static func evict(folder: URL, manager: NSFileProviderManager) async {
    let children = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: Array(walkKeys))) ?? []
    for child in children where !isDataless(child) {
      let values = try? child.resourceValues(forKeys: walkKeys)
      if values?.isDirectory == true {
        await evict(folder: child, manager: manager)
      } else if let id = await identifier(of: child), isTaken(id) {
        do {
          try await manager.evictItem(identifier: NSFileProviderItemIdentifier(id))
        } catch {
          NSLog("[BunnyDrive] evict: %@", error.localizedDescription)
        }
      }
    }
  }

  private static func keep(
    _ source: URL?,
    path: String,
    tag: String,
    into directory: URL,
    tally: inout Tally
  ) {
    let files = FileManager.default
    let bytes = directory.appendingPathComponent("\(UUID().uuidString).data")
    do {
      if let source {
        var failure: NSError?
        var copied: Error?
        NSFileCoordinator().coordinate(readingItemAt: source, options: [], error: &failure) { url in
          do { try files.copyItem(at: url, to: bytes) } catch { copied = error }
        }
        if let problem = failure ?? copied.map({ $0 as NSError }) { throw problem }
      } else {
        files.createFile(atPath: bytes.path, contents: nil)
      }
      let hash = try sha256(bytes)
      let size = (try files.attributesOfItem(atPath: bytes.path)[.size] as? NSNumber)?.int64Value ?? 0
      let type = source.flatMap { UTType(filenameExtension: $0.pathExtension)?.preferredMIMEType?.lowercased() }
      var kept = path
      // Twice at most: this name, then the other one. A third pass means something
      // holds a name it shouldn't, which is no reason to spin.
      for _ in 0..<3 {
        let id = recordId(tag: tag, path: kept)
        if let earlier = readRecord(directory, id) {
          if earlier["sha256"] as? String == hash {
            try files.removeItem(at: bytes)
            return
          }
          // A different file already holds this name. Both stay.
          let name = path as NSString
          let suffix = name.pathExtension.isEmpty ? "" : ".\(name.pathExtension)"
          kept = "\(name.deletingPathExtension) recovered \(hash.prefix(6))\(suffix)"
          continue
        }
        let record: [String: Any] = [
          "id": id, "tag": tag, "path": kept, "sha256": hash, "byteSize": size,
          "contentType": type ?? "application/octet-stream",
          "capturedAt": Date().timeIntervalSince1970 * 1000,
          "data": bytes.lastPathComponent,
        ]
        let published = try publish(
          JSONSerialization.data(withJSONObject: record),
          as: directory.appendingPathComponent("\(id).json")
        )
        if published {
          tally.rescued += 1
          return
        }
      }
      throw CocoaError(.fileWriteFileExists)
    } catch {
      NSLog("[BunnyDrive] rescue: %@", error.localizedDescription)
      try? files.removeItem(at: bytes)
      // The difference that decides whether the domain may ever go.
      if let source, readFails(source) {
        tally.unreadable += 1
      } else {
        tally.blocked += 1
      }
    }
  }

  /// True only for a read that was made and failed, end to end: damage can sit past
  /// the first byte. Not getting as far as reading proves nothing about the file.
  private static func readFails(_ source: URL) -> Bool {
    var fails = false
    var failure: NSError?
    NSFileCoordinator().coordinate(readingItemAt: source, options: [], error: &failure) { url in
      do {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        while try autoreleasepool(invoking: { try handle.read(upToCount: 1 << 20)?.isEmpty == false }) {}
      } catch {
        fails = true
      }
    }
    return fails
  }

  // The extension's own `Spool.publish`: linking can't overwrite, as a move can.
  private static func publish(_ record: Data, as url: URL) throws -> Bool {
    let temporary = url.deletingLastPathComponent().appendingPathComponent("\(UUID().uuidString).tmp")
    try record.write(to: temporary)
    defer { try? FileManager.default.removeItem(at: temporary) }
    if link(temporary.path, url.path) == 0 { return true }
    if errno == EEXIST { return false }
    throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
  }

  /// A record's bytes. Records from before unique names used the record's own.
  private static func dataName(_ directory: URL, _ id: String) -> String {
    readRecord(directory, id)?["data"] as? String ?? "\(id).data"
  }

  private static func readRecord(_ directory: URL, _ id: String) -> [String: Any]? {
    (try? Data(contentsOf: directory.appendingPathComponent("\(id).json")))
      .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
  }

  // The extension's own record name and hash: `Spool` in FileProviderExtension.swift.
  private static func recordId(tag: String, path: String) -> String {
    String(hex(SHA256.hash(data: Data("\(tag)\n\(path)".utf8))).prefix(32))
  }

  private static func sha256(_ url: URL) throws -> String {
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    var hasher = SHA256()
    var more = true
    while more {
      try autoreleasepool {
        let data = try handle.read(upToCount: 1024 * 1024) ?? Data()
        more = !data.isEmpty
        hasher.update(data: data)
      }
    }
    return hex(hasher.finalize())
  }

  private static func hex<Digest: Sequence>(_ digest: Digest) -> String where Digest.Element == UInt8 {
    digest.map { String(format: "%02x", $0) }.joined()
  }

  /// Serializes the app's own spool calls. The extension never takes a record aside.
  private static let spoolLock = NSLock()

  /// Ends a removal: deletes the taken record and its bytes if they're the version
  /// being removed, and otherwise puts it back. If a newer save has written the
  /// record since, that one wins and the taken one's bytes go.
  private static func settleTaken(_ taken: URL, id: String, removing sha256: String?, in directory: URL) {
    let manager = FileManager.default
    let held = (try? Data(contentsOf: taken))
      .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
    let bytes = (held?["data"] as? String) ?? "\(id).data"
    if let sha256, held?["sha256"] as? String == sha256 {
      // The record first: a record with no bytes is the one state nothing handles.
      try? manager.removeItem(at: taken)
      try? manager.removeItem(at: directory.appendingPathComponent(bytes))
      return
    }
    // Linking can't overwrite a newer record, as a move would.
    if link(taken.path, directory.appendingPathComponent("\(id).json").path) != 0, errno == EEXIST {
      try? manager.removeItem(at: taken)
      try? manager.removeItem(at: directory.appendingPathComponent(bytes))
      return
    }
    try? manager.removeItem(at: taken)
  }

  // Files no record points at: a save the extension didn't finish, which iOS retries
  // under a new name, or a removal cut short. Old enough that no save is still on it.
  private static func sweepSpool(_ directory: URL, names: [String]) {
    let manager = FileManager.default
    let ids = names.filter { $0.hasSuffix(".json") }.map { ($0 as NSString).deletingPathExtension }
    let referenced = Set(ids.map { dataName(directory, $0) })
    let cutoff = Date(timeIntervalSinceNow: -24 * 60 * 60)
    for name in names where !name.hasSuffix(".json") && !referenced.contains(name) && name != notedPaths {
      let url = directory.appendingPathComponent(name)
      let modified = try? manager.attributesOfItem(atPath: url.path)[.modificationDate] as? Date
      if let modified, modified < cutoff {
        try? manager.removeItem(at: url)
      }
    }
  }

  private static func spoolDirectory() -> URL? {
    guard
      let group = Bundle.main.object(forInfoDictionaryKey: "BunnyDriveAppGroup") as? String,
      let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
    else { return nil }
    return container.appendingPathComponent("bunny-drive-spool", isDirectory: true)
  }

  private static func isMissingDomain(_ error: Error) -> Bool {
    let nsError = error as NSError
    if nsError.domain == NSCocoaErrorDomain && nsError.code == NSFileNoSuchFileError {
      return true
    }
    if #available(iOS 17.1, *) {
      return nsError.domain == NSFileProviderErrorDomain
        && nsError.code == NSFileProviderError.providerDomainNotFound.rawValue
    }
    return false
  }

  private static func baseQuery() throws -> [String: Any] {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "BunnyDriveKeychainGroup") as? String else {
      throw Exception(name: "ERR_BUNNY_DRIVE_GROUP", description: "No keychain group in Info.plist.")
    }
    return [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: keychainService,
      kSecAttrAccount as String: keychainAccount,
      kSecAttrAccessGroup as String: group,
    ]
  }

  private static func readHolder() throws -> String? {
    var query = try baseQuery()
    query[kSecReturnData as String] = true
    var result: AnyObject?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = result as? Data else {
      throw Exception(name: "ERR_BUNNY_DRIVE_KEYCHAIN", description: "Keychain read failed: \(status).")
    }
    return String(data: data, encoding: .utf8)
  }

  private static func writeHolder(_ json: String) throws {
    let query = try baseQuery()
    let data = Data(json.utf8)
    let update = [kSecValueData as String: data] as CFDictionary
    var status = SecItemUpdate(query as CFDictionary, update)
    if status == errSecItemNotFound {
      var add = query
      add[kSecValueData as String] = data
      // The extension runs when Files asks, which can be with the app closed.
      add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
      status = SecItemAdd(add as CFDictionary, nil)
    }
    guard status == errSecSuccess else {
      throw Exception(name: "ERR_BUNNY_DRIVE_KEYCHAIN", description: "Keychain write failed: \(status).")
    }
  }
}
