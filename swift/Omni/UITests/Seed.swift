import XCTest

extension OmniUITestCase {
    /// One thread in every state the list can show, and one draft of every kind.
    func seed() {
        let made = server { backend -> [String: String] in
            try await backend.reset()
            var ids: [String: String] = [:]
            ids["done"] = try await backend.thread("Summarise yesterday's notes", "Summarise yesterday's notes in five lines.")
            ids["scheduled"] = try await backend.thread("Check the forecast on Friday", "Check the marine forecast on Friday morning and tell me if the crossing is on.")
            ids["error"] = try await backend.thread("Look up the tide tables", "Look up the tide tables for Saturday. stub:error")
            ids["drop"] = try await backend.thread("Draft the packing list", "Draft the packing list for the retreat. stub:drop")
            ids["toolfail"] = try await backend.thread("File the receipts", "File last month's receipts. stub:toolfail:sample-note-2")
            ids["empty"] = try await backend.thread("Name the boat", "Suggest a name for the boat. stub:empty")
            // A made-up note id: the gateway builds the card without asking the vault for it.
            ids["card"] = try await backend.thread("Update the task for Dana", "Mark the call with Dana as due Friday. stub:card:sample-note-1")
            for id in ids.values { try await backend.settle(id) }
            if let scheduled = ids["scheduled"] { _ = try await backend.call("PATCH", "/api/omni/threads/\(scheduled)", ["state": "scheduled"]) }

            let waiting = try await backend.thread("Compare the two quotes", "Compare the two mooring quotes. stub:slow:900")
            ids["waiting"] = waiting
            try await Task.sleep(for: .seconds(2))
            try await backend.stopTurn(in: waiting)

            let drafts = [
                ("email", "Email Kevin about the buoy spec"), ("email-reply", "Reply to Dana"), ("message", "Message the hardware room"),
                ("calendar-invite", "Invite for the spec review"), ("tweet", "Post about the retreat"), ("wallet-proposal", "Pay the venue deposit"),
            ]
            for (kind, title) in drafts {
                let id = try await backend.thread(title, "\(title). stub:approval:\(kind)")
                ids["approval-\(kind)"] = id
                try await backend.settle(id)
            }
            ids["followup"] = try await backend.thread("Find the grant deadline", "Find the grant deadline. stub:followup")
            ids["working"] = try await backend.thread("Research mooring suppliers", "Research mooring suppliers near the harbour. stub:slow:900")
            // The follow-up arrives three seconds after its turn: wait for the unread dot.
            if let followup = ids["followup"] {
                try await backend.settle(followup)
                for _ in 0..<30 {
                    if try await backend.state(of: followup).unread > 0 { break }
                    try await Task.sleep(for: .milliseconds(300))
                }
            }
            return ids
        }
        OmniUITestCase.seeded = made ?? [:]
        XCTAssertFalse(OmniUITestCase.seeded.isEmpty, "seeding the backend failed")
    }
}
