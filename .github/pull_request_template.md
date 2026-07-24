## Summary

<!-- What changed, why, and which user/developer outcome it owns. -->

## Validation

<!-- List exact commands, test counts, layouts, viewports, and manual evidence. -->

- [ ] I ran the risk-appropriate repository checks and listed the exact results.
- [ ] I added or updated regression/acceptance evidence for externally visible behavior.
- [ ] I did not weaken a test, inventory, coverage, lint, performance, or security ratchet merely to make the branch green.

## Visible UI changes

<!-- Select the applicable impact boundary. -->

- [ ] This PR cannot affect rendered UI or layout.
- [ ] This PR affects rendered UI/layout; the evidence below is supplied.
- [ ] Every affected modern/legacy layout satisfies the [responsive UI contract](https://github.com/4eh5xitv6787h645ebv/Jellyfin-Canopy/blob/main/CONTRIBUTING.md#responsive-ui-contract); any layout-specific exclusion is explained.
- [ ] The affected phone, landscape, tablet, desktop, breakpoint-neighbor, long-content/count, and dynamic-resize boundaries were exercised and listed.
- [ ] Browser tests directly assert containment, overflow, intersection, and action/close-control reachability.
- [ ] Production acceptance cases are registered in `e2e/required-test-inventory.json`.
- [ ] Representative before/after screenshots are included for every affected form factor when layout behavior changes.

## Assistance and risk

<!-- Note AI assistance, breaking changes, residual risks, and follow-up work. -->
