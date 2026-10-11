# Link-health alert investigation — 2026-10-11

Read-only investigation of the production Mac Mini vault and server health cursor. No vault values, baselines, worker state, or production services were changed.

## Finding

The stored check at 2026-10-11T05:46:23.747Z reported task.project = 83/150 (55.3%), against a running level of 96.6%. No target listing was truncated. The worker samples by updated_at, not creation date or task lifecycle.

All 150 sampled tasks are terminal: 89 archived, 57 cancelled, 3 done, and 1 completed. 148 were last updated October 10 and two October 11. Their retained revision history shows a project/project(s) migration around October 10 07:00 UTC: 118 retained the same normalized project values; 32 converted existing project names/slugs to project-note wikilinks. The 60 empty project associations were already empty before the migration. The remaining seven unrecognized project references are nonempty legacy names. No project-value loss was found in this sample.

Thus the sharp baseline deviation is driven by old records entering the recently-updated sample after maintenance. It is not evidence that the UI release deleted task associations. This does not prove every vault relationship is healthy: independently, 90/137 non-terminal tasks have recognized project links, and 99/150 most recently created tasks do. Some tasks may legitimately be standalone; no project assignments were guessed.

## Misleading alert metadata

worker/health.ts maps any non-ok link-health result to config.workerFailStreak. Consequently the alert's “3 consecutive failures” is a synthetic failure signal, not three observed failed runs. lastSuccessAt is also set from any completed measurement, including a failing-quality measurement. The 2880-minute threshold is twice the daily scan interval and applies to staleness, not link coverage.

## Recommended follow-up

- Separate active-task coverage from historical/archive coverage. Do not simply exclude terminal rows after taking the current 150-row sample: in this incident that would leave zero rows and falsely imply recovery. Select an appropriate bounded cohort upstream or report insufficient coverage explicitly.
- Track sample lifecycle composition so bulk maintenance cannot masquerade as a linker outage. Version/reset only the affected baseline when intentionally changing metric semantics; do not silently lower the current baseline to clear an alert.
- Report real scan success timestamps and consecutive unhealthy scan counts; distinguish successful measurement from healthy content. Preserve immediate actionable coverage alerts without inventing a streak.
- Review active tasks with missing project references separately, matching only proven existing targets and retaining intentional standalone tasks.

The prior frontend refinements remain separate and are not implicated by this evidence.
