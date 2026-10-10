# Reviewed local M3 job management

Enable only after verifying the installed wrappers match these exact pins:

| Stored basename | SHA-256 |
| --- | --- |
| omni-nudges-sweep.sh | 7511e15e7c51f54c9e5bcb6d5e13d9d25b289facd4bd5340947a195f25ce8c8b |
| omni-nudges-context.sh | 418a3fb822d389b30152bd3481616ee8f326d4f0eff1cc123389401d34903f91 |
| omni-nudges-audit.sh | 15dd47cab26389f6b31522955a8c7427a01b5bcd538189860a33279f2891f308 |

Set `OMNI_REVIEWED_JOB_SCRIPTS_DIR=/Users/benjaminlife/.hermes/scripts` in the server environment and use the normal reviewed deployment/restart process. Unset disables this exception. This change does not create, resume, run or edit any live job itself.

At each operation the server requires local delivery, `no_agent=true`, no monitor, a known basename, regular non-symlink paths and exact wrapper bytes. Only Run, Resume and name/schedule edits are added. Prompt/script/delivery fields cannot change. Run uses normal Hermes dispatch and requires an executed/background receipt; completion is observed later through job status. The three wrappers still invoke their existing read-only/proposal-safe production commands. Six unrelated legacy script jobs remain blocked for Run/Resume/Edit; Pause/Delete remain available.

Capabilities may change after listing (for example, if a wrapper is edited). The mutation recheck is authoritative and can refuse a stale UI action. This is a trusted local-admin boundary, not containment against a privileged filesystem actor racing after the check. No live mutation or outward send is needed to validate this implementation.
