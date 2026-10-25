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
const clone = value => JSON.parse(JSON.stringify(value));

function createHost() {
  const messages = [], shown = [], sizes = [], writes = [], reads = [], notices = [];
  const figma = {
    currentPage: { selection: [], appendChild() { throw new Error('Unexpected document change'); } },
    showUI(html, options) { shown.push(options); },
    ui: {
      postMessage(message) { messages.push(clone(message)); },
      resize(width, height) { sizes.push({ width, height }); }
    },
    clientStorage: {
      async getAsync(storageKey) { reads.push(storageKey); throw new Error('Layout preferences must never be read'); },
      async setAsync(storageKey, value) { writes.push({ key: storageKey, value: clone(value) }); throw new Error('Layout preferences must never be saved'); }
    },
    on() {}, notify(message) { notices.push(message); },
    closePlugin() { figma.closed = true; },
    createFrame() { throw new Error('Unexpected document change'); }
  };
  const context = vm.createContext({ figma, __html__: '<html></html>', console, Uint8Array });
  vm.runInContext(code, context, { filename: sourceMode ? 'src/code.ts (transpiled)' : manifest.main });
  return {
    figma, context, messages, shown, sizes, writes, reads, notices,
    send: message => figma.ui.onmessage(message)
  };
}

(async () => {
  const host = createHost();
  assert.deepEqual(clone(host.shown), [{ width: 560, height: 840, themeColors: true }], 'Every launch uses the fixed compact default and existing height');
  assert.equal(host.messages.at(-1).type, 'SELECTION_ERROR');

  // Obsolete messages and saved values cannot restore or persist a split ratio.
  const initialMessages = clone(host.messages);
  for (const panelRatio of [undefined, null, .25, .38, .5, .6, '0.4', NaN, Infinity]) {
    await host.send({ type: 'GET_UI_PREFERENCES' });
    await host.send({ type: 'SAVE_UI_PREFERENCES', panelRatio, width: 1600, height: 1200, zoom: 4 });
    await host.send({ type: 'UI_PREFERENCES', panelRatio, width: 1600, height: 1200, windowWidth: 1600, windowHeight: 1200, zoom: 4 });
  }
  assert.deepEqual(host.messages, initialMessages, 'Removed panel preferences are ignored without side effects');
  assert.deepEqual(host.reads, [], 'The removed preference key is never restored');
  assert.deepEqual(host.writes, [], 'No layout or window preference is persisted');
  assert.deepEqual(host.sizes, [], 'Obsolete saved dimensions cannot resize the window');
  for (let launch = 0; launch < 3; launch++) {
    const fresh = createHost();
    assert.deepEqual(clone(fresh.shown), [{ width: 560, height: 840, themeColors: true }]);
    assert.deepEqual(fresh.reads, []);
    assert.deepEqual(fresh.writes, []);
  }

  await host.send({ type: 'UI_RESIZE', width: 1100.4, height: 840.6 });
  assert.deepEqual(host.sizes.at(-1), { width: 1100, height: 841 });
  assert.deepEqual(host.messages.at(-1), { type: 'UI_WINDOW_RESIZED', width: 1100, height: 841 });
  await host.send({ type: 'UI_RESIZE', width: 10, height: 9999 });
  assert.deepEqual(host.sizes.at(-1), { width: 360, height: 1200 });
  await host.send({ type: 'UI_RESIZE', width: 9999, height: 1 });
  assert.deepEqual(host.sizes.at(-1), { width: 1600, height: 420 });
  const resizeCount = host.sizes.length;
  await host.send({ type: 'UI_RESIZE', width: Infinity, height: 700 });
  assert.equal(host.messages.at(-1).type, 'UI_WINDOW_ERROR');
  assert.equal(host.sizes.length, resizeCount);
  host.figma.ui.resize = () => { throw new Error('fixture native resize unavailable'); };
  await host.send({ type: 'UI_RESIZE', width: 900, height: 600 });
  assert.equal(host.messages.at(-1).type, 'UI_WINDOW_ERROR');
  assert.deepEqual(host.writes, [], 'Window resize does not persist window size or zoom');
  assert.deepEqual(host.reads, [], 'Manual resizing cannot restore layout preferences');

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
  console.log(`PASS: ${sourceMode ? 'source controller' : manifest.main} opens at the fixed 560px default, ignores obsolete panel preferences without storage access, retains resize clamps/errors, controller actions and layer-bound fallback.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
