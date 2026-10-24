// Run after `npm run build`: node tests/redesign-workflow.cjs
// Requires Playwright and Chromium. All Figma-host and backend operations are fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const ui = fs.readFileSync(path.join(root, manifest.ui), 'utf8');
assert.equal(ui, fs.readFileSync(path.join(root, 'src/ui.html'), 'utf8'), 'Rebuild the manifest UI before testing');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 840 }, acceptDownloads: true });
    page.setDefaultTimeout(7000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let savedPanelRatio = 0.38, healthStatus = 200, createStatus = 200, uploadedPayload, uploadedFiles = [], createBody;
    await page.exposeFunction('__readFixturePanelRatio', () => savedPanelRatio);
    await page.exposeFunction('__writeFixturePanelRatio', ratio => { savedPanelRatio = ratio; });
    await page.addInitScript(() => {
      window.__hostRequests = [];
      const requests = new Set(['GET_UI_PREFERENCES', 'SAVE_UI_PREFERENCES', 'UI_RESIZE', 'EXPORT', 'REFRESH_SELECTION', 'CLOSE']);
      window.addEventListener('message', async event => {
        const message = event.data && event.data.pluginMessage;
        if (!message || !requests.has(message.type)) return;
        window.__hostRequests.push(message);
        if (message.type === 'SAVE_UI_PREFERENCES') {
          await window.__writeFixturePanelRatio(message.panelRatio);
          window.__savedPanelRatio = message.panelRatio;
        }
        if (message.type === 'GET_UI_PREFERENCES') {
          window.postMessage({ pluginMessage: { type: 'UI_PREFERENCES', panelRatio: await window.__readFixturePanelRatio() } }, '*');
        }
      });
    });
    const accounts = Array.from({ length: 81 }, (_, index) => ({ id: `account-${index}`, displayName: index === 42 ? 'Northwind Store' : `Account ${index}` }));
    await page.route('**/*', async route => {
      const request = route.request(), url = request.url();
      if (url === 'https://redesign-plugin.test/') return route.fulfill({ contentType: 'text/html', body: ui });
      if (url.endsWith('/api/klaviyo-accounts')) return route.fulfill({ json: { accounts } });
      if (url.endsWith('/health')) return route.fulfill({ status: healthStatus, json: { ok: healthStatus === 200 } });
      if (url.endsWith('/api/prepare-klaviyo')) {
        assert.equal(request.method(), 'POST');
        const body = request.postDataBuffer().toString('utf8');
        const payloadPart = body.match(/name="payload"\r\n\r\n([\s\S]*?)\r\n--/);
        assert(payloadPart, 'Preparation retains the multipart JSON payload');
        uploadedPayload = JSON.parse(payloadPart[1]);
        uploadedFiles = [...body.matchAll(/filename="([^"]+)"/g)].map(match => match[1]);
        return route.fulfill({ json: {
          templateName: uploadedPayload.templateName,
          slices: uploadedPayload.slices.map(slice => ({ ...slice, imageUrl: `https://images.test/${slice.filename}`, originalSizeBytes: 100, compressedSizeBytes: 60 }))
        } });
      }
      if (url.endsWith('/api/create-klaviyo-template')) {
        assert.equal(request.method(), 'POST');
        createBody = request.postDataJSON();
        return route.fulfill({ status: createStatus, json: createStatus === 200
          ? { templateName: createBody.templateName, accountName: 'Northwind Store', rowCount: createBody.slices.length, tableRowCount: 1 }
          : { error: 'Fixture account permission denied' } });
      }
      errors.push(`Unexpected request: ${url}`);
      return route.abort();
    });

    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const post = message => page.evaluate(message => window.postMessage({ pluginMessage: message }, '*'), message);
    const hostRequests = type => page.evaluate(type => window.__hostRequests.filter(message => message.type === type), type);
    const geometry = () => page.evaluate(() => ({ cuts: state.horizontalCuts, columns: state.verticalCutsBySection, regions: buildUiRegions() }));
    const assertNotificationDock = async () => {
      const dock = await page.evaluate(() => {
        const workspace = document.getElementById('workspace').getBoundingClientRect(), notices = document.getElementById('toastRegion').getBoundingClientRect();
        return { workspaceBottom: workspace.bottom, workspaceHeight: workspace.height, noticesTop: notices.top, noticesBottom: notices.bottom, noticesHeight: notices.height, viewportHeight: innerHeight };
      });
      assert(dock.noticesHeight > 0, 'Notifications remain visible in their reserved footer');
      assert(dock.workspaceBottom <= dock.noticesTop + 1, 'Notification footer never overlaps the workflow scroll area');
      assert(dock.noticesBottom <= dock.viewportHeight + 1 && dock.workspaceHeight > 100, 'Footer keeps a usable workflow inside the plugin window');
      await page.locator('#prepareKlaviyo').scrollIntoViewIfNeeded();
      assert(await page.locator('#prepareKlaviyo').evaluate(element => {
        const rect = element.getBoundingClientRect(), hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return element === hit || element.contains(hit);
      }), 'Footer notifications do not obscure the primary action');
    };
    const shot = async name => {
      if (!process.env.REDESIGN_SCREENSHOT_DIR) return;
      fs.mkdirSync(process.env.REDESIGN_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.REDESIGN_SCREENSHOT_DIR, `${name}.png`) });
    };
    const revealFrame = async () => {
      await page.evaluate(() => {
        const image = document.createElement('canvas'); image.width = 600; image.height = 1200;
        const ctx = image.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 600, 1200);
        ctx.fillStyle = '#172b3a'; ctx.fillRect(0, 0, 600, 180);
        ctx.fillStyle = '#fff'; ctx.font = 'bold 32px sans-serif'; ctx.fillText('NEW ARRIVALS', 30, 72);
        ctx.fillStyle = '#e8f6fb'; ctx.fillRect(30, 200, 250, 160); ctx.fillRect(320, 200, 250, 160);
        ctx.fillStyle = '#00b8f5'; ctx.fillRect(30, 400, 540, 320);
        ctx.fillStyle = '#edf1f5'; ctx.fillRect(30, 800, 540, 340);
        const preview = Uint8Array.from(atob(image.toDataURL('image/png').split(',')[1]), character => character.charCodeAt(0));
        window.postMessage({ pluginMessage: {
          type: 'FRAME_READY',
          frame: { id: 'email-frame', name: 'Northwind / New arrivals — summer email with a long descriptive frame name', width: 600, height: 1200, autoScale: 2 },
          layerBounds: [{ x: 0, y: 0, width: 600, height: 400 }, { x: 0, y: 400, width: 600, height: 400 }, { x: 0, y: 800, width: 600, height: 400 }],
          textItems: [
            { id: 'heading', text: 'New arrivals', x: 30, y: 40, width: 230, height: 30 },
            { id: 'intro', text: 'Made for your everyday', x: 30, y: 100, width: 230, height: 30 },
            { id: 'cta', text: 'Shop collection', x: 30, y: 250, width: 220, height: 30 },
            ...Array.from({ length: 5 }, (_, index) => ({ id: `detail-${index}`, text: `Product detail ${index + 1}`, x: 30, y: 145 + index * 18, width: 230, height: 15 })),
            { id: 'right-column', text: 'Thoughtful design', x: 350, y: 100, width: 210, height: 35 },
            { id: 'lower-row', text: 'Explore the collection', x: 30, y: 500, width: 450, height: 35 }
          ], preview
        } }, '*');
      });
      await page.locator('#workspace').waitFor({ state: 'visible' });
      await page.waitForFunction(() => state.frame && document.getElementById('preview').complete && document.getElementById('preview').naturalWidth === 600);
      await settle();
    };
    const clickDesign = async (x, y) => {
      await page.locator('#previewWrap').scrollIntoViewIfNeeded();
      await page.evaluate(({ x, y }) => {
        const wrap = document.getElementById('previewWrap'), scale = canvasScale();
        wrap.scrollLeft = Math.max(0, x * scale - wrap.clientWidth / 2);
        wrap.scrollTop = Math.max(0, y * scale - wrap.clientHeight / 2);
      }, { x, y });
      await settle();
      const target = await page.evaluate(({ x, y }) => {
        const rect = document.getElementById('canvas').getBoundingClientRect(), scale = canvasScale();
        return { x: rect.left + x * scale, y: rect.top + y * scale };
      }, { x, y });
      await page.mouse.click(target.x, target.y);
      await settle();
    };

    await page.goto('https://redesign-plugin.test/');
    await revealFrame();
    await page.waitForFunction(() => !document.getElementById('klaviyoAccountTrigger').disabled);
    for (const id of ['frameStep', 'sliceStep', 'reviewStep', 'klaviyoPanel', 'createStep']) {
      assert.equal(await page.locator(`#workflowPanel #${id}.workflow-step`).count(), 1, `${id} remains in the same workflow page`);
    }
    const initialPanels = await page.evaluate(() => {
      const preview = document.getElementById('previewPanel').getBoundingClientRect(), workflow = document.getElementById('workflowPanel').getBoundingClientRect();
      return { preview: { x: preview.x, y: preview.y, right: preview.right }, workflow: { x: workflow.x, y: workflow.y } };
    });
    assert(initialPanels.preview.right <= initialPanels.workflow.x, 'Wide view has side-by-side preview and workflow');
    assert.equal(await page.evaluate(() => state.zoom), 0.5, 'Frame selection retains the existing default zoom');
    await shot('wide-default');

    // Exercise the original slice controls and their original design coordinates.
    await page.locator('#horizontalBtn').click();
    await clickDesign(100, 400); await clickDesign(100, 800);
    assert.deepEqual((await geometry()).cuts, [400, 800]);
    await page.locator('#equal2Btn').click(); await clickDesign(100, 200);
    assert.deepEqual((await geometry()).columns['0'], [300]);
    await page.locator('#equal3Btn').click(); await clickDesign(100, 600);
    assert.deepEqual((await geometry()).columns['1'], [200, 400]);
    await page.locator('#verticalBtn').click(); await clickDesign(450, 200);
    const customColumns = (await geometry()).columns['0'];
    assert.equal(customColumns.length, 2);
    assert(customColumns.includes(300));
    assert(Math.abs(customColumns.find(value => value !== 300) - 450) < 1, 'Manual cuts map pointer coordinates back to the design within pixel rounding');
    await clickDesign(450, 200); // Clicking the existing guide removes that cut.
    assert.deepEqual((await geometry()).columns['0'], [300]);
    await page.locator('#undoBtn').click();
    assert.deepEqual((await geometry()).columns['0'], customColumns);
    await page.locator('#resetBtn').click();
    assert.deepEqual((await geometry()).cuts, []);
    await page.locator('#undoBtn').click();
    assert.deepEqual((await geometry()).cuts, [400, 800]);
    await page.locator('#resetBtn').click();
    await page.locator('#horizontalBtn').click(); await clickDesign(100, 400); await clickDesign(100, 800);
    await page.locator('#equal2Btn').click(); await clickDesign(100, 200);
    assert.equal((await geometry()).regions.length, 3, 'Footer exclusion and column layout remain intact');

    // Footer exclusion remains an explicit export boundary, and empty slices are reviewable.
    await page.locator('#excludeAfterLastCut').uncheck();
    assert.equal((await geometry()).regions.length, 4);
    await page.evaluate(() => setActiveReviewIndex(3));
    assert.match(await page.locator('#textSlices').textContent(), /No text was detected/);
    assert(await page.locator('.alt-builder input[type=radio]').isChecked(), 'An empty slice starts without a CTA divider');
    assert(await page.locator('.review-nav').getByRole('button', { name: 'Next →', exact: true }).isDisabled());
    await page.locator('#excludeAfterLastCut').check();
    assert.equal((await geometry()).regions.length, 3);

    // Review inclusion, single CTA, manual alt text and links survive navigation.
    await page.evaluate(() => setActiveReviewIndex(0));
    assert(await page.locator('.review-nav').getByRole('button', { name: '← Previous', exact: true }).isDisabled());
    await page.locator('.text-slice-title').getByRole('button', { name: 'Select all', exact: true }).click();
    const ctaRow = page.locator('.text-row').filter({ hasText: 'Shop collection' });
    await ctaRow.locator('input[type=radio]').check();
    assert.equal(await page.locator('.text-row input[type=radio]:checked').count(), 1);
    assert.match(await page.locator('.alt-final').inputValue(), /\| Shop collection$/);
    await page.locator('.text-row').filter({ hasText: 'Made for your everyday' }).locator('.text-choice').uncheck();
    assert(!(await page.locator('.alt-final').inputValue()).includes('Made for your everyday'));
    await page.locator('.alt-final').fill('A hand-edited description of the collection');
    await page.locator('.slice-link-panel input').fill('https://example.test/collection');
    await page.locator('.review-nav').getByRole('button', { name: 'Next →', exact: true }).click();
    assert.equal(await page.evaluate(() => state.activeReviewIndex), 1);
    await page.locator('.text-slice-title').getByRole('button', { name: 'Select all', exact: true }).click();
    assert.equal(await page.locator('.text-choice:checked').count(), 1);
    await page.locator('.text-slice-title').getByRole('button', { name: 'Clear', exact: true }).click();
    assert.equal(await page.locator('.text-choice:checked').count(), 0);
    assert.equal(await page.locator('.alt-final').inputValue(), '');
    assert(await page.locator('.alt-builder input[type=radio]').isChecked());
    await page.locator('.review-nav').getByRole('button', { name: '← Previous', exact: true }).click();
    assert.equal(await page.locator('.alt-final').inputValue(), 'A hand-edited description of the collection');
    assert.equal(await page.locator('.slice-link-panel input').inputValue(), 'https://example.test/collection');
    assert.equal(await page.evaluate(() => state.altCtaBySlice['0-0']), 'cta');
    assert(await page.locator('.review-highlight').isVisible());
    await shot('content-review');

    const preserved = await geometry();
    await page.locator('#canvas button.slice-label').nth(1).click();
    assert.equal(await page.evaluate(() => state.activeReviewIndex), 1, 'Preview slice labels navigate content review');
    assert.deepEqual(await geometry(), preserved, 'Reviewing a preview label must not create or change cuts');
    await page.locator('#canvas button.slice-label').first().click();
    assert.equal(await page.evaluate(() => state.activeReviewIndex), 0);
    // Split changes and view-only interactions must never mutate slice data.
    const divider = page.locator('#panelDivider');
    await page.locator('#workspace').evaluate(element => element.scrollTo(0, 0)); await settle();
    const dividerBox = await divider.boundingBox(), workspaceBox = await page.locator('#workspace').boundingBox();
    const dividerY = Math.max(dividerBox.y, workspaceBox.y) + Math.min(40, workspaceBox.height / 2);
    await page.mouse.move(dividerBox.x + dividerBox.width / 2, dividerY);
    await page.mouse.down(); await page.mouse.move(dividerBox.x + dividerBox.width / 2 + 60, dividerY, { steps: 5 }); await page.mouse.up();
    await page.waitForFunction(() => typeof window.__savedPanelRatio === 'number' && window.__savedPanelRatio !== 0.38);
    assert.notEqual(savedPanelRatio, 0.38, 'Divider saves the changed panel proportion');
    await divider.focus(); await divider.press('ArrowRight');
    await page.locator('#zoomInBtn').click(); await page.locator('#zoomOutBtn').click(); await page.locator('#fitBtn').click();
    const beforeKeyboardZoom = await page.evaluate(() => state.zoom);
    await page.locator('#zoomInBtn').focus(); await page.keyboard.press('Control+=');
    assert(await page.evaluate(() => state.zoom) > beforeKeyboardZoom, 'Ctrl+plus still zooms while a button has focus');
    const beforeSpaceZoom = await page.evaluate(() => state.zoom);
    await page.locator('#zoomInBtn').press('Space');
    assert(await page.evaluate(() => state.zoom) > beforeSpaceZoom, 'Space activates the focused zoom button');
    assert.equal(await page.evaluate(() => state.spacePressed), false, 'Button activation does not enable canvas panning');
    await page.locator('.review-context > summary').click();
    assert(await page.locator('.review-context').evaluate(element => element.open));
    await page.locator('#fitBtn').click();
    assert(await page.locator('.review-context').evaluate(element => element.open), 'Optional preview remains expanded across view rerenders');
    await page.locator('#previewWrap').evaluate(el => { el.scrollTop = 50; el.scrollLeft = 10; });
    assert.deepEqual(await geometry(), preserved);
    const preferenceMessages = await hostRequests('SAVE_UI_PREFERENCES');
    assert(preferenceMessages.every(message => typeof message.panelRatio === 'number' && message.panelRatio > 0 && message.panelRatio < 1));
    assert(preferenceMessages.every(message => !Object.keys(message).some(key => /zoom/i.test(key))), 'Only panel proportions are persisted, never preview zoom');
    await page.locator('#wideViewBtn').click();
    await page.waitForFunction(() => window.__hostRequests.some(message => message.type === 'UI_RESIZE'));
    assert((await hostRequests('UI_RESIZE')).length > 0, 'Window expansion uses the Figma-host resize message');

    for (const [width, height] of [[1100, 840], [900, 650], [700, 700], [360, 500], [1100, 480]]) {
      await page.setViewportSize({ width, height }); await settle();
      assert.deepEqual(await geometry(), preserved, `Viewport ${width}×${height} cannot alter slices`);
      const layout = await page.evaluate(() => {
        const preview = document.getElementById('previewPanel').getBoundingClientRect(), workflow = document.getElementById('workflowPanel').getBoundingClientRect(), workspace = document.getElementById('workspace');
        return { scrollWidth: document.documentElement.scrollWidth, innerWidth, workspaceScrollWidth: workspace.scrollWidth, workspaceWidth: workspace.clientWidth, previewBottom: preview.bottom, previewRight: preview.right, workflowTop: workflow.top, workflowLeft: workflow.left };
      });
      assert(layout.scrollWidth <= layout.innerWidth + 1, `No horizontal document overflow at ${width}×${height}`);
      assert(layout.workspaceScrollWidth <= layout.workspaceWidth + 1, `No horizontal workflow overflow at ${width}×${height}`);
      if (width < 840) assert(layout.previewBottom <= layout.workflowTop + 1, 'Narrow view stacks preview above controls');
      else assert(layout.previewRight <= layout.workflowLeft + 1, 'Usable widths retain two columns');
      await page.locator('#createStep').scrollIntoViewIfNeeded();
      assert(await page.locator('#createStep').isVisible(), 'The final action area remains reachable by scrolling');
      await page.locator('#frameStep').scrollIntoViewIfNeeded();
      assert(await page.locator('#frameStep').isVisible(), 'The first step remains reachable from the final action area');
      const overlay = await page.evaluate(() => {
        const highlight = document.querySelector('.review-highlight'), region = buildUiRegions()[state.activeReviewIndex], scale = canvasScale();
        return { left: parseFloat(highlight.style.left), top: parseFloat(highlight.style.top), width: parseFloat(highlight.style.width), expectedLeft: region.x * scale, expectedTop: region.y * scale, expectedWidth: region.width * scale };
      });
      assert(Math.abs(overlay.left - overlay.expectedLeft) < 1 && Math.abs(overlay.top - overlay.expectedTop) < 1 && Math.abs(overlay.width - overlay.expectedWidth) < 1, 'Overlay remains mapped to design coordinates');
      await page.evaluate(() => showToast('Fixture warning about panel layout preferences.', 'warning'));
      await settle(); await assertNotificationDock();
      while (await page.locator('#toastRegion button[aria-label="Dismiss notification"]').count()) {
        await page.locator('#toastRegion button[aria-label="Dismiss notification"]').first().click();
      }
      await settle();
      if (width === 360) {
        await page.locator('#workspace').evaluate(element => element.scrollTo(0, 0));
        await shot('narrow-stacked');
      }
      if (height === 480) await shot('short-window');
    }
    await page.setViewportSize({ width: 1100, height: 840 }); await settle();

    // Account IDs still flow from the custom combobox to the unchanged template API.
    await page.locator('#klaviyoAccountTrigger').click();
    await page.locator('#klaviyoAccountSearch').fill('nOrTh');
    await page.locator('#klaviyoAccountOptions [role=option]').click();
    assert.equal(await page.locator('#klaviyoAccount').inputValue(), 'account-42');
    await page.locator('#klaviyoAccountTrigger').click(); await shot('account-dropdown'); await page.locator('#klaviyoAccountSearch').press('Escape');

    // The manual ZIP export remains available and produces the expected JPEG members.
    await page.locator('#exportBtn').evaluate(element => {
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        if (ancestor.tagName === 'DETAILS') ancestor.open = true;
      }
    });
    const zipExportBefore = (await hostRequests('EXPORT')).length;
    await page.locator('#exportBtn').click();
    await page.waitForFunction(expected => window.__hostRequests.filter(message => message.type === 'EXPORT').length > expected, zipExportBefore);
    for (const region of preserved.regions) await post({ type: 'EXPORTED_FILE', filename: `${region.number}.jpg`, bytes: [255, 216, 255, 217] });
    const downloadReady = page.waitForEvent('download');
    await post({ type: 'EXPORT_COMPLETE', count: 3, zipName: 'fixture-slices.zip' });
    const download = await downloadReady;
    assert.equal(download.suggestedFilename(), 'fixture-slices.zip');
    const zipBytes = Array.from(fs.readFileSync(await download.path()));
    const zipNames = await page.evaluate(async bytes => Object.keys((await JSZip.loadAsync(new Uint8Array(bytes))).files), zipBytes);
    assert.deepEqual(zipNames, ['1.jpg', '2.jpg', '3.jpg']);
    await page.waitForFunction(() => !state.exporting);

    const exportBefore = (await hostRequests('EXPORT')).length;
    await page.locator('#prepareKlaviyo').click();
    await page.waitForFunction(expected => window.__hostRequests.filter(message => message.type === 'EXPORT').length > expected, exportBefore);
    const exportRequest = (await hostRequests('EXPORT')).at(-1);
    assert.deepEqual(exportRequest.horizontalCuts, preserved.cuts);
    assert.deepEqual(exportRequest.verticalCutsBySection, preserved.columns);
    assert.equal(exportRequest.excludeAfterLastCut, true);
    await page.locator('#prepareKlaviyo').evaluate(el => el.click());
    assert.equal((await hostRequests('EXPORT')).length, exportBefore + 1, 'Repeated preparation is guarded while exporting');
    await post({ type: 'EXPORT_PROGRESS', current: 1, total: 3 });
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('1 of 3'));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.locator('#operationStatus').evaluate(element => getComputedStyle(element, '::before').animationName), 'none', 'Reduced motion disables the progress spinner animation');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await shot('export-progress');
    for (const region of preserved.regions) await post({ type: 'EXPORTED_FILE', filename: `${region.number}.jpg`, bytes: [255, 216, 255, 217] });
    await post({ type: 'EXPORT_COMPLETE', count: 3, zipName: 'fixture-slices.zip' });
    await page.waitForFunction(() => state.preparedBackendResult && !state.backendUploading);
    assert.deepEqual(uploadedFiles, ['1.jpg', '2.jpg', '3.jpg']);
    assert.equal(uploadedPayload.slices[0].altText, 'A hand-edited description of the collection');
    assert.equal(uploadedPayload.slices[0].url, 'https://example.test/collection');
    assert.equal(uploadedPayload.slices[0].width, 300);
    assert.equal(uploadedPayload.slices[0].rowWidth, 600);
    assert(uploadedPayload.slices.every(slice => slice.imageReady));
    await page.locator('#createKlaviyoTemplate').click();
    await page.waitForFunction(() => document.getElementById('klaviyoCreateStatus').textContent.includes('Created'));
    assert.equal(createBody.accountId, 'account-42');
    assert.equal(createBody.slices.length, 3);
    assert.equal(createBody.slices[0].url, 'https://example.test/collection');
    assert.equal(createBody.slices[0].altText, 'A hand-edited description of the collection');
    assert(!await page.locator('#prepareKlaviyo').isDisabled());

    // Preserve actionable errors and restore controls after failures.
    createStatus = 403;
    await page.locator('#createKlaviyoTemplate').click();
    await page.waitForFunction(() => document.getElementById('klaviyoCreateStatus').textContent.includes('Fixture account permission denied'));
    assert(!await page.locator('#createKlaviyoTemplate').isDisabled());
    healthStatus = 503;
    await page.locator('#prepareKlaviyo').click();
    for (const region of preserved.regions) await post({ type: 'EXPORTED_FILE', filename: `${region.number}.jpg`, bytes: [255, 216, 255, 217] });
    await post({ type: 'EXPORT_COMPLETE', count: 3, zipName: 'fixture-slices.zip' });
    await page.waitForFunction(() => document.getElementById('uploadStatus').textContent.includes('health check returned 503'));
    await settle(); await assertNotificationDock();
    assert.match(await page.locator('#operationStatus').textContent(), /Upload failed/, 'Idle feedback must not say images are ready after a failed retry');
    assert.match(await page.locator('#toastRegion .toast').first().textContent(), /health check returned 503/, 'The latest actionable error is visible before older notifications');
    assert.equal(await page.evaluate(() => state.backendUploading), false);
    assert(!await page.locator('#prepareKlaviyo').isDisabled());
    await shot('upload-error');
    await page.locator('#prepareKlaviyo').click();
    await post({ type: 'EXPORT_ERROR', message: 'Fixture frame export failed' });
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('Fixture frame export failed'));
    assert.equal(await page.evaluate(() => state.exporting), false);
    assert(!await page.locator('#prepareKlaviyo').isDisabled());

    // Restoring UI preferences leaves preview zoom at the existing frame default.
    assert(savedPanelRatio > 0 && savedPanelRatio < 1);
    const persistedRatio = savedPanelRatio;
    await page.reload(); await revealFrame();
    await page.waitForFunction(expected => Math.abs(parseFloat(getComputedStyle(document.querySelector('.workspace-layout')).getPropertyValue('--preview-ratio')) / 100 - expected) < 0.001, persistedRatio);
    assert.equal(await page.evaluate(() => state.zoom), 0.5);
    await post({ type: 'SELECTION_ERROR', message: 'Select exactly one email frame, component, or instance.' });
    await page.locator('#workspace').waitFor({ state: 'hidden' });
    assert.match(await page.locator('#status').textContent(), /Select exactly one/);
    assert.deepEqual(errors, []);
    console.log(`PASS: ${manifest.ui} five-step redesign preserves slicing, coordinates across split/resize/zoom, review edits/CTA/URLs, keyboard controls, preferences without zoom, export/upload/template contracts, and actionable error recovery; responsive layouts and non-overlapping notification dock verified.`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
