// Watches Claude Code's projects folder so new log lines are picked up at once.
// Windows and macOS watch the whole tree natively; on Linux (including WSL and
// SSH remotes) a recursive watch means one inotify handle per file, so only the
// folder and its project subfolders are watched. A periodic scan elsewhere
// catches anything a watcher misses, and a missing folder is retried.

import * as fs from 'fs';
import * as path from 'path';

export class LogWatcher {
  private watchers: fs.FSWatcher[] = [];
  private retry?: NodeJS.Timeout;
  private debounce?: NodeJS.Timeout;
  private disposed = false;

  constructor(private readonly dir: string, private readonly onChange: () => void, private readonly log: (m: string) => void) {
    this.start();
  }

  private start() {
    this.close();
    if (this.disposed) return;
    const recursive = process.platform === 'win32' || process.platform === 'darwin';
    try {
      this.add(this.dir, recursive);
      if (!recursive) {
        for (const e of fs.readdirSync(this.dir, { withFileTypes: true })) if (e.isDirectory()) this.add(path.join(this.dir, e.name), false);
      }
    } catch (e: any) {
      if (e?.code !== 'ENOENT') this.log(`Not watching ${this.dir} (${e?.message ?? e}); relying on the periodic scan.`);
      this.close();
    }
    // Re-arm every minute: picks up new project folders on Linux and recovers from errors or a folder created later.
    this.retry = setTimeout(() => this.start(), this.watchers.length && recursive ? 10 * 60_000 : 60_000);
  }

  private add(dir: string, recursive: boolean) {
    const w = fs.watch(dir, { recursive }, (_ev, file) => {
      if (file && !String(file).endsWith('.jsonl')) return;
      clearTimeout(this.debounce);
      this.debounce = setTimeout(this.onChange, 250);
    });
    w.on('error', () => { w.close(); this.watchers = this.watchers.filter(x => x !== w); });
    this.watchers.push(w);
  }

  private close() {
    clearTimeout(this.retry);
    for (const w of this.watchers) { try { w.close(); } catch { /* already closed */ } }
    this.watchers = [];
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.debounce);
    this.close();
  }
}
