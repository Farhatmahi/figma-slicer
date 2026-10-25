// Run after npm run build: node tests/unified-status.cjs
// Exercises the manifest UI with simulated Figma exports and backend responses.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const html = fs.readFileSync(path.join(root, manifest.ui), 'utf8');
assert.equal(html, fs.readFileSync(path.join(root, 'src/ui.html'), 'utf8'), 'Rebuild the manifest UI before testing');
let opening;
vm.runInNewContext(fs.readFileSync(path.join(root, manifest.main), 'utf8'), {
  __html__: html,
  figma: { showUI(_, options) { opening = options; }, currentPage: { selection: [] }, ui: { postMessage() {} }, on() {} }
});
assert(opening, 'Use the actual manifest controller opening dimensions');
const deferred = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: opening.width, height: opening.height }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(7000);
    const errors = [], uploads = [], creates = [];
    let accountName = 'Northwind / destination', accountReads = 0, healthStatus = 200, createStatus = 200;
    let returnedSliceCount = null, includeCompressionSizes = true;
    let uploadGate = null, createGate = null;
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.__statusExports = [];
      window.__statusCopies = [];
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.__statusCopies.push(text); } } });
      window.addEventListener('message', event => {
        const message = event.data && event.data.pluginMessage;
        if (message && message.type === 'EXPORT') window.__statusExports.push(message);
      });
    });
    await page.route('**/*', async route => {
      const request = route.request(), url = request.url();
      if (url === 'https://unified-status.test/') return route.fulfill({ contentType: 'text/html', body: html });
      if (url.endsWith('/api/klaviyo-accounts')) {
        accountReads++;
        return route.fulfill({ json: { accounts: [{ id: 'destination-42', displayName: accountName }, { id: 'other-77', displayName: 'Other destination' }] } });
      }
      if (url.endsWith('/health')) return route.fulfill({ status: healthStatus, json: { ok: healthStatus === 200 } });
      if (url.endsWith('/api/prepare-klaviyo')) {
        const body = request.postDataBuffer().toString('utf8');
        const part = body.match(/name="payload"\r\n\r\n([\s\S]*?)\r\n--/);
        assert(part, 'Preparation still sends multipart JSON and JPEG files');
        const payload = JSON.parse(part[1]);
        const filenames = [...body.matchAll(/filename="([^"]+)"/g)].map(match => match[1]);
        uploads.push({ payload, filenames });
        if (uploadGate) await uploadGate.promise;
        return route.fulfill({ json: {
          templateName: 'Autumn launch — approved',
          slices: payload.slices.slice(0, returnedSliceCount ?? payload.slices.length).map(slice => ({
            ...slice, imageUrl: `https://images.test/${slice.filename}`,
            ...(includeCompressionSizes ? { originalSizeBytes: 1000, compressedSizeBytes: 630 } : {})
          }))
        } });
      }
      if (url.endsWith('/api/create-klaviyo-template')) {
        const body = request.postDataJSON(); creates.push(body);
        if (createGate) await createGate.promise;
        return route.fulfill({ status: createStatus, json: createStatus === 200
          ? { templateName: body.templateName, accountName: 'Northwind / created account', rowCount: 2, tableRowCount: 1 }
          : { error: 'Fixture account access was revoked' } });
      }
      errors.push(`Unexpected request: ${url}`);
      return route.abort();
    });
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const post = message => page.evaluate(message => window.postMessage({ pluginMessage: message }, '*'), message);
    const savedShots = new Set();
    const shot = async (name, selector = '#operationStatus') => {
      if (!process.env.UNIFIED_STATUS_SCREENSHOT_DIR || savedShots.has(name)) return;
      savedShots.add(name);
      fs.mkdirSync(process.env.UNIFIED_STATUS_SCREENSHOT_DIR, { recursive: true });
      await page.locator(selector).scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(process.env.UNIFIED_STATUS_SCREENSHOT_DIR, `${name}.png`) });
    };
    const waitState = async value => {
      await page.waitForFunction(value => document.getElementById('operationStatus').dataset.state === value, value);
      await settle();
      assert.equal(await page.locator('#createStep #operationStatus').count(), 1, 'One current status component remains in Step 5');
      assert(await page.locator('#operationStatus').isVisible());
      assert.equal(await page.locator('#createStep .result-card:visible:not(#operationStatus)').count(), 0, 'Old preparation, upload and template result cards are not separately visible');
    };
    const facts = () => page.locator('#operationFacts').evaluate(element => Object.fromEntries([...element.querySelectorAll('dt')].map(term => [term.textContent, term.nextElementSibling.textContent])));
    const fact = (values, pattern) => Object.entries(values).find(([key]) => pattern.test(key))?.[1];
    const clearToasts = () => page.locator('#toastRegion').evaluate(element => element.replaceChildren());
    const prepare = async fileCount => {
      const count = await page.evaluate(() => window.__statusExports.length);
      await page.locator('#prepareKlaviyo').click();
      await page.waitForFunction(count => window.__statusExports.length > count, count);
      await waitState('preparing');
      assert.match(await page.locator('#operationTitle').textContent(), /Preparing images/i);
      await post({ type: 'EXPORT_PROGRESS', current: 1, total: 3 });
      await page.waitForFunction(() => document.getElementById('operationProgress').value === 1 && document.getElementById('operationProgress').max === 3 && document.getElementById('operationMessage').textContent.includes('1 of 3'));
      assert(await page.locator('#operationProgress').isVisible(), 'Real Figma export progress is visible');
      assert.match(await page.locator('#operationMessage').textContent(), /1 of 3/);
      await shot('preparing');
      for (let number = 1; number <= fileCount; number++) await post({ type: 'EXPORTED_FILE', filename: `${number}.jpg`, bytes: [255, 216, 255, 217] });
      await post({ type: 'EXPORT_COMPLETE', count: 3, zipName: 'autumn-fixture.zip' });
    };
    await page.goto('https://unified-status.test/');
    await page.evaluate(() => {
      const image = document.createElement('canvas'); image.width = 600; image.height = 1800;
      image.getContext('2d').fillRect(0, 0, 600, 1800);
      const preview = Uint8Array.from(atob(image.toDataURL('image/png').split(',')[1]), char => char.charCodeAt(0));
      window.postMessage({ pluginMessage: {
        type: 'FRAME_READY', frame: { id: 'status-frame', name: 'Autumn source design', width: 600, height: 1800, autoScale: 2 }, preview, layerBounds: [], textItems: []
      } }, '*');
    });
    await page.waitForFunction(() => state.frame && document.getElementById('preview').naturalWidth === 600 && !document.getElementById('klaviyoAccountTrigger').disabled);
    await page.evaluate(() => { document.getElementById('excludeAfterLastCut').checked = false; state.horizontalCuts = [600, 1200]; render(); });
    await page.locator('#klaviyoAccountTrigger').click();
    await page.locator('#klaviyoAccountSearch').fill('Northwind');
    await page.locator('#klaviyoAccountOptions [role=option]').click();
    await waitState('idle');
    assert.equal(await page.locator('#technicalDetails').getAttribute('open'), null, 'Technical details is collapsed by default');
    assert.equal(await page.locator('#technicalDetails > summary').textContent(), 'Technical details');
    for (const id of ['copyKlaviyoJson', 'copyBackendResult', 'copyKlaviyoCreateResult', 'klaviyoJson', 'backendResult', 'klaviyoCreateResult']) {
      assert.equal(await page.locator(`#technicalDetails #${id}`).count(), 1, `Technical details retains ${id}`);
      assert(!(await page.locator(`#${id}`).isVisible()), 'Debug controls do not clutter the normal status');
    }

    // Partial preparation must not look ready, upload anything, or allow creation.
    await prepare(1);
    await waitState('error');
    assert.match(await page.locator('#operationStatus').textContent(), /incomplete.*2.*not attached/i);
    assert.equal(uploads.length, 0);
    assert(await page.locator('#createKlaviyoTemplate').isDisabled());
    assert(!(await page.locator('#prepareKlaviyo').isDisabled()), 'Preparation can be retried');
    await clearToasts();

    // Unknown upload progress remains honest; ready uses actual response counts and bytes.
    uploadGate = deferred();
    await prepare(3);
    await page.waitForFunction(() => state.backendUploading && document.getElementById('uploadStatus').textContent.includes('Backend connected'));
    await waitState('preparing');
    assert.match(await page.locator('#operationMessage').textContent(), /Uploading JPEG slices/i);
    assert(!(await page.locator('#operationProgress').isVisible()), 'Do not invent percent progress for the upload');
    assert(await page.locator('#createKlaviyoTemplate').isDisabled());
    await page.evaluate(() => snapshot());
    await waitState('preparing');
    assert.match(await page.locator('#operationMessage').textContent(), /Uploading JPEG slices/i, 'A cut snapshot must not clear the status of an upload still in flight');
    uploadGate.release(); uploadGate = null;
    await waitState('ready');
    assert.match(await page.locator('#operationTitle').textContent(), /Images ready/i);
    let values = await facts();
    assert.equal(fact(values, /slices/i), '3');
    assert.match(fact(values, /compression|savings/i), /37%/);
    assert.deepEqual(uploads[0].filenames, ['1.jpg', '2.jpg', '3.jpg']);
    assert(uploads[0].payload.slices.every(slice => slice.imageReady));
    assert(!(await page.locator('#createKlaviyoTemplate').isDisabled()));
    await shot('ready');
    await clearToasts();

    // Creation remains a separate request and a persistent success card with real facts.
    createGate = deferred();
    await page.locator('#createKlaviyoTemplate').click();
    await waitState('creating');
    assert.match(await page.locator('#operationMessage').textContent(), /Northwind \/ destination/);
    assert(await page.locator('#createKlaviyoTemplate').isDisabled());
    await page.evaluate(() => resetTemplateOperation());
    await waitState('creating');
    createGate.release(); createGate = null;
    await waitState('success');
    assert.match(await page.locator('#operationTitle').textContent(), /Template created successfully/i);
    values = await facts();
    assert.equal(fact(values, /slices/i), '3', 'Uploaded slice count is not the template table-row count');
    assert.equal(fact(values, /account/i), 'Northwind / created account');
    assert.equal(fact(values, /template/i), 'Autumn launch — approved');
    assert.match(fact(values, /compression|savings/i), /37%/);
    assert.equal(creates[0].accountId, 'destination-42');
    assert.equal(creates[0].slices.length, 3);
    assert.equal(creates[0].templateName, 'Autumn launch — approved');
    assert.equal(await page.locator('#toastRegion .toast').count(), 0, 'Template success is confirmed only by the persistent card');
    await shot('success');
    const successText = await page.locator('#operationStatus').textContent();
    const reads = accountReads; accountName = 'Northwind / renamed after creation';
    await page.locator('#refreshAccounts').click();
    await page.waitForFunction(() => !state.accountsLoading);
    await settle();
    assert(accountReads > reads);
    assert.equal(await page.locator('#klaviyoAccount').inputValue(), 'destination-42');
    assert.equal(await page.locator('#operationStatus').textContent(), successText, 'Refreshing accounts does not rewrite the completed template facts');

    // All three debug datasets can still be viewed and copied from one disclosure.
    await page.locator('#technicalDetails > summary').click();
    assert.equal(await page.locator('#technicalDetails').getAttribute('open'), '');
    for (const [copyId, valueId, summary] of [
      ['copyKlaviyoJson', 'klaviyoJson', /View prepared JSON/],
      ['copyBackendResult', 'backendResult', /View upload result/],
      ['copyKlaviyoCreateResult', 'klaviyoCreateResult', /View template result/]
    ]) {
      const value = await page.locator(`#${valueId}`).inputValue(); assert(value.length > 0);
      await page.locator(`#${copyId}`).click();
      assert.equal(await page.evaluate(() => window.__statusCopies.at(-1)), value);
      const disclosure = page.locator(`#technicalDetails details`).filter({ has: page.locator('summary', { hasText: summary }) });
      await disclosure.locator('summary').click();
      assert(await page.locator(`#${valueId}`).isVisible());
      assert.deepEqual(JSON.parse(await page.locator(`#${valueId}`).inputValue()), JSON.parse(value));
    }
    await clearToasts();
    if (process.env.UNIFIED_STATUS_SCREENSHOT_DIR) await page.waitForFunction(() => ['copyKlaviyoJson', 'copyBackendResult', 'copyKlaviyoCreateResult'].every(id => document.getElementById(id).textContent !== 'Copied'));
    await shot('technical-details', '#technicalDetails > summary');
    await page.locator('#technicalDetails > summary').click();
    await clearToasts();

    // A failed creation replaces success, retains useful errors and permits retry.
    createStatus = 403;
    await page.locator('#createKlaviyoTemplate').click();
    await waitState('error');
    assert.match(await page.locator('#operationStatus').textContent(), /account access was revoked/);
    assert.doesNotMatch(await page.locator('#operationTitle').textContent(), /successfully/);
    assert(!(await page.locator('#createKlaviyoTemplate').isDisabled()));
    assert.match(await page.locator('#toastRegion').textContent(), /account access was revoked/, 'Actionable template errors still notify');
    await shot('error');
    createStatus = 200;
    await page.locator('#createKlaviyoTemplate').click();
    await waitState('success');
    await clearToasts();

    // A failed re-upload must not show stale readiness or a previous creation success.
    healthStatus = 503;
    await prepare(3);
    await waitState('error');
    assert.match(await page.locator('#operationStatus').textContent(), /health check returned 503/);
    assert.doesNotMatch(await page.locator('#operationTitle').textContent(), /ready|successfully/i);
    assert(!(await page.locator('#prepareKlaviyo').isDisabled()));
    assert.match(await page.locator('#toastRegion').textContent(), /health check returned 503/);

    // A successful HTTP response containing only some uploads is still an error.
    healthStatus = 200; returnedSliceCount = 2;
    await prepare(3);
    await waitState('error');
    assert.match(await page.locator('#operationStatus').textContent(), /2 of 3 slices/);
    assert(await page.locator('#createKlaviyoTemplate').isDisabled(), 'Partial backend preparation cannot be submitted as a complete template');
    assert.equal(await page.evaluate(() => state.preparedBackendResult), null, 'Do not reuse a previous success after an incomplete retry');
    assert.equal(JSON.parse(await page.locator('#backendResult').inputValue()).slices.length, 2, 'Partial backend response remains available for debugging');

    // Missing compression metadata is unknown, not a fabricated zero-percent saving.
    returnedSliceCount = null; includeCompressionSizes = false;
    await prepare(3);
    await waitState('ready');
    assert.equal(fact(await facts(), /compression|savings/i), undefined);
    await clearToasts();
    await page.locator('#createKlaviyoTemplate').click();
    await waitState('success');
    assert.equal(fact(await facts(), /compression|savings/i), undefined);
    assert.equal(await page.locator('#toastRegion .toast').count(), 0);
    await page.evaluate(() => showToast('Review the selected account before retrying.', 'warning'));
    assert.match(await page.locator('#toastRegion [data-tone=warning]').first().textContent(), /Review the selected account/, 'The global warning system is preserved');
    await page.evaluate(() => { snapshot(); state.horizontalCuts.push(1500); render(); });
    await waitState('idle');
    assert.equal(await page.evaluate(() => state.preparedBackendResult), null, 'An idle layout edit invalidates previously prepared slices');
    assert(await page.locator('#createKlaviyoTemplate').isDisabled(), 'Create stays disabled until edited slices are prepared again');
    assert.deepEqual(errors, []);
    console.log(`PASS: ${manifest.ui} presents one current preparation/ready/creation/success/error component using real progress, slice counts, account/template facts and compression savings; partial exports cannot report success, debug view/copy controls work, account refresh preserves completed facts, retries and global warnings/errors remain, and template success has no toast.`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
