// "Usage at a Glance": every limit in a QuickPick, then the common actions.

import * as vscode from 'vscode';
import { RunCommand, ViewModel } from './types';
import { glance } from './glanceItems';

type Item = vscode.QuickPickItem & { key?: string; command?: RunCommand };

export async function showGlance(vm: ViewModel, o: { openDashboard: (key?: string) => void; run: (c: RunCommand) => void }) {
  const g = glance(vm);
  const items: Item[] = g.items.map(i => i.separator
    ? { label: i.label, kind: vscode.QuickPickItemKind.Separator }
    : { label: i.label, description: i.description, detail: i.detail, key: i.key, command: i.command });
  const pick = await vscode.window.showQuickPick(items, {
    title: g.title,
    placeHolder: 'Pick a limit to open it in the dashboard',
    matchOnDetail: true,
  });
  if (!pick) return;
  if (pick.key) o.openDashboard(pick.key);
  else if (pick.command) o.run(pick.command);
}
