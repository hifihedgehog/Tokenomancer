// The full report as a read-only Markdown document (tokenomancer:/Tokenomancer Report.md),
// regenerated whenever it is opened or refreshed.

import * as vscode from 'vscode';

export const REPORT_URI = vscode.Uri.parse('tokenomancer:/Tokenomancer Report.md');

export class ReportProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  private reg: vscode.Disposable;

  constructor(private readonly content: () => string) {
    this.reg = vscode.workspace.registerTextDocumentContentProvider('tokenomancer', this);
  }

  provideTextDocumentContent(): string { return this.content(); }

  /** Re-renders the report if it is open. */
  refresh() {
    if (vscode.workspace.textDocuments.some(d => d.uri.toString() === REPORT_URI.toString())) this.emitter.fire(REPORT_URI);
  }

  async open() {
    this.emitter.fire(REPORT_URI);
    const doc = await vscode.workspace.openTextDocument(REPORT_URI);
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  dispose() { this.reg.dispose(); this.emitter.dispose(); }
}
