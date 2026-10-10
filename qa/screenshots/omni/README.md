# Omni UI gallery — 2026-10-10

These are fixture screenshots; names, records and approvals are sample data. No email or other external action was sent.

- `mac/`: 36 screen snapshots in light, dark and narrow layouts (108 images).
- `iphone/`: largest accessibility text walkthrough plus dark representative Today, approval, record-card, composer/keyboard and Settings views.
- `ipad/`: representative portrait, landscape and compact split-width views. The final layout checks include native notification and privacy-lock settings from the dependent native stage.

Validation: the largest Dynamic Type audit passed with zero asserted violations (13 documented platform audit notes). Focused largest-text checks passed for keyboard dismissal, approval edit/Save/cancel, and command denial. Core tests passed; the representative device matrix and native signing gates are tracked in PRs #57 and #60.

JPEG exports are intentionally smaller review artifacts. Test output retains original PNGs locally. Mac snapshots run offscreen; interactive Mac UI automation and real biometric/push delivery require owner device access and signed apps.
