/** Promise-based mutex used by the lifecycle lock and the send serializer. */
export class AsyncMutex {
  private _locked = false;
  private readonly _queue: Array<() => void> = [];

  get locked(): boolean {
    return this._locked;
  }

  async acquire(): Promise<() => void> {
    if (!this._locked) {
      this._locked = true;
      return () => this._release();
    }

    return new Promise<() => void>((resolve) => {
      this._queue.push(() => {
        this._locked = true;
        resolve(() => this._release());
      });
    });
  }

  private _release(): void {
    this._locked = false;
    const next = this._queue.shift();
    if (next) {
      next();
    }
  }
}
