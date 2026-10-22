// Builds media/view.js and one standalone page per view-model fixture and surface, for the
// headless-Chromium preview harness or any browser:
//   node scripts/preview.mjs            → out/preview/<fixture>-<panel|view>.html and index.html
// Each page is the real shell (same CSP) plus a nonce'd boot script that stubs acquireVsCodeApi
// (unless the harness already did) and posts the fixture's {type:'model'} message.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'out', 'preview');
const fixtures = path.join(root, 'test', 'fixtures', 'vm');

await build({
  entryPoints: [path.join(root, 'src/webview/main.ts')], bundle: true, platform: 'browser', format: 'iife',
  target: 'chrome114', minify: true, outfile: path.join(root, 'media/view.js'), logLevel: 'warning',
});
const shell = await build({ entryPoints: [path.join(root, 'src/ui/webviewShell.ts')], bundle: true, format: 'esm', platform: 'neutral', write: false });
const { renderShell } = await import('data:text/javascript,' + encodeURIComponent(shell.outputFiles[0].text));

fs.mkdirSync(out, { recursive: true });
const rel = f => path.relative(out, path.join(root, f)).split(path.sep).join('/');
const pages = [];
for (const file of fs.readdirSync(fixtures).filter(f => f.endsWith('.json')).sort()) {
  const name = file.replace(/\.json$/, '');
  const fx = JSON.parse(fs.readFileSync(path.join(fixtures, file), 'utf8'));
  const msg = JSON.stringify({ type: 'model', vm: fx.vm, detail: fx.detail, theme: fx.theme ?? 'dark' }).replace(/</g, '\\u003c');
  for (const surface of ['panel', 'view']) {
    const nonce = 'preview' + Math.random().toString(36).slice(2).padEnd(12, '0');
    const boot = `<script nonce="${nonce}">
window.acquireVsCodeApi = window.acquireVsCodeApi || (() => { let s; return { postMessage: m => console.log('webview →', JSON.stringify(m)), getState: () => s, setState: v => { s = v; } }; });
addEventListener('load', () => setTimeout(() => window.postMessage(${msg}, '*'), 0));
</script>
`;
    const html = renderShell({ cspSource: 'file:', nonce, scriptUri: rel('media/view.js'), styleUri: rel('media/view.css'), surface })
      .replace(`<script nonce="${nonce}" src=`, `${boot}<script nonce="${nonce}" src=`);
    const page = `${name}-${surface}.html`;
    fs.writeFileSync(path.join(out, page), html);
    pages.push(page);
  }
}
fs.writeFileSync(path.join(out, 'index.html'), `<!DOCTYPE html><meta charset="utf-8"><title>Tokenomancer previews</title><ul>${pages.map(p => `<li><a href="${p}">${p}</a></li>`).join('')}</ul>\n`);
console.log(`${pages.length} pages in ${path.relative(root, out)}`);
