import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csp, nonce, renderShell } from '../ui/webviewShell';

const base = { cspSource: 'https://file+.vscode-resource.vscode-cdn.net', nonce: 'abcDEF0123456789abcDEF0123456789', scriptUri: 'https://x/media/view.js', styleUri: 'https://x/media/view.css', surface: 'panel' as const };

test('the CSP allows only our stylesheet and our nonce’d script', () => {
  assert.equal(csp(base.cspSource, base.nonce), `default-src 'none'; style-src ${base.cspSource}; script-src 'nonce-${base.nonce}';`);
  const html = renderShell(base);
  assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; style-src https:\/\/file\+\.vscode-resource\.vscode-cdn\.net; script-src &#39;nonce-abcDEF0123456789abcDEF0123456789&#39;;">/);
});

test('the served HTML has no inline style and exactly one script, nonce’d', () => {
  const html = renderShell(base);
  assert.doesNotMatch(html, /style=/i);
  assert.doesNotMatch(html, /<style/i);
  const scripts = html.match(/<script[^>]*>/g) ?? [];
  assert.deepEqual(scripts, [`<script nonce="${base.nonce}" src="https://x/media/view.js">`]);
  assert.match(html, /<link rel="stylesheet" href="https:\/\/x\/media\/view.css">/);
  assert.match(html, /<main id="tk-root" aria-busy="true"><\/main>/);
});

test('the surface picks the layout; anything unknown is the panel', () => {
  assert.match(renderShell({ ...base, surface: 'view' }), /<body data-surface="view">/);
  assert.match(renderShell({ ...base, surface: 'bogus' as 'view' }), /<body data-surface="panel">/);
});

test('URIs are attribute-escaped', () => {
  const html = renderShell({ ...base, scriptUri: 'https://x/a"onload="alert(1)', styleUri: "https://x/b'<c>" });
  assert.doesNotMatch(html, /"onload=/);
  assert.match(html, /src="https:\/\/x\/a&#34;onload=&#34;alert\(1\)"/);
  assert.match(html, /href="https:\/\/x\/b&#39;&#60;c&#62;"/);
});

test('values that land inside the CSP itself are refused, not escaped', () => {
  assert.throws(() => renderShell({ ...base, nonce: "x'; script-src *" }), /bad nonce/);
  assert.throws(() => renderShell({ ...base, nonce: 'short' }), /bad nonce/);
  assert.throws(() => renderShell({ ...base, cspSource: "https://x; script-src 'unsafe-inline'" }), /bad cspSource/);
  assert.throws(() => renderShell({ ...base, cspSource: '' }), /bad cspSource/);
});

test('nonce() is 32 base-62 characters and fresh each time', () => {
  const a = nonce(), b = nonce();
  assert.match(a, /^[A-Za-z0-9]{32}$/);
  assert.notEqual(a, b);
  assert.doesNotThrow(() => renderShell({ ...base, nonce: a }));
});
