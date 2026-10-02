# Governance workspace presentation

October2,2026 · D05/R12 · board23 (`assets/23-sharing-governance.png`).

The existing governance surface now opens with Overview and access context. Roles & rules, Proposals, and History have separate keyboard-accessible sections, while their components remain mounted so changing sections preserves drafts. The review queue precedes collapsed rule/role and content proposal composers. Small screens use a two-by-two section bar with44px controls; existing current/proposed text, quorum arithmetic and apply/publish actions remain intact. Token corrections restore dark/light surfaces without replacing governance semantics.

Actual GovernancePanel fixtures exercise section keyboard/focus behavior, retained role/amendment/vote drafts, exact vote payload, approval-before-apply, failed vote recovery, and all four sections at1440/390/320dark. Ten Chromium/WebKit checks passed; combined with actual History the earlier38 passed, and the final governance+command-helper38 passed. Aggregate fixture TypeScript passed.

Reviewed fictional screenshots: [desktop](governance-1440-chromium.png), [phone](governance-390-chromium.png), [narrow dark](governance-320-webkit.png). The first screenshot review exposed a form above the review queue and wrapping tab text; both were corrected and rerun. This is a quieter implementation of board23’s hierarchy, not a claim to have added its effective-access simulation or new approval semantics.

The existing live governance E2E navigation selectors were updated, but its destructive bootstrap/reset journey was **not run against production**. These fixture writes hit only a fake transport. Existing partial-read/error recovery and backend authorization are unchanged; no native or production verification of this batch, governance audit redesign, effective-access preview, or new undo workflow is claimed.
