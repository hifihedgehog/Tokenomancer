// The HTML both webview hosts serve: a strict CSP, one stylesheet, one nonce'd script and an
// empty root that media/view.js fills. Pure: no vscode, no Node.

export interface ShellOptions {
  cspSource: string;                      // webview.cspSource
  nonce: string;                          // fresh per render, from nonce()
  scriptUri: string;                      // webview.asWebviewUri(media/view.js)
  styleUri: string;                       // webview.asWebviewUri(media/view.css)
  surface: 'panel' | 'view';
}

const attr = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

/** 32 random base-62 characters for the script nonce. */
export function nonce(): string {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, b => abc[b % 62]).join('');
}

/** The CSP is the official sample's recipe: nothing but our own stylesheet and our nonce'd script. */
export function csp(cspSource: string, n: string): string {
  return `default-src 'none'; style-src ${cspSource}; script-src 'nonce-${n}';`;
}

export function renderShell(o: ShellOptions): string {
  // Both values land inside the CSP itself, where escaping can't help: refuse anything odd.
  if (!/^[A-Za-z0-9+/_-]{16,}={0,2}$/.test(o.nonce)) throw new Error('renderShell: bad nonce');
  // VS Code's cspSource is a space-separated source list such as "'self' https://*.vscode-cdn.net".
  const src = o.cspSource.trim();
  if (!src || !src.split(/\s+/).every(t => /^('self'|[a-z][a-z0-9+.-]*:(\/\/[A-Za-z0-9*+.:/_-]+)?)$/i.test(t))) throw new Error('renderShell: bad cspSource');
  const surface = o.surface === 'view' ? 'view' : 'panel';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${attr(csp(src, o.nonce))}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${attr(o.styleUri)}">
<title>Claude Usage</title>
</head>
<body data-surface="${surface}">
<main id="tk-root" aria-busy="true"></main>
<script nonce="${o.nonce}" src="${attr(o.scriptUri)}"></script>
</body>
</html>
`;
}
