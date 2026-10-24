# InboxImplementor Slicer v11.4

Internal Figma plugin for slicing email designs and creating native Klaviyo templates.

## Review workflow update

- Reviews one slice at a time instead of showing one long alt-text list.
- Shows a large preview of the active slice beside its text controls.
- Shows the active slice's location in a full-email map.
- Adds Previous, Next, dropdown, and numbered slice navigation.
- Shows alt-text progress and completed-slice indicators.
- Highlights the active review slice in the main slicing preview.
- Keeps the existing 1200 px full-email export rule.

## Install

1. Extract the ZIP.
2. In the Figma desktop app, open **Plugins > Development > Import plugin from manifest**.
3. Select `manifest.json`.
4. Select one email frame and run **InboxImplementor Slicer**.

The `dist` folder is already built. Running `npm run build` is only necessary after editing files in `src`.
