import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

// 运行日志：每次运行一条 stateDir/runs/<runId>.json，启动即写、完结改写。
// 恢复只依赖落盘记录，不依赖调用方持有的内存。
export class RunJournal {
  constructor(stateDir) {
    this.dir = path.join(stateDir, 'runs');
  }

  async ready() {
    await mkdir(this.dir, { recursive: true });
  }

  async write(record) {
    const file = path.join(this.dir, record.runId + '.json');
    const temporary = file + '.tmp';
    await writeFile(temporary, JSON.stringify(record, null, 2));
    await rename(temporary, file);
  }

  async start(record) {
    await this.write(record);
  }

  async finish(runId, patch) {
    let current = null;
    try {
      current = JSON.parse(await readFile(path.join(this.dir, runId + '.json'), 'utf8'));
    } catch { /* 记录缺失也要落下终态 */ }
    await this.write({ ...(current ?? {}), ...patch, runId });
  }

  async list() {
    let names;
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const records = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        records.push(JSON.parse(await readFile(path.join(this.dir, name), 'utf8')));
      } catch { /* 跳过损坏记录，不影响恢复 */ }
    }
    return records;
  }

  // 执行器重启恢复：上一 boot 留下的未完结运行一律判定 aborted，
  // 新 boot 绝不允许它们与本次运行混淆。
  async sweep(bootId) {
    const aborted = [];
    for (const record of await this.list()) {
      if (record.status === 'running' && record.bootId !== bootId) {
        const next = { ...record, status: 'aborted', reason: 'executor-restart', endedAt: new Date().toISOString() };
        await this.write(next);
        aborted.push(next.runId);
      }
    }
    return aborted;
  }
}
