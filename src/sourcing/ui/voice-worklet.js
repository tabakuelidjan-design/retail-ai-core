// AudioWorklet processor for Field Voice: forwards the microphone's mono samples to the page in blocks of ~2048 frames. It keeps nothing and sends nothing anywhere (the page feeds the
// on-device engine). Served from our own origin so the page's Content-Security-Policy ('self') stays tight (no blob: scripts).
class NordlaCapture extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) { this.buf[this.n++] = ch[i]; if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice(0)); this.n = 0; } }
    }
    return true;
  }
}
registerProcessor('nordla-capture', NordlaCapture);
