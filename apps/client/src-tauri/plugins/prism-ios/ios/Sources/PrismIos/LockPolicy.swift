// Pure decision logic of the iOS app lock (WP5). Foundation-only, so it is
// compiled and tested on macOS too: apps/client/scripts/ios-policy-tests/.

import Foundation

enum LockMode: String {
  case off, launch, background, always
}

/// Seconds on a MONOTONIC clock that keeps counting while the device sleeps
/// (`mach_continuous_time`). Unlike the wall clock it can't be set back, so
/// "After N minutes in the background" can't be bypassed by changing the time.
func continuousSeconds() -> Double {
  var info = mach_timebase_info_data_t()
  mach_timebase_info(&info)
  let ticks = Double(mach_continuous_time())
  return ticks * Double(info.numer) / Double(info.denom) / 1_000_000_000
}

enum LockPolicy {
  /// Should the app lock when it becomes active again?
  /// - backgroundedAt: `continuousSeconds()` when it entered the background
  ///   (nil = it never went to the background, e.g. Control Center was pulled down).
  /// Anything nonsensical (time running backwards, NaN) locks.
  static func shouldLock(mode: LockMode, minutes: Int, backgroundedAt: Double?, now: Double) -> Bool {
    switch mode {
    case .off, .launch:
      return false
    case .always:
      return backgroundedAt != nil
    case .background:
      guard let at = backgroundedAt else { return false }
      let elapsed = now - at
      if !elapsed.isFinite || elapsed < 0 { return true }
      return elapsed >= Double(max(1, minutes) * 60)
    }
  }

  /// May something be handed to the page (an incoming link) right now, i.e. is
  /// it certain that nothing is, or is about to be, behind the lock cover?
  /// With no lock: always. With a lock: only while unlocked AND the app is
  /// active AND no trip through the background is waiting for its lock decision.
  /// (A link that brings the app back from the background reaches the app BEFORE
  /// `didBecomeActive` runs `shouldLock`; at that moment `locked` is still false.)
  static func mayDeliverLink(mode: LockMode, locked: Bool, active: Bool, backgroundedAt: Double?) -> Bool {
    if mode == .off { return true }
    return !locked && active && backgroundedAt == nil
  }
}
