# First voice turn navigation regression

Checked on 2026-10-10 against build 10 source (`5db5f05e`) plus the draft-continuation and modular reply-speech changes. The tests host real SwiftUI `DestinationView`, `NewThreadView`, and `ThreadView` in an invisible AppKit window with synthetic in-memory service data and a fake audio implementation. They do not open a microphone, call a server, or send an outbound operation.

## Observed cause

`ThreadView` attached its bottom `safeAreaInset` directly to the conditional transcript. The initial loading `ProgressView` changed to the loaded `ScrollViewReader`, rebuilding the inset containing the voice control. Redacted temporary lifecycle observations showed:

```
new control appeared: listening
thread control appeared: answering
new control disappeared: handoff retained
thread control appeared: answering
previous thread control disappeared: canceled current owner
```

The first reply was canceled during this transition. A stable `ZStack` around the transcript keeps the inset's control mounted across the phase change. The voice control also keeps its lifecycle observer mounted when its visible panel is empty, and stale callbacks check ownership before canceling a transferred task or changing its privacy state.

## Regression evidence

`VoiceNavigationLifecycleTests.testMountedNewThreadHandoffNarratesFirstReplyAndContinues` invokes the mounted production control's automatic-finish callback, creates a thread, receives an immediate synthetic reply, checks one narration and a second microphone start, then exercises the mounted draft-saving finish callback shared with Pause. The next spoken turn remains an unsent draft.

With the original transcript tree temporarily restored, the same test failed: narration was empty, capture started only once, voice state was `off`, and the next draft was absent. Log: `/private/tmp/voice-navigation-red.log`.

With the stable container restored, the test passed. `testLateSceneCallbackFromTransferredNewControlCannotCancelSession` also passed, proving a retained old new-thread control cannot cancel the transferred session when it receives an inactive-scene callback. Both hosted tests passed together (2 tests, 0 failures). Log: `/private/tmp/voice-navigation-late-callback.log`.

The existing `VoiceConversationTests`, `VoiceDraftContinuationTests`, and `VoiceEntryTests` passed (30 tests, 0 failures). Log: `/private/tmp/voice-navigation-green.log`.

These checks establish the view-transition behavior with synthetic audio. Physical microphone/speaker behavior and installed-device validation remain release checks.
