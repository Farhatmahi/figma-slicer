// Run after npm run build: node tests/ui-preferences.cjs
// --source tests the controller in memory while UI build changes are in progress.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const sourceMode = process.argv.includes('--source');
const code = sourceMode
  ? require('typescript').transpileModule(fs.readFileSync(path.join(root, 'src/code.ts'), 'utf8'), {
    compilerOptions: { target: require('typescript').ScriptTarget.ES2020, module: require('typescript').ModuleKind.None, strict: true }
  }).outputText
  : fs.readFileSync(path.join(root, manifest.main), 'utf8');
const key = 'inbox-slicer:ui:v12';
const clone = value => JSON.parse(JSON.stringify(value));
const flush = () => new Promise(resolve => setImmediate(resolve));

function createHost() {
  const messages = [], shown = [], sizes = [], writes = [], reads = [], notices = [];
  let stored;
  let get = async () => stored;
  let set = async (storageKey, value) => { stored = clone(value); };
  const figma = {
    currentPage: { selection: [], appendChild() { throw new Error('Unexpected document change'); } },
    showUI(html, options) { shown.push(options); },
    ui: {
      postMessage(message) { messages.push(clone(message)); },
      resize(width, height) { sizes.push({ width, height }); }
    },
    clientStorage: {
      async getAsync(storageKey) { reads.push(storageKey); return get(storageKey); },
      async setAsync(storageKey, value) { writes.push({ key: storageKey, value: clone(value) }); await set(storageKey, value); }
    },
    on() {}, notify(message) { notices.push(message); },
    closePlugin() { figma.closed = true; },
    createFrame() { throw new Error('Unexpected document change'); }
  };
  const context = vm.createContext({ figma, __html__: '<html></html>', console, Uint8Array });
  vm.runInContext(code, context, { filename: sourceMode ? 'src/code.ts (transpiled)' : manifest.main });
  return {
    figma, context, messages, shown, sizes, writes, reads, notices,
    send: message => figma.ui.onmessage(message),
    setStored(value) { stored = value; },
    onGet(fn) { get = fn; },
    onSet(fn) { set = fn; }
  };
}

(async () => {
  const host = createHost();
  assert.deepEqual(clone(host.shown), [{ width: 800, height: 840, themeColors: true }], 'Compact default keeps the existing height and preview');
  assert.equal(host.messages.at(-1).type, 'SELECTION_ERROR');

  await host.send({ type: 'GET_UI_PREFERENCES' });
  assert.deepEqual(host.messages.at(-1), { type: 'UI_PREFERENCES', panelRatio: 0.38 });
  assert.deepEqual(host.reads, [key]);
  for (const invalid of [null, {}, { panelRatio: 0.24 }, { panelRatio: 0.61 }, { panelRatio: '0.4' }, { panelRatio: NaN }]) {
    host.setStored(invalid);
    await host.send({ type: 'GET_UI_PREFERENCES' });
    assert.deepEqual(host.messages.at(-1), { type: 'UI_PREFERENCES', panelRatio: 0.38 });
  }
  host.setStored({ panelRatio: 0.45, zoom: 4 });
  await host.send({ type: 'GET_UI_PREFERENCES' });
  assert.deepEqual(host.messages.at(-1), { type: 'UI_PREFERENCES', panelRatio: 0.45 }, 'Zoom is never restored as a preference');

  await host.send({ type: 'SAVE_UI_PREFERENCES', panelRatio: 0.5, zoom: 4, backendToken: 'fixture-not-a-credential' });
  assert.deepEqual(host.writes.at(-1), { key, value: { panelRatio: 0.5 } }, 'Only panel proportions are persisted');
  assert.deepEqual(host.messages.at(-1), { type: 'UI_PREFERENCES_SAVED', panelRatio: 0.5 });
  await host.send({ type: 'GET_UI_PREFERENCES' });
  assert.equal(host.messages.at(-1).panelRatio, 0.5);
  const validWriteCount = host.writes.length;
  for (const invalid of [undefined, null, '0.4', NaN, Infinity, 0.2, 0.7]) {
    await host.send({ type: 'SAVE_UI_PREFERENCES', panelRatio: invalid });
    assert.equal(host.messages.at(-1).type, 'UI_PREFERENCES_ERROR');
  }
  assert.equal(host.writes.length, validWriteCount, 'Invalid values never enter storage');

  // A later adjustment waits for an earlier one; completion order cannot restore an older layout.
  let releaseFirst;
  const held = new Promise(resolve => { releaseFirst = resolve; });
  const serial = createHost();
  let pendingCalls = 0;
  serial.onSet(async () => { pendingCalls++; if (pendingCalls === 1) await held; });
  const first = serial.send({ type: 'SAVE_UI_PREFERENCES', panelRatio: 0.35 });
  const second = serial.send({ type: 'SAVE_UI_PREFERENCES', panelRatio: 0.55 });
  await flush();
  assert.equal(pendingCalls, 1);
  assert.equal(serial.messages.filter(message => message.type === 'UI_PREFERENCES_SAVED').length, 0, 'No success before storage completes');
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(serial.writes.map(write => write.value), [{ panelRatio: 0.35 }, { panelRatio: 0.55 }]);
  assert.deepEqual(serial.messages.filter(message => message.type === 'UI_PREFERENCES_SAVED').map(message => message.panelRatio), [0.35, 0.55]);

  const failed = createHost();
  failed.onGet(async () => { throw new Error('fixture storage unavailable'); });
  await failed.send({ type: 'GET_UI_PREFERENCES' });
  assert.deepEqual(failed.messages.slice(-2), [
    { type: 'UI_PREFERENCES', panelRatio: 0.38 },
    { type: 'UI_PREFERENCES_ERROR', message: 'Panel layout could not be restored.' }
  ]);
  failed.onSet(async () => { throw new Error('fixture write unavailable'); });
  await failed.send({ type: 'SAVE_UI_PREFERENCES', panelRatio: 0.4 });
  assert.equal(failed.messages.at(-1).type, 'UI_PREFERENCES_ERROR');
  assert.equal(failed.messages.filter(message => message.type === 'UI_PREFERENCES_SAVED').length, 0);
  failed.onSet(async () => {});
  await failed.send({ type: 'SAVE_UI_PREFERENCES', panelRatio: 0.45 });
  assert.deepEqual(failed.messages.at(-1), { type: 'UI_PREFERENCES_SAVED', panelRatio: 0.45 }, 'A failed write cannot poison later changes');

  await host.send({ type: 'UI_RESIZE', width: 1100.4, height: 840.6 });
  assert.deepEqual(host.sizes.at(-1), { width: 1100, height: 841 });
  assert.deepEqual(host.messages.at(-1), { type: 'UI_WINDOW_RESIZED', width: 1100, height: 841 });
  await host.send({ type: 'UI_RESIZE', width: 10, height: 9999 });
  assert.deepEqual(host.sizes.at(-1), { width: 360, height: 1200 });
  await host.send({ type: 'UI_RESIZE', width: 9999, height: 1 });
  assert.deepEqual(host.sizes.at(-1), { width: 1600, height: 420 });
  const resizeCount = host.sizes.length;
  await host.send({ type: 'UI_RESIZE', width: Infinity, height: 700 });
  assert.equal(host.messages.at(-1).type, 'UI_PREFERENCES_ERROR');
  assert.equal(host.sizes.length, resizeCount);
  host.figma.ui.resize = () => { throw new Error('fixture native resize unavailable'); };
  await host.send({ type: 'UI_RESIZE', width: 900, height: 600 });
  assert.equal(host.messages.at(-1).type, 'UI_PREFERENCES_ERROR');
  assert.equal(host.writes.length, validWriteCount, 'Window resize does not persist window size or zoom');

  // Existing controller messages retain their previous selection/export guards and actions.
  await host.send({ type: 'REFRESH_SELECTION' });
  assert.equal(host.messages.at(-1).type, 'SELECTION_ERROR');
  await host.send({ type: 'EXPORT', horizontalCuts: [], verticalCutsBySection: {}, excludeAfterLastCut: true, scale: 2 });
  assert.deepEqual(host.messages.at(-1), { type: 'EXPORT_ERROR', message: 'Select an email frame first.' });
  await host.send({ type: 'PREPARE_KLAVIYO_EXPORT' });
  assert.equal(host.notices.at(-1), 'Klaviyo table export data prepared.');
  await host.send({ type: 'CLOSE' });
  assert.equal(host.figma.closed, true);

  // Safe type narrowing preserves the existing absoluteBoundingBox fallback for node variants.
  const frame = {
    id: 'root', width: 600, height: 1200, absoluteTransform: [[1, 0, 10], [0, 1, 20]],
    children: [
      { id: 'legacy', visible: true, absoluteBoundingBox: { x: 30, y: 40, width: 100, height: 50 } },
      { id: 'rendered', visible: true, absoluteRenderBounds: { x: 40, y: 60, width: 20, height: 30 }, absoluteBoundingBox: { x: 100, y: 100, width: 10, height: 10 } }
    ]
  };
  assert.deepEqual(clone(host.context.collectLayerBounds(frame)), [
    { x: 20, y: 20, width: 100, height: 50 },
    { x: 30, y: 40, width: 20, height: 30 }
  ]);
  console.log(`PASS: ${sourceMode ? 'source controller' : manifest.main} validates, serializes and restores panel preferences; storage failures, resize clamps, existing controller actions and layer-bound fallback verified.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
