/**
 * A generic deterministic state machine that enforces validated transitions.
 * Invalid transitions are rejected and logged; they never silently occur.
 */
import { getLogger } from '../logging/logger.js';

export interface StateMachineOptions<TState extends string> {
  name: string;
  initialState: TState;
  isValidTransition: (from: TState, to: TState) => boolean;
  onTransition?: (from: TState, to: TState) => void;
}

export class StateMachine<TState extends string> {
  private _state: TState;
  private readonly name: string;
  private readonly isValidTransition: (from: TState, to: TState) => boolean;
  private readonly onTransition?: (from: TState, to: TState) => void;
  private readonly subscribers = new Set<(from: TState, to: TState) => void>();
  private _locked = false;

  constructor(opts: StateMachineOptions<TState>) {
    this.name = opts.name;
    this._state = opts.initialState;
    this.isValidTransition = opts.isValidTransition;
    this.onTransition = opts.onTransition;
  }

  get state(): TState {
    return this._state;
  }

  /** Subscribe to every applied transition (including forceTransition). */
  subscribe(listener: (from: TState, to: TState) => void): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  private notify(from: TState, to: TState): void {
    this.onTransition?.(from, to);
    for (const listener of this.subscribers) {
      try {
        listener(from, to);
      } catch {
        // a broken subscriber must never break the machine
      }
    }
  }

  /** Attempt a state transition; true if applied, false if rejected. */
  transition(to: TState): boolean {
    if (this._locked) {
      getLogger().warn(
        { stateMachine: this.name, from: this._state, to },
        'State machine is locked; transition rejected',
      );
      return false;
    }

    const from = this._state;

    if (from === to) {
      return true; // same-state is a no-op, not an error
    }

    if (!this.isValidTransition(from, to)) {
      getLogger().error(
        { stateMachine: this.name, from, to },
        'Invariant violation: invalid state transition attempted',
      );
      return false;
    }

    this._state = to;
    getLogger().debug(
      { stateMachine: this.name, from, to },
      'State transition',
    );
    this.notify(from, to);
    return true;
  }

  /**
   * Force a transition without validation — recovery to a safe state only
   * (security invalidation, shutdown, destruction settling).
   */
  forceTransition(to: TState, reason: string): void {
    const from = this._state;
    getLogger().warn(
      { stateMachine: this.name, from, to, reason },
      'Forced state transition (recovery)',
    );
    this._state = to;
    this.notify(from, to);
  }

  /** Lock the machine — no further transitions (graceful shutdown). */
  lock(): void {
    this._locked = true;
  }
}
