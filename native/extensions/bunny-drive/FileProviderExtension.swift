import CryptoKit
import FileProvider
import Security
import UniformTypeIdentifiers

// The Bunny Drive location in Files: a view of what the store holds for whoever
// holds this iPad. This process has no session and no JS. It reads a grant the app
// leaves in the shared keychain group, and asks convex/bunnyDriveFiles.ts for
// everything, which is where the tree and every access decision live.
//
// SAVING IS LOCAL, then the app uploads. My files is the one place that takes new
// files, and the server says which folders those are. A saved file is copied into
// the spool in the App Group, outside the domain, tagged with the sign-in of the
// folder it was saved to, and iOS is told it's done. So a save works offline and
// doesn't depend on who holds the iPad next:
//  - A hand-over removes the domain with everything in it, and the spool isn't in
//    it. The app has the file and uploads it with the owner's own token.
//  - The tag is the folder's, not the current holder's, so a file iOS delivers
//    late can't land on the next scholar.
//  - Only the same tag lists a spooled file, so the next scholar never sees it.
// filesSpoolRunner.ts does the rest, and removes a file once the store confirms it.
//
// ONE SCHOLAR NEVER SEES ANOTHER'S FILES, from three directions:
//  - The server checks every call against who holds the iPad now, so a reassign
//    ends the grant even if the app hasn't run. Then this lists nothing.
//  - At a hand-over the app removes the domain, which takes iOS's listings and
//    downloaded copies with it, and doesn't serve anything until that's done.
//  - Every identifier carries a tag of the sign-in, so one that outlives all of
//    that resolves to nothing for the next scholar.
// One gap, which nothing here can close: iOS doesn't wake this process for what
// it already holds, so a copy already on the iPad stays visible until Rabbithole
// next runs. Files can't be reached under the lock, which is what bounds that.
//
// MEMORY. iOS gives an extension about 20 MB, by developers' reports. So nothing
// is cached here: lists arrive a page at a time and go straight to iOS, downloads
// stream to disk, and images are never decoded, which is why there's no thumbnail
// provider. Files makes its own once a file is downloaded.
//
// REMOTE CHANGES. The app signals the working set when it comes and goes, and the
// change feed answers. There's no push: a scholar reaches Files from Rabbithole.
final class FileProviderExtension: NSObject, NSFileProviderReplicatedExtension {
  private let manager: NSFileProviderManager?

  required init(domain: NSFileProviderDomain) {
    manager = NSFileProviderManager(for: domain)
    super.init()
  }

  func invalidate() {}

  func item(
    for identifier: NSFileProviderItemIdentifier,
    request: NSFileProviderRequest,
    completionHandler: @escaping (NSFileProviderItem?, Error?) -> Void
  ) -> Progress {
    if identifier == .rootContainer {
      completionHandler(RootItem(), nil)
      return Progress()
    }
    guard let (holder, id) = Drive.resolve(identifier) else {
      completionHandler(nil, NSFileProviderError(.noSuchItem))
      return Progress()
    }
    return cancellable {
      do {
        let found: Entry? = try await Drive.call(holder, "item", ["id": id])
        guard let entry = found ?? Spool.entry(id: id, tag: holder.tag) else {
          throw NSFileProviderError(.noSuchItem)
        }
        completionHandler(DriveItem(entry, tag: holder.tag), nil)
      } catch {
        completionHandler(nil, Drive.providerError(error))
      }
    }
  }

  func fetchContents(
    for itemIdentifier: NSFileProviderItemIdentifier,
    version requestedVersion: NSFileProviderItemVersion?,
    request: NSFileProviderRequest,
    completionHandler: @escaping (URL?, NSFileProviderItem?, Error?) -> Void
  ) -> Progress {
    guard let (holder, id) = Drive.resolve(itemIdentifier), let manager else {
      completionHandler(nil, nil, NSFileProviderError(.noSuchItem))
      return Progress()
    }
    return cancellable {
      do {
        let found: Download? = try await Drive.call(holder, "download", ["id": id])
        guard let found else {
          // Saved here and not uploaded yet. The call above proved the holder.
          let (file, entry) = try Spool.contents(id: id, tag: holder.tag)
          let copy = try manager.temporaryDirectoryURL().appendingPathComponent(UUID().uuidString)
          try FileManager.default.copyItem(at: file, to: copy)
          completionHandler(copy, DriveItem(entry, tag: holder.tag), nil)
          return
        }
        // To disk, not into memory: a film's frame or a video can pass the limit.
        let (temporary, response) = try await Drive.session.download(
          for: try Drive.downloadRequest(holder, id: id, directURL: found.url)
        )
        let status = (response as? HTTPURLResponse)?.statusCode
        if status == 401 { throw DriveError.ended }
        guard status == 200 else { throw NSFileProviderError(.serverUnreachable) }
        let directory = try manager.temporaryDirectoryURL()
        let destination = directory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.moveItem(at: temporary, to: destination)
        // The hand-over can land during a long download, and the copy goes to iOS,
        // so the server gets asked again before it does.
        do {
          let _: Entry? = try await Drive.call(holder, "item", ["id": id])
        } catch {
          try? FileManager.default.removeItem(at: destination)
          throw error
        }
        guard Holder.read()?.tag == holder.tag else {
          try? FileManager.default.removeItem(at: destination)
          throw NSFileProviderError(.notAuthenticated)
        }
        completionHandler(destination, DriveItem(found.entry, tag: holder.tag), nil)
      } catch {
        completionHandler(nil, nil, Drive.providerError(error))
      }
    }
  }

  // Only into My files. Takes no holder: the parent's tag says whose this is, and
  // iOS can deliver a save after the hand-over has started. Once a reset that's
  // waiting is sealed, this refuses everything: a late delivery is safe where it
  // sits, because the rescue reads it, and anything else is the next scholar
  // writing into the last one's folder.
  func createItem(
    basedOn itemTemplate: NSFileProviderItem,
    fields: NSFileProviderItemFields,
    contents url: URL?,
    options: NSFileProviderCreateItemOptions = [],
    request: NSFileProviderRequest,
    completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void
  ) -> Progress {
    guard
      let target = Spool.target(
        parent: itemTemplate.parentItemIdentifier,
        filename: itemTemplate.filename
      )
    else {
      completionHandler(nil, [], false, CocoaError(.fileWriteInvalidFileName))
      return Progress()
    }
    if Holder.isSealed() {
      completionHandler(nil, [], false, CocoaError(.fileWriteNoPermission))
      return Progress()
    }
    let type = itemTemplate.contentType ?? UTType(filenameExtension: (target.name as NSString).pathExtension)
    let isFolder = type?.conforms(to: .folder) ?? false
    let modified = itemTemplate.contentModificationDate ?? nil
    return cancellable {
      do {
        let id = isFolder ? "d|files|\(target.path)" : "f|files|\(target.path)"
        if let holder = Holder.read(), holder.tag == target.tag {
          // Best effort: offline, a clash waits for the store, which keeps both.
          let known: Entry?? = try? await Drive.call(holder, "item", ["id": id], timeout: 5)
          if let entry = known ?? nil {
            // A retry of this same save is done. Anything else is a real clash, and
            // telling iOS it's saved would let it evict the only copy.
            let same = try options.contains(.mayAlreadyExist)
              && url.map { try Spool.sha256($0) == entry.contentVersion } == true
            guard isFolder || same else {
              throw NSError.fileProviderErrorForCollision(with: DriveItem(entry, tag: target.tag))
            }
            completionHandler(DriveItem(entry, tag: target.tag), [], false, nil)
            return
          }
        }
        // Again, since the lookup above can take seconds and the seal can land in them.
        if Holder.isSealed() { throw CocoaError(.fileWriteNoPermission) }
        let entry = try Spool.add(
          target,
          isFolder: isFolder,
          contents: url,
          contentType: type?.preferredMIMEType?.lowercased() ?? "application/octet-stream",
          capturedAt: (modified ?? Date()).timeIntervalSince1970 * 1000
        )
        completionHandler(DriveItem(entry, tag: target.tag), [], false, nil)
      } catch {
        // Hashed first: the file is iOS's again once the error has gone back.
        let tooBig = (error as? NSFileProviderError)?.code == .insufficientQuota
        let hash = tooBig ? url.flatMap { try? Spool.sha256($0) } : nil
        completionHandler(nil, [], false, error)
        if let hash { Spool.noteRefused(target, sha256: hash) }
      }
    }
  }

  // Bookkeeping, a folder's first name, and an app saving over a file in My files.
  // Anything else in the store stays as it is.
  func modifyItem(
    _ item: NSFileProviderItem,
    baseVersion version: NSFileProviderItemVersion,
    changedFields: NSFileProviderItemFields,
    contents newContents: URL?,
    options: NSFileProviderModifyItemOptions = [],
    request: NSFileProviderRequest,
    completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void
  ) -> Progress {
    // Opening a file changes `lastUsedDate`, and a copy can carry its dates. iOS
    // keeps those for itself and still sends them here. Refusing one reads as a
    // failed upload: the file shows Upload Error and iOS keeps retrying. Only these
    // three would need the store.
    let stored: NSFileProviderItemFields = [.contents, .filename, .parentItemIdentifier]
    if changedFields.contains(.contents) {
      return saveOver(item, changedFields: changedFields, contents: newContents, completionHandler: completionHandler)
    }
    if stored.isDisjoint(with: changedFields) {
      completionHandler(item, [], false, nil)
    } else if changedFields.isDisjoint(with: [.contents, .parentItemIdentifier]), !Holder.isSealed(),
      let target = Spool.target(parent: item.parentItemIdentifier, filename: item.filename),
      let renamed = Spool.renameIdentifier(item.itemIdentifier, to: target) {
      completionHandler(DriveItem(renamed, tag: target.tag), [], false, nil)
    } else {
      completionHandler(nil, [], false, CocoaError(.featureUnsupported))
    }
    return Progress()
  }

  // An app saving over a file in My files. It goes up as a new version of the
  // same path, by the same rules as a new save: sealed refuses, and the folder's
  // tag says whose it is. A save that also renames or moves is refused: the old
  // name would stay in the store beside the new one.
  private func saveOver(
    _ item: NSFileProviderItem,
    changedFields: NSFileProviderItemFields,
    contents: URL?,
    completionHandler: @escaping (NSFileProviderItem?, NSFileProviderItemFields, Bool, Error?) -> Void
  ) -> Progress {
    let raw = item.itemIdentifier.rawValue
    guard
      changedFields.isDisjoint(with: [.filename, .parentItemIdentifier]),
      let contents,
      let dot = raw.firstIndex(of: "."),
      raw[raw.index(after: dot)...].hasPrefix("f|files|"),
      let target = Spool.target(parent: item.parentItemIdentifier, filename: item.filename)
    else {
      completionHandler(nil, [], false, CocoaError(.featureUnsupported))
      return Progress()
    }
    if Holder.isSealed() {
      completionHandler(nil, [], false, CocoaError(.fileWriteNoPermission))
      return Progress()
    }
    let type = item.contentType ?? UTType(filenameExtension: (target.name as NSString).pathExtension)
    // A save over a file is a new edit, so it's never older than now: a file with
    // a future date, or an iPad with a fast clock, mustn't keep it from being latest.
    let modified = max((item.contentModificationDate ?? nil) ?? Date(), Date())
    return cancellable {
      do {
        let entry = try Spool.add(
          target,
          isFolder: false,
          contents: contents,
          contentType: type?.preferredMIMEType?.lowercased() ?? "application/octet-stream",
          capturedAt: modified.timeIntervalSince1970 * 1000,
          replacing: true
        )
        completionHandler(DriveItem(entry, tag: target.tag), [], false, nil)
      } catch {
        let tooBig = (error as? NSFileProviderError)?.code == .insufficientQuota
        let hash = tooBig ? (try? Spool.sha256(contents)) : nil
        completionHandler(nil, [], false, error)
        if let hash { Spool.noteRefused(target, sha256: hash) }
      }
    }
  }

  // Only in My files, and only by the holder whose folder it is. Sealed means a
  // hand-over or no upload token, and then nothing changes. The store goes first:
  // if it can't be reached the item stays, and iOS asks again.
  func deleteItem(
    identifier: NSFileProviderItemIdentifier,
    baseVersion version: NSFileProviderItemVersion,
    options: NSFileProviderDeleteItemOptions = [],
    request: NSFileProviderRequest,
    completionHandler: @escaping (Error?) -> Void
  ) -> Progress {
    let raw = identifier.rawValue
    guard let dot = raw.firstIndex(of: "."), DriveItem.isDeletable(String(raw[raw.index(after: dot)...])) else {
      completionHandler(CocoaError(.featureUnsupported))
      return Progress()
    }
    let tag = String(raw[..<dot])
    let id = String(raw[raw.index(after: dot)...])
    if Holder.isSealed() {
      completionHandler(CocoaError(.fileWriteNoPermission))
      return Progress()
    }
    guard let holder = Holder.read(), holder.tag == tag else {
      completionHandler(NSFileProviderError(.notAuthenticated))
      return Progress()
    }
    return cancellable {
      do {
        let _: Bool? = try await Drive.call(holder, "remove", ["id": id])
        // So a save still waiting here doesn't upload it again.
        Spool.remove(id: id, tag: tag)
        completionHandler(nil)
      } catch DriveError.refused {
        // Not something this sign-in can delete. Unsupported stops iOS retrying.
        completionHandler(CocoaError(.featureUnsupported))
      } catch {
        completionHandler(Drive.providerError(error))
      }
    }
  }

  func enumerator(
    for containerItemIdentifier: NSFileProviderItemIdentifier,
    request: NSFileProviderRequest
  ) throws -> NSFileProviderEnumerator {
    switch containerItemIdentifier {
    case .rootContainer:
      return Enumerator(folderId: "root")
    case .workingSet:
      return Enumerator(folderId: nil, carriesRoot: true)
    case .trashContainer:
      return Enumerator(folderId: nil)
    default:
      guard let (_, id) = Drive.resolve(containerItemIdentifier) else {
        throw NSFileProviderError(.noSuchItem)
      }
      return Enumerator(folderId: id)
    }
  }

  private func cancellable(_ work: @escaping () async -> Void) -> Progress {
    let progress = Progress(totalUnitCount: 1)
    let task = Task {
      await work()
      progress.completedUnitCount = 1
    }
    progress.cancellationHandler = { task.cancel() }
    return progress
  }
}

// What the app leaves in the shared keychain group. No token means nobody holds
// this iPad, or a hand-over is part way through.
private struct Holder: Decodable {
  let convexUrl: String?
  let token: String?
  let deviceId: String?
  let holderKey: String?
  let sealed: Bool?

  /// A keychain that won't answer counts: refusing costs a retry, and accepting
  /// could file the next scholar's work under the last one.
  static func isSealed() -> Bool {
    var failed = false
    guard let data = stored(failed: &failed) else { return failed }
    return (try? JSONDecoder().decode(Holder.self, from: data))?.sealed == true
  }

  private static func stored(failed: inout Bool) -> Data? {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "BunnyDriveKeychainGroup") as? String else {
      return nil
    }
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "school.rabbithole.bunny-drive",
      kSecAttrAccount as String: "files-holder",
      kSecAttrAccessGroup as String: group,
      kSecReturnData as String: true,
    ]
    var result: AnyObject?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    failed = status != errSecSuccess && status != errSecItemNotFound
    return status == errSecSuccess ? result as? Data : nil
  }

  static func read() -> Live? {
    var failed = false
    guard
      let data = stored(failed: &failed),
      let holder = try? JSONDecoder().decode(Holder.self, from: data),
      let convexUrl = holder.convexUrl,
      let token = holder.token,
      let deviceId = holder.deviceId,
      let holderKey = holder.holderKey
    else { return nil }
    let digest = SHA256.hash(data: Data(holderKey.utf8))
    let tag = digest.prefix(8).map { String(format: "%02x", $0) }.joined()
    return Live(convexUrl: convexUrl, token: token, deviceId: deviceId, tag: tag)
  }

  struct Live {
    let convexUrl: String
    let token: String
    let deviceId: String
    let tag: String
  }
}

private struct Entry: Decodable {
  let id: String
  let parentId: String
  let name: String
  let isFolder: Bool
  let byteSize: Int64?
  let contentType: String?
  let contentVersion: String
  let metadataVersion: String
  let createdAt: Double?
  let modifiedAt: Double?
  /// Files may add to this folder. Absent from a server that predates My files.
  var writable: Bool? = nil
}

private struct Listing: Decodable {
  let entries: [Entry]
  let nextCursor: String?
}

private struct Download: Decodable {
  /// Only for a file too big for the download route.
  let url: String?
  let entry: Entry
}

private struct Changes: Decodable {
  let entries: [Entry]
  /// Deleted from My files on another iPad. Absent from a server without deletes.
  var deleted: [String]? = nil
  let anchor: String
  let more: Bool
  let expired: Bool
}

private enum DriveError: Error {
  /// The grant is over: this iPad's holder changed, or nobody holds it.
  case ended
  /// The store answered and said no, so asking again gets the same answer.
  case refused
  case failed
}

private enum Drive {
  // Ephemeral, so no request or response lands in a URL cache on disk.
  static let session = URLSession(configuration: .ephemeral)

  private struct Response<Value: Decodable>: Decodable {
    let status: String
    let value: Value?
    let errorData: ErrorData?
  }

  private struct ErrorData: Decodable {
    let kind: String?
  }

  /// The holder, and the server's id, for an identifier of this sign-in.
  static func resolve(_ identifier: NSFileProviderItemIdentifier) -> (Holder.Live, String)? {
    guard let holder = Holder.read() else { return nil }
    let prefix = "\(holder.tag)."
    guard identifier.rawValue.hasPrefix(prefix) else { return nil }
    return (holder, String(identifier.rawValue.dropFirst(prefix.count)))
  }

  static func call<Value: Decodable>(
    _ holder: Holder.Live,
    _ function: String,
    _ args: [String: Any?],
    timeout: TimeInterval = 60
  ) async throws -> Value? {
    guard let url = URL(string: "\(holder.convexUrl)/api/mutation") else { throw DriveError.failed }
    var body = args.mapValues { $0 ?? NSNull() }
    body["token"] = holder.token
    body["deviceId"] = holder.deviceId
    var request = URLRequest(url: url, timeoutInterval: timeout)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: [
      "path": "bunnyDriveFiles:\(function)",
      "args": body,
      "format": "json",
    ])
    let (data, _) = try await session.data(for: request)
    let response = try JSONDecoder().decode(Response<Value>.self, from: data)
    if response.status == "success" { return response.value }
    switch response.errorData?.kind {
    case "files_grant_ended": throw DriveError.ended
    case .some: throw DriveError.refused
    case .none: throw DriveError.failed
    }
  }

  static func downloadRequest(
    _ holder: Holder.Live,
    id: String,
    directURL: String?
  ) throws -> URLRequest {
    if let directURL, let url = URL(string: directURL) { return URLRequest(url: url) }
    let site = holder.convexUrl.replacingOccurrences(of: ".convex.cloud", with: ".convex.site")
    guard let url = URL(string: "\(site)/bunny-drive/files/download") else { throw DriveError.failed }
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: [
      "token": holder.token, "deviceId": holder.deviceId, "id": id,
    ])
    return request
  }

  static func providerError(_ error: Error) -> Error {
    switch error {
    case DriveError.ended:
      return NSFileProviderError(.notAuthenticated)
    case is NSFileProviderError:
      return error
    default:
      return NSFileProviderError(.serverUnreachable)
    }
  }
}

// What Files saved and the store doesn't have yet. See the top of this file. A
// file is two files: bytes under a name of their own, then a record written last
// that points at them. So a record always has its bytes, even with the app rescuing
// the same path: each writes its own bytes, and whichever links its record first
// wins. A record's name comes from its sign-in and path, so one save doesn't read
// every other: a card holds thousands. filesSpoolRunner.ts reads these through the
// app's module, which also sweeps bytes an interrupted save left behind.
private enum Spool {
  // What the store can take. Past this its upload POST gets a 413 at Cloudflare,
  // measured to the byte, so a bigger save has to be refused here while the scholar
  // is looking: taken, it would read as saved and never arrive.
  private static let maxBytes: Int64 = 500 * 1024 * 1024
  private static let maxPathLength = 1024
  private static let folderMarker = ".bunny-folder"
  private static let writablePrefix = "d|files|"

  struct Target {
    let tag: String
    let folder: String
    let name: String
    var path: String { folder.isEmpty ? name : "\(folder)/\(name)" }
  }

  private struct Record: Codable {
    let id: String
    let tag: String
    let path: String
    let sha256: String
    let byteSize: Int64
    let contentType: String
    let capturedAt: Double
    /** The bytes' file. Records from before this named them after the record. */
    var data: String? = nil

    var dataName: String { data ?? "\(id).data" }
  }

  /** Where a save lands, or nil for a folder or a name the store wouldn't take. */
  static func target(parent: NSFileProviderItemIdentifier, filename: String) -> Target? {
    guard
      let dot = parent.rawValue.firstIndex(of: "."),
      parent.rawValue[dot...].hasPrefix(".\(writablePrefix)")
    else { return nil }
    let tag = String(parent.rawValue[..<dot])
    let folder = String(parent.rawValue[dot...].dropFirst(writablePrefix.count + 1))
    let name = filename.precomposedStringWithCanonicalMapping
    let forbidden = name.unicodeScalars.contains {
      $0.value < 0x20 || $0.value == 0x7f || $0 == "\\" || $0 == "/"
    }
    let target = Target(tag: tag, folder: folder, name: name)
    // A leading combining mark merges with the "/" or "|" before it, which every
    // path here relies on finding.
    guard
      !forbidden, !name.isEmpty, name.unicodeScalars.first?.properties.isGraphemeExtend == false, name != ".", name != "..", name != folderMarker,
      target.path.utf16.count + folderMarker.count < maxPathLength
    else { return nil }
    return target
  }

  /** The bytes are safe on return, however this process ends after. */
  static func add(
    _ target: Target,
    isFolder: Bool,
    contents: URL?,
    contentType: String,
    capturedAt: Double,
    // A save over a file already here: different bytes replace its record.
    replacing: Bool = false
  ) throws -> Entry {
    guard let directory else { throw CocoaError(.fileWriteUnknown) }
    let path = isFolder ? "\(target.path)/\(folderMarker)" : target.path
    let id = recordId(tag: target.tag, path: path)
    let bytes = directory.appendingPathComponent("\(UUID().uuidString).data")
    if !isFolder, let contents {
      if try contents.resourceValues(forKeys: [.isDirectoryKey]).isDirectory == true {
        throw CocoaError(.featureUnsupported)
      }
      // On one volume this is a clone: instant, and no second copy on disk.
      try FileManager.default.copyItem(at: contents, to: bytes)
    } else {
      FileManager.default.createFile(atPath: bytes.path, contents: nil)
    }
    do {
      let size = try fileSize(bytes)
      if size > maxBytes { throw NSFileProviderError(.insufficientQuota) }
      let hash = try sha256(bytes)
      let settled = { (earlier: Record) throws -> Entry in
        guard earlier.sha256 == hash else {
          throw NSError.fileProviderErrorForCollision(with: DriveItem(entry(file: earlier), tag: target.tag))
        }
        try FileManager.default.removeItem(at: bytes)
        return isFolder ? folderEntry(target.path, date: earlier.capturedAt) : entry(file: earlier)
      }
      let earlier = record(id: id)
      if let earlier, !(replacing && earlier.sha256 != hash) { return try settled(earlier) }
      // Last, since copying and hashing take time and the seal can land in it.
      if Holder.isSealed() { throw CocoaError(.fileWriteNoPermission) }
      let record = Record(
        id: id, tag: target.tag, path: path, sha256: hash, byteSize: size,
        contentType: isFolder ? "application/octet-stream" : contentType,
        capturedAt: capturedAt, data: bytes.lastPathComponent
      )
      if let earlier {
        // The old bytes' upload, if one is queued, finds no record for them and
        // is cancelled (filesSpoolRunner.ts), so only these go up.
        try replace(JSONEncoder().encode(record), as: directory.appendingPathComponent("\(id).json"))
        if earlier.dataName != record.dataName {
          try? FileManager.default.removeItem(at: directory.appendingPathComponent(earlier.dataName))
        }
        return entry(file: record)
      }
      let published = try publish(
        JSONEncoder().encode(record),
        as: directory.appendingPathComponent("\(id).json")
      )
      if !published {
        guard let earlier = Self.record(id: id) else { throw CocoaError(.fileWriteUnknown) }
        return try settled(earlier)
      }
      return isFolder ? folderEntry(target.path, date: capturedAt) : entry(file: record)
    } catch {
      try? FileManager.default.removeItem(at: bytes)
      throw error
    }
  }

  /**
   * New Folder creates "untitled folder" and renames it a moment later, so the name
   * a scholar types arrives here. Only for an empty folder still in the spool: the
   * store has no rename, and iOS would have to follow every child. Nil otherwise.
   */
  static func renameFolder(id: String, tag: String, to target: Target) throws -> Entry? {
    guard id.hasPrefix(writablePrefix), let directory else { return nil }
    let from = String(id.dropFirst(writablePrefix.count))
    guard from != target.path, record(id: recordId(tag: tag, path: "\(target.path)/\(folderMarker)")) == nil else {
      return nil
    }
    let inside = records(tag: tag).filter { $0.path.hasPrefix("\(from)/") }
    guard inside.count == 1, let old = inside.first, old.path == "\(from)/\(folderMarker)" else {
      return nil
    }
    let entry = try add(
      target, isFolder: true, contents: nil,
      contentType: "application/octet-stream", capturedAt: old.capturedAt
    )
    try? FileManager.default.removeItem(at: directory.appendingPathComponent("\(old.id).json"))
    try? FileManager.default.removeItem(at: directory.appendingPathComponent(old.dataName))
    return entry
  }

  /**
   * How the rescue knows a scholar was told this exact file was too big. Written
   * after the error went out and naming the bytes, so a crash or a new file at the
   * same name reads as not told, and the file is kept.
   */
  static func noteRefused(_ target: Target, sha256 hash: String) {
    guard let directory else { return }
    let mark = directory.appendingPathComponent("\(recordId(tag: target.tag, path: target.path)).refused")
    try? Data(hash.utf8).write(to: mark, options: .atomic)
  }

  /** Overwrites a record in one step: readers see the old one or the new, never neither. */
  private static func replace(_ record: Data, as url: URL) throws {
    let temporary = url.deletingLastPathComponent().appendingPathComponent("\(UUID().uuidString).tmp")
    try record.write(to: temporary)
    defer { try? FileManager.default.removeItem(at: temporary) }
    if rename(temporary.path, url.path) != 0 {
      throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
    }
  }

  /** False if a record is already there. Linking can't overwrite, as a move can. */
  private static func publish(_ record: Data, as url: URL) throws -> Bool {
    let temporary = url.deletingLastPathComponent().appendingPathComponent("\(UUID().uuidString).tmp")
    try record.write(to: temporary)
    defer { try? FileManager.default.removeItem(at: temporary) }
    if link(temporary.path, url.path) == 0 { return true }
    if errno == EEXIST { return false }
    throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
  }

  /** The folder's direct children, files and implied folders, not in `listed`. */
  static func children(of folderId: String, tag: String, excluding listed: Set<String>) -> [Entry] {
    guard folderId.hasPrefix(writablePrefix) else { return [] }
    let folder = String(folderId.dropFirst(writablePrefix.count))
    return entries(for: records(tag: tag), in: folder).filter { !listed.contains($0.id) }
  }

  /// What a delete leaves: no record of the file, or of anything in the folder.
  static func remove(id: String, tag: String) {
    guard let directory else { return }
    let path = String(id.dropFirst("f|files|".count))
    let gone = id.hasPrefix("d|")
      ? records(tag: tag).filter { $0.path.hasPrefix("\(path)/") }
      : record(id: recordId(tag: tag, path: path)).map { [$0] } ?? []
    for record in gone {
      try? FileManager.default.removeItem(at: directory.appendingPathComponent("\(record.id).json"))
      try? FileManager.default.removeItem(at: directory.appendingPathComponent(record.dataName))
    }
  }

  static func renameIdentifier(_ identifier: NSFileProviderItemIdentifier, to target: Target) -> Entry? {
    let prefix = "\(target.tag)."
    guard identifier.rawValue.hasPrefix(prefix) else { return nil }
    return try? renameFolder(id: String(identifier.rawValue.dropFirst(prefix.count)), tag: target.tag, to: target)
  }

  static func entry(id: String, tag: String) -> Entry? {
    if id.hasPrefix("f|files|") {
      return record(id: recordId(tag: tag, path: String(id.dropFirst(8)))).map(entry(file:))
    }
    guard id.hasPrefix(writablePrefix) else { return nil }
    let path = String(id.dropFirst(8))
    let slash = path.lastIndex(of: "/")
    let folder = slash.map { String(path[..<$0]) } ?? ""
    return entries(for: records(tag: tag), in: folder).first { $0.id == id }
  }

  static func contents(id: String, tag: String) throws -> (URL, Entry) {
    guard
      id.hasPrefix("f|files|"),
      let record = record(id: recordId(tag: tag, path: String(id.dropFirst(8)))),
      let directory
    else { throw NSFileProviderError(.noSuchItem) }
    return (directory.appendingPathComponent(record.dataName), entry(file: record))
  }

  private static func entries(for records: [Record], in folder: String) -> [Entry] {
    let prefix = folder.isEmpty ? "" : "\(folder)/"
    var found: [String: Entry] = [:]
    for record in records where record.path.hasPrefix(prefix) {
      let rest = record.path.dropFirst(prefix.count)
      if let slash = rest.firstIndex(of: "/") {
        let path = "\(prefix)\(rest[..<slash])"
        let entry = folderEntry(path, date: record.capturedAt)
        found[entry.id] = entry
      } else if rest != folderMarker {
        let entry = entry(file: record)
        found[entry.id] = entry
      }
    }
    return Array(found.values)
  }

  private static func entry(file record: Record) -> Entry {
    let name = String(record.path[(record.path.lastIndex(of: "/").map(record.path.index(after:)) ?? record.path.startIndex)...])
    return Entry(
      id: "f|files|\(record.path)",
      parentId: parent(of: record.path),
      name: name,
      isFolder: false,
      byteSize: record.byteSize,
      contentType: record.contentType,
      contentVersion: record.sha256,
      metadataVersion: hex(SHA256.hash(data: Data(name.utf8))),
      createdAt: record.capturedAt,
      modifiedAt: record.capturedAt
    )
  }

  private static func folderEntry(_ path: String, date: Double) -> Entry {
    let name = String(path[(path.lastIndex(of: "/").map(path.index(after:)) ?? path.startIndex)...])
    return Entry(
      id: "d|files|\(path)",
      parentId: parent(of: path),
      name: name,
      isFolder: true,
      byteSize: nil,
      contentType: nil,
      contentVersion: "folder",
      metadataVersion: hex(SHA256.hash(data: Data(name.utf8))),
      createdAt: date,
      modifiedAt: date,
      writable: true
    )
  }

  private static func parent(of path: String) -> String {
    "d|files|\(path.lastIndex(of: "/").map { String(path[..<$0]) } ?? "")"
  }

  private static var directory: URL? {
    guard
      let group = Bundle.main.object(forInfoDictionaryKey: "BunnyDriveAppGroup") as? String,
      let container = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
    else { return nil }
    let directory = container.appendingPathComponent("bunny-drive-spool", isDirectory: true)
    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    return directory
  }

  private static func records(tag: String) -> [Record] {
    guard
      let directory,
      let names = try? FileManager.default.contentsOfDirectory(atPath: directory.path)
    else { return [] }
    return names.filter { $0.hasSuffix(".json") }.compactMap { name in
      let url = directory.appendingPathComponent(name)
      return (try? Data(contentsOf: url))
        .flatMap { try? JSONDecoder().decode(Record.self, from: $0) }
        .flatMap { $0.tag == tag ? $0 : nil }
    }
  }

  private static func recordId(tag: String, path: String) -> String {
    String(hex(SHA256.hash(data: Data("\(tag)\n\(path)".utf8))).prefix(32))
  }

  private static func record(id: String) -> Record? {
    guard let directory else { return nil }
    return (try? Data(contentsOf: directory.appendingPathComponent("\(id).json")))
      .flatMap { try? JSONDecoder().decode(Record.self, from: $0) }
  }

  private static func fileSize(_ url: URL) throws -> Int64 {
    let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
    return (attributes[.size] as? NSNumber)?.int64Value ?? 0
  }

  // A megabyte at a time, to stay inside the extension's memory limit.
  static func sha256(_ url: URL) throws -> String {
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
}

private final class DriveItem: NSObject, NSFileProviderItem {
  private let entry: Entry
  private let tag: String

  init(_ entry: Entry, tag: String) {
    self.entry = entry
    self.tag = tag
  }

  var itemIdentifier: NSFileProviderItemIdentifier {
    NSFileProviderItemIdentifier("\(tag).\(entry.id)")
  }

  var parentItemIdentifier: NSFileProviderItemIdentifier {
    entry.parentId == "root" ? .rootContainer : NSFileProviderItemIdentifier("\(tag).\(entry.parentId)")
  }

  var filename: String { entry.name }

  var contentType: UTType {
    if entry.isFolder { return .folder }
    let byName = (entry.name as NSString).pathExtension
    return UTType(filenameExtension: byName)
      ?? entry.contentType.flatMap { UTType(mimeType: $0) }
      ?? .data
  }

  var capabilities: NSFileProviderItemCapabilities {
    let deleting: NSFileProviderItemCapabilities = Self.isDeletable(entry.id) ? .allowsDeleting : []
    return entry.isFolder
      ? [
        .allowsReading, .allowsContentEnumerating, .allowsEvicting, Self.simulatorOnly, deleting,
        // On a folder this one bit is "add items", so only the server turns it on.
        entry.writable == true ? .allowsWriting : [],
      ]
      // A file in My files can be saved over. Without this iOS locks it, and a
      // locked file can't be deleted either.
      : [.allowsReading, .allowsEvicting, Self.simulatorOnly, deleting, entry.id.hasPrefix("f|files|") ? .allowsWriting : []]
  }

  /// A file or folder inside My files, never My files itself. The server checks too.
  static func isDeletable(_ id: String) -> Bool {
    (id.hasPrefix("f|files|") || id.hasPrefix("d|files|")) && id.count > "d|files|".count
  }

  // The simulator's fileproviderd can't create an item without write mode: it fails
  // with `cannotSetMetadata` (EPERM), and the item never appears. So a simulator
  // build isn't read-only. A real iPad is, because the location must be.
  #if targetEnvironment(simulator)
  private static let simulatorOnly: NSFileProviderItemCapabilities = .allowsWriting
  #else
  private static let simulatorOnly: NSFileProviderItemCapabilities = []
  #endif

  var documentSize: NSNumber? { entry.byteSize.map { NSNumber(value: $0) } }
  var creationDate: Date? { entry.createdAt.map { Date(timeIntervalSince1970: $0 / 1000) } }
  var contentModificationDate: Date? { entry.modifiedAt.map { Date(timeIntervalSince1970: $0 / 1000) } }

  var itemVersion: NSFileProviderItemVersion {
    NSFileProviderItemVersion(
      contentVersion: Data(entry.contentVersion.utf8),
      metadataVersion: Data(entry.metadataVersion.utf8)
    )
  }
}

private final class RootItem: NSObject, NSFileProviderItem {
  let itemIdentifier = NSFileProviderItemIdentifier.rootContainer
  let parentItemIdentifier = NSFileProviderItemIdentifier.rootContainer
  let filename = "Bunny Drive"
  let contentType = UTType.folder
  let capabilities: NSFileProviderItemCapabilities = [.allowsReading, .allowsContentEnumerating]
  let itemVersion = NSFileProviderItemVersion(
    contentVersion: Data("1".utf8),
    metadataVersion: Data("1".utf8)
  )
}

// A folder's enumerator, or with no folder the working set. The working set lists
// the root's folders and carries changes, so nothing here walks a whole library.
private final class Enumerator: NSObject, NSFileProviderEnumerator {
  private let folderId: String?
  // iOS keeps what it last listed, and the feed reports files, not the root's
  // folders. So a root listed before anyone held the iPad would stay empty. The
  // working set repeats them on every change, which repairs that on any signal.
  private let carriesRoot: Bool
  private let lock = NSLock()
  private var tasks: [UUID: Task<Void, Never>] = [:]
  // iOS caps a page at 500 bytes and a cursor can be longer, so a page is an
  // index into these. A new enumerator has none, which reads as an expired page.
  private var cursors: [String] = []
  // Every page's ids, because a spooled file the store has since confirmed can
  // arrive on any of them, and the spool's own list comes last.
  private var listed: Set<String> = []

  init(folderId: String?, carriesRoot: Bool = false) {
    self.folderId = folderId
    self.carriesRoot = carriesRoot
  }

  func invalidate() {
    lock.withLock { tasks.values.forEach { $0.cancel() } }
  }

  func enumerateItems(for observer: NSFileProviderEnumerationObserver, startingAt page: NSFileProviderPage) {
    // A new domain's anchor belongs to nobody, so its first change is a full list.
    guard let folderId = folderId ?? (carriesRoot ? "root" : nil), let holder = Holder.read() else {
      observer.finishEnumerating(upTo: nil)
      return
    }
    var cursor: String?
    if !Self.isInitial(page) {
      guard
        let index = Int(String(data: page.rawValue, encoding: .utf8) ?? ""),
        let saved = lock.withLock({ cursors.indices.contains(index) ? cursors[index] : nil })
      else {
        observer.finishEnumeratingWithError(NSFileProviderError(.pageExpired))
        return
      }
      cursor = saved
    } else {
      lock.withLock { listed = [] }
    }
    run { [self] in
      do {
        let found: Listing? = try await Drive.call(
          holder, "list", ["folderId": folderId, "cursor": cursor]
        )
        guard let listing = found else { throw DriveError.failed }
        let seen = lock.withLock {
          listed.formUnion(listing.entries.map(\.id))
          return listed
        }
        // Left out, a file saved here would read as deleted the next time iOS lists.
        let saved = listing.nextCursor == nil
          ? Spool.children(of: folderId, tag: holder.tag, excluding: seen)
          : []
        observer.didEnumerate((listing.entries + saved).map { DriveItem($0, tag: holder.tag) })
        guard let next = listing.nextCursor else {
          observer.finishEnumerating(upTo: nil)
          return
        }
        let index = lock.withLock {
          cursors.append(next)
          return cursors.count - 1
        }
        observer.finishEnumerating(upTo: NSFileProviderPage(Data(String(index).utf8)))
      } catch DriveError.ended {
        // Not an empty folder: iOS would take that as every file in it deleted.
        // The app replaces the grant each launch, so this is usually a moment's
        // gap, and at a real hand-over the app's reset is what clears the listing.
        observer.finishEnumeratingWithError(NSFileProviderError(.serverUnreachable))
      } catch {
        observer.finishEnumeratingWithError(Drive.providerError(error))
      }
    }
  }

  func enumerateChanges(for observer: NSFileProviderChangeObserver, from anchor: NSFileProviderSyncAnchor) {
    let raw = String(data: anchor.rawValue, encoding: .utf8) ?? ""
    guard let holder = Holder.read(), raw.hasPrefix("\(holder.tag)|") else {
      // A different sign-in's position, or none: start the listing over.
      observer.finishEnumeratingWithError(NSFileProviderError(.syncAnchorExpired))
      return
    }
    let position = String(raw.dropFirst(holder.tag.count + 1))
    run {
      do {
        let found: Changes? = try await Drive.call(holder, "changes", ["anchor": position])
        guard let changes = found else { throw DriveError.failed }
        if changes.expired {
          observer.finishEnumeratingWithError(NSFileProviderError(.syncAnchorExpired))
          return
        }
        var entries = changes.entries
        if self.carriesRoot {
          let root: Listing? = try await Drive.call(holder, "list", ["folderId": "root"])
          entries += root?.entries ?? []
        }
        // Deletions first: a folder made again comes back with its new files.
        if let deleted = changes.deleted, !deleted.isEmpty {
          observer.didDeleteItems(withIdentifiers: deleted.map { NSFileProviderItemIdentifier("\(holder.tag).\($0)") })
        }
        observer.didUpdate(entries.map { DriveItem($0, tag: holder.tag) })
        observer.finishEnumeratingChanges(
          upTo: Self.anchor(holder.tag, changes.anchor),
          moreComing: changes.more
        )
      } catch DriveError.ended {
        observer.finishEnumeratingWithError(NSFileProviderError(.syncAnchorExpired))
      } catch {
        observer.finishEnumeratingWithError(Drive.providerError(error))
      }
    }
  }

  func currentSyncAnchor(completionHandler: @escaping (NSFileProviderSyncAnchor?) -> Void) {
    guard let holder = Holder.read() else {
      completionHandler(Self.anchor("nobody", ""))
      return
    }
    run {
      do {
        let changes: Changes? = try await Drive.call(holder, "changes", ["anchor": nil])
        completionHandler(Self.anchor(changes == nil ? "nobody" : holder.tag, changes?.anchor ?? ""))
      } catch {
        completionHandler(Self.anchor("nobody", ""))
      }
    }
  }

  private func run(_ work: @escaping () async -> Void) {
    let id = UUID()
    lock.withLock {
      tasks[id] = Task { [weak self] in
        await work()
        self?.finish(id)
      }
    }
  }

  private func finish(_ id: UUID) {
    lock.withLock { tasks[id] = nil }
  }

  private static func anchor(_ tag: String, _ position: String) -> NSFileProviderSyncAnchor {
    NSFileProviderSyncAnchor(Data("\(tag)|\(position)".utf8))
  }

  private static func isInitial(_ page: NSFileProviderPage) -> Bool {
    page.rawValue == NSFileProviderPage.initialPageSortedByDate as Data
      || page.rawValue == NSFileProviderPage.initialPageSortedByName as Data
  }
}
