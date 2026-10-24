// Run after npm run build: node tests/active-slice-scroll.cjs
// Loads the manifest's actual production UI. Figma messages and accounts are fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const html = fs.readFileSync(path.join(root, manifest.ui), 'utf8');
assert.equal(html, fs.readFileSync(path.join(root, 'src/ui.html'), 'utf8'), 'Rebuild the production UI before testing');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 840 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(7000);
    const errors = [], apiRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.__hostRequests = [];
      window.addEventListener('message', event => {
        const message = event.data && event.data.pluginMessage;
        if (!message || !['GET_UI_PREFERENCES', 'SAVE_UI_PREFERENCES', 'UI_RESIZE', 'EXPORT', 'REFRESH_SELECTION'].includes(message.type)) return;
        window.__hostRequests.push(message);
        if (message.type === 'GET_UI_PREFERENCES') window.postMessage({ pluginMessage: { type: 'UI_PREFERENCES', panelRatio: .38 } }, '*');
      });
    });
    await page.route('**/*', route => {
      const url = route.request().url();
      if (url === 'https://active-slice.test/') return route.fulfill({ contentType: 'text/html', body: html });
      apiRequests.push(url);
      if (url.endsWith('/api/klaviyo-accounts')) return route.fulfill({ json: { accounts: [{ id: 'fixture-account', displayName: 'Fixture account' }] } });
      errors.push(`Unexpected API operation: ${url}`);
      return route.abort();
    });
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
    const reveal = async (height = 8400, cuts = Array.from({ length: 13 }, (_, index) => (index + 1) * 600)) => {
      await page.evaluate(({ height, cuts }) => {
        const image = document.createElement('canvas'); image.width = 600; image.height = height;
        const ctx = image.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 600, height);
        for (let y = 0; y < height; y += 600) {
          ctx.fillStyle = y % 1200 ? '#eaf8ff' : '#eef2f6'; ctx.fillRect(12, y + 12, 576, Math.min(570, height - y));
        }
        const preview = Uint8Array.from(atob(image.toDataURL('image/png').split(',')[1]), char => char.charCodeAt(0));
        window.postMessage({ pluginMessage: {
          type: 'FRAME_READY', frame: { id: 'long-email', name: 'Long email scroll fixture', width: 600, height, autoScale: 2 },
          layerBounds: [], preview,
          textItems: cuts.flatMap((stop, index) => [
            { id: `body-${index}`, text: `Body text ${index + 1}`, x: 30, y: stop - 560, width: 180, height: 30 },
            { id: `cta-${index}`, text: `Shop slice ${index + 1}`, x: 30, y: stop - 500, width: 180, height: 30 }
          ])
        } }, '*');
      }, { height, cuts });
      await page.locator('#workspace').waitFor({ state: 'visible' });
      await page.waitForFunction(height => state.frame && state.frame.height === height && document.getElementById('preview').complete && document.getElementById('preview').naturalHeight === height, height);
      await page.evaluate(cuts => { state.horizontalCuts = cuts; state.verticalCutsBySection = {}; render(); }, cuts);
      await settle();
    };
    const business = () => page.evaluate(() => ({
      cuts: state.horizontalCuts, columns: state.verticalCutsBySection, regions: buildUiRegions(),
      alt: state.altTextOverrides, manual: state.altManualEdited, urls: state.sliceUrlOverrides,
      included: state.altSelections, cta: state.altCtaBySlice,
      prepared: state.preparedBackendResult, files: state.klaviyoFiles
    }));
    const workspaceScroll = () => page.locator('#workspace').evaluate(el => ({ top: el.scrollTop, left: el.scrollLeft }));
    const metrics = () => page.evaluate(() => {
      const wrap = document.getElementById('previewWrap'), highlight = document.querySelector('.review-highlight');
      const viewport = wrap.getBoundingClientRect(), rect = highlight.getBoundingClientRect();
      const top = rect.top - viewport.top - wrap.clientTop + wrap.scrollTop;
      const left = rect.left - viewport.left - wrap.clientLeft + wrap.scrollLeft;
      const maxTop = Math.max(0, wrap.scrollHeight - wrap.clientHeight), maxLeft = Math.max(0, wrap.scrollWidth - wrap.clientWidth);
      const clamp = (value, max) => Math.max(0, Math.min(max, value));
      return {
        top, left, height: rect.height, width: rect.width, viewportHeight: wrap.clientHeight, viewportWidth: wrap.clientWidth,
        scrollTop: wrap.scrollTop, scrollLeft: wrap.scrollLeft, maxTop, maxLeft,
        expectedCenterTop: clamp(top + rect.height / 2 - wrap.clientHeight / 2, maxTop),
        expectedStartTop: clamp(top, maxTop)
      };
    });
    const waitLocated = async () => {
      await settle();
      await page.waitForFunction(() => {
        const wrap = document.getElementById('previewWrap'), highlight = document.querySelector('.review-highlight');
        const viewport = wrap.getBoundingClientRect(), rect = highlight.getBoundingClientRect();
        const top = rect.top - viewport.top - wrap.clientTop + wrap.scrollTop;
        const max = Math.max(0, wrap.scrollHeight - wrap.clientHeight);
        const target = Math.max(0, Math.min(max, top + rect.height / 2 - wrap.clientHeight / 2));
        const start = Math.max(0, Math.min(max, top));
        return rect.height <= wrap.clientHeight
          ? Math.abs(wrap.scrollTop - target) <= 3
          : wrap.scrollTop >= start - 24 && wrap.scrollTop <= start + 2;
      });
      const value = await metrics();
      assert(value.scrollTop >= 0 && value.scrollTop <= value.maxTop, 'Preview scroll stays clamped');
      return value;
    };
    const next = () => page.locator('.review-nav').getByRole('button', { name: 'Next →', exact: true });
    const previous = () => page.locator('.review-nav').getByRole('button', { name: '← Previous', exact: true });
    const locate = () => page.locator('.review-locate-slice');

    await page.goto('https://active-slice.test/');
    await reveal();
    assert.equal(await page.evaluate(() => buildUiRegions().length), 13);
    await page.evaluate(() => {
      const wrap = document.getElementById('previewWrap'), nativeScroll = wrap.scrollTo.bind(wrap);
      window.__previewScrolls = [];
      wrap.scrollTo = (...args) => { window.__previewScrolls.push(args); return nativeScroll(...args); };
    });
    await page.locator('.review-nav').scrollIntoViewIfNeeded();
    const originalOuter = await workspaceScroll();
    const originalGeometry = await page.evaluate(() => ({ cuts: state.horizontalCuts, columns: state.verticalCutsBySection, regions: buildUiRegions() }));
    for (let index = 1; index <= 7; index++) {
      await next().click();
      await waitLocated();
      assert.equal(await page.evaluate(() => state.activeReviewIndex), index);
    }
    assert.deepEqual(await workspaceScroll(), originalOuter, 'Navigating to Slice 8 scrolls only the email preview');
    assert.match(await locate().textContent(), /Slice 8 of 13/);
    assert((await metrics()).scrollTop > 0, 'Long-email navigation actually moves the preview');
    assert.equal(await page.evaluate(() => window.__previewScrolls.at(-1)[0].behavior), 'auto', 'Reduced motion uses immediate preview scrolling');
    if (process.env.ACTIVE_SLICE_SCREENSHOT) await page.screenshot({ path: process.env.ACTIVE_SLICE_SCREENSHOT });

    // Per-slice content and optional CTA remain associated with Slice 8.
    await page.locator('.text-slice-title').getByRole('button', { name: 'Select all', exact: true }).click();
    await page.locator('.text-row .cta-choice input').last().check();
    await page.locator('.alt-final').fill('Preserve this hand-edited alt text for slice eight.');
    await page.locator('.slice-link-panel input').fill('https://example.test/slice-eight');
    const editingState = await business();
    await next().click(); await waitLocated();
    await previous().click(); await waitLocated();
    assert.equal(await page.locator('.alt-final').inputValue(), 'Preserve this hand-edited alt text for slice eight.');
    assert.equal(await page.locator('.slice-link-panel input').inputValue(), 'https://example.test/slice-eight');
    assert.equal(await page.locator('.text-choice:checked').count(), 2);
    assert(await page.locator('.text-row .cta-choice input').last().isChecked());
    assert.deepEqual(await business(), editingState, 'Next/Previous preserve all existing editing and prepared data');

    // Re-locating the current index changes neither active state nor outer scroll.
    await page.locator('.review-nav').scrollIntoViewIfNeeded();
    await page.locator('#previewWrap').evaluate(el => { el.scrollTop = 0; });
    const outerBeforeLocate = await workspaceScroll(), dataBeforeLocate = await business();
    await locate().click(); await waitLocated();
    assert.equal(await page.evaluate(() => state.activeReviewIndex), 7);
    assert.deepEqual(await workspaceScroll(), outerBeforeLocate);
    assert.deepEqual(await business(), dataBeforeLocate);
    assert(await page.locator('.review-highlight').isVisible());
    await page.locator('#previewWrap').evaluate(el => { el.scrollTop = 0; });
    await locate().press('Enter'); await waitLocated();
    assert.equal(await page.evaluate(() => state.activeReviewIndex), 7, 'Keyboard activation locates the current index without navigating');

    // Editing after a manual scroll must never recenter the preview.
    await page.locator('#previewWrap').evaluate(el => { el.scrollTop = 0; window.__previewScrolls = []; });
    await page.locator('.alt-final').fill('Another manual edit without changing the current slice.');
    await page.locator('.slice-link-panel input').fill('https://example.test/manual-scroll');
    await page.locator('.text-choice').first().uncheck();
    await settle();
    assert.equal((await metrics()).scrollTop, 0, 'Text, URL and inclusion edits do not fight a manually scrolled preview');
    assert.equal(await page.evaluate(() => window.__previewScrolls.length), 0, 'Unrelated rerenders do not request scrolling');

    // Navigation immediately after a panel-width change must win over pending zoom restoration.
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.evaluate(() => {
      document.getElementById('previewPanel').style.flexBasis = '280px';
      Array.from(document.querySelectorAll('.review-nav button')).find(button => button.textContent === 'Next →').click();
    });
    try { await waitLocated(); } catch (error) {
      console.error('Rapid panel resize/navigation geometry:', await metrics());
      throw error;
    }
    assert.equal(await page.evaluate(() => state.activeReviewIndex), 8);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.locator('#previewPanel').evaluate(el => { el.style.flexBasis = ''; });
    await settle();
    await previous().evaluate(el => el.click()); await waitLocated();

    // Responsive widths and zoom use the actual rendered slice, not original pixels.
    for (const [width, height, zoom] of [[1100, 840, .5], [900, 650, 1], [700, 700, 1.75], [360, 500, .5]]) {
      await page.setViewportSize({ width, height }); await settle();
      await page.evaluate(zoom => applyZoom(zoom), zoom); await settle();
      await page.locator('#previewWrap').evaluate(el => { el.scrollTop = 0; });
      const outer = await workspaceScroll();
      await locate().evaluate(el => el.click());
      const value = await waitLocated();
      assert.deepEqual(await workspaceScroll(), outer, `Locate at ${width}px never scrolls the plugin page`);
      if (value.height <= value.viewportHeight) assert(Math.abs(value.scrollTop - value.expectedCenterTop) <= 3, 'Rendered slice is centered when it fits');
      else assert(value.scrollTop >= value.expectedStartTop - 24 && value.scrollTop <= value.expectedStartTop + 2, 'Oversized slice starts near viewport top');
      assert.deepEqual(await page.evaluate(() => ({ cuts: state.horizontalCuts, columns: state.verticalCutsBySection, regions: buildUiRegions() })), originalGeometry);
    }

    // Actual smooth scrolling is used when the user has not requested reduced motion.
    await page.setViewportSize({ width: 1100, height: 840 }); await settle();
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.locator('#previewWrap').evaluate(el => { el.scrollTop = 0; });
    await locate().evaluate(el => el.click());
    await waitLocated();
    assert.equal(await page.evaluate(() => window.__previewScrolls.at(-1)[0].behavior), 'smooth');
    await page.emulateMedia({ reducedMotion: 'reduce' });

    // First/last slices clamp correctly. Multi-column slices are horizontally located.
    await page.locator('.review-nav select').selectOption('0'); await waitLocated();
    assert.equal((await metrics()).scrollTop, 0);
    await page.locator('.review-nav select').selectOption('12'); await waitLocated();
    assert((await metrics()).scrollTop <= (await metrics()).maxTop);
    await page.evaluate(() => { state.verticalCutsBySection['7'] = [300]; render(); applyZoom(3); });
    await settle();
    await page.locator('.review-nav select').selectOption('8'); await waitLocated();
    const column = await metrics();
    assert(column.left + column.width > column.scrollLeft && column.left < column.scrollLeft + column.viewportWidth, 'Right-column active slice is visible at high zoom');
    if (column.width <= column.viewportWidth) assert(column.left >= column.scrollLeft - 2 && column.left + column.width <= column.scrollLeft + column.viewportWidth + 2);

    // A short email with no scroll range still highlights and locates without errors.
    await reveal(200, []);
    await locate().evaluate(el => el.click()); await waitLocated();
    assert.equal((await metrics()).scrollTop, 0);
    assert.equal(await page.evaluate(() => state.activeReviewIndex), 0);
    assert.equal(await page.evaluate(() => window.__hostRequests.filter(message => message.type === 'EXPORT').length), 0, 'Navigation never prepares, saves or exports a template');
    assert.equal(apiRequests.length, 1, 'Reviewing and locating slices only use already loaded state');
    assert.deepEqual(errors, []);
    console.log(`PASS: ${manifest.ui} auto-locates Slice 8 using Next/Previous and the current-index button; rendered centering/top alignment, smooth/reduced motion, preview-only clamping, responsive zoom/columns, editing preservation and no export/API side effects verified.`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
