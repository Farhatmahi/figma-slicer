# InboxImplementor Slicer v12.0

Internal Figma plugin for slicing email designs and creating native Klaviyo templates.

## Workspace

The light workspace pairs an interactive email preview with five sections on one scrollable page: Select Frame, Slice Layout, Review Content, Klaviyo Settings, and Create Template.

The default window is **560 × 840**, exactly 30% narrower than the previous 800 × 840 default. The right workflow panel keeps its previous width (347.28 px with overlay scrollbars). All 240 px of removed width comes from the left preview, now 156.72 px wide. The old divider is replaced by a fixed 16 px gap, with no dragging, resize cursor, or saved divider preferences. Old saved panel settings cannot override the layout. See [the measured before/after comparison](docs/compact-workspace.md).

The left panel uses remaining window width, while the editor stays fixed in the horizontal layout. Panels stack when there is insufficient room for the editor and a usable 148 px preview (around 552 px total, depending on scrollbars). The zoom toolbar wraps its help text and retains all four controls. **Fit** fits the email to the current preview; manual zoom, panning, scrolling, slice highlighting, and coordinate mapping remain available. Outer window resizing never changes source-frame or export dimensions.

Use the header's workspace toggle or the bottom-right window grip to resize the outer window. The grip also supports arrow keys. Window size and zoom are not saved or repeatedly reduced on subsequent launches. Notifications occupy a reserved footer rather than covering controls.

## Existing workflow

1. A valid frame selected when the plugin opens becomes the **locked working frame**. Selecting or copying from other canvas layers never changes the preview or edits, even after unlocking. To switch: **Unlock → select the desired frame in Figma → click Use selected frame inside Step 1**. Confirm **Switch frame** if work would be discarded, or choose **Keep current frame**. A new working frame locks automatically. **Refresh always updates the current working frame by ID**, whether locked or unlocked; it never adopts the canvas selection. If no frame was available at startup, select one and click **Use selected frame** in the empty-state view. No actual Figma layer is locked and canvas selection is never forced.
2. Use Horizontal mode to add rows, then split a row into 2 columns, 3 columns, or custom columns. Click guides to remove them; Undo and Reset retain their existing behavior. Numbered preview labels open that slice's content review.
3. Review text inclusion, the optional CTA, final alt text, and each slice's destination URL. Next/Previous, slice chips and the jump selector locate the active slice in the email preview. Click the **Slice N of M** indicator to locate it again without changing any edits. Fitting slices are centered; tall slices align near the top. Only the preview scrolls, using smooth motion unless reduced motion is enabled. Select All, Clear, text Copy, default URL, and “No CTA divider” remain available. Expand **Slice preview & location** for the original crop and email map.
4. Choose a Klaviyo account with the searchable dropdown. Search appears inside the panel only, resets on opening, and uses the already loaded account list. Refresh retains a still-valid selected account ID. Advanced settings retain the backend URL/token, automatic export scale, and JPEG ZIP download.
5. **Prepare & upload images**, then **Create Klaviyo template**. Preparation, compression/upload, and creation remain separate operations with their existing validation, progress messages, and debug results. Full-width JPEG export remains 1200 px.

Existing session behavior and credential handling are unchanged. Panel proportions are no longer persisted.

If the working frame is deleted, the plugin keeps its last preview and edits and disables export/upload/creation. Undo the deletion in Figma or refresh after restoring it; alternatively unlock and confirm a replacement frame. Working-frame locking is session-only. See [the frame-lock diagnosis](docs/working-frame-lock.md) for the history comparison and verification boundary.

## Install in Figma Desktop

1. Close the currently running plugin. Download the new repository ZIP and extract it to a **new folder**, or pull the updated checkout.
2. Open **Plugins > Development > Import plugin from manifest** and select the **root `manifest.json` in that new folder**. It sits beside `src` and `dist`; do not select a manifest in an older extracted folder.
3. Select an email frame and run **Plugins > Development > InboxImplementor Slicer v12.0**. Avoid an older generic entry from Recents or Community.
4. Confirm **v12.0** appears in the plugin header and the preview sits to the left of the five workflow sections. If the header still says v11.4, Figma is still loading the old installation. Re-import the new manifest rather than rerunning that old entry.

GitHub pushes do **not** update files in an older extracted ZIP folder, change Figma's saved local manifest path, or publish a Community plugin update. See [the installation diagnosis](docs/v12-installation-diagnosis.md) for the verified cause and reload guidance.

`manifest.json` loads `dist/code.js` and `dist/ui.html`. The production files are committed and already built; no local build is required to import the plugin.

## Development and verification

Use Node.js with the existing npm toolchain:

```sh
npm ci
npm run build
npm run verify:production
npx --no-install tsc --noEmit
```

TypeScript is pinned to 5.9.3 because the build uses its JavaScript compiler API. The lockfile retains the existing dependencies. `npm run watch` still performs a single build; rerun the build after source changes.

Browser regression tests use an externally available Playwright installation and Chromium; they add no runtime dependencies. With Playwright available to Node and `CHROMIUM_PATH` pointing to Chromium (default `/usr/bin/chromium`):

```sh
node tests/klaviyo-account-search.cjs
node tests/redesign-workflow.cjs
node tests/active-slice-scroll.cjs
node tests/working-frame-controller.cjs
node tests/working-frame-lock.cjs
node tests/working-frame-authority.cjs
node tests/ui-preferences.cjs
node tests/compact-workspace.cjs
```

`verify:production` checks that both built entry points exactly match their sources, the Figma menu and UI identify v12.0, and the compiled controller opens at 560 × 840. The workflow browser test takes its initial viewport from the **actual built controller's `showUI` call**, rather than assuming a wide window. The compact-workspace comparison uses the immutable production UI at commit `e30d0f3` as its baseline, so run it from a Git checkout containing that commit's history. It verifies the entire window reduction comes from the preview, the editor keeps its width, retired divider preferences have no effect, and preview interactions and narrow layouts remain usable.

The browser tests load the actual manifest-referenced HTML and mock Figma host messages and backend responses. The controller tests exercise the built controller in a mock Figma host. These checks do not establish live Figma document export or live backend/Klaviyo access. See [the preservation audit](docs/functional-preservation.md) for coverage and known limitations.
