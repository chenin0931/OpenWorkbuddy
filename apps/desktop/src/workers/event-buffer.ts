export class TextDeltaBuffer {
  private pending = ''
  private timer: NodeJS.Timeout | undefined

  constructor(
    private readonly emit: (delta: string) => void,
    private readonly maxDelayMs = 50,
    private readonly maxCharacters = 256,
  ) {}

  push(delta: string): void {
    if (!delta) return
    this.pending += delta
    if (this.pending.length >= this.maxCharacters) {
      this.flush()
      return
    }
    if (!this.timer) this.timer = setTimeout(() => this.flush(), this.maxDelayMs)
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (!this.pending) return
    const delta = this.pending
    this.pending = ''
    this.emit(delta)
  }

  dispose(): void {
    this.flush()
  }
}
