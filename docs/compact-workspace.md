# Compact workspace verification

The baseline is commit `8a1a235`, using its manifest-referenced production HTML. Before and after use the same 600 × 8400 frame, preview image bytes, 50% zoom, and saved panel preference of 0.38. Measurements come from rendered browser elements, including the visible intersection of the image and its viewport.

| Measurement | Before | After |
| --- | ---: | ---: |
| Default window | 1100 × 840 px | 800 × 840 px |
| Left preview panel width | 396.71875 px | 396.71875 px |
| Preview viewport border box | 396.71875 × 604 px | 396.71875 × 604 px |
| Rendered image width | 181.5 px | 181.5 px |
| Visible image width | 181.5 px | 181.5 px |
| Rendered image height | 2541 px | 2541 px |
| Zoom | 50% | 50% |
| Right workflow panel width | 647.28125 px | 347.28125 px |

The default window is **27.27% narrower**. The entire 300 px reduction comes from the workflow panel. Its card padding decreases from 16 px to 12 px; preview toolbar and canvas padding are unchanged. Existing name truncation keeps long frame and account names within the panel, and the selected account has a tooltip with its full name.

## Saved preferences and platform differences

The saved panel fraction is interpreted against the previous 1100 px window's available panel space. Applying 38% to the new 800 px window would shrink the preview, so the new layout retains the equivalent preview width in pixels. No saved window dimensions or zoom override the opening defaults.

A saved 0.50 preference previously produced a 522 px preview viewport and a 244 px image at 50% zoom. Keeping that viewport plus a usable 320 px editor requires **898 px**, an 18.36% reduction. The UI requests this practical minimum on initial preference restoration rather than shrinking the preview. It does not repeatedly enlarge the window after manual resizing.

The comparison also reserves 15 px scrollbar gutters to exercise platforms with non-overlay scrollbars. Each row uses identical scrollbar conditions before and after:

| Scrollbar configuration | Saved preference | Window before → after | Preview width before = after | Image width before = after |
| --- | ---: | ---: | ---: | ---: |
| Overlay | 0.38 | 1100 → 800 px | 396.71875 px | 181.5 px |
| Overlay | 0.50 | 1100 → 898 px | 522 px | 244 px |
| Workspace gutter | 0.38 | 1100 → 800 px | 391.015625 px | 178.5 px |
| Workspace gutter | 0.50 | 1100 → 906 px | 514.5 px | 240.5 px |
| Workspace and preview gutters | 0.38 | 1100 → 800 px | 391.015625 px | 171 px |
| Workspace and preview gutters | 0.50 | 1100 → 906 px | 514.5 px | 233 px |

Resizing the window or divider changes available viewport space without changing image scale or slice coordinates. **Fit** remains an explicit zoom action and fits to the current viewport. Below the width needed for the preferred preview, divider, padding, and 320 px editor, panels stack vertically. Very narrow windows retain image panning and scrolling rather than shrinking the image.

## Production and regression checks

`manifest.json` loads `dist/code.js` and `dist/ui.html`. `npm run build` compiles the controller and copies the source UI to that production path. `npm run verify:production` verifies both outputs against their sources. Product version and manifest identity remain unchanged.

`tests/compact-workspace.cjs` loads the immutable baseline from Git history and the current manifest-referenced HTML. It checks all six measurement cases, initial saved-preference restoration, ignored saved window sizes, manual window resizing, divider dragging and keyboard operation, an immediate divider interaction before initial layout settles, explicit Fit, responsive stacking, overflow, five accessible workflow sections, visible frame controls, and the searchable account panel. Optional `COMPACT_METRICS_PATH` and `COMPACT_SCREENSHOT_DIR` save measurements and screenshots.

The existing regression suites cover content editing, active-slice auto-scroll, frame locking and explicit switching, slicing, account selection and refresh, and export/template flows with mocked host and backend responses. The controller's only source change is the opening width; frame authority and business operations are unchanged.

Figma Desktop is unavailable in this environment. Measurements and interactions were verified in Chromium using the actual production HTML, with simulated Figma messages and API responses. Live Figma document export, native window behavior, and live Klaviyo operations still require a Desktop check.

To check the updated plugin manually, close the plugin, update the local checkout or extract the new commit's ZIP, and import that folder's root `manifest.json` through Figma Desktop's development menu. Use the same frame and zoom to compare preview dimensions. Check the divider, narrow stacked layout, all five sections, account search, Next/Previous auto-scroll, and the locked frame while selecting another canvas layer. A GitHub push does not replace files in an older extracted plugin folder.
