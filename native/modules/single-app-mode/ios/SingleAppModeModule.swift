import ExpoModulesCore
import UIKit

// Bridges iOS **Autonomous Single App Mode (ASAM)** to JS. The app can lock
// ITSELF into single-app mode — the same "Guided Access" lockdown, but initiated
// by the app rather than a triple-click — via
// `UIAccessibility.requestGuidedAccessSession(enabled:completionHandler:)`.
//
// This ONLY succeeds when the bundle is whitelisted for ASAM by MDM
// (Configuration profile → "Autonomous Single App Mode" listing this bundle id).
// On any other device — an unmanaged iPad, the Simulator, a non-whitelisted
// build — the API simply completes with `false`; it never throws or crashes. So
// every entry point here NO-OP-fails gracefully and the JS side degrades to
// "not locked".
//
// ── ONE TRANSITION AT A TIME ──────────────────────────────────────────────────
// backboardd evaluates lock changes one at a time and REJECTS a request that
// arrives while it is still evaluating the previous one. Its log says so
// ("asked to change ASAM state but we are already evaluating a previous
// request"), and the request's completion handler reports `false`. Two callers
// in JS (the lock controller and the native-app launcher) both ask for changes,
// and on the pilot iPad (2026-11-06) every tile tap sent two unlocks 1 ms apart,
// the second always rejected; a re-lock was followed within 125 ms by two more
// rejected unlocks. So every enter/exit goes through one FIFO on the main
// thread:
//
//   - A request whose target state already holds resolves `true` without asking
//     iOS. That is what absorbs the duplicate unlock.
//   - After iOS accepts a request, the next one waits until the OS reports the
//     new state (read directly, or from the status-change notification;
//     bounded), so it rarely lands mid-way. When it does, the busy retry below
//     covers it.
//   - A request iOS refuses while the state still differs is retried a few
//     times, briefly, because "already evaluating" is transient. The budget is
//     small so an iPad that is genuinely not ASAM-permitted still answers fast.
//
// ── READING THE STATE ─────────────────────────────────────────────────────────
// `UIAccessibility` is main-thread-only, and `isActive` is a synchronous
// function JS calls on its own thread — iOS logged "Unsupported use of UIKit API
// off the main thread: UIAccessibilityIsGuidedAccessEnabled()" on every call.
// So the module keeps the last value it read on the main thread (refreshed by
// the status notification and after every transition) and `isActive` returns
// that from any other thread.
public class SingleAppModeModule: Module {
  // Last known OS truth. Written on the main thread only; read from any thread.
  private let stateLock = NSLock()
  private var cachedActive = false
  // False until the main thread has read the state once. Before that, an
  // off-main read falls back to asking UIKit directly (the old behaviour), so
  // a cold start already inside Single App Mode never reports "unlocked".
  private var hasCachedActive = false
  private var statusObserver: NSObjectProtocol?

  // Main-thread-only transition queue.
  private struct Transition {
    let enabled: Bool
    let promise: Promise
  }
  private var pending: [Transition] = []
  private var transitionRunning = false
  // Bumped per transition, so a watchdog or a late completion from an earlier
  // transition can tell it no longer owns the queue.
  private var transitionId = 0
  // Callbacks waiting for the status notification to report a given state.
  private var settleWaiters: [(id: Int, enabled: Bool, done: () -> Void)] = []
  private var nextWaiterId = 0
  private var activeObserver: NSObjectProtocol?

  /// How long to wait for the status notification after iOS accepts a request.
  private let settleTimeout: TimeInterval = 1.5
  /// Retries for a request iOS refused while it was still evaluating another.
  private let busyRetryDelay: TimeInterval = 0.3
  private let busyRetryLimit = 4
  /// Longest one transition may hold the queue. A completion iOS never calls
  /// would otherwise stall every later enter/exit — and a stalled exit leaves
  /// the kiosk locked, a stalled enter leaves it open. It covers the slowest
  /// healthy transition (every busy retry, then the full settle wait) with two
  /// seconds to spare for iOS's own round trips, so it only ever fires on a
  /// completion that is lost, never on one that is merely slow.
  private var transitionWatchdog: TimeInterval {
    Double(busyRetryLimit) * busyRetryDelay + settleTimeout + 2.0
  }
  /// Set on the main thread when the module is torn down. Nothing new starts
  /// after it, and anything still queued is answered.
  private var destroyed = false

  private func readCachedActive() -> Bool {
    stateLock.lock()
    let cached = hasCachedActive ? cachedActive : nil
    stateLock.unlock()
    return cached ?? UIAccessibility.isGuidedAccessEnabled
  }

  /// Main thread only.
  private func refreshCachedActive() -> Bool {
    let active = UIAccessibility.isGuidedAccessEnabled
    stateLock.lock()
    cachedActive = active
    hasCachedActive = true
    stateLock.unlock()
    return active
  }

  /// Main thread only. Called on every status notification.
  private func statusDidChange() {
    let active = refreshCachedActive()
    let ready = settleWaiters.filter { $0.enabled == active }
    settleWaiters.removeAll { $0.enabled == active }
    ready.forEach { $0.done() }
  }

  private func enqueue(enabled: Bool, promise: Promise) {
    DispatchQueue.main.async {
      if self.destroyed {
        promise.resolve(false)
        return
      }
      self.pending.append(Transition(enabled: enabled, promise: promise))
      self.runNextTransition()
    }
  }

  /// Main thread only.
  private func runNextTransition() {
    guard !transitionRunning, !pending.isEmpty else { return }
    let transition = pending.removeFirst()
    if refreshCachedActive() == transition.enabled {
      transition.promise.resolve(true)
      runNextTransition()
      return
    }
    transitionRunning = true
    transitionId += 1
    let id = transitionId
    DispatchQueue.main.asyncAfter(deadline: .now() + transitionWatchdog) {
      guard self.transitionRunning, self.transitionId == id else { return }
      self.finish(transition, result: self.refreshCachedActive() == transition.enabled)
    }
    attempt(transition, id: id, retriesLeft: busyRetryLimit)
  }

  /// Main thread only.
  private func attempt(_ transition: Transition, id: Int, retriesLeft: Int) {
    UIAccessibility.requestGuidedAccessSession(enabled: transition.enabled) { success in
      DispatchQueue.main.async {
        // The watchdog already finished this transition; the queue moved on.
        guard self.transitionRunning, self.transitionId == id else { return }
        if success {
          self.awaitSettled(enabled: transition.enabled) { reached in
            guard self.transitionRunning, self.transitionId == id else { return }
            self.finish(transition, result: reached)
          }
          return
        }
        // Refused. If the state already matches (another path got there), that
        // is success. If iOS was merely busy, try again shortly.
        if self.refreshCachedActive() == transition.enabled {
          self.finish(transition, result: true)
        } else if retriesLeft > 0 {
          DispatchQueue.main.asyncAfter(deadline: .now() + self.busyRetryDelay) {
            guard self.transitionRunning, self.transitionId == id else { return }
            self.attempt(transition, id: id, retriesLeft: retriesLeft - 1)
          }
        } else {
          self.finish(transition, result: false)
        }
      }
    }
  }

  /// Main thread only. Calls `done(reached)` once the OS reports `enabled`
  /// (`true`), or at the settle timeout with whatever the OS reports then —
  /// whichever is first, and exactly once.
  private func awaitSettled(enabled: Bool, done: @escaping (Bool) -> Void) {
    if refreshCachedActive() == enabled {
      done(true)
      return
    }
    var fired = false
    let fireOnce = { (reached: Bool) in
      if fired { return }
      fired = true
      done(reached)
    }
    nextWaiterId += 1
    let waiterId = nextWaiterId
    settleWaiters.append((id: waiterId, enabled: enabled, done: { fireOnce(true) }))
    DispatchQueue.main.asyncAfter(deadline: .now() + settleTimeout) {
      self.settleWaiters.removeAll { $0.id == waiterId }
      fireOnce(self.refreshCachedActive() == enabled)
    }
  }

  /// Main thread only.
  private func finish(_ transition: Transition, result: Bool) {
    _ = refreshCachedActive()
    transition.promise.resolve(result)
    transitionRunning = false
    runNextTransition()
  }

  public func definition() -> ModuleDefinition {
    Name("SingleAppMode")

    OnCreate {
      DispatchQueue.main.async {
        // A reload can tear the module down before this block runs.
        if self.destroyed { return }
        _ = self.refreshCachedActive()
        self.statusObserver = NotificationCenter.default.addObserver(
          forName: UIAccessibility.guidedAccessStatusDidChangeNotification,
          object: nil,
          queue: .main
        ) { _ in
          self.statusDidChange()
        }
        // iOS can drop the lock on its own (its integrity checks kill and
        // relaunch apps). Re-read on every return to the foreground so the
        // cached value can never hide that from the reconciler, whether or not
        // the status notification fired for it.
        self.activeObserver = NotificationCenter.default.addObserver(
          forName: UIApplication.didBecomeActiveNotification,
          object: nil,
          queue: .main
        ) { _ in
          self.statusDidChange()
        }
      }
    }

    OnDestroy {
      DispatchQueue.main.async {
        self.destroyed = true
        for observer in [self.statusObserver, self.activeObserver].compactMap({ $0 }) {
          NotificationCenter.default.removeObserver(observer)
        }
        self.statusObserver = nil
        self.activeObserver = nil
        // Every promise is answered exactly once, even across a teardown. An
        // in-flight transition still finishes through its own completion.
        let queued = self.pending
        self.pending.removeAll()
        queued.forEach { $0.promise.resolve(false) }
      }
    }

    // Synchronous read of the OS truth, so JS can seed state. On the main
    // thread it asks UIKit directly; anywhere else it returns the value last
    // read on the main thread (see the header). False on the Simulator / any
    // non-managed device.
    Function("isActive") { () -> Bool in
      if Thread.isMainThread {
        return self.refreshCachedActive()
      }
      return self.readCachedActive()
    }

    // Lock the app into Single App Mode. Resolves true once the lock holds
    // (false when the app isn't ASAM-permitted) — never rejects. Queued behind
    // any transition already in flight.
    AsyncFunction("enter") { (promise: Promise) in
      self.enqueue(enabled: true, promise: promise)
    }

    // Release Single App Mode so the surrounding kiosk (and Settings → Wi-Fi)
    // is reachable again. Resolves true once released — never rejects. Queued
    // behind any transition already in flight.
    AsyncFunction("exit") { (promise: Promise) in
      self.enqueue(enabled: false, promise: promise)
    }
  }
}
