import { createHash } from 'node:crypto';

// ndjson-trailer-v1 成帧：
//   stdout 每行一个 JSON；资料行在前，最后一行必须是 {"trailer":{"count":N,"sha256":"..."}}。
//   摘要 = 此前全部资料行原始字节（含行尾 \n）的 sha256。
// 解析器是严格模式：非 JSON 行、尾标后还有数据、结尾半行都判成帧失败，
// 绝不退化成“在日志里找 JSON”。
export class TrailerParser {
  constructor({ maxRecords = 10000, maxLineBytes = 262144 } = {}) {
    this.maxRecords = maxRecords;
    this.maxLineBytes = maxLineBytes;
    this.pending = null;        // 未成行的字节（跨 chunk 半行）
    this.hash = createHash('sha256');
    this.digest = null;
    this.recordCount = 0;
    this.ids = [];
    this.records = [];          // 全部资料帧（受 maxRecords 限制）
    this.pendingRecords = [];   // 自上次 takeRecords 以来的资料帧
    this.trailer = null;
    this.error = null;          // 首个成帧错误，之后输入一律忽略
    this.ended = false;
    this.lineNo = 0;
  }

  feed(chunk) {
    if (this.ended || this.error) return;
    const data = this.pending ? Buffer.concat([this.pending, chunk]) : chunk;
    let offset = 0;
    for (;;) {
      const newline = data.indexOf(0x0a, offset);
      if (newline === -1) break;
      this.line(data.subarray(offset, newline));
      offset = newline + 1;
      if (this.error) { this.pending = null; return; }
    }
    this.pending = offset < data.length ? data.subarray(offset) : null;
    if (this.pending && this.pending.length > this.maxLineBytes) {
      this.error = 'line-too-long';
      this.pending = null;
    }
  }

  line(raw) {
    this.lineNo += 1;
    if (this.trailer) { this.error = 'trailing-data-after-trailer'; return; }
    if (raw.length > this.maxLineBytes) { this.error = 'line-too-long'; return; }
    let frame;
    try {
      frame = JSON.parse(raw.toString('utf8'));
    } catch {
      this.error = `invalid-json-line-${this.lineNo}`;
      return;
    }
    if (frame !== null && typeof frame === 'object' && !Array.isArray(frame) && 'trailer' in frame) {
      const trailer = frame.trailer;
      const wellFormed = trailer !== null && typeof trailer === 'object'
        && Number.isInteger(trailer.count) && trailer.count >= 0
        && typeof trailer.sha256 === 'string' && /^[0-9a-f]{64}$/.test(trailer.sha256);
      if (!wellFormed) { this.error = 'invalid-trailer'; return; }
      this.trailer = { count: trailer.count, sha256: trailer.sha256 };
      return;
    }
    this.recordCount += 1;
    if (this.recordCount > this.maxRecords) { this.error = 'too-many-records'; return; }
    // 摘要覆盖资料行原始字节（含行尾换行），与设备端计算方式一致
    this.hash.update(raw);
    this.hash.update('\n');
    this.records.push(frame);
    this.pendingRecords.push(frame);
    if (frame !== null && typeof frame === 'object' && typeof frame.id === 'string') this.ids.push(frame.id);
  }

  // 流结束。结尾残留半行 = 输出被截断。
  endOfStream() {
    if (this.ended) return;
    this.ended = true;
    if (!this.error && this.pending && this.pending.length > 0) this.error = 'truncated-final-line';
    this.pending = null;
  }

  // 运行器在 stdout 超限等情况下直接标记成帧失败
  fail(error) {
    if (!this.error) this.error = error;
  }

  takeRecords() {
    const out = this.pendingRecords;
    this.pendingRecords = [];
    return out;
  }

  // 汇总核验。只有 ok:true 才允许交付资料；调用方还必须确认退出码为 0。
  result() {
    if (!this.ended) this.endOfStream();
    const base = { recordCount: this.recordCount, trailer: this.trailer };
    if (this.error) return { ok: false, error: this.error, ...base, ids: [], records: [] };
    if (!this.trailer) return { ok: false, error: 'missing-trailer', ...base, ids: [], records: [] };
    if (this.trailer.count !== this.recordCount) return { ok: false, error: 'count-mismatch', ...base, ids: [], records: [] };
    if (this.digest === null) this.digest = this.hash.digest('hex');
    if (this.digest !== this.trailer.sha256) return { ok: false, error: 'digest-mismatch', ...base, ids: [], records: [] };
    return { ok: true, ...base, sha256: this.digest, ids: [...this.ids], records: [...this.records] };
  }
}
