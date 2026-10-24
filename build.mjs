let ts;
try {
  ts = (await import('typescript')).default;
} catch {
  ts = (await import('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript/lib/typescript.js')).default;
}
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
const source = await readFile('src/code.ts', 'utf8');
const result = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.None,
    strict: true
  }
});
await writeFile('dist/code.js', result.outputText);
await copyFile('src/ui.html', 'dist/ui.html');
console.log('Built dist/code.js and dist/ui.html');
