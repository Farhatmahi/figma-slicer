# InboxImplementor Slicer v12.0

Internal Figma plugin for slicing email designs and creating native Klaviyo templates.

## Workspace

The light workspace pairs an interactive email preview with five sections on one scrollable page: Select Frame, Slice Layout, Review Content, Klaviyo Settings, and Create Template. At widths of 840 px and above, drag the divider or focus it and use the arrow keys to adjust the panels. Double-click it to restore the 38% preview proportion. The panel proportion is saved through Figma client storage; zoom and window size are not saved.

The opening window is now **1100 × 840**, so the two-panel design and divider appear on launch. The earlier 700 px opening width was below the 840 px split breakpoint and always opened the stacked layout. Use the header's **Switch to compact workspace** button for a 700 px window, or drag the bottom-right window grip. The grip also supports arrow keys. Below 840 px, preview and controls stack vertically. Notifications occupy a reserved footer rather than covering controls.

## Existing workflow

1. Select one email frame, component, or instance in Figma. It automatically becomes the **locked working frame**: selecting or copying from other canvas layers does not change the preview or edits. **Unlock** alone keeps the current work; select another frame (or use Refresh on an already selected frame) to switch intentionally. If switching would discard work, confirm **Switch frame** or choose **Keep current frame**. A new working frame locks automatically. While locked, Refresh updates that same frame by ID and preserves edits. This control never locks actual Figma layers or changes canvas selection.
2. Use Horizontal mode to add rows, then split a row into 2 columns, 3 columns, or custom columns. Click guides to remove them; Undo and Reset retain their existing behavior. Numbered preview labels open that slice's content review.
3. Review text inclusion, the optional CTA, final alt text, and each slice's destination URL. Next/Previous, slice chips and the jump selector locate the active slice in the email preview. Click the **Slice N of M** indicator to locate it again without changing any edits. Fitting slices are centered; tall slices align near the top. Only the preview scrolls, using smooth motion unless reduced motion is enabled. Select All, Clear, text Copy, default URL, and “No CTA divider” remain available. Expand **Slice preview & location** for the original crop and email map.
4. Choose a Klaviyo account with the searchable dropdown. Search appears inside the panel only, resets on opening, and uses the already loaded account list. Refresh retains a still-valid selected account ID. Advanced settings retain the backend URL/token, automatic export scale, and JPEG ZIP download.
5. **Prepare & upload images**, then **Create Klaviyo template**. Preparation, compression/upload, and creation remain separate operations with their existing validation, progress messages, and debug results. Full-width JPEG export remains 1200 px.

Existing session behavior and credential handling are unchanged. Only panel proportions are persisted by the new UI.

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
node tests/ui-preferences.cjs
```

`verify:production` checks that both built entry points exactly match their sources, the Figma menu and UI identify v12.0, and the compiled controller opens above the split-layout breakpoint. The workflow browser test takes its initial viewport from the **actual built controller's `showUI` call**, rather than assuming a wide window.

The browser tests load the actual manifest-referenced HTML and mock Figma host messages and backend responses. The controller tests exercise the built controller in a mock Figma host. These checks do not establish live Figma document export or live backend/Klaviyo access. See [the preservation audit](docs/functional-preservation.md) for coverage and known limitations.
