// Run after npm run build; --source verifies the TypeScript controller in memory.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const sourceMode = process.argv.includes('--source');
const code = sourceMode ? require('typescript').transpileModule(fs.readFileSync(path.join(root, 'src/code.ts'), 'utf8'), {
  compilerOptions: { target: require('typescript').ScriptTarget.ES2020, module: require('typescript').ModuleKind.None, strict: true }
}).outputText : fs.readFileSync(path.join(root, manifest.main), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const idle = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function createHost(initial = ['A']) {
  const messages = [], events = new Map(), pageEvents = new Set(), clones = [], crops = [], reads = [], writes = [];
  const nodes = new Map();
  let selected = [], selectionWrites = 0, actualLayerLockWrites = 0;
  let render = async () => new Uint8Array([1, 2, 3]);
  let cropExport = async () => new Uint8Array([255, 216, 255, 217]);
  const document = { id: 'doc', type: 'DOCUMENT', parent: null };
  const page = {
    id: 'page', type: 'PAGE', parent: document,
    on(type, callback) { assert.equal(type, 'nodechange'); pageEvents.add(callback); },
    off(type, callback) { assert.equal(type, 'nodechange'); pageEvents.delete(callback); },
    appendChild(node) { node.parent = page; }
  };
  Object.defineProperty(page, 'selection', { get: () => selected, set() { selectionWrites++; throw Error('Controller must not change canvas selection'); } });
  for (const id of ['A', 'B', 'C']) {
    const frame = {
      id, name: `Frame ${id}`, type: 'FRAME', width: 600, height: 1200, visible: true, removed: false,
      parent: page, children: [], absoluteTransform: [[1, 0, 0], [0, 1, 0]],
      async exportAsync(options) { assert.equal(options.format, 'PNG'); return render(id, options); },
      clone() { clones.push(id); return { id: `clone-${id}`, sourceFrameId: id }; }
    };
    Object.defineProperty(frame, 'locked', { get: () => false, set() { actualLayerLockWrites++; throw Error('Controller must not lock Figma layers'); } });
    nodes.set(id, frame);
  }
  nodes.set('text-B', { id: 'text-B', type: 'TEXT', characters: 'Copyable text', parent: nodes.get('B'), removed: false });
  selected = initial.map(id => nodes.get(id));
  const figma = {
    currentPage: page, showUI() {},
    ui: { postMessage(message) { messages.push(clone(message)); }, resize() {} },
    on(type, callback) { events.set(type, callback); },
    notify() {}, closePlugin() {},
    getNodeByIdAsync: async id => { reads.push(id); return nodes.get(id) || null; },
    clientStorage: { getAsync: async () => ({ panelRatio: .41 }), async setAsync(key, value) { writes.push({ key, value: clone(value) }); } },
    createFrame() {
      const crop = {
        type: 'FRAME', removed: false, width: 0, height: 0,
        resize(width, height) { this.width = width; this.height = height; },
        appendChild(node) { this.clonedEmail = node; },
        async exportAsync(options) { assert.equal(options.format, 'JPG'); return cropExport(this, options); },
        remove() { this.removed = true; }
      };
      crops.push(crop);
      return crop;
    }
  };
  // Mock Figma methods and the controller share Error identity, as in the host.
  const context = vm.createContext({ figma, __html__: '<html></html>', console, Uint8Array, Error });
  vm.runInContext(code, context, { filename: sourceMode ? 'src/code.ts (transpiled)' : manifest.main });
  return {
    messages, nodes, clones, crops, reads, writes, pageEvents, page, context,
    async select(...ids) { selected = ids.map(id => nodes.get(id)); events.get('selectionchange')(); await idle(); },
    async pageChange(type = 'DELETE', id = 'A') { for (const callback of [...pageEvents]) callback({ nodeChanges: [{ type, id }] }); await idle(); },
    send: message => figma.ui.onmessage(message),
    get selection() { return selected; },
    get selectionWrites() { return selectionWrites; },
    get actualLayerLockWrites() { return actualLayerLockWrites; },
    setRender(fn) { render = fn; }, setCropExport(fn) { cropExport = fn; },
    state() { return clone(vm.runInContext('({workingFrameId, workingFrameLocked, workingFrameMissing, exportInProgress})', context)); },
    last(type) { return messages.filter(message => message.type === type).at(-1); },
    count(type) { return messages.filter(message => message.type === type).length; }
  };
}

const exportRequest = (workingFrameId = 'A') => ({ type: 'EXPORT', workingFrameId, horizontalCuts: [400, 800], verticalCutsBySection: { '0': [300] }, excludeAfterLastCut: true, scale: 2 });
const unlock = host => host.send({ type: 'SET_WORKING_FRAME_LOCK', frameId: host.state().workingFrameId, locked: false });

(async () => {
  const host = createHost(); await idle();
  assert.equal(host.last('FRAME_READY').frame.id, 'A');
  assert.equal(host.last('FRAME_READY').locked, true);
  assert.equal(host.state().workingFrameId, 'A');
  const initialMessages = host.count('FRAME_READY');
  const initialErrors = host.count('SELECTION_ERROR');
  await host.select('B');
  await host.select('text-B');
  await host.select();
  assert.equal(host.count('FRAME_READY'), initialMessages, 'Selecting other canvas nodes while locked never sends a replacement preview');
  assert.equal(host.count('SELECTION_ERROR'), initialErrors, 'Other canvas selections must not hide the working UI');
  assert.equal(host.state().workingFrameId, 'A');
  await host.select('B');
  await host.send(exportRequest());
  assert.deepEqual(host.clones, ['A', 'A', 'A'], 'Every exported crop must clone Frame A even when B is selected');
  assert.equal(host.last('EXPORT_COMPLETE').count, 3);
  assert(host.crops.every(crop => crop.removed), 'Temporary crop cleanup stays intact');
  assert(host.crops.every(crop => crop.clonedEmail.sourceFrameId === 'A'));
  assert.deepEqual(host.selection.map(node => node.id), ['B'], 'Export must not move canvas selection back to A');
  assert.equal(host.selectionWrites, 0);
  assert.equal(host.actualLayerLockWrites, 0);

  await unlock(host);
  assert.equal(host.state().workingFrameLocked, false);
  assert.equal(host.state().workingFrameId, 'A', 'Unlock alone must not adopt already-selected B');
  assert.equal(host.count('FRAME_SWITCH_REQUEST'), 0, 'Unlock does not propose an implicit switch');
  assert.equal(host.count('FRAME_READY'), initialMessages);
  await host.send({ type: 'REFRESH_SELECTION' });
  const canceled = host.last('FRAME_SWITCH_REQUEST');
  assert.equal(canceled.frame.id, 'B');
  await host.send({ type: 'FRAME_SWITCH_DECISION', requestId: canceled.requestId, accept: false });
  assert.equal(host.state().workingFrameId, 'A');
  assert.equal(host.state().workingFrameLocked, false);
  assert.equal(host.last('FRAME_SWITCH_CANCELED').requestId, canceled.requestId);
  await host.send({ type: 'FRAME_SWITCH_DECISION', requestId: canceled.requestId, accept: true });
  assert.equal(host.state().workingFrameId, 'A', 'Canceled requests cannot be accepted later');

  await host.select('B');
  const oldRequest = host.last('FRAME_SWITCH_REQUEST');
  await host.select('C');
  const newRequest = host.last('FRAME_SWITCH_REQUEST');
  await host.send({ type: 'FRAME_SWITCH_DECISION', requestId: oldRequest.requestId, accept: true });
  assert.equal(host.state().workingFrameId, 'A', 'A stale request cannot replace the working frame');
  await host.send({ type: 'FRAME_SWITCH_DECISION', requestId: newRequest.requestId, accept: true });
  assert.equal(host.state().workingFrameId, 'C');
  assert.equal(host.state().workingFrameLocked, true, 'Intentionally chosen frames lock automatically');
  assert.equal(host.last('FRAME_READY').switchConfirmed, true);
  assert.equal(host.last('FRAME_READY').preserveEdits, false);

  const countBeforeRefresh = host.count('FRAME_READY');
  await host.select('B');
  await host.send({ type: 'REFRESH_SELECTION' });
  assert.equal(host.count('FRAME_READY'), countBeforeRefresh + 1);
  assert.equal(host.last('FRAME_READY').frame.id, 'C', 'Locked refresh resolves the working ID, not selected B');
  assert.equal(host.last('FRAME_READY').preserveEdits, true);
  assert.equal(host.last('FRAME_READY').locked, true);
  await unlock(host); await host.select('C');
  assert.equal(host.count('FRAME_READY'), countBeforeRefresh + 1, 'Selecting the same frame does not reset its work');
  await host.send({ type: 'REFRESH_SELECTION' });
  assert.equal(host.last('FRAME_READY').locked, false, 'Refreshing the same frame retains unlocked mode');
  assert.equal(host.last('FRAME_READY').preserveEdits, true);

  // Deleting the frame or an ancestor retains identity and notifies without fallback.
  const deleted = createHost(); await idle();
  assert.equal(deleted.pageEvents.size, 1);
  const a = deleted.nodes.get('A'); deleted.nodes.delete('A'); a.removed = true;
  await deleted.pageChange('DELETE', 'ancestor-group');
  assert.equal(deleted.state().workingFrameId, 'A');
  assert.equal(deleted.state().workingFrameMissing, true);
  assert.equal(deleted.last('WORKING_FRAME_MISSING').frameId, 'A');
  await deleted.select('B');
  await deleted.send(exportRequest());
  assert.equal(deleted.crops.length, 0, 'Deleted-frame export cannot silently export selected B');
  assert.match(deleted.last('EXPORT_ERROR').message, /working frame no longer exists/);
  assert.equal(deleted.count('FRAME_READY'), 1);
  a.removed = false; deleted.nodes.set('A', a);
  await deleted.pageChange('CREATE', 'A');
  assert.equal(deleted.state().workingFrameMissing, false);
  assert.equal(deleted.last('WORKING_FRAME_LOCK_STATE').frameId, 'A');
  assert.equal(deleted.count('FRAME_READY'), 1, 'Undo restoration does not reset editing state');
  await deleted.send({ type: 'REFRESH_SELECTION' });
  assert.equal(deleted.last('FRAME_READY').preserveEdits, true);

  // Canceled/locked/failed renders must never commit late over newer choices.
  const racing = createHost(); await idle(); await unlock(racing); await racing.select('B');
  const held = deferred(); racing.setRender(id => id === 'B' ? held.promise : Promise.resolve(new Uint8Array([4])));
  const loadingB = racing.send({ type: 'FRAME_SWITCH_DECISION', requestId: racing.last('FRAME_SWITCH_REQUEST').requestId, accept: true });
  await idle();
  await racing.select('C');
  await racing.send({ type: 'FRAME_SWITCH_DECISION', requestId: racing.last('FRAME_SWITCH_REQUEST').requestId, accept: true });
  held.resolve(new Uint8Array([2])); await loadingB;
  assert.equal(racing.state().workingFrameId, 'C');
  assert.deepEqual(racing.messages.filter(message => message.type === 'FRAME_READY').map(message => message.frame.id), ['A', 'C']);
  await unlock(racing); await racing.select('B');
  const heldAgain = deferred(); racing.setRender(() => heldAgain.promise);
  const lateB = racing.send({ type: 'FRAME_SWITCH_DECISION', requestId: racing.last('FRAME_SWITCH_REQUEST').requestId, accept: true });
  await idle();
  await racing.send({ type: 'SET_WORKING_FRAME_LOCK', frameId: 'C', locked: true });
  heldAgain.resolve(new Uint8Array([2])); await lateB;
  assert.equal(racing.state().workingFrameId, 'C');
  assert.equal(racing.state().workingFrameLocked, true);
  await unlock(racing); await racing.select('B'); racing.setRender(async () => { throw Error('Fixture render failure'); });
  await racing.send({ type: 'FRAME_SWITCH_DECISION', requestId: racing.last('FRAME_SWITCH_REQUEST').requestId, accept: true });
  assert.equal(racing.state().workingFrameId, 'C');
  assert.match(racing.last('WORKING_FRAME_SELECTION_NOTICE').message, /Fixture render failure/);

  const initialRace = createHost([]); await idle();
  const initialHeld = deferred(); initialRace.setRender(id => id === 'A' ? initialHeld.promise : Promise.resolve(new Uint8Array([3])));
  await initialRace.select('A'); await initialRace.select('B');
  initialHeld.resolve(new Uint8Array([1])); await idle();
  assert.equal(initialRace.state().workingFrameId, 'B');
  assert.deepEqual(initialRace.messages.filter(message => message.type === 'FRAME_READY').map(message => message.frame.id), ['B']);

  // Export and preferences keep their contracts while stable IDs guard work.
  const busy = createHost(); await idle(); await unlock(busy); await busy.select('B');
  const cropHeld = deferred(); busy.setCropExport(() => cropHeld.promise);
  const exporting = busy.send(exportRequest()); await idle();
  assert.equal(busy.state().exportInProgress, true);
  await busy.send(exportRequest());
  assert.match(busy.last('EXPORT_ERROR').message, /already in progress/);
  await busy.send({ type: 'FRAME_SWITCH_DECISION', requestId: busy.last('FRAME_SWITCH_REQUEST').requestId, accept: true });
  assert.equal(busy.state().workingFrameId, 'A');
  cropHeld.resolve(new Uint8Array([255, 216, 255, 217])); await exporting;
  assert.equal(busy.state().exportInProgress, false);
  const cropCount = busy.crops.length;
  await busy.send(exportRequest('B'));
  assert.equal(busy.crops.length, cropCount);
  assert.match(busy.last('EXPORT_ERROR').message, /does not match/);
  await busy.send({ type: 'GET_UI_PREFERENCES' });
  assert.equal(busy.last('UI_PREFERENCES').panelRatio, .41);
  await busy.send({ type: 'SAVE_UI_PREFERENCES', panelRatio: .45 });
  assert.deepEqual(busy.writes.at(-1), { key: 'inbox-slicer:ui:v12', value: { panelRatio: .45 } });
  assert.equal(busy.selectionWrites, 0); assert.equal(busy.actualLayerLockWrites, 0);
  console.log(`PASS: ${sourceMode ? 'source controller' : manifest.main} auto-locks stable working IDs, ignores canvas selection without touching layers, preserves refresh/cancel/delete state, guards stale renders and exports the locked frame; preferences remain compatible.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
