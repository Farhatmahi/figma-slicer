// Verify the files Figma actually imports, not only the editable source.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
const pkg = JSON.parse(read('package.json'));
assert.equal(manifest.name, 'InboxImplementor Slicer v12.0', 'Figma menu must identify the new installation');
assert.equal(manifest.id, 'inboximplementor-slicer', 'Keep the existing plugin identity and storage scope');
assert.equal(pkg.version, '12.0.0');
assert.equal(manifest.ui, 'dist/ui.html');
assert.equal(manifest.main, 'dist/code.js');

const html = read(manifest.ui);
const controller = read(manifest.main);
assert.equal(html, read('src/ui.html'), 'Production HTML is stale: run npm run build');
const expectedController = ts.transpileModule(read('src/code.ts'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None, strict: true }
}).outputText;
assert.equal(controller, expectedController, 'Production controller is stale: run npm run build');
for (const id of ['pluginVersion', 'previewPanel', 'panelDivider', 'workflowPanel', 'frameStep', 'sliceStep', 'reviewStep', 'klaviyoPanel', 'createStep', 'klaviyoAccountTrigger', 'klaviyoAccountSearch']) {
  assert(html.includes(`id="${id}"`), `Missing built v12 component: ${id}`);
}
assert.equal((html.match(/class="card workflow-step"/g) || []).length, 5);
for (const token of ['--ii-bg: #ffffff', '--ii-text: #101828', '--ii-accent: #00b8f5']) {
  assert(html.includes(token), `Missing v12 light-theme token: ${token}`);
}
assert(html.includes('@media (max-width: 839px)'), 'Retain compact responsive stacking');
assert(html.includes('id="pluginVersion"') && html.includes('>v12.0</span>'));

let opening;
vm.runInNewContext(controller, {
  __html__: html,
  figma: {
    showUI(actualHtml, options) {
      assert.equal(actualHtml, html, 'showUI must receive the manifest-selected HTML');
      opening = options;
    },
    currentPage: { selection: [] }, ui: { postMessage() {} }, on() {}
  }
});
assert.equal(opening.width, 1100, 'Normal launch must be above the split-layout breakpoint');
assert.equal(opening.height, 840);
const digest = crypto.createHash('sha256').update(html).digest('hex');
console.log(`PASS: ${manifest.name}; manifest -> ${manifest.main} + ${manifest.ui}; source/built files match; 5-step light workspace opens ${opening.width}x${opening.height}; UI SHA256 ${digest}.`);
