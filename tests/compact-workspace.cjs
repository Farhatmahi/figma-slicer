// Run after npm run build: node tests/compact-workspace.cjs
// Compares the manifest's production UI with the immutable 800px baseline e30d0f3.
// Playwright/Chromium are supplied by the development environment, not the plugin.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const previous = relative => execFileSync('git', ['show', `e30d0f3:${relative}`], { cwd: root, encoding: 'utf8' });
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const html = fs.readFileSync(path.join(root, manifest.ui), 'utf8');
const controller = fs.readFileSync(path.join(root, manifest.main), 'utf8');
assert.equal(html, fs.readFileSync(path.join(root, 'src/ui.html'), 'utf8'), 'Rebuild before testing the production UI');
assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version, JSON.parse(previous('package.json')).version, 'The layout change must not change the product version');
assert(!/GET_UI_PREFERENCES|SAVE_UI_PREFERENCES/.test(html), 'The fixed layout must remove the obsolete preference protocol');
assert(!/GET_UI_PREFERENCES|SAVE_UI_PREFERENCES|inbox-slicer:ui:v12/.test(controller), 'The production controller must remove obsolete layout storage');

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
assert.deepEqual(beforeOpening, { width: 800, height: 840 });
assert.deepEqual(afterOpening, { width: 560, height: 840 });
const nearly = (actual, expected, message, tolerance = .1) => assert(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} versus ${expected}`);

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  const results = [];
  try {
    async function openFixture(content, initial, label, stableGutter = false) {
      if (stableGutter) content = content.replace('</head>', `<style>#workspace { scrollbar-gutter: stable; }${stableGutter === 'both' ? '#previewWrap { scrollbar-gutter: stable; }' : ''}</style></head>`);
      const page = await browser.newPage({ viewport: initial, reducedMotion: 'reduce' });
      page.setDefaultTimeout(7000);
      const errors = [], host = [], api = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.exposeFunction('__compactResize', async message => {
        host.push(message);
        await page.setViewportSize({ width: Math.min(1600, Math.max(360, Math.round(message.width))), height: Math.min(1200, Math.max(420, Math.round(message.height))) });
      });
      await page.addInitScript(() => {
        window.__compactMessages = [];
        window.addEventListener('message', event => {
          const message = event.data && event.data.pluginMessage;
          if (!message || !['GET_UI_PREFERENCES', 'SAVE_UI_PREFERENCES', 'UI_RESIZE', 'EXPORT', 'REFRESH_SELECTION'].includes(message.type)) return;
          window.__compactMessages.push(message);
          // Only the immutable baseline asks for this obsolete preference.
          if (message.type === 'GET_UI_PREFERENCES') window.postMessage({ pluginMessage: { type: 'UI_PREFERENCES', panelRatio: .38 } }, '*');
          if (message.type === 'UI_RESIZE') window.__compactResize(message).catch(error => { throw error; });
        });
      });
      await page.route('**/*', route => {
        const url = route.request().url();
        if (url === 'https://compact-workspace.test/') return route.fulfill({ contentType: 'text/html', body: content });
        api.push(url);
        if (url.endsWith('/api/klaviyo-accounts')) return route.fulfill({ json: { accounts: Array.from({ length: 81 }, (_, i) => ({ id: `account-${i}`, displayName: i === 42 ? 'A very long Klaviyo account name for fixed layout testing' : `Account ${i}` })) } });
        errors.push(`Unexpected API request: ${url}`);
        return route.abort();
      });
      const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))))));
      await page.goto('https://compact-workspace.test/');
      await page.evaluate(() => {
        const image = document.createElement('canvas'); image.width = 600; image.height = 8400;
        const context = image.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, 600, 8400);
        for (let y = 0; y < 8400; y += 600) {
          context.fillStyle = y % 1200 ? '#eaf8ff' : '#edf2f7'; context.fillRect(12, y + 12, 576, 576);
        }
        const preview = Uint8Array.from(atob(image.toDataURL('image/png').split(',')[1]), char => char.charCodeAt(0));
        window.postMessage({ pluginMessage: {
          type: 'FRAME_READY', frame: { id: 'compact-frame', name: 'An intentionally long working frame name for fixed layout verification', width: 600, height: 8400, autoScale: 2 },
          preview, layerBounds: [], textItems: Array.from({ length: 13 }, (_, i) => [
            { id: `heading-${i}`, text: `Detected text for slice ${i + 1}`, x: 30, y: i * 600 + 40, width: 220, height: 30 },
            { id: `cta-${i}`, text: `Shop slice ${i + 1}`, x: 30, y: i * 600 + 110, width: 220, height: 30 }
          ]).flat()
        } }, '*');
      });
      await page.waitForFunction(() => state.frame && document.getElementById('preview').naturalHeight === 8400 && document.getElementById('workspace').offsetParent !== null);
      await settle();
      assert.deepEqual(errors, [], `${label} production fixture must initialize without script errors`);
      const metrics = () => page.evaluate(() => {
        const preview = document.getElementById('preview'), panel = document.getElementById('previewPanel'), wrap = document.getElementById('previewWrap'), workflow = document.getElementById('workflowPanel'), workspace = document.getElementById('workspace');
        const image = preview.getBoundingClientRect(), viewport = wrap.getBoundingClientRect(), left = panel.getBoundingClientRect(), right = workflow.getBoundingClientRect();
        return {
          windowWidth: innerWidth, windowHeight: innerHeight, previewPanelWidth: left.width, workflowWidth: right.width, gap: right.left - left.right,
          workspaceGutter: workspace.offsetWidth - workspace.clientWidth,
          viewportWidth: viewport.width, viewportHeight: viewport.height, viewportClientWidth: wrap.clientWidth,
          previewChromeWidth: wrap.offsetWidth - wrap.clientWidth,
          imageWidth: image.width, imageHeight: image.height, fitWidth: state.fitWidth, zoom: state.zoom,
          visibleImageWidth: Math.max(0, Math.min(image.right, viewport.left + wrap.clientLeft + wrap.clientWidth) - Math.max(image.left, viewport.left + wrap.clientLeft)),
          previewScrollWidth: wrap.scrollWidth,
          stacked: left.bottom <= right.top + 1
        };
      });
      const workflow = () => page.evaluate(() => [
        '#workflowPanel', '#frameStep', '#frameStep .card-head', '#frameStep .card-body', '#frameName', '#frameLockBtn',
        '#sliceStep .card-body', '#horizontalBtn', '#reviewStep .review-global-settings', '.review-toolbar', '.review-editor-body',
        '#klaviyoPanel .card-body', '#klaviyoAccountTrigger', '#refreshAccounts', '#createStep .card-body', '#prepareKlaviyo'
      ].map(selector => {
        const el = document.querySelector(selector), style = getComputedStyle(el);
        return { selector, width: el.getBoundingClientRect().width, fontSize: style.fontSize, padding: style.padding, gap: style.gap, border: style.borderWidth };
      }));
      return { page, metrics, workflow, settle, errors, host, api, label };
    }

    const gutterModes = process.env.COMPACT_DEFAULT_ONLY ? [false] : process.env.COMPACT_GUTTER_ONLY === 'both' ? ['both'] : process.env.COMPACT_GUTTER_ONLY ? [true, 'both'] : [false, true, 'both'];
    for (const stableGutter of gutterModes) {
      const before = await openFixture(beforeHtml, beforeOpening, 'before', stableGutter);
      const after = await openFixture(html, afterOpening, 'after', stableGutter);
      const a = await before.metrics(), b = await after.metrics();
      nearly(b.workflowWidth, a.workflowWidth, 'The entire right workflow panel keeps its original width');
      nearly(a.previewPanelWidth - b.previewPanelWidth, 240, 'All 240px of reduction comes from the left preview pane');
      nearly(b.gap, 16, 'Removing the divider retains the existing 16px separation');
      nearly(b.zoom, a.zoom, 'Opening zoom is unchanged');
      nearly(b.imageWidth, a.imageWidth, 'The initial preview rendering scale remains unchanged');
      nearly(b.imageHeight, a.imageHeight, 'Preview aspect and rendered dimensions remain unchanged');
      assert(b.visibleImageWidth < a.visibleImageWidth, 'The narrower viewport crops the image until the user deliberately Fits or pans');
      assert(b.previewScrollWidth >= b.imageWidth - 1, 'The full rendered preview remains reachable through its internal scrollbar');
      assert.equal(b.windowHeight, a.windowHeight);
      assert.equal(b.windowWidth, 560);
      assert(!b.stacked, 'The 560px default retains a two-panel workspace');
      assert.equal(after.host.length, 0, 'The fixed default must not be overridden by startup resizing');
      if (stableGutter) {
        assert(a.workspaceGutter > 0);
        if (stableGutter === 'both') assert(a.previewChromeWidth > 2);
      }
      const originalControls = await before.workflow(), compactControls = await after.workflow();
      for (let i = 0; i < originalControls.length; i++) {
        const original = originalControls[i], current = compactControls[i];
        nearly(current.width, original.width, `${original.selector} retains its width`);
        assert.deepEqual({ ...current, width: 0 }, { ...original, width: 0 }, `${original.selector} keeps its typography, borders, padding and spacing`);
      }
      assert.equal(await after.page.locator('#panelDivider, [role=separator]').count(), 0, 'The draggable divider and its keyboard focus stop are removed');
      assert(await after.page.locator('#frameLockBtn').isVisible());
      assert.equal(await after.page.locator('#frameLockBtn').getAttribute('aria-pressed'), 'true');
      assert.equal(await after.page.locator('.workflow-step').count(), 5);
      for (const id of ['zoomOutBtn', 'zoomInBtn', 'fitBtn']) {
        const panel = await after.page.locator('#previewPanel').boundingBox(), control = await after.page.locator(`#${id}`).boundingBox();
        assert(control.x >= panel.x && control.x + control.width <= panel.x + panel.width + .1, 'Every preview zoom control fits inside the narrow preview pane');
      }
      assert(await after.page.locator('.preview-caption').evaluate(el => {
        const caption = el.getBoundingClientRect(), workspace = document.getElementById('workspace').getBoundingClientRect();
        return caption.left >= workspace.left && caption.right <= workspace.right && caption.bottom <= workspace.bottom;
      }), 'The wrapped preview caption remains inside the visible plugin workspace');
      results.push({ stableGutter, before: a, after: b });
      if (process.env.COMPACT_SCREENSHOT_DIR && !stableGutter) {
        fs.mkdirSync(process.env.COMPACT_SCREENSHOT_DIR, { recursive: true });
        await before.page.screenshot({ path: path.join(process.env.COMPACT_SCREENSHOT_DIR, 'compact-before.png') });
        await after.page.screenshot({ path: path.join(process.env.COMPACT_SCREENSHOT_DIR, 'compact-after.png') });
      }

      // Old saved ratios/window sizes have no effect, even as unsolicited late messages.
      for (const panelRatio of [.25, .38, .5, .6]) {
        await after.page.evaluate(panelRatio => window.postMessage({ pluginMessage: { type: 'UI_PREFERENCES', panelRatio, width: 1600, height: 1200, windowWidth: 1600, windowHeight: 1200, zoom: 4 } }, '*'), panelRatio);
        await after.settle();
        assert.deepEqual(await after.metrics(), b, 'Obsolete preferences cannot alter the fixed layout or zoom');
      }
      assert.equal(await after.page.evaluate(() => window.__compactMessages.some(message => /UI_PREFERENCES/.test(message.type))), false);

      // Clicking the old divider area cannot change the fixed split.
      const panel = await after.page.locator('#previewPanel').boundingBox();
      await after.page.mouse.move(panel.x + panel.width + 8, panel.y + 24); await after.page.mouse.down();
      await after.page.mouse.move(panel.x + panel.width - 30, panel.y + 24); await after.page.mouse.up();
      await after.settle();
      nearly((await after.metrics()).previewPanelWidth, b.previewPanelWidth, 'The static gap has no hidden resize behavior');

      // Manual cuts still map the actual displayed pixels back to Figma coordinates.
      await after.page.locator('#horizontalBtn').click();
      await after.page.locator('#previewWrap').evaluate(el => { el.scrollLeft = 0; el.scrollTop = 0; });
      const point = await after.page.evaluate(() => {
        const rect = document.getElementById('canvas').getBoundingClientRect();
        return { x: rect.left + 30, y: rect.top + 400 * rect.width / state.frame.width };
      });
      await after.page.mouse.click(point.x, point.y);
      const cuts = await after.page.evaluate(() => state.horizontalCuts);
      assert.equal(cuts.length, 1);
      nearly(cuts[0], 400, 'Narrow-viewport cut position uses original frame coordinates', 4);
      await after.page.evaluate(() => { state.horizontalCuts = Array.from({ length: 13 }, (_, i) => (i + 1) * 600); state.verticalCutsBySection = {}; render(); });
      await after.settle();
      const geometry = () => after.page.evaluate(() => JSON.stringify({ cuts: state.horizontalCuts, columns: state.verticalCutsBySection, regions: buildUiRegions() }));
      const originalGeometry = await geometry();
      await after.page.locator('#zoomInBtn').click(); await after.settle();
      assert((await after.metrics()).imageWidth > b.imageWidth, 'Zoom in still changes the rendering scale');
      await after.page.locator('#zoomOutBtn').click(); await after.settle();
      nearly((await after.metrics()).imageWidth, b.imageWidth, 'Zoom out restores the previous scale');

      // High zoom remains pannable inside the preview without changing slicing data.
      await after.page.evaluate(() => applyZoom(2)); await after.settle();
      await after.page.locator('#previewWrap').evaluate(el => { el.scrollLeft = 120; el.scrollTop = 200; });
      const wrap = await after.page.locator('#previewWrap').boundingBox();
      const scroll = () => after.page.locator('#previewWrap').evaluate(el => ({ left: el.scrollLeft, top: el.scrollTop }));
      const panBefore = await scroll();
      await after.page.mouse.move(wrap.x + 70, wrap.y + 90); await after.page.mouse.down({ button: 'middle' });
      await after.page.mouse.move(wrap.x + 40, wrap.y + 50); await after.page.mouse.up({ button: 'middle' });
      const panAfter = await scroll();
      assert(panAfter.left > panBefore.left + 20 && panAfter.top > panBefore.top + 30, 'Panning moves both preview axes');
      assert.equal(await geometry(), originalGeometry);
      await after.page.evaluate(() => applyZoom(.5)); await after.settle();

      await after.page.locator('#klaviyoAccountTrigger').click();
      await after.page.locator('#klaviyoAccountSearch').fill('VERY LONG');
      assert.equal(await after.page.locator('#klaviyoAccountOptions [role=option]').count(), 1);
      await after.page.locator('#klaviyoAccountOptions [role=option]').click();
      assert.equal(await after.page.locator('#klaviyoAccount').inputValue(), 'account-42');
      await after.page.locator('#refreshAccounts').click(); await after.settle();
      assert.equal(await after.page.locator('#klaviyoAccount').inputValue(), 'account-42', 'Account refresh preserves the original selected ID');

      const imageWidth = (await after.metrics()).imageWidth, resizeCount = after.host.length;
      for (const [width, height] of [[800, 840], [700, 700], [560, 480], [360, 640]]) {
        await after.page.setViewportSize({ width, height }); await after.settle();
        const resized = await after.metrics();
        nearly(resized.imageWidth, imageWidth, `Manual resize to ${width}px cannot silently change rendering scale`);
        if (!resized.stacked) nearly(resized.workflowWidth, b.workflowWidth, 'The right pane remains fixed while the left receives extra window space');
        if (width === 360) assert(resized.stacked, 'A narrow manual window stacks the two panels');
        assert.equal(after.host.length, resizeCount, 'Manual window changes are not overridden by old saved dimensions');
        assert.equal(await geometry(), originalGeometry);
        assert(await after.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        assert(await after.page.locator('#workspace').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
        for (const id of ['frameStep', 'sliceStep', 'reviewStep', 'klaviyoPanel', 'createStep']) {
          await after.page.locator(`#${id}`).scrollIntoViewIfNeeded();
          assert(await after.page.locator(`#${id}`).isVisible());
        }
        await after.page.locator('#klaviyoAccountTrigger').click();
        const popup = await after.page.locator('#klaviyoAccountDropdown').boundingBox();
        assert(popup.x >= 0 && popup.y >= 0 && popup.x + popup.width <= width + .1 && popup.y + popup.height <= height + .1, 'Account search stays inside the webview');
        await after.page.locator('#klaviyoAccountSearch').press('Escape');
      }
      await after.page.setViewportSize(afterOpening); await after.settle();
      await after.page.locator('#fitBtn').click(); await after.settle();
      const fitted = await after.metrics();
      assert.equal(fitted.zoom, 1);
      assert(fitted.imageWidth <= fitted.viewportClientWidth, 'Explicit Fit fits the narrower preview viewport');
      assert.equal(await geometry(), originalGeometry, 'Window, zoom, pan and Fit never alter cuts or export dimensions');
      await after.page.locator('#windowResizeHandle').focus(); await after.page.locator('#windowResizeHandle').press('ArrowRight');
      await after.page.waitForFunction(() => window.__compactMessages.some(message => message.type === 'UI_RESIZE'));
      assert(after.host.length > resizeCount, 'Manual plugin-window resizing is preserved');
      assert.equal(await after.page.evaluate(() => window.__compactMessages.some(message => /UI_PREFERENCES/.test(message.type))), false);
      assert.deepEqual(before.errors, []); assert.deepEqual(after.errors, []);
      assert(before.api.every(url => url.endsWith('/api/klaviyo-accounts')) && after.api.every(url => url.endsWith('/api/klaviyo-accounts')), 'Layout changes never export, upload or create templates');
      await before.page.close(); await after.page.close();
    }
    if (process.env.COMPACT_METRICS_PATH) fs.writeFileSync(process.env.COMPACT_METRICS_PATH, JSON.stringify(results, null, 2));
    console.log('Measured before/after:', JSON.stringify(results));
    console.log('PASS: actual production opens 560×840; right workflow dimensions/styles match 800px baseline; all 240px of reduction comes from the preview; fixed split ignores old preferences; zoom, Fit, panning, cut coordinates, account refresh, window resizing and narrow stacking are preserved.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
