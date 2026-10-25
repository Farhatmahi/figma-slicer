# Fixed-panel workspace verification

The baseline is immutable commit `e30d0f3`, using its manifest-referenced production HTML and actual 800 × 840 controller default. Before and after use identical 600 × 8400 frame content and 50% zoom.

| Measurement | Before | After |
| --- | ---: | ---: |
| Default window width | 800 px | 560 px |
| Default height | 840 px | 840 px |
| Left preview panel width | 396.71875 px | 156.71875 px |
| Right workflow panel width | 347.28125 px | 347.28125 px |
| Divider / fixed gap | 16 px draggable divider | 16 px static gap |
| Outer horizontal padding | 40 px | 40 px |

The entire **240 px / 30%** window-width reduction comes from the preview. The workflow's controls and padding retain their previous widths. The plugin version is unchanged.

## Preview usability and responsive behavior

The narrow preview retains all four zoom controls by using 4 px toolbar padding and a 36 px zoom label. The controls require approximately 147.89 px including toolbar chrome; a 148 px minimum preview supports them. The heading and pan hint wrap, and the preview viewport can shrink vertically so the caption stays reachable. At the default width, Fit renders the same frame at 123 px wide while preserving its aspect ratio. Manual zoom can render a wider image, with overflow contained inside the preview for scrolling and panning.

The right editor has a fixed width in the horizontal layout; outer window growth supplies the preview. Below the editor plus a 148 px preview, 16 px gap, padding and any scrollbar gutter, the panels stack. The default overlay-scrollbar breakpoint is 552 px. No draggable divider, panel-resizing listeners, or divider-preference read/write handlers remain. Old storage values cannot change this layout. The default is a fixed 560 px value, not a multiplication applied at runtime on every launch. Outer window resizing and its existing size validation remain supported.

With a reserved 15 px workspace scrollbar gutter, the previous editor was 337.984375 px and the preview was 391.015625 px. The new editor retains 337.984375 px while the preview becomes 151.015625 px: again exactly 240 px less. This platform difference is measured rather than used to shrink the editor. Reserving a preview scrollbar as well leaves all zoom controls within the toolbar and produces a 102 px Fit image.

## Production and regression checks

`manifest.json` continues to load `dist/code.js` and `dist/ui.html`. The build compiles the controller and copies the source UI to the production path; production verification compares both outputs against their sources.

`tests/compact-workspace.cjs` compares the actual baseline and current production UI across overlay and reserved-gutter conditions. It verifies fixed editor/control widths, exact window and preview reduction, absent separator and preference messages, ignored old saved settings, repeated launch dimensions, usable zoom controls, Fit, pan, pixel-to-slice mapping, account search/refresh IDs, outer resizing, responsive stacking, and no document overflow. Existing suites cover frame authority, active-slice auto-scroll, content edits, slicing modes, export and template contracts.

Figma Desktop is unavailable in this environment. Browser checks use the actual production HTML in Chromium with simulated Figma messages and backend responses; native Figma export and live Klaviyo operations still require a Desktop check. Close the old plugin, update the checkout or extract the new commit ZIP, then import that folder's root `manifest.json` through Figma Desktop's development menu. A GitHub push does not update an older extracted plugin folder.
