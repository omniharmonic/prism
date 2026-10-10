import Foundation
import OmniClient
import PrismTransport

public protocol JobManagementService: Sendable {
    func createJob(_ job: NewJob, key: IdempotencyKey) async throws -> OmniJob
    func updateJob(_ id: String, edit: JobEdit) async throws -> OmniJob
    func deleteJob(_ id: String) async throws
}
extension LiveOmniService: JobManagementService {
    public func createJob(_ job: NewJob, key: IdempotencyKey) async throws -> OmniJob { try await client.createJob(job, idempotencyKey: key) }
    public func updateJob(_ id: String, edit: JobEdit) async throws -> OmniJob { try await client.updateJob(id, edit: edit) }
    public func deleteJob(_ id: String) async throws { try await client.deleteJob(id) }
}
