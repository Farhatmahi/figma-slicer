# Unified template status

Step 5 contains one persistent `operationStatus` card. It shows the current phase: idle, preparing images, images ready, creating a template, template created successfully, or an error. Progress uses real JPEG export counts when available. Upload/compression has an activity indicator rather than an invented percentage.

Ready and success facts use the uploaded `slices` array. Compression savings appear only when every slice has valid original/compressed byte counts and the original total is positive. The success card retains the completed operation's account name and template name instead of changing when the user refreshes or selects another account. Uploaded slice count is distinct from the resulting template's table-row count.

Incomplete JPEG exports and incomplete backend upload responses show an error and cannot enable Create using a stale prepared result. Failed operations preserve existing retry paths. Invalidating prepared images clears readiness and disables Create; presentation resets do not replace an active operation with idle.

All original debug datasets and copy functions remain under one **Technical details** disclosure, collapsed on launch and on working-frame replacement:

- Copy debug data / View prepared JSON.
- Copy upload results / View upload results.
- Copy template results / View template results.

The three old result-card containers are now debug sections within that disclosure. Their original IDs and textarea data remain available to the existing handlers. They no longer provide competing status cards. Template creation success remains visible in the unified card; its specific success toast is suppressed. Global toast creation, clipboard notices, warnings and errors remain available.

`tests/unified-status.cjs` loads the actual `manifest.json` production UI, with simulated Figma export messages and backend replies. It verifies real progress and facts, missing compression metadata, partial export/upload rejection, retry states, all six debug controls, completed facts after account refresh, and absence of a template-success toast. Screenshots were visually checked at the actual 560 × 840 default. Existing workflow, frame-authority, auto-scroll and account tests cover preservation of their operations.

`npm run build` copies this component into `dist/ui.html`; `npm run verify:production` checks that this manifest-referenced UI exactly matches `src/ui.html`, and that the compiled controller matches its source. API URLs, request bodies, authentication and the account vault are unchanged. The product version is unchanged.

Figma Desktop and live Klaviyo testing are unavailable here. For a manual check, import the updated root `manifest.json`, select a frame, prepare its slices, and confirm one status component progresses through preparation, readiness and creation. Expand Technical details and verify each view/copy control. Check a failed request and retry; successful template creation should leave its card visible without a success toast.
