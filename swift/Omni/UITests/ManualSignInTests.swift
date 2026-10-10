import XCTest

/// THE OWNER STEP. The real sign-in goes through the system browser (Safari on the Mac, the
/// system's sign-in sheet on iPhone and iPad), which a UI test cannot drive reliably — and
/// should not: it is the one place a person proves who they are.
///
/// Run it by hand with `OMNI_UITEST_MANUAL=1 Scripts/uitest.sh iphone` (or `mac`, `ipad`).
/// The test opens the app WITHOUT the test sign-in, on the dev gateway, presses Sign In, and
/// then waits up to three minutes for you to finish in the browser: sign in as the dev
/// owner, press Approve. It passes when the app shows Today.
///
/// What only a person can check here: the browser page names "Omni on <this device>", the
/// app comes back to the front by itself, and (on a real device) Face ID / Touch ID asks
/// before Send.
final class ManualSignInTests: XCTestCase {
    @MainActor
    func testSignInThroughTheBrowser() throws {
        let env = ProcessInfo.processInfo.environment
        try XCTSkipUnless(env["OMNI_UITEST_MANUAL"] == "1" || env["TEST_RUNNER_OMNI_UITEST_MANUAL"] == "1", "Owner step: run with OMNI_UITEST_MANUAL=1 and finish the sign-in in the browser yourself.")
        let app = XCUIApplication()
        // No OMNI_UITEST: the app's real sign-in, real Keychain, real server screen.
        app.launch()
        let signIn = app.buttons["Sign In"].firstMatch
        if !signIn.waitForExistence(timeout: 10) {
            let go = app.buttons["Continue"].firstMatch
            if go.exists { go.tap() }
        }
        XCTAssertTrue(signIn.waitForExistence(timeout: 20), "the Sign In screen did not appear (is the dev backend up?)")
        signIn.tap()
        let today = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'Needs you'")).firstMatch
        XCTAssertTrue(today.waitForExistence(timeout: 180), "not signed in after three minutes")
    }
}
