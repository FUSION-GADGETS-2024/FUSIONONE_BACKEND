'use client';

/**
 * useFieldErrors — the ONE interaction model for inline field errors.
 *
 *   untouched field            → normal (never an error on a freshly opened form)
 *   interacted/blurred field   → its error (if any) shows
 *   form submission            → every field's error shows
 *
 * The caller computes a per-field error map each render from the canonical
 * validators (pure, cheap) and passes each entry through `show(field, err)`
 * to decide visibility. Toasts are NOT part of this model — field errors
 * render next to their fields; toasts stay for operation/server failures.
 */
import { useCallback, useState } from 'react';

export function useFieldErrors<K extends string = string>() {
  const [touched, setTouched] = useState<ReadonlySet<K>>(new Set());
  const [submitted, setSubmitted] = useState(false);

  /** Mark one field as interacted (its error becomes visible). */
  const touch = useCallback((field: K) => {
    setTouched(prev => {
      if (prev.has(field)) return prev;
      const next = new Set(prev);
      next.add(field);
      return next;
    });
  }, []);

  /**
   * The visible error for one field, or null. An error shows once the field
   * has been interacted with OR the form was submitted.
   */
  const show = useCallback(
    (field: K, error: string | null | undefined): string | null =>
      error && (submitted || touched.has(field)) ? error : null,
    [touched, submitted],
  );

  /** Mark the form as submission-attempted (all errors become visible). */
  const beginSubmit = useCallback(() => setSubmitted(true), []);

  /** Clear the interaction state (form re-opened / reset). */
  const reset = useCallback(() => {
    setTouched(new Set());
    setSubmitted(false);
  }, []);

  return { touch, show, beginSubmit, reset, isSubmitted: submitted };
}

/**
 * Focus the first invalid control after a failed submit — inside any OPEN
 * dialog first (modals portal to the end of the DOM), then the page.
 * Controls are marked aria-invalid by Field + Input/MoneyInput wiring.
 *
 * Deferred to the next frame ON PURPOSE: submit handlers call this right
 * after beginSubmit()'s state update, and the aria-invalid attributes only
 * exist once React has re-rendered the fields with their errors.
 */
export function focusFirstInvalid(): void {
  if (typeof window === 'undefined') return;
  const focus = () => {
    const el =
      document.querySelector<HTMLElement>('[role="dialog"] [aria-invalid="true"]') ??
      document.querySelector<HTMLElement>('[aria-invalid="true"]');
    el?.focus();
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(focus);
  else setTimeout(focus, 0);
}
