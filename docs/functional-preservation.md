# v12.0 functional-preservation audit

Audit baseline: commit `883642f` (v11.4 UI with the working searchable account selector).
The supplied redesign request includes a text specification; no visual-reference screenshot was attached.
The source defines the functional requirements. The completed preservation review and compatible-browser/controller tests are recorded below; live Figma/backend testing remains unverified.

## Entry points and build

- `manifest.json` loads `dist/code.js` in Figma and `dist/ui.html` in the plugin webview.
- `src/code.ts` owns frame discovery, preview/text/bounds extraction, and JPEG export.
- `src/ui.html` owns UI state, slicing interactions, review, ZIP packaging, and backend calls. Its embedded JSZip dependency must remain intact.
- `npm run build` runs `node build.mjs`: transpile the controller and copy the complete source HTML to `dist/ui.html`. The existing `--watch` argument does not implement a file watcher.
- The existing toolchain works with TypeScript 5.9.3. Baseline type checking reports `src/code.ts:53`: `absoluteRenderBounds` is not present on every member of `SceneNode`; transpilation/build succeeds independently.
- The baseline Figma window opens at 700 × 840 with `themeColors: true`. No plugin-window resize action, panel divider, or UI-preference persistence exists in the baseline. New UI preference storage must exclude zoom, account credentials, and document data.

## Known baseline defect

Custom vertical-cut removal can target a different cut when cuts were inserted out of left-to-right order. `render()` sorts cuts for guide display, then removes by that sorted guide index from the original insertion-order array. For example, adding x=400 followed by x=200 and clicking the x=200 guide removes the x=400 entry. This behavior exists at the audit baseline and is not introduced by the redesign. The slicing algorithm is deliberately unchanged; this requires a separate functional fix and must not be reported as passing all possible guide-removal orders.

## Existing workflow and invariants

1. Select one Figma frame, component, or instance. Selection changes or `refreshBtn` refresh the same selection. The controller exports a PNG preview, frame metadata, up to 6,000 visible layer bounds, and up to 4,000 visible text items.
2. Add horizontal cuts, then split rows into equal columns or custom vertical cuts. Guides remove existing cuts. Layer bounds provide snapping. Undo/reset preserve their existing operations.
3. Review each export slice. Text checkboxes generate alt text; one optional CTA radio per slice places that text after the configured divider. Manual alt text and per-slice destination URLs remain associated with their original region/slice keys.
4. Choose an account through the custom searchable selector; Refresh reloads the account vault while retaining a still-valid selected ID.
5. Prepare fresh JPEG slices, upload/compress them, then create the template from the prepared backend result. Manual JPEG ZIP export remains available independently.

All workflow sections remain accessible on one page, without mandatory wizard gates.
No slicing algorithm, authentication behavior, API contract, credential storage, or existing default may change as part of the redesign.

## Preservation checklist

Checked items mean preserved by source review and/or the explicit mock-host/browser checks below, not a claim that every path was exercised in Figma Desktop.

### Frame and canvas

- [x] `REFRESH_SELECTION`, Figma `selectionchange`, frame/component/instance detection, selected-frame name/dimensions, PNG preview, layer bounds, and text extraction remain connected.
- [x] Invalid/multiple/no selection and preview-export errors retain actionable feedback.
- [x] `previewWrap`, `canvas`, and `preview` retain image aspect ratio and mouse-coordinate transforms (`canvasScale()` uses rendered canvas width divided by original frame width).
- [x] `horizontalBtn`, `equal2Btn`, `equal3Btn`, and `verticalBtn` retain horizontal, two-column, three-column, and custom-cut semantics, including layer-edge snapping.
- [x] Preview row clicks retain their current slicing meaning; guide clicks remove cuts. Review navigation updates the active preview highlight without inventing a new cut operation.
- [x] `undoBtn` and `resetBtn` preserve the existing cut snapshot/undo behavior (history limit 30).
- [x] `zoomInBtn`, `zoomOutBtn`, `fitBtn`, Ctrl/Cmd-wheel, keyboard zoom, Space-drag, and middle-button pan remain available. Zoom remains session-local and retains the existing default/fit behavior on reopening.
- [x] Window resize, divider drag, responsive stacking, canvas scroll, and zoom do not change original-design cut/region coordinates, per-slice edits, or export data. Layout code must not call `snapshot()` (which clears prepared JPEG/backend data).

### Slice review and links

- [x] `textSlices` still renders previous/next navigation, slice dropdown, numbered slice chips, completion indicators, current-slice preview/map metadata, and active-slice highlighting.
- [x] First/last slice navigation states, empty slices, many text blocks, and no-frame/no-region states remain usable.
- [x] Select all, Clear, individual text inclusion, text Copy, CTA radios, and the meaningful existing “No CTA divider” radio retain their exact selection semantics.
- [x] `altSelections`, `altCtaBySlice`, `altTextOverrides`, and `altManualEdited` keep region keys and per-slice edits through navigation. Editing text/CTA selections regenerates alt text as before; manual alt text remains manual until an existing regeneration action occurs.
- [x] The final editable alt field remains connected; no new CTA rules, character limits, or validation defaults are invented.
- [x] `klaviyoDefaultUrl`, per-slice URL input, “Use default URL,” and `sliceUrlOverrides` retain blank/default/override behavior. URL extraction or length validation must not be implied because neither exists in the baseline.
- [x] `ctaDivider` retains its default ` | ` value and regeneration behavior for non-manual alt text.
- [x] `excludeAfterLastCut` remains checked by default: the footer after the last horizontal cut is excluded when cuts exist; without cuts, the whole frame is still one slice.

### Accounts, advanced controls, and backend operations

- [x] `klaviyoAccountTrigger`, in-panel `klaviyoAccountSearch`, `klaviyoAccountOptions`, and `refreshAccounts` remain one custom searchable selector, with no permanently visible second search field/native dropdown.
- [x] Opening focuses an empty search; filtering is immediate, partial and case-insensitive, using loaded account data only. Selection shows its name/checkmark, closes the panel, and retains the original ID.
- [x] Reopening, arrows/Enter/Escape/Tab, outside-click dismissal, 80+ accounts, scroll containment, and upward/downward popup placement remain usable without parent clipping.
- [x] Hidden `klaviyoAccount` continues to supply IDs and trigger the existing change handler. Refresh preserves existing IDs if available; one-account auto-selection, unavailable accounts, load failures, and fallback backend account behavior remain intact.
- [x] Advanced settings remain available: `backendUrl`, password `backendToken`, disabled automatic `scale`, `scaleRule`, and `exportBtn` (“Download JPEG ZIP”). Sensitive values must not be logged or included in new preference storage.
- [x] `prepareKlaviyo` still exports fresh images before upload. Existing busy flags and disabled controls prevent repeated operations.
- [x] `klaviyoPayloadBox`, `uploadStatus`, `backendResultBox`, `klaviyoCreateStatus`, and `klaviyoCreateResultBox` retain inline progress, results, validation, and actionable errors. JSON result/debug details and copy buttons remain accessible.
- [x] `createKlaviyoTemplate` still requires prepared slices, a valid backend URL, and an active account/fallback. It uses the prepared result and original account ID, without merging/bypassing export, upload, and creation stages.
- [x] Export ZIP packaging and controller cleanup of temporary crop frames remain unchanged. The full email maps to 1200 px; partial columns scale proportionally.

## Message and API contracts

Existing UI → controller messages:

- `REFRESH_SELECTION` refreshes selection/preview.
- `EXPORT` carries `horizontalCuts`, `verticalCutsBySection`, `excludeAfterLastCut`, and `scale` (controller enforces its existing 1200 px rule).
- `PREPARE_KLAVIYO_EXPORT` retains its existing notification handler; `CLOSE` closes the plugin.

Existing controller → UI messages:

- `FRAME_READY`: `frame` (`id`, `name`, `width`, `height`, `autoScale`), `layerBounds`, `textItems`, `preview` bytes.
- `SELECTION_ERROR` and `EXPORT_ERROR`: actionable `message`.
- `EXPORT_PROGRESS`: actual `current` and `total`, never fabricated percentages.
- `EXPORTED_FILE`: `filename`, `bytes`; `EXPORT_COMPLETE`: `count`, `zipName`.

Existing backend routes and payloads (optional bearer header continues to come only from `backendToken`):

- `GET /api/klaviyo-accounts`: account array or `{accounts, fallbackConfigured}`; retain vault IDs, display labels, and existing last-four suffix behavior.
- `GET /health`: existing five-second pre-upload health check.
- `POST /api/prepare-klaviyo`: multipart `payload` JSON plus JPEG `files`. Payload retains template/default URL flags and each slice's section/column, original geometry, row width, filename, alt text, URL, readiness and byte count.
- `POST /api/create-klaviyo-template`: JSON `{templateName, accountId, slices}` from the prepared result. No account-vault, API, or authentication changes.

## Verification record

- [x] Build and manifest-referenced production-file checks.
- [x] Existing account combobox browser regression test.
- [x] Frame, slicing/guide removal/undo/reset, coordinate invariance, text/CTA/alt/URL, export/upload/create message and API regression checks.
- [x] Divider preference persistence with zoom excluded.
- [x] Wide, medium, narrow, and short-window layouts; keyboard/focus and reduced-motion behavior.
- [x] Visual inspection of wide preview/active slice, opened account dropdown, narrow layout, multi-text review, loading and error states.
- [x] Figma Desktop/live backend results explicitly distinguished from compatible browser/mock results. No live behavior is claimed without a live run.

### Executed checks

- `npm ci --cache /workspace/.npm-cache` — passed from the committed lockfile; the existing compiler API is pinned to TypeScript 5.9.3.
- `npm run build` — passed; source HTML and `manifest.json`'s `dist/ui.html` match byte-for-byte, and the compiled controller includes the new UI-only message handlers.
- `tsc --noEmit` — passed. A property-existence guard resolves the baseline SceneNode typing error while keeping the existing bounding-box fallback.
- `node tests/klaviyo-account-search.cjs` — passed against the production HTML with 81 mocked accounts: single closed selector, in-panel search, IDs, selection/checkmark, reset, keyboard, outside dismissal, refresh, failures, and viewport containment.
- `node tests/redesign-workflow.cjs` — passed against the production HTML: all existing cut modes, ordered guide removal, Undo/Reset, footer boundaries, no-text slices, text selection/CTA/manual alt/URL review state, preview-label navigation, coordinate invariance across split/zoom/resize, real ZIP packaging, mocked multipart upload/template creation, duplicate-action guards, error recovery, reduced motion, and reserved notification space.
- `node tests/ui-preferences.cjs` — passed against the production controller: safe restore/default/error paths, serialized preference saves, ratio-only storage, window resize validation/clamping, and existing controller entry points.
- Browser layouts checked at 1100 × 840, 900 × 650/700, 700 × 700/840, 360 × 500/640, and 1100 × 480. Both document and workflow horizontal overflow checks passed. All five sections remain reachable in the single workflow scroller. The preview has its intentional canvas scroller; account results scroll only inside their popup.
- The panel ratio survives a mock-host reload; the frame preview restarts at the original 50% zoom. Controller storage tests assert no zoom, window size, document data, or credentials are saved.
- All 51 baseline static control IDs remain, with no duplicate IDs. Existing message types, API paths/payloads, footer-exclusion default, 700 × 840 opening window, and 1200 px export rule are preserved.

### Visual evidence

These are screenshots of the rendered production UI using synthetic email/account fixtures, not hardcoded product data:

- [Wide workspace](screenshots/wide-default.png)
- [Active slice and content review](screenshots/content-review.png)
- [Searchable account panel](screenshots/account-dropdown.png)
- [Narrow stacked workspace](screenshots/narrow-stacked.png)
- [Real export progress message](screenshots/export-progress.png)
- [Actionable upload error and notification dock](screenshots/upload-error.png)

The written light-theme specification guided the design. No reference image was supplied, so screenshot-to-reference comparison could not be performed.

### Unverified live behavior

Figma Desktop was unavailable in this environment. Actual selection events from a live document, temporary-frame cloning/JPEG rendering, real Figma window dragging and clientStorage across desktop sessions, and live backend/Klaviyo uploads/template creation still require a desktop smoke test. Browser tests use real UI interactions with mock host messages/API responses; controller tests use a mock Figma API. No live template was created and no credentials were changed.
