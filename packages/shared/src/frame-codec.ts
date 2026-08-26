const HEADER_BYTES = 4;
const DEFAULT_MAX_FRAME_BYTES = 64 * 1024 * 1024;

export function encodeFrame(value: unknown): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(value));
  const frame = new Uint8Array(HEADER_BYTES + payload.length);
  new DataView(frame.buffer).setUint32(0, payload.length, true);
  frame.set(payload, HEADER_BYTES);
  return frame;
}

export class FrameDecoder {
  private buffer = new Uint8Array();

  constructor(private readonly maxFrameBytes = DEFAULT_MAX_FRAME_BYTES) {}

  push(chunk: Uint8Array): unknown[] {
    const combined = new Uint8Array(this.buffer.length + chunk.length);
    combined.set(this.buffer);
    combined.set(chunk, this.buffer.length);
    this.buffer = combined;

    const values: unknown[] = [];
    while (this.buffer.length >= HEADER_BYTES) {
      const size = new DataView(
        this.buffer.buffer,
        this.buffer.byteOffset,
        this.buffer.byteLength,
      ).getUint32(0, true);
      if (size > this.maxFrameBytes) {
        throw new Error("Frame exceeds configured size limit");
      }
      if (this.buffer.length < HEADER_BYTES + size) {
        break;
      }

      const payload = this.buffer.slice(HEADER_BYTES, HEADER_BYTES + size);
      values.push(JSON.parse(new TextDecoder().decode(payload)));
      this.buffer = this.buffer.slice(HEADER_BYTES + size);
    }
    return values;
  }
}
