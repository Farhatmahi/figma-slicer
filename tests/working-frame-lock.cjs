// Run after npm run build: node tests/working-frame-lock.cjs
// The actual manifest UI talks to the actual built controller in a mock Figma host.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const html = fs.readFileSync(path.join(root, manifest.ui), 'utf8');
const controller = fs.readFileSync(path.join(root, manifest.main), 'utf8');
assert.equal(html, fs.readFileSync(path.join(root, 'src/ui.html'), 'utf8'), 'Rebuild the manifest UI before testing');
const clone = value => JSON.parse(JSON.stringify(value, (_, item) => ArrayBuffer.isView(item) ? Array.from(item) : item));

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 560, height: 840 }, reducedMotion: 'reduce', acceptDownloads: true });
    page.setDefaultTimeout(7000);
    const errors = [], apiRequests = [], outbound = [], inbound = [], cloneSources = [];
    let sendController;
    const queuedInbound = [];
    await page.exposeFunction('__sendToController', async message => {
      inbound.push(clone(message));
      if (!sendController) { queuedInbound.push(message); return; }
      await sendController(message);
    });
    await page.addInitScript(() => {
      const requests = new Set(['GET_UI_PREFERENCES', 'SAVE_UI_PREFERENCES', 'UI_RESIZE', 'EXPORT', 'REFRESH_SELECTION', 'USE_CANVAS_SELECTION', 'SET_WORKING_FRAME_LOCK', 'FRAME_SWITCH_DECISION', 'CLOSE']);
      window.addEventListener('message', event => {
        const message = event.data && event.data.pluginMessage;
        if (message && requests.has(message.type)) {
          window.__sendToController(message).catch(error => { throw error; });
        }
      });
    });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const url = route.request().url();
      if (url === 'https://working-frame.test/') return route.fulfill({ contentType: 'text/html', body: html });
      apiRequests.push(url);
      if (url.endsWith('/api/klaviyo-accounts')) return route.fulfill({ json: { accounts: [{ id: 'fixture-account', displayName: 'Fixture account' }] } });
      errors.push(`Unexpected API request: ${url}`);
      return route.abort();
    });
    await page.goto('https://working-frame.test/');
    const images = await page.evaluate(() => {
      const result = {};
      for (const [id, height] of [['frame-A', 8400], ['frame-B', 3000]]) {
        const canvas = document.createElement('canvas'); canvas.width = 600; canvas.height = height;
        const context = canvas.getContext('2d');
        context.fillStyle = '#fff'; context.fillRect(0, 0, 600, height);
        for (let y = 0; y < height; y += 600) {
          context.fillStyle = y % 1200 ? '#eaf8ff' : '#edf2f7';
          context.fillRect(12, y + 12, 576, Math.min(576, height - y));
        }
        result[id] = Array.from(Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]), character => character.charCodeAt(0)));
      }
      return result;
    });

    // Selection belongs to the user/canvas. Any plugin assignment is a regression.
    let canvasSelection = [], selectionWrites = 0, layerLockWrites = 0, canvasClipboard = '';
    const events = new Map(), nodeEvents = new Map(), nodes = new Map();
    const figmaPage = {
      id: 'fixture-page', type: 'PAGE', parent: { id: 'document', type: 'DOCUMENT' },
      on(type, handler) { if (!nodeEvents.has(type)) nodeEvents.set(type, new Set()); nodeEvents.get(type).add(handler); },
      off(type, handler) { nodeEvents.get(type)?.delete(handler); },
      appendChild(node) { node.parent = figmaPage; }
    };
    Object.defineProperty(figmaPage, 'selection', {
      get() { return canvasSelection; },
      set() { selectionWrites++; throw new Error('Plugin must not change canvas selection'); }
    });
    function frame(id, name, height) {
      const value = {
        id, name, type: 'FRAME', width: 600, height, removed: false, visible: true,
        parent: figmaPage, absoluteTransform: [[1, 0, 0], [0, 1, 0]],
        children: Array.from({ length: Math.floor(height / 600) }, (_, index) => [
          { id: `${id}-text-${index}`, name: 'Body', type: 'TEXT', visible: true, characters: `Body ${index + 1} from ${name}`, absoluteRenderBounds: { x: 30, y: index * 600 + 40, width: 230, height: 30 } },
          { id: `${id}-cta-${index}`, name: 'CTA', type: 'TEXT', visible: true, characters: `Shop ${name} ${index + 1}`, absoluteRenderBounds: { x: 30, y: index * 600 + 100, width: 230, height: 30 } }
        ]).flat(),
        async exportAsync() { if (id === previewGateForId && previewGate) await previewGate; return Uint8Array.from(images[id]); },
        clone() { cloneSources.push(id); return { id: `${id}-clone`, type: 'FRAME', x: 0, y: 0, removed: false }; }
      };
      Object.defineProperty(value, 'locked', { get() { return false; }, set() { layerLockWrites++; throw new Error('Plugin must not lock Figma layers'); } });
      for (const child of value.children) { child.parent = value; child.absoluteBoundingBox = child.absoluteRenderBounds; nodes.set(child.id, child); }
      nodes.set(id, value);
      return value;
    }
    const frameA = frame('frame-A', 'Frame A', 8400), frameB = frame('frame-B', 'Frame B', 3000);
    canvasSelection = [frameA];
    let delivery = Promise.resolve(), exportGate = null, previewGate = null, previewGateForId = 'frame-B';
    const figma = {
      currentPage: figmaPage,
      showUI(actualHtml, options) { assert.equal(actualHtml, html); assert.equal(options.width, 560); },
      ui: {
        postMessage(message) {
          const serial = clone(message);
          outbound.push(serial);
          delivery = delivery.then(() => page.evaluate(message => {
            // Restore the binary views that Figma's real postMessage preserves.
            if (Array.isArray(message.preview)) message.preview = Uint8Array.from(message.preview);
            if (Array.isArray(message.bytes)) message.bytes = Uint8Array.from(message.bytes);
            window.postMessage({ pluginMessage: message }, '*');
          }, serial));
        },
        resize() {}
      },
      clientStorage: { async getAsync() { return undefined; }, async setAsync() {} },
      on(type, handler) { if (!events.has(type)) events.set(type, new Set()); events.get(type).add(handler); },
      off(type, handler) { events.get(type)?.delete(handler); },
      async getNodeByIdAsync(id) {
        const node = nodes.get(id);
        return !node || node.removed || node.parent?.removed ? null : node;
      },
      createFrame() {
        return {
          type: 'FRAME', removed: false, parent: null,
          resize(width, height) { this.width = width; this.height = height; },
          appendChild(node) { node.parent = this; },
          async exportAsync() { if (exportGate) await exportGate; return Uint8Array.from([255, 216, 255, 217]); },
          remove() { this.removed = true; }
        };
      },
      notify() {}, closePlugin() {}
    };
    const context = vm.createContext({ figma, __html__: html, Uint8Array, console });
    vm.runInContext(controller, context, { filename: manifest.main });
    sendController = message => figma.ui.onmessage(message);
    for (const message of queuedInbound) await sendController(message);
    const pump = async () => { await new Promise(resolve => setImmediate(resolve)); await delivery; await new Promise(resolve => setImmediate(resolve)); await delivery; };
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
    const selectCanvas = async selection => {
      canvasSelection = selection;
      for (const handler of events.get('selectionchange') || []) await handler();
      await pump();
    };
    const changeDocument = async (type, target = frameB, properties = []) => {
      for (const handler of nodeEvents.get('nodechange') || []) await handler({ nodeChanges: [{ type, id: target.id, node: target, properties }] });
      await pump();
    };
    const business = () => page.evaluate(() => ({
      frame: state.frame, cuts: state.horizontalCuts, columns: state.verticalCutsBySection,
      active: state.activeReviewIndex, alt: state.altTextOverrides, manual: state.altManualEdited,
      urls: state.sliceUrlOverrides, included: state.altSelections, cta: state.altCtaBySlice,
      history: state.history, files: state.klaviyoFiles, prepared: state.preparedBackendResult
    }));
    const screenshot = async (name, selector = '#frameStep') => {
      if (!process.env.WORKING_FRAME_SCREENSHOT_DIR) return;
      fs.mkdirSync(process.env.WORKING_FRAME_SCREENSHOT_DIR, { recursive: true });
      await page.locator(selector).screenshot({ path: path.join(process.env.WORKING_FRAME_SCREENSHOT_DIR, `${name}.png`) });
    };
    const next = () => page.locator('.review-nav').getByRole('button', { name: 'Next →', exact: true });
    const previous = () => page.locator('.review-nav').getByRole('button', { name: '← Previous', exact: true });
    const waitFrame = id => page.waitForFunction(id => state.frame?.id === id && document.getElementById('preview').complete && document.getElementById('preview').naturalWidth > 0 && document.getElementById('workspace').offsetParent !== null, id);
    const waitLocated = () => page.waitForFunction(() => {
      const wrap = document.getElementById('previewWrap'), highlight = document.querySelector('.review-highlight');
      if (!highlight) return false;
      const rect = highlight.getBoundingClientRect(), viewport = wrap.getBoundingClientRect();
      const top = rect.top - viewport.top - wrap.clientTop + wrap.scrollTop;
      const target = rect.height > wrap.clientHeight ? top - 16 : top + (rect.height - wrap.clientHeight) / 2;
      const clamped = Math.max(0, Math.min(wrap.scrollHeight - wrap.clientHeight, target));
      return Math.abs(wrap.scrollTop - clamped) < 3;
    });
    await pump();
    try { await waitFrame(frameA.id); } catch (error) {
      console.error('Fixture startup diagnostics', { errors, messages: outbound.map(message => ({type:message.type,frame:message.frame?.id,previewLength:message.preview?.length})), ui: await page.evaluate(() => ({frame:state.frame?.id,status:document.getElementById('status').textContent,previewWidth:document.getElementById('preview').naturalWidth,src:document.getElementById('preview').getAttribute('src'),display:document.getElementById('workspace').style.display})) });
      throw error;
    }
    await settle();
    assert.equal(await page.locator('#frameLockBtn').getAttribute('aria-pressed'), 'true', 'First working frame locks automatically');
    assert.match(await page.locator('#frameLockBtn').textContent(), /Unlock/);
    await page.evaluate(() => { state.horizontalCuts = Array.from({ length: 13 }, (_, index) => (index + 1) * 600); render(); });
    for (let index = 0; index < 7; index++) await next().click();
    await waitLocated();
    await page.locator('.text-slice-title').getByRole('button', { name: 'Select all', exact: true }).click();
    await page.locator('.text-row .cta-choice input').last().check();
    await page.locator('.alt-final').fill('Keep this edited alt text on Frame A, slice eight.');
    await page.locator('.slice-link-panel input').fill('https://example.test/frame-a/slice-8');
    await next().click(); await previous().click(); await waitLocated();
    const beforeRename = await business();
    frameA.name = 'Frame A renamed';
    await changeDocument('PROPERTY_CHANGE', frameA, ['name']);
    await page.waitForFunction(() => document.getElementById('frameName').textContent === 'Frame A renamed');
    beforeRename.frame.name = frameA.name;
    assert.deepEqual(await business(), beforeRename, 'Renaming updates only metadata, never preview geometry or editing state');
    const editedA = await business(), previewA = await page.locator('#preview').getAttribute('src');
    await screenshot('locked-frame');
    const readyCount = outbound.filter(message => message.type === 'FRAME_READY').length;

    // Exact acceptance scenario: browsing/copying elsewhere leaves the working frame alone.
    await selectCanvas([frameB]);
    await selectCanvas([frameB.children[0]]);
    canvasClipboard = frameB.children[0].characters; // External Figma copy, outside the plugin.
    await settle();
    assert.deepEqual(await business(), editedA, 'Frame B/text selection and copy preserve every working-frame edit');
    assert.equal(await page.locator('#preview').getAttribute('src'), previewA);
    assert.equal(outbound.filter(message => message.type === 'FRAME_READY').length, readyCount, 'Locked canvas changes must not republish the working preview');
    assert.equal(canvasSelection[0], frameB.children[0], 'Canvas selection is free to remain on the copied text');
    assert.match(canvasClipboard, /Frame B/);
    await next().click(); await previous().click(); await waitLocated();
    assert.deepEqual(await business(), editedA, 'Auto-scroll remains functional after outside canvas interactions');
    await page.locator('#previewWrap').evaluate(element => { element.scrollTop = 0; });
    await page.locator('.review-locate-slice').click(); await waitLocated();
    assert.equal(await page.evaluate(() => state.activeReviewIndex), 7);
    assert((await page.locator('#previewWrap').evaluate(element => element.scrollTop)) > 0);

    // Explicit same-frame refresh uses A's stable ID even though B's text is selected.
    await page.locator('#refreshBtn').click(); await pump();
    await page.waitForFunction(() => document.getElementById('preview').complete);
    await settle();
    assert.equal(outbound.filter(message => message.type === 'FRAME_READY').at(-1).frame.id, frameA.id);
    assert.equal(outbound.filter(message => message.type === 'FRAME_READY').at(-1).preserveEdits, true);
    assert.deepEqual(await business(), editedA, 'Refreshing the same working frame never discards content or cuts');

    // Actual export must clone A, never the currently selected B/text.
    let releaseExport;
    exportGate = new Promise(resolve => { releaseExport = resolve; });
    const downloaded = page.waitForEvent('download');
    await page.locator('.settings-panel > summary').click();
    await page.locator('#exportBtn').click();
    await page.waitForFunction(() => state.exporting);
    assert(await page.locator('#frameLockBtn').isDisabled(), 'Do not allow working-frame changes during image export');
    await selectCanvas([frameB]);
    releaseExport(); exportGate = null;
    await downloaded;
    await page.waitForFunction(() => !state.exporting);
    await pump();
    assert(cloneSources.length > 0 && cloneSources.every(id => id === frameA.id), 'Every exported crop comes from locked Frame A');
    assert.equal(inbound.filter(message => message.type === 'EXPORT').at(-1).workingFrameId, frameA.id);

    const beforeUnlock = await business();
    const proposalsBeforeUnlock = outbound.filter(message => message.type === 'FRAME_SWITCH_REQUEST').length;
    await page.locator('#frameLockBtn').click(); await pump();
    await page.waitForFunction(() => document.getElementById('frameLockBtn').getAttribute('aria-pressed') === 'false');
    assert.equal(outbound.filter(message => message.type === 'FRAME_SWITCH_REQUEST').length, proposalsBeforeUnlock, 'Unlock alone must not consume a pre-existing canvas selection');
    assert.deepEqual(await business(), beforeUnlock);
    await selectCanvas([frameB]);
    await selectCanvas([frameB.children[0]]);
    assert.equal(outbound.filter(message => message.type === 'FRAME_SWITCH_REQUEST').length, proposalsBeforeUnlock, 'Even unlocked, canvas clicks must not propose a switch');
    assert.deepEqual(await business(), beforeUnlock);
    await page.locator('#refreshBtn').click(); await pump(); await waitFrame(frameA.id); await settle();
    assert.deepEqual(await business(), beforeUnlock, 'Refresh also keeps the working frame when unlocked');
    let releaseSameFramePreview;
    previewGateForId = frameA.id;
    previewGate = new Promise(resolve => { releaseSameFramePreview = resolve; });
    await selectCanvas([frameA]);
    await page.locator('#useSelectedFrameBtn').click();
    await page.waitForFunction(() => Boolean(frameSelectionIntent));
    assert(await page.locator('#refreshBtn').isDisabled(), 'Refresh cannot cancel a pending explicit same-frame preview and strand its intent');
    releaseSameFramePreview(); previewGate = null; previewGateForId = frameB.id;
    await pump(); await page.waitForFunction(() => !frameSelectionIntent && !document.getElementById('useSelectedFrameBtn').disabled);
    assert.deepEqual(await business(), beforeUnlock);
    await selectCanvas([frameB]);
    await page.locator('#useSelectedFrameBtn').click();
    await page.locator('#frameSwitchDialog').waitFor({ state: 'visible' });
    assert.match(await page.locator('#frameSwitchDialog').textContent(), /Frame B/);
    await screenshot('confirm-switch', '#frameSwitchDialog');
    await page.locator('#cancelFrameSwitch').click(); await pump();
    assert(!(await page.locator('#frameSwitchDialog').isVisible()));
    assert.deepEqual(await business(), beforeUnlock, 'Cancel keeps Frame A and all edits');
    await selectCanvas([frameB]);
    await page.locator('#useSelectedFrameBtn').click();
    await page.locator('#frameSwitchDialog').waitFor({ state: 'visible' });
    await page.keyboard.press('Escape'); await pump();
    assert(!(await page.locator('#frameSwitchDialog').isVisible()));
    assert.deepEqual(await business(), beforeUnlock, 'Escape cancels a switch without clearing work');
    await selectCanvas([frameB]);
    await page.locator('#useSelectedFrameBtn').click();
    await page.locator('#frameSwitchDialog').waitFor({ state: 'visible' });
    let releasePreview;
    previewGate = new Promise(resolve => { releasePreview = resolve; });
    const exportCountBeforeSwitchLoad = inbound.filter(message => message.type === 'EXPORT').length;
    const apiCountBeforeSwitchLoad = apiRequests.length;
    await page.locator('#confirmFrameSwitch').click(); await pump();
    await page.waitForFunction(() => Boolean(loadingFrameSwitch));
    assert(await page.locator('#prepareKlaviyo').isDisabled(), 'A pending frame switch blocks new operations on the old frame');
    assert(await page.locator('#frameLockBtn').isDisabled());
    assert(await page.locator('#workflowPanel').evaluate(element => element.inert), 'Old-frame inputs cannot be edited during a confirmed switch load');
    await page.evaluate(async () => { startSliceExport('zip'); await createKlaviyoTemplate(); });
    assert.equal(inbound.filter(message => message.type === 'EXPORT').length, exportCountBeforeSwitchLoad);
    assert.equal(apiRequests.length, apiCountBeforeSwitchLoad);
    assert.equal(await page.evaluate(() => state.frame.id), frameA.id, 'Old work stays active until the new preview is ready');
    releasePreview(); previewGate = null;
    await pump(); await waitFrame(frameB.id); await settle();
    assert(!(await page.locator('#workflowPanel').evaluate(element => element.inert)));
    assert.equal(await page.locator('#frameLockBtn').getAttribute('aria-pressed'), 'true', 'An intentional new working frame locks automatically');
    assert.deepEqual(await page.evaluate(() => state.horizontalCuts), []);
    assert.deepEqual(await page.evaluate(() => state.sliceUrlOverrides), {});
    assert.deepEqual(await page.evaluate(() => state.altCtaBySlice), {});
    assert.equal(await page.evaluate(() => state.preparedBackendResult), null);
    assert(!(await page.evaluate(() => Object.values(state.altTextOverrides))).includes(editedA.alt['7-0']), 'Old frame edits clear only after a confirmed switch');

    // A deleted locked frame retains the last preview/work and cannot export/create.
    await page.evaluate(() => {
      state.horizontalCuts = [600, 1200]; render();
      state.preparedBackendResult = { templateName: 'Fixture B', slices: [{ imageUrl: 'https://images.test/b.jpg' }] };
      document.getElementById('createKlaviyoTemplate').disabled = false;
    });
    await page.locator('.alt-final').fill('Preserve Frame B work if its Figma layer is deleted.');
    const editedB = await business(), previewB = await page.locator('#preview').getAttribute('src');
    frameB.removed = true;
    await changeDocument('DELETE');
    await page.waitForFunction(() => state.frameMissing);
    assert.deepEqual(await business(), editedB);
    assert.equal(await page.locator('#preview').getAttribute('src'), previewB);
    assert(await page.locator('#workspace').isVisible());
    assert(await page.locator('#exportBtn').isDisabled());
    assert(await page.locator('#prepareKlaviyo').isDisabled());
    assert(await page.locator('#createKlaviyoTemplate').isDisabled());
    assert.match(await page.locator('#frameLockStatus').textContent(), /deleted|missing|no longer|removed/i);
    await screenshot('missing-frame');
    const apiBeforeMissingCreate = apiRequests.length;
    await page.evaluate(() => createKlaviyoTemplate());
    assert.equal(apiRequests.length, apiBeforeMissingCreate, 'Missing-frame guard must prevent even programmatic template creation');
    frameB.removed = false;
    await changeDocument('CREATE');
    await page.waitForFunction(() => !state.frameMissing);
    assert.deepEqual(await business(), editedB, 'Restoring the same frame preserves edits');
    assert(!(await page.locator('#exportBtn').isDisabled()));
    assert(!(await page.locator('#createKlaviyoTemplate').isDisabled()));

    // Explicit Refresh can restore the same ID even before a CREATE event arrives.
    frameB.removed = true; await changeDocument('DELETE');
    await page.waitForFunction(() => state.frameMissing);
    frameB.removed = false;
    await page.locator('#refreshBtn').click(); await pump(); await waitFrame(frameB.id);
    await page.waitForFunction(() => !state.frameMissing && !document.getElementById('createKlaviyoTemplate').disabled);
    assert.deepEqual(await business(), editedB, 'Refresh restoration preserves prepared data and all edits');

    frameB.removed = true; await changeDocument('DELETE');
    await page.waitForFunction(() => state.frameMissing);
    await page.locator('#frameLockBtn').click(); await pump();
    await page.waitForFunction(() => document.getElementById('frameLockBtn').getAttribute('aria-pressed') === 'false');
    await selectCanvas([frameA]);
    await page.locator('#useSelectedFrameBtn').click();
    await page.locator('#frameSwitchDialog').waitFor({ state: 'visible' });
    await page.locator('#cancelFrameSwitch').click(); await pump();
    assert.deepEqual(await business(), editedB, 'Canceling replacement of a deleted frame also keeps its edits');
    await selectCanvas([frameA]);
    await page.locator('#useSelectedFrameBtn').click();
    await page.locator('#frameSwitchDialog').waitFor({ state: 'visible' });
    await page.locator('#confirmFrameSwitch').click(); await pump(); await waitFrame(frameA.id);
    assert.equal(await page.evaluate(() => state.frameMissing), false);
    assert.equal(await page.locator('#frameLockBtn').getAttribute('aria-pressed'), 'true');
    // A clean frame can switch intentionally without a destructive-work prompt.
    frameB.removed = false;
    await page.locator('#frameLockBtn').click(); await pump();
    await page.waitForFunction(() => !state.frameLocked);
    await selectCanvas([frameB]);
    assert.equal(await page.evaluate(() => state.frame.id), frameA.id, 'A clean unlocked frame also waits for an explicit plugin action');
    await page.locator('#useSelectedFrameBtn').click(); await waitFrame(frameB.id); await settle();
    assert(!(await page.locator('#frameSwitchDialog').isVisible()));
    assert.equal(await page.evaluate(() => state.frameLocked), true);
    await page.setViewportSize({ width: 360, height: 640 }); await settle();
    await page.locator('#frameStep').scrollIntoViewIfNeeded();
    assert(await page.locator('#frameLockBtn').isVisible());
    assert(await page.locator('#workspace').evaluate(element => element.scrollWidth <= element.clientWidth + 1));
    await screenshot('narrow-lock-control');
    assert.equal(selectionWrites, 0, 'Working-frame locking must never force the Figma canvas selection');
    assert.equal(layerLockWrites, 0, 'Working-frame locking must never lock actual Figma nodes');
    assert.equal(apiRequests.filter(url => !url.endsWith('/api/klaviyo-accounts')).length, 0);
    assert.deepEqual(errors, []);
    console.log(`PASS: actual ${manifest.main} + ${manifest.ui} keep Frame A through canvas B/text/copy interactions, preserve content and auto-scroll, export stable frame IDs, guard unlock/switch/cancel/refresh and deleted-frame recovery without locking nodes or changing canvas selection.`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
