// Run after npm run build. Exercises the actual UI's frame-message boundary.
// Host replies are fixtures so stale/unsolicited messages can be delivered deliberately.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const html = fs.readFileSync(path.join(root, manifest.ui), 'utf8');
assert.equal(html, fs.readFileSync(path.join(root, 'src/ui.html'), 'utf8'), 'Rebuild before testing the production UI');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 840 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(7000);
    const errors = [], requests = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.__authorityMessages = [];
      const outgoing = new Set(['GET_UI_PREFERENCES', 'SET_WORKING_FRAME_LOCK', 'USE_CANVAS_SELECTION', 'FRAME_SWITCH_DECISION', 'EXPORT']);
      window.addEventListener('message', event => {
        const message = event.data && event.data.pluginMessage;
        if (message && outgoing.has(message.type)) window.__authorityMessages.push(message);
      });
    });
    await page.route('**/*', route => {
      const url = route.request().url();
      if (url === 'https://frame-authority.test/') return route.fulfill({ contentType: 'text/html', body: html });
      requests.push(url);
      if (url.endsWith('/api/klaviyo-accounts')) return route.fulfill({ json: { accounts: [{ id: 'fixture-account', displayName: 'Fixture account' }] } });
      errors.push(`Unexpected network operation: ${url}`);
      return route.abort();
    });
    await page.goto('https://frame-authority.test/');
    const images = await page.evaluate(() => {
      const result = {};
      for (const [id, color] of [['A', '#fff'], ['B', '#eaf8ff'], ['C', '#ecfdf3'], ['stale', '#fee4e2']]) {
        const canvas = document.createElement('canvas'); canvas.width = 600; canvas.height = 1200;
        const context = canvas.getContext('2d'); context.fillStyle = color; context.fillRect(0, 0, 600, 1200);
        result[id] = Array.from(Uint8Array.from(atob(canvas.toDataURL().split(',')[1]), char => char.charCodeAt(0)));
      }
      return result;
    });
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
    const post = async message => {
      await page.evaluate(message => {
        if (Array.isArray(message.preview)) message.preview = Uint8Array.from(message.preview);
        window.postMessage({ pluginMessage: message }, '*');
      }, message);
      await settle();
    };
    const frame = id => ({ id, name: `Frame ${id}`, width: 600, height: 1200, autoScale: 2 });
    const ready = (id, extra = {}, image = id) => ({ type: 'FRAME_READY', frame: frame(id), preview: images[image], layerBounds: [], textItems: [], locked: true, preserveEdits: false, ...extra });
    const outbound = type => page.evaluate(type => window.__authorityMessages.filter(message => message.type === type), type);
    const snapshot = () => page.evaluate(() => ({
      frameId: state.frame?.id, locked: state.frameLocked, missing: state.frameMissing,
      cuts: state.horizontalCuts, columns: state.verticalCutsBySection, active: state.activeReviewIndex,
      alt: state.altTextOverrides, manual: state.altManualEdited, cta: state.altCtaBySlice,
      included: state.altSelections, urls: state.sliceUrlOverrides, history: state.history,
      prepared: state.preparedBackendResult, files: state.klaviyoFiles,
      zoom: state.zoom, preview: document.getElementById('preview').getAttribute('src')
    }));
    const waitFrame = id => page.waitForFunction(id => state.frame?.id === id && document.getElementById('frameName').textContent === `Frame ${id}` && document.getElementById('preview').naturalWidth === 600, id);
    const unlock = async (id, revision) => {
      const count = (await outbound('SET_WORKING_FRAME_LOCK')).length;
      await page.locator('#frameLockBtn').click();
      await page.waitForFunction(count => window.__authorityMessages.filter(message => message.type === 'SET_WORKING_FRAME_LOCK').length > count, count);
      const sent = (await outbound('SET_WORKING_FRAME_LOCK')).at(-1);
      assert.equal(sent.frameId, id); assert.equal(sent.locked, false);
      await post({ type: 'WORKING_FRAME_LOCK_STATE', frameId: id, locked: false, missing: false, revision });
      assert.equal(await page.evaluate(() => state.frameLocked), false);
    };
    const explicitSelection = async id => {
      const count = (await outbound('USE_CANVAS_SELECTION')).length;
      await page.locator('#useSelectedFrameBtn').click();
      await page.waitForFunction(count => window.__authorityMessages.filter(message => message.type === 'USE_CANVAS_SELECTION').length > count, count);
      const intent = (await outbound('USE_CANVAS_SELECTION')).at(-1);
      assert.equal(intent.frameId, id);
      assert(Number.isInteger(intent.selectionRequestId) && intent.selectionRequestId > 0, 'Explicit selection carries a positive intent ID');
      return intent.selectionRequestId;
    };

    await post(ready('A', { revision: 1 })); await waitFrame('A');
    await page.evaluate(() => {
      state.horizontalCuts = [400, 800];
      state.altTextOverrides = { '0-0': 'Keep the edited description from Frame A.' };
      state.altManualEdited = { '0-0': true };
      state.altCtaBySlice = { '0-0': 'fixture-cta' };
      state.altSelections = { '0-0': ['fixture-cta'] };
      state.sliceUrlOverrides = { '1': 'https://example.test/keep-a' };
      state.preparedBackendResult = { templateName: 'Frame A', slices: [{ id: '1', imageUrl: 'https://images.test/a.jpg' }] };
      render();
    });
    const lockedA = await snapshot();

    // This was a concrete data-loss path in 9bd8b9f: a boolean bypassed the lock.
    await post(ready('B', { revision: 100, switchConfirmed: true }));
    assert.deepEqual(await snapshot(), lockedA, 'An unsolicited flagged FRAME_READY must not replace locked Frame A or clear edits');
    await post({ type: 'FRAME_SWITCH_REQUEST', requestId: 90, fromFrameId: 'A', frame: frame('B'), selectionRequestId: 900 });
    assert(!(await page.locator('#frameSwitchDialog').isVisible()), 'A locked UI must reject unsolicited proposals');
    assert.equal((await outbound('FRAME_SWITCH_DECISION')).filter(message => message.accept).length, 0);
    assert.deepEqual(await snapshot(), lockedA);

    await unlock('A', 1);
    const unlockedA = await snapshot();
    await post({ type: 'FRAME_SWITCH_REQUEST', requestId: 91, fromFrameId: 'A', frame: frame('B'), selectionRequestId: 901 });
    assert(!(await page.locator('#frameSwitchDialog').isVisible()), 'Unlocking must not authorize canvas-only proposals');
    assert.deepEqual(await snapshot(), unlockedA);

    const selectionRequestId = await explicitSelection('A');
    const request = { type: 'FRAME_SWITCH_REQUEST', requestId: 101, fromFrameId: 'A', frame: frame('B'), selectionRequestId };
    await post({ ...request, selectionRequestId: selectionRequestId + 999 });
    await post({ ...request, fromFrameId: 'C' });
    assert(!(await page.locator('#frameSwitchDialog').isVisible()), 'Mismatched intent/from-frame cannot open destructive confirmation');
    assert.deepEqual(await snapshot(), unlockedA);
    await post(request);
    await page.locator('#frameSwitchDialog').waitFor({ state: 'visible' });
    await page.locator('#confirmFrameSwitch').click();
    await page.waitForFunction(() => window.__authorityMessages.some(message => message.type === 'FRAME_SWITCH_DECISION' && message.requestId === 101 && message.accept === true));

    const acceptedReply = { revision: 2, switchConfirmed: true, requestId: 101, selectionRequestId, fromFrameId: 'A' };
    for (const invalid of [
      ready('B', { ...acceptedReply, requestId: 100 }),
      ready('B', { ...acceptedReply, selectionRequestId: selectionRequestId + 1 }),
      ready('B', { ...acceptedReply, fromFrameId: 'C' }),
      ready('C', acceptedReply),
      ready('B', { ...acceptedReply, switchConfirmed: false }),
      ready('B', { ...acceptedReply, revision: 1 })
    ]) {
      await post(invalid);
      assert.deepEqual(await snapshot(), unlockedA, 'A preview must match the accepted intent, request, target, source and fresh revision');
    }
    await post(ready('B', acceptedReply)); await waitFrame('B');
    assert.equal(await page.evaluate(() => state.frameLocked), true);
    assert.deepEqual(await page.evaluate(() => state.horizontalCuts), []);
    assert.equal(await page.evaluate(() => state.preparedBackendResult), null);
    assert.notEqual(await page.locator('#preview').getAttribute('src'), lockedA.preview);

    await page.evaluate(() => {
      state.horizontalCuts = [300, 600];
      state.altTextOverrides = { '0-0': 'New edits on B must survive replay.' };
      state.altManualEdited = { '0-0': true }; render();
    });
    const lockedB = await snapshot();
    await post(ready('B', { ...acceptedReply, revision: 1 }, 'stale'));
    await post(ready('B', acceptedReply, 'stale'));
    assert.deepEqual(await snapshot(), lockedB, 'Duplicate and older same-frame preview revisions cannot replace the current preview');
    await post(ready('C', { revision: 999, switchConfirmed: true }));
    assert.deepEqual(await snapshot(), lockedB, 'A later-looking revision alone is not authority to switch a locked frame');

    await post({ type: 'WORKING_FRAME_METADATA', frameId: 'B', name: 'Renamed Frame B', revision: 2 });
    assert.equal(await page.locator('#frameName').textContent(), 'Renamed Frame B');
    assert.equal(await page.evaluate(() => state.frame.name), 'Renamed Frame B');
    assert.deepEqual(await snapshot(), lockedB, 'Renaming updates metadata only, preserving preview, edits and identity');
    await post({ type: 'WORKING_FRAME_METADATA', frameId: 'C', name: 'Wrong frame', revision: 2 });
    await post({ type: 'WORKING_FRAME_METADATA', frameId: 'B', name: 'Stale name', revision: 1 });
    assert.equal(await page.locator('#frameName').textContent(), 'Renamed Frame B');

    await unlock('B', 2);
    const beforeCancel = await snapshot();
    const canceledIntent = await explicitSelection('B');
    const canceledRequest = { type: 'FRAME_SWITCH_REQUEST', requestId: 202, fromFrameId: 'B', frame: frame('C'), selectionRequestId: canceledIntent };
    await post(canceledRequest);
    await page.locator('#frameSwitchDialog').waitFor({ state: 'visible' });
    await page.locator('#cancelFrameSwitch').click();
    await post(ready('C', { revision: 3, switchConfirmed: true, requestId: 202, selectionRequestId: canceledIntent, fromFrameId: 'B' }));
    assert.deepEqual(await snapshot(), beforeCancel, 'A late reply after cancellation cannot discard current work');

    assert.equal((await outbound('EXPORT')).length, 0);
    assert.equal(requests.length, 1, 'Frame validation must not call upload/template APIs');
    assert.deepEqual(errors, []);
    console.log(`PASS: ${manifest.ui} rejects unsolicited and replayed frame replacement messages, requires explicit matching selection intent/request/source/target, preserves locked edits and canceled work, and applies rename metadata without resetting the editor.`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
