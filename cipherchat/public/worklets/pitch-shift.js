// v1.5.0 实时变声 AudioWorklet：pitch shift（全部本地，音频不出设备）
// 原理：简易颗粒合成（granular pitch shift）—— 用读取指针以变速扫过环形缓冲，
// 输出时做线性插值 + 交叉淡化，ratio>1 升调 / <1 降调。
class PitchShiftProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const opts = (options && options.processorOptions) || {}
    this.ratio = opts.ratio || 1.0 // 变调比率 0.5-2.0
    this.grainSize = opts.grainSize || 2048 // 颗粒大小（采样数）
    this.buffer = new Float32Array(this.grainSize * 4)
    this.writePos = 0
    this.readPos = 0
    this.fraction = 0 // 亚采样插值余数
  }

  setRatio(r) {
    this.ratio = Math.min(2, Math.max(0.5, r))
    this.port.postMessage({ type: 'ratio', value: this.ratio })
  }

  process(inputs, outputs) {
    const input = inputs[0]
    const output = outputs[0]
    if (!input || input.length === 0 || !output || output.length === 0) return true
    const inCh = input[0]
    const outCh = output[0]

    // 写入环形缓冲
    for (let i = 0; i < inCh.length; i++) {
      this.buffer[this.writePos] = inCh[i]
      this.writePos = (this.writePos + 1) % this.buffer.length
    }

    // 以 ratio 速率读取（变速 → 变调），双颗粒交叉淡化减少金属声
    const grain = this.grainSize
    for (let i = 0; i < outCh.length; i++) {
      // 读指针按 1/ratio 前进（读得慢 = 拉长 = 音调升高）
      const advance = 1 / this.ratio
      this.readPos = (this.readPos + advance) % this.buffer.length

      // 环形缓冲线性插值
      const p0 = Math.floor(this.readPos)
      const p1 = (p0 + 1) % this.buffer.length
      const frac = this.readPos - p0
      let sample = this.buffer[p0] * (1 - frac) + this.buffer[p1] * frac

      // 与延迟一个颗粒的信号交叉淡化（抑制周期性伪影）
      const echoP = Math.floor((this.readPos + grain) % this.buffer.length)
      const echo1 = (echoP + 1) % this.buffer.length
      const echoFrac = this.readPos - Math.floor(echoP)
      const echoSample =
        this.buffer[echoP % this.buffer.length] * (1 - echoFrac) +
        this.buffer[echo1] * echoFrac
      sample = sample * 0.65 + echoSample * 0.35

      outCh[i] = Math.max(-1, Math.min(1, sample))
    }
    return true
  }
}

registerProcessor('pitch-shift', PitchShiftProcessor)
