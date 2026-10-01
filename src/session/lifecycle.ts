/**
 * Lifecycle coordination: the lifecycle lock (serializes session
 * destruction), the sends-blocked flag, and the session generation/epoch
 * counter that lets in-flight async operations detect that a destructive
 * operation superseded them.
 */
import { AsyncMutex } from '../utils/mutex.js';

class LifecycleManagerImpl {
  private readonly _lifecycleLock = new AsyncMutex();
  private _sendsBlocked = false;
  private _shuttingDown = false;
  /** Incremented FIRST by every destructive session operation; async
   *  operations touching session material capture it on entry and must
   *  discard their result if it changed — a destroyed session can never
   *  be resurrected. */
  private _sessionGeneration = 0;

  get lifecycleLock(): AsyncMutex {
    return this._lifecycleLock;
  }

  get sessionGeneration(): number {
    return this._sessionGeneration;
  }

  invalidateSessionGeneration(): void {
    this._sessionGeneration += 1;
  }

  get sendsBlocked(): boolean {
    return this._sendsBlocked;
  }

  get shuttingDown(): boolean {
    return this._shuttingDown;
  }

  blockSends(): void {
    this._sendsBlocked = true;
  }

  unblockSends(): void {
    this._sendsBlocked = false;
  }

  markShuttingDown(): void {
    this._shuttingDown = true;
    this._sendsBlocked = true;
  }
}

let _instance: LifecycleManagerImpl | null = null;

export function getLifecycle(): LifecycleManagerImpl {
  if (!_instance) {
    _instance = new LifecycleManagerImpl();
  }
  return _instance;
}
