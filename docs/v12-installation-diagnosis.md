# v12 installation diagnosis

## What was verified

The investigation started from Git commit `f006baa46a360826501e2eee8e921e58a6eacb4f`, which was both the local `HEAD` and GitHub `main` at the time of inspection.

- `manifest.json` points to `dist/code.js` and `dist/ui.html`.
- The controller opens Figma's manifest-supplied `__html__` with `figma.showUI(...)`.
- The committed source and production HTML match byte-for-byte. Their SHA-256 at that original v12 commit is `96cfb22cf28b3427d53496d6ef5cec5b1464787f0419426ce5a99775b379b88d`.
- The committed production HTML contains the v12 light-theme tokens, preview/workflow panels, divider, five workflow sections, and `v12.0` header. There was one manifest in the workspace, and the build copied the entire source HTML into its production path.
- A Chromium run of that production HTML, using a mock Figma frame message, displayed the light v12 UI and five sections without JavaScript errors.

The user reported seeing **v11.4 or earlier** in the plugin header. That is evidence that the running window contains older UI files: the verified v12 production HTML identifies itself as v12.0. A GitHub push does not update a previously extracted ZIP, a development plugin imported from another local folder, or an installed published plugin.

The exact old local path, or whether the user launched a development versus published entry, cannot be inspected from this environment. Those remain installation-location questions; the old header does not identify which old folder or published release was launched.

## A separate launch-layout defect

The original v12 controller still opened at 700 × 840. The responsive split layout begins at 840 px, so normal launch always stacked the panels and hid the divider. This was independently reproduced at 700 px; at 1100 px the same production HTML displayed the panels side-by-side and showed the divider.

That defect explains a missing split layout **in a v12 window**. It does not explain a v11.4 header or the previous theme. The targeted delivery fix opens the plugin wide by default, makes the v12 development entry identifiable, and adds production-consistency checks. It does not redesign the interface again or change slicing, account, authentication, or template operations.

## Verified correction

- `manifest.json`: development menu name is now **InboxImplementor Slicer v12.0**; plugin ID and the `dist/code.js` / `dist/ui.html` paths remain unchanged.
- `src/code.ts`, `dist/code.js`: normal opening size is now **1100 × 840**. Compact mode and responsive stacking remain available.
- `src/ui.html`, `dist/ui.html`: browser title identifies v12.0 and the header version label stays visible at narrow widths. The existing redesign itself was not replaced.
- `package.json`, `package-lock.json`: version metadata now matches v12.0 (`12.0.0`), with a `verify:production` command. Dependencies are unchanged.
- `tests/production-build.cjs`: verifies both compiled entry points against source, the manifest routing, light-theme/workflow markup, visible version marker, and actual controller launch options. Corrected production HTML SHA-256: `720807e36ddaed8aadabfc0a3810637daa1b5490098d52f7190ad4ec1825364d`.
- `tests/redesign-workflow.cjs`: launches the browser using the compiled controller's `showUI` size and asserts the divider and v12 version label are visible on first launch. It also verifies the version remains visible in compact layouts.
- `tests/ui-preferences.cjs`: updated launch-size regression expectation; preference, resize, storage and existing-controller checks remain.
- `README.md`, `docs/functional-preservation.md`, and this diagnosis: document the targeted startup correction and exact installation/reload procedure.

The build, production verifier, TypeScript check, account regression, workflow regression and controller regression passed. The rendered production UI was visually inspected at its actual launch size; no reference screenshot was attached, so only the written visual specification was available for comparison.

## Load the corrected development build in Figma Desktop

1. Close the currently open slicer window so an old webview is not left running.
2. Download the exact corrected commit ZIP linked in the delivery message and extract it into a **new folder**. Keep the original folder until the new build is verified; do not replace or delete unrelated local files.
3. In the extracted repository root, find `manifest.json`. Its sibling folders must include `src` and `dist`; `dist/ui.html` and `dist/code.js` are already built and committed.
4. In **Figma Desktop**, use the development-plugin command **Import plugin from manifest**. It is commonly under **Plugins → Development**; the menu's location can vary by Figma version.
5. Select the root `manifest.json` from that newly extracted folder. Do not select a manifest from an older download, and do not select `src/ui.html` or `dist/ui.html` as the manifest.
6. Run **InboxImplementor Slicer v12.0** from the **Development** plugin entries. Avoid a recent, Community, or installed published entry named only **InboxImplementor Slicer** while checking this build.
7. Before selecting a frame, confirm the header shows **v12.0** and the light interface. After selecting one email frame/component/instance, the wide window should show the preview at left and five workflow sections at right, separated by a draggable divider. The account search remains inside the opened account dropdown.

If the header still says v11.4, the running window is still an older build. Check the folder selected in the import dialog and launch the newly imported development entry explicitly. Re-downloading files alone does not change the manifest location of an already imported development plugin.

For a Git checkout, updating the **same local checkout that Figma imported** can also update the built files. Confirm that checkout is on the intended `main` commit, then close and reopen its development plugin. Editing a different clone has no effect on the imported folder.

## Development and published plugins are different deliveries

Importing a local development manifest runs local files. It does not publish a Community/plugin release or update teammates' separately installed copies. Publishing a new Figma release is a separate action through Figma's plugin publishing workflow; this investigation neither performed nor claimed that publication.

## Verification boundary

Automated checks can verify the GitHub ref, manifest paths, source/compiled consistency, controller launch settings, rendered browser UI, and mock-host/API behavior. They cannot reveal which local manifest a user's Desktop installation has imported. Actual Figma document rendering/export, live Klaviyo requests, and the final local development-entry launch still need the user's Desktop smoke test.
