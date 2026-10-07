// Tests for the iOS app lock's pure decision logic (LockPolicy.swift).
// Run: apps/client/scripts/ios-policy-tests/run.sh (macOS; also run by verify-client.mjs).
import Foundation

var failures = 0
func expect(_ cond: Bool, _ what: String) {
  if cond { print("✓ \(what)") } else { print("✗ \(what)"); failures += 1 }
}

let t0 = 10_000.0
// Off / on launch never lock on return from the background.
expect(!LockPolicy.shouldLock(mode: .off, minutes: 5, backgroundedAt: t0, now: t0 + 9999), "off never locks")
expect(!LockPolicy.shouldLock(mode: .launch, minutes: 5, backgroundedAt: t0, now: t0 + 9999), "launch mode doesn't lock on resume")
// Every time: any trip through the background, but not a mere resign-active.
expect(LockPolicy.shouldLock(mode: .always, minutes: 5, backgroundedAt: t0, now: t0 + 1), "always locks after background")
expect(!LockPolicy.shouldLock(mode: .always, minutes: 5, backgroundedAt: nil, now: t0), "always: Control Center pull (no background) doesn't lock")
// After N minutes.
expect(!LockPolicy.shouldLock(mode: .background, minutes: 5, backgroundedAt: t0, now: t0 + 299), "5 min: 4:59 doesn't lock")
expect(LockPolicy.shouldLock(mode: .background, minutes: 5, backgroundedAt: t0, now: t0 + 300), "5 min: 5:00 locks")
expect(LockPolicy.shouldLock(mode: .background, minutes: 60, backgroundedAt: t0, now: t0 + 3600), "60 min: 1h locks")
expect(!LockPolicy.shouldLock(mode: .background, minutes: 15, backgroundedAt: nil, now: t0), "never backgrounded: no lock")
// Nonsense locks: time running backwards, NaN, infinities.
expect(LockPolicy.shouldLock(mode: .background, minutes: 5, backgroundedAt: t0, now: t0 - 1), "clock went backwards → lock")
expect(LockPolicy.shouldLock(mode: .background, minutes: 5, backgroundedAt: .nan, now: t0), "NaN → lock")
expect(LockPolicy.shouldLock(mode: .background, minutes: 5, backgroundedAt: t0, now: .infinity), "infinite elapsed → lock")
expect(LockPolicy.shouldLock(mode: .background, minutes: 0, backgroundedAt: t0, now: t0 + 60), "minutes floor at 1")
// The clock is monotonic and advances.
let a = continuousSeconds()
usleep(20_000)
let b = continuousSeconds()
expect(b > a && b - a < 5, "continuousSeconds advances monotonically (\(b - a)s)")
expect(LockMode(rawValue: "sometimes") == nil, "unknown mode string is rejected")

// Incoming links wait for the lock (links.rs → waitUnlocked).
expect(LockPolicy.mayDeliverLink(mode: .off, locked: false, active: false, backgroundedAt: t0), "no lock: a link is delivered at once")
expect(LockPolicy.mayDeliverLink(mode: .always, locked: false, active: true, backgroundedAt: nil), "unlocked + active: delivered")
expect(!LockPolicy.mayDeliverLink(mode: .launch, locked: true, active: true, backgroundedAt: nil), "locked: a link waits")
expect(!LockPolicy.mayDeliverLink(mode: .always, locked: false, active: false, backgroundedAt: t0), "back from the background, lock not decided yet: waits")
expect(!LockPolicy.mayDeliverLink(mode: .background, locked: false, active: true, backgroundedAt: t0), "background trip still undecided: waits")
expect(!LockPolicy.mayDeliverLink(mode: .background, locked: false, active: false, backgroundedAt: nil), "not active (Face ID sheet, app switcher): waits")
expect(!LockPolicy.mayDeliverLink(mode: .always, locked: true, active: false, backgroundedAt: t0), "locked in the background: waits")

if failures > 0 {
  print("\n\(failures) lock-policy check(s) failed")
  exit(1)
}
print("\nlock policy — all checks passed")
