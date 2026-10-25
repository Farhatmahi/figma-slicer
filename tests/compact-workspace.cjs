// Run after npm run build: node tests/compact-workspace.cjs
// Compares the actual production UI with immutable pre-compact commit 8a1a235.
// Playwright/Chromium are supplied by the development environment, not the plugin.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const previous = relative => execFileSync('git', ['show', `8a1a235:${relative}`], { cwd: root, encoding: 'utf8' });
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const html = fs.readFileSync(path.join(root, manifest.ui), 'utf8');
const controller = fs.readFileSync(path.join(root, manifest.main), 'utf8');
assert.equal(html, fs.readFileSync(path.join(root, 'src/ui.html'), 'utf8'), 'Rebuild before testing the production UI');
assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version, JSON.parse(previous('package.json')).version, 'A compact layout must not change the product version');

function opening(code, ui) {
  let options;
  vm.runInNewContext(code, {
    __html__: ui,
    figma: {
      showUI(actual, value) { assert.equal(actual, ui); options = { width: value.width, height: value.height }; },
      currentPage: { selection: [] }, ui: { postMessage() {} }, on() {}
    }
  });
  assert(options, 'The manifest controller must open a UI');
  return options;
}

const beforeHtml = previous('dist/ui.html');
const beforeOpening = opening(previous('dist/code.js'), beforeHtml);
const afterOpening = opening(controller, html);
assert.equal(beforeOpening.width, 1100);
assert.equal(afterOpening.height, beforeOpening.height, 'Keep the original default height');
assert(afterOpening.width >= beforeOpening.width * .70 && afterOpening.width <= beforeOpening.width * .75, 'Default width must be 25–30% narrower when preserving the default preview is practical');
const nearly = (actual, expected, message, tolerance = .1) => assert(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} versus ${expected}`);

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const results = [];
  try {
    async function openFixture(content, initial, panelRatio, label, stableGutter = false, immediateDivider = false) {
      if (stableGutter) content = content.replace('</head>', `<style>#workspace { scrollbar-gutter: stable; }${stableGutter === 'both' ? '#previewWrap { scrollbar-gutter: stable; }' : ''}</style></head>`);
      const page = await browser.newPage({ viewport: initial, reducedMotion: 'reduce' });
      page.setDefaultTimeout(7000);
      const errors = [], host = [], api = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.exposeFunction('__compactResize', async message => {
        host.push(message);
        if (message.type === 'UI_RESIZE') await page.setViewportSize({
          width: Math.min(1600, Math.max(360, Math.round(message.width))),
          height: Math.min(1200, Math.max(420, Math.round(message.height)))
        });
      });
      await page.addInitScript(({ panelRatio }) => {
        window.__compactMessages = [];
        window.addEventListener('message', event => {
          const message = event.data && event.data.pluginMessage;
          if (!message || !['GET_UI_PREFERENCES', 'SAVE_UI_PREFERENCES', 'UI_RESIZE', 'EXPORT', 'REFRESH_SELECTION'].includes(message.type)) return;
          window.__compactMessages.push(message);
          if (message.type === 'GET_UI_PREFERENCES') {
            // Saved window and zoom fields are intentionally irrelevant to UI preferences.
            window.postMessage({ pluginMessage: { type: 'UI_PREFERENCES', panelRatio, width: 1600, height: 1200, windowWidth: 1600, windowHeight: 1200, zoom: 4 } }, '*');
          }
          if (message.type === 'UI_RESIZE') window.__compactResize(message).catch(error => { throw error; });
        });
      }, { panelRatio });
      await page.route('**/*', route => {
        const url = route.request().url();
        if (url === 'https://compact-workspace.test/') return route.fulfill({ contentType: 'text/html', body: content });
        api.push(url);
        if (url.endsWith('/api/klaviyo-accounts')) return route.fulfill({ json: { accounts: Array.from({ length: 81 }, (_, i) => ({ id: `account-${i}`, displayName: i === 42 ? 'A very long Klaviyo account name for compact layout testing' : `Account ${i}` })) } });
        errors.push(`Unexpected API request: ${url}`);
        return route.abort();
      });
      const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))))));
      await page.goto('https://compact-workspace.test/');
      await page.evaluate(({ immediateDivider }) => {
        if (immediateDivider) document.getElementById('preview').addEventListener('load', () => {
          // Run before the first scheduled calibration pass, as a fast user can.
          requestAnimationFrame(() => {
            const preview = document.getElementById('preview');
            const panel = document.getElementById('previewPanel');
            window.__compactEarlyDivider = { imageWidth: preview.getBoundingClientRect().width, panelWidth: panel.getBoundingClientRect().width };
            document.getElementById('panelDivider').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
          });
        }, { once: true });
        const image = document.createElement('canvas'); image.width = 600; image.height = 8400;
        const context = image.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, 600, 8400);
        for (let y = 0; y < 8400; y += 600) {
          context.fillStyle = y % 1200 ? '#eaf8ff' : '#edf2f7'; context.fillRect(12, y + 12, 576, 576);
        }
        const preview = Uint8Array.from(atob(image.toDataURL('image/png').split(',')[1]), char => char.charCodeAt(0));
        window.postMessage({ pluginMessage: {
          type: 'FRAME_READY', frame: { id: 'compact-frame', name: 'An intentionally long working frame name for compact layout verification', width: 600, height: 8400, autoScale: 2 },
          preview, layerBounds: [], textItems: [
            { id: 'heading', text: 'A long detected heading that must wrap without forcing the editor wider', x: 30, y: 60, width: 220, height: 30 },
            { id: 'cta', text: 'Shop this collection', x: 30, y: 120, width: 220, height: 30 }
          ]
        } }, '*');
      }, { immediateDivider });
      await page.waitForFunction(() => state.frame && document.getElementById('preview').naturalHeight === 8400 && document.getElementById('workspace').offsetParent !== null);
      await settle();
      const metrics = () => page.evaluate(() => {
        const preview = document.getElementById('preview'), panel = document.getElementById('previewPanel'), wrap = document.getElementById('previewWrap'), workflow = document.getElementById('workflowPanel'), workspace = document.getElementById('workspace');
        const image = preview.getBoundingClientRect(), viewport = wrap.getBoundingClientRect();
        return {
          windowWidth: innerWidth, windowHeight: innerHeight, previewPanelWidth: panel.getBoundingClientRect().width,
          workspaceGutter: workspace.offsetWidth - workspace.clientWidth,
          viewportWidth: viewport.width, viewportHeight: viewport.height, viewportClientWidth: wrap.clientWidth,
          previewChromeWidth: wrap.offsetWidth - wrap.clientWidth,
          imageWidth: image.width, imageHeight: image.height,
          visibleImageWidth: Math.max(0, Math.min(image.right, viewport.left + wrap.clientLeft + wrap.clientWidth) - Math.max(image.left, viewport.left + wrap.clientLeft)),
          workflowWidth: workflow.getBoundingClientRect().width, fitWidth: state.fitWidth, zoom: state.zoom
        };
      });
      return { page, metrics, settle, errors, host, api, label };
    }

    // Both layouts receive exactly the same frame pixels, dimensions, zoom and preferences.
    const gutterModes = process.env.COMPACT_DEFAULT_ONLY ? [false] : process.env.COMPACT_GUTTER_ONLY === 'both' ? ['both'] : process.env.COMPACT_GUTTER_ONLY ? [true, 'both'] : [false, true, 'both'];
    const ratioModes = process.env.COMPACT_DEFAULT_ONLY ? [.38] : [.38, .5];
    for (const stableGutter of gutterModes) for (const panelRatio of ratioModes) {
      const before = await openFixture(beforeHtml, beforeOpening, panelRatio, 'before', stableGutter);
      const after = await openFixture(html, afterOpening, panelRatio, 'after', stableGutter);
      if (panelRatio === .5) await after.page.waitForFunction(() => innerWidth >= 898 && innerWidth < 1100);
      await after.settle();
      const a = await before.metrics(), b = await after.metrics();
      if (stableGutter) {
        assert(a.workspaceGutter > 0, 'Stable-gutter fixture must reserve a non-overlay scrollbar lane');
        if (stableGutter === 'both') assert(a.previewChromeWidth > 2, 'Both-gutter fixture reserves a lane inside the canvas viewport too');
        console.log('Stable-gutter measurements:', JSON.stringify({ panelRatio, stableGutter, before: a, after: b }));
      }
      nearly(b.zoom, a.zoom, 'Opening zoom is unchanged');
      nearly(b.imageWidth, a.imageWidth, 'Rendered image width is preserved');
      nearly(b.imageHeight, a.imageHeight, 'Rendered image height/aspect is preserved');
      nearly(b.visibleImageWidth, a.visibleImageWidth, 'The same image width is visible, not merely rendered offscreen');
      nearly(b.previewPanelWidth, a.previewPanelWidth, 'Preferred preview panel width is preserved');
      nearly(b.viewportWidth, a.viewportWidth, 'Preferred preview viewport width is preserved');
      nearly(b.viewportHeight, a.viewportHeight, 'Preview viewport height is preserved');
      assert(b.workflowWidth < a.workflowWidth - 180, 'Width reduction comes from the workflow panel');
      assert(b.workflowWidth >= 320, 'The compact workflow retains its usable minimum');
      assert.equal(b.windowHeight, a.windowHeight);
      assert(b.windowWidth < 1100 && b.windowWidth !== 1600, 'Saved window dimensions never restore the old oversized window');
      if (panelRatio === .38) {
        assert.equal(b.windowWidth, afterOpening.width, 'Default panel preferences do not override the new default window');
        assert.equal(after.host.length, 0, 'Default startup does not issue a window resize');
      } else {
        assert.equal(b.windowWidth, Math.ceil(a.previewPanelWidth + 376 + a.workspaceGutter), 'A wider saved preview uses only its practical minimum window width, including the scrollbar lane');
      }
      results.push({ panelRatio, stableGutter, before: a, after: b });
      if (process.env.COMPACT_SCREENSHOT_DIR && !stableGutter && panelRatio === .38) {
        fs.mkdirSync(process.env.COMPACT_SCREENSHOT_DIR, { recursive: true });
        await before.page.screenshot({ path: path.join(process.env.COMPACT_SCREENSHOT_DIR, 'compact-before.png') });
        await after.page.screenshot({ path: path.join(process.env.COMPACT_SCREENSHOT_DIR, 'compact-after.png') });
        await after.page.locator('#frameStep').screenshot({ path: path.join(process.env.COMPACT_SCREENSHOT_DIR, 'compact-frame-control.png') });
      }

      // Locking, account selection and all five workflow sections remain available.
      assert(await after.page.locator('#frameLockBtn').isVisible());
      assert.equal(await after.page.locator('#frameLockBtn').getAttribute('aria-pressed'), 'true');
      assert.equal(await after.page.locator('.workflow-step').count(), 5);
      await after.page.locator('#klaviyoAccountTrigger').click();
      if (process.env.COMPACT_SCREENSHOT_DIR && !stableGutter && panelRatio === .38) {
        await after.page.screenshot({ path: path.join(process.env.COMPACT_SCREENSHOT_DIR, 'compact-accounts.png') });
      }
      await after.page.locator('#klaviyoAccountSearch').fill('very long');
      assert.equal(await after.page.locator('#klaviyoAccountOptions [role=option]').count(), 1);
      await after.page.locator('#klaviyoAccountOptions [role=option]').click();
      assert.equal(await after.page.locator('#klaviyoAccount').inputValue(), 'account-42');

      const preservedGeometry = await after.page.evaluate(() => {
        state.horizontalCuts = [600, 1200, 1800]; state.verticalCutsBySection = { '0': [300] }; render();
        return JSON.stringify({ cuts: state.horizontalCuts, columns: state.verticalCutsBySection, regions: buildUiRegions() });
      });
      const imageWidth = (await after.metrics()).imageWidth;
      const resizeCount = after.host.length;
      for (const [width, height] of [[1100, 840], [900, 700], [700, 840], [360, 640], [800, 480]]) {
        await after.page.setViewportSize({ width, height }); await after.settle();
        nearly((await after.metrics()).imageWidth, imageWidth, `Manual resize to ${width}px cannot shrink the rendering scale`);
        assert.equal(after.host.length, resizeCount, 'Manually resizing must not trigger a saved-preference window-size override');
        assert.equal(await after.page.evaluate(() => JSON.stringify({ cuts: state.horizontalCuts, columns: state.verticalCutsBySection, regions: buildUiRegions() })), preservedGeometry);
        assert(await after.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        assert(await after.page.locator('#workspace').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
        if (width <= 700) {
          assert(await after.page.evaluate(() => document.getElementById('previewPanel').getBoundingClientRect().bottom <= document.getElementById('workflowPanel').getBoundingClientRect().top + 1), 'Narrow view stacks preview above controls');
        }
        for (const id of ['frameStep', 'sliceStep', 'reviewStep', 'klaviyoPanel', 'createStep']) {
          await after.page.locator(`#${id}`).scrollIntoViewIfNeeded();
          assert(await after.page.locator(`#${id}`).isVisible(), 'Every workflow section remains scroll-accessible');
        }
        await after.page.locator('#klaviyoAccountTrigger').click();
        const popup = await after.page.locator('#klaviyoAccountDropdown').boundingBox();
        assert(popup.x >= 0 && popup.y >= 0 && popup.x + popup.width <= width + .1 && popup.y + popup.height <= height + .1, 'Searchable account popup stays inside the webview');
        await after.page.locator('#klaviyoAccountSearch').press('Escape');
      }

      await after.page.setViewportSize({ width: afterOpening.width, height: afterOpening.height }); await after.settle();
      if (panelRatio === .38) {
        await after.page.locator('#workspace').evaluate(el => el.scrollTo(0, 0));
        const divider = after.page.locator('#panelDivider');
        assert(await divider.isVisible(), 'Default compact layout retains the draggable divider');
        const previousPanel = (await after.metrics()).previewPanelWidth;
        const box = await divider.boundingBox(), workspace = await after.page.locator('#workspace').boundingBox();
        const y = Math.max(box.y, workspace.y) + 24;
        await after.page.mouse.move(box.x + box.width / 2, y); await after.page.mouse.down();
        await after.page.mouse.move(box.x + box.width / 2 - 24, y, { steps: 4 }); await after.page.mouse.up();
        await after.settle();
        assert(Math.abs((await after.metrics()).previewPanelWidth - previousPanel) > 8, 'Divider drag still changes panel allocation');
        nearly((await after.metrics()).imageWidth, imageWidth, 'Dragging the divider does not change rendered image scale');
        await after.page.locator('#panelDivider').focus(); await after.page.locator('#panelDivider').press('ArrowRight'); await after.settle();
        nearly((await after.metrics()).imageWidth, imageWidth, 'Keyboard panel resizing does not change rendering scale');
        const saves = await after.page.evaluate(() => window.__compactMessages.filter(message => message.type === 'SAVE_UI_PREFERENCES'));
        assert(saves.length > 0);
        assert(saves.every(message => Number.isFinite(message.panelRatio) && Object.keys(message).every(key => ['type', 'panelRatio'].includes(key))), 'Only the panel preference is saved, not zoom or window dimensions');
        await after.page.locator('#fitBtn').click(); await after.settle();
        const fitted = await after.metrics();
        assert.equal(fitted.zoom, 1);
        assert(fitted.imageWidth <= fitted.viewportClientWidth, 'Explicit Fit still fits the current preview viewport');
        await after.page.locator('#windowResizeHandle').focus(); await after.page.locator('#windowResizeHandle').press('ArrowRight');
        await after.page.waitForFunction(() => window.__compactMessages.some(message => message.type === 'UI_RESIZE'));
        assert(after.host.length > resizeCount, 'Manual plugin-window resize messages remain supported');
      }
      assert.equal(await after.page.evaluate(() => JSON.stringify({ cuts: state.horizontalCuts, columns: state.verticalCutsBySection, regions: buildUiRegions() })), preservedGeometry);
      assert.deepEqual(before.errors, []); assert.deepEqual(after.errors, []);
      assert(before.api.every(url => url.endsWith('/api/klaviyo-accounts')) && after.api.every(url => url.endsWith('/api/klaviyo-accounts')), 'Layout changes never export, upload or create templates');
      await before.page.close(); await after.page.close();
    }
    if (gutterModes.includes(false)) {
      const early = await openFixture(html, afterOpening, .38, 'immediate-divider', false, true);
      const initial = await early.page.evaluate(() => window.__compactEarlyDivider);
      assert(initial, 'Exercise the divider during opening calibration');
      const final = await early.metrics();
      assert(Math.abs(final.previewPanelWidth - initial.panelWidth) > 8, 'The immediate divider interaction really changes the panel');
      nearly(final.imageWidth, initial.imageWidth, 'Opening calibration cannot rescale the image after an immediate divider interaction');
      nearly(final.zoom, .5, 'Opening divider interaction preserves the default zoom');
      assert.deepEqual(early.errors, []);
      await early.page.close();
    }
    if (process.env.COMPACT_METRICS_PATH) fs.writeFileSync(process.env.COMPACT_METRICS_PATH, JSON.stringify(results, null, 2));
    console.log('Measured before/after:', JSON.stringify(results));
    console.log('PASS: compact production window preserves actual preview image/viewport dimensions under identical content and zoom, narrows the editor, retains panel/window resizing, saved preferences, stacked layouts, five workflow steps, locking and account selection without geometry/API changes.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
