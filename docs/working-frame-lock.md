# Working-frame locking

## History comparison before implementation

The fix starts from GitHub `main` at `f8191daaa6c68223ff5aa267a86220228a8fa1dc`, the auto-scroll commit, compared with its parent `8156e927dd487cd4db6ca252020e580837b8a470`.

- Auto-scroll changed only the UI source/build, README, and its regression test.
- Controller source and compiled controller are byte-identical between those commits. The UI's `SELECTION_ERROR` / `FRAME_READY` handlers are also unchanged.
- The existing `selectionchange → sendSelection()` pipeline assigned the working frame from live canvas selection. Every `FRAME_READY` cleared cuts, history, URLs, text/CTA/alt edits and review index. Selecting a non-frame hid the working UI.
- The selection behavior traces to the initial project import (`0e6d763`). It was not introduced by auto-scroll. The appropriate fix is separate working-frame state, not a revert.

No commits were reverted, reset, deleted or force-pushed. The auto-scroll helper and navigation function remain unchanged from `f8191da`.

## Behavior and implementation

`src/code.ts` tracks a session-only working frame ID independently from canvas nodes. The first valid frame, component or instance locks automatically. A lock toggles only plugin state; no node `locked` property or canvas `selection` is assigned.

Locked canvas selection changes do not publish replacement previews. Exports resolve the working ID, include an optional UI working-ID consistency check, and clone that frame even if another frame or text layer is currently selected. The slicing/export geometry and backend API contracts are unchanged.

Unlocking only changes the flag. A subsequent selection or explicit refresh can propose another frame. The UI confirms before discarding existing work, and the controller commits a switch only after a matching request decision and successful preview load. New working frames lock automatically; canceled, stale or failed requests retain the old frame. Image export and pending preview loads block conflicting actions.

Refreshing the same frame preserves cuts, review state, zoom, edits, files and prepared backend results. UI preview revisions and controller request tokens prevent late asynchronous results from replacing newer choices.

Page-level `nodechange` observation detects frame/ancestor deletion and undo without loading all document pages. A missing frame keeps its last preview and work visible, blocks new export/upload/template operations, and never falls back to the canvas selection. Undo/restore or explicit same-ID refresh restores controls; choosing another frame still requires confirmation when work exists.

## Verification

- `tests/working-frame-controller.cjs` runs the built controller with a mock Figma host: auto-lock, stable-ID exports, untouched selection/layers, unlock-only behavior, confirmation tokens, cancel/stale requests, same-frame refresh, deletion/restore, asynchronous render races and operation guards.
- `tests/working-frame-lock.cjs` bridges the actual manifest-selected UI and compiled controller. It configures Frame A, enters slice text/CTA/alt/URL edits, navigates to Slice 8, selects Frame B and its text, models an external copy operation, returns to review, and verifies all work and auto-scroll are retained. It also tests ZIP export from A, intentional switch/cancel, pending-load guards, clean-frame switching, missing-frame UI and restore through both node events and Refresh.
- Existing auto-scroll, account selector, workflow and UI preference suites remain in place. The workflow's old expectation that an unrelated canvas-selection error should hide the working UI is updated to assert preservation instead.
- `manifest.json` still points to `dist/code.js` and `dist/ui.html`; rebuild and `verify:production` check source/build consistency.

The build, TypeScript check, production verifier, and all six regression scripts passed. Source comparisons also confirm auto-scroll, active-slice navigation, slicing/coordinate algorithms, text/CTA/URL payload mapping and account-loading/selection functions remain unchanged from `f8191da`. The new browser test covers Escape cancellation, pending-load input guards and the compact lock control at 360 px.

These are code review, Chromium interactions and mock Figma/API tests. Figma Desktop was not available. Real canvas clipboard behavior, live document rendering/export and live Klaviyo operations still need a Desktop smoke test; no live copy, upload or template creation is claimed.
