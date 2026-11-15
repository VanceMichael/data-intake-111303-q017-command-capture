// stderr 独立诊断通道：限量保存，超量丢弃但持续排空。
// 持续排空是必须的——停止读取会让子进程阻塞在 stderr 写管道上。
// 截断时回退到 UTF-8 字符边界，避免截断说明里出现乱码。
export class Diagnostics {
  constructor(limit) {
    this.limit = limit;
    this.parts = [];
    this.captured = 0;
    this.dropped = 0;
  }

  push(chunk) {
    let keep = Math.min(chunk.length, Math.max(this.limit - this.captured, 0));
    if (keep > 0) {
      if (keep < chunk.length) keep = utf8Boundary(chunk, keep);
      this.parts.push(chunk.subarray(0, keep));
      this.captured += keep;
    }
    this.dropped += chunk.length - keep;
  }

  get truncated() {
    return this.dropped > 0;
  }

  summary() {
    return {
      text: Buffer.concat(this.parts).toString('utf8'),
      truncated: this.truncated,
      bytesCaptured: this.captured,
      bytesDropped: this.dropped,
    };
  }
}

function utf8Boundary(buffer, end) {
  if (end <= 0) return 0;
  let index = end - 1;
  while (index > 0 && (buffer[index] & 0xc0) === 0x80) index -= 1;
  const lead = buffer[index];
  const length = lead < 0x80 ? 1
    : (lead & 0xe0) === 0xc0 ? 2
      : (lead & 0xf0) === 0xe0 ? 3
        : (lead & 0xf8) === 0xf0 ? 4 : 1;
  return index + length <= end ? end : index;
}
