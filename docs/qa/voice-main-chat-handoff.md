# Voice main-chat handoff

Build 13 deliberately retained voice creation in the compose sheet. This avoided a sheet dismissal plus a second navigation push, but left an unwanted popup throughout the conversation.

Voice launch now selects Threads and pushes one main-stack new-thread entry. Its content resolves the created thread synchronously from the retained voice owner before destination observers run. The entry remains stable while the session destination names the actual thread. Text creation keeps its sheet. End stays in the chat; Back returns to Threads; external navigation and another voice request reset the retained entry.

Validation: focused `VoiceChatHandoffTests|VoiceNavigationLifecycleTests|VoiceContinuityTests|VoiceEmptyCaptureTests|VoiceSubmissionProgressTests` passed 10 Core and 5 UI policy/hosted tests. MainView Swift parsing, diff whitespace and release source checks passed. A subsequent small source guard suppresses retained old-thread content immediately when the authoritative destination changes; its new assertion awaits integrated testing.

Actual iPhone coverage: `OmniUITests/OmniWalkTests/testIPhoneFirstVoiceTurnContinuesInMainChatWithoutSheet`, using existing DEBUG `sample-data,voice-handoff` synthetic audio and loopback stub gateway. Checks no sheet before/after creation, one active voice panel, End stays in chat, Back returns to Threads, and another voice launch opens fresh main-chat composition. Simulator execution and physical acceptance are pending; no real microphone, production server or outward action is used by this fixture.

The physical trace's accepted turn followed by paused about 60 seconds later has no playback drain milestone. Core has no answering timeout; this trace cannot establish a backend timeout or a missing text cause. It shows no processed completion before pause, which may be explicit UI pause. Additional content-free completion and pause-source milestones are being coordinated separately.
