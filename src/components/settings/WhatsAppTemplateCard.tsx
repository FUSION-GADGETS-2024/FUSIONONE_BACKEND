'use client';

import { useEffect, useLayoutEffect, useRef } from 'react';
import { Pencil, Save } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import type { TemplateCardType } from '@/features/whatsapp/templateTokens';
import { templateToPreview } from '@/features/whatsapp/templateTokens';
import { TemplateTokenEditor } from './TemplateTokenEditor';

/**
 * WhatsAppTemplateCard — one document's message template card.
 *
 * VIEW MODE shows only the document title, description, Auto Send state (for
 * invoice cards), the RENDERED message preview (representative sample data),
 * and an Edit action. EDIT MODE transforms the very same preview area into
 * the token editor — no dialog, no second card, no separate editor block:
 * the preview becomes the editor in place (crossfade + smooth height
 * transition of the SAME region, never a layout jump).
 *
 * Invoice cards carry the Auto Send toggle; the payment-receipt and reminder
 * cards are template-only (receipts are manual-only sends; reminder POLICY
 * lives per-invoice) and show a fixed trigger descriptor instead.
 *
 * The card is a PRESENTATIONAL component: saved/draft state, persistence,
 * and the one-editor-at-a-time guard are owned by WhatsAppMessageSettingsPanel.
 */

export interface WhatsAppTemplateCardProps {
  type: TemplateCardType;
  label: string;
  description: string;
  /** Saved (persisted) configuration rendered in view mode. */
  autoSend?: boolean;
  onToggleAutoSend?: (next: boolean) => void;
  /** Toggle caption — 'Auto Send' for invoice cards, 'Automatic sending' for
   *  the payment-receipt switches (same control, exact wording per area). */
  autoSendLabel?: string;
  /** Fixed trigger descriptor for template-only cards (no Auto Send). */
  triggerLabel?: string;
  template: string;
  /** Edit-mode state (drives the inline editor while true). */
  editing: boolean;
  /** Draft template while `editing`. */
  draft: string;
  /** Save request in flight for this card. */
  saving: boolean;
  /** Whether the current user may edit (the store owner). */
  canEdit: boolean;
  onBeginEdit: () => void;
  onDraftChange: (next: string) => void;
  onCancel: () => void;
  onSave: () => void;
}

/**
 * Transition the SAME content region between view and edit heights: capture
 * the pre-change (auto) height, lock the container to it before paint, then
 * animate to the new content's height and release back to auto. Skipped
 * entirely under prefers-reduced-motion.
 */
function useInlineTransition(contentRef: React.RefObject<HTMLDivElement | null>, editing: boolean) {
  const lastAutoHeightRef = useRef<number | null>(null);

  // Continuously remember the region's natural (auto) height — the "from"
  // value for the next mode change.
  useEffect(() => {
    const el = contentRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      // Only record heights measured while NOT animating (explicit height
      // set by the transition below is never a "from" candidate).
      if (el.style.height === '') {
        lastAutoHeightRef.current = el.offsetHeight;
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [contentRef]);

  useLayoutEffect(() => {
    const el = contentRef.current;
    const from = lastAutoHeightRef.current;
    if (!el || from == null) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const to = el.offsetHeight; // new content at natural height
    if (Math.abs(from - to) < 1) return;
    // Hold the OLD height before the first paint of the new content…
    el.style.height = `${from}px`;
    el.style.overflow = 'hidden';
    void el.offsetHeight; // commit the start state
    // …then animate to the new height and release back to auto.
    el.style.transition = 'height 200ms cubic-bezier(0.4, 0, 0.2, 1)';
    el.style.height = `${to}px`;
    const release = () => {
      el.style.transition = '';
      el.style.height = '';
      el.style.overflow = '';
      el.removeEventListener('transitionend', onTransitionEnd);
    };
    const onTransitionEnd = (event: TransitionEvent) => {
      if (event.target === el && event.propertyName === 'height') release();
    };
    el.addEventListener('transitionend', onTransitionEnd);
    return release; // mid-flight mode flips release the inline styles
    // The mode flag is the ONLY trigger that matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);
}

export function WhatsAppTemplateCard(props: WhatsAppTemplateCardProps) {
  const {
    type,
    label,
    description,
    autoSend,
    onToggleAutoSend,
    autoSendLabel = 'Auto Send',
    triggerLabel,
    template,
    editing,
    draft,
    saving,
    canEdit,
    onBeginEdit,
    onDraftChange,
    onCancel,
    onSave,
  } = props;

  const contentRef = useRef<HTMLDivElement>(null);
  useInlineTransition(contentRef, editing);

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      {/* Header — stable: title, description, trigger mode (Auto Send /
          Automatic sending for cards with a switch; fixed descriptor for
          statement/reminder cards) */}
      <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-3.5">
        <div>
          <p className="text-xs font-semibold text-slate-900">{label}</p>
          <p className="text-[11px] text-slate-400">{description}</p>
        </div>
        {autoSend !== undefined && onToggleAutoSend ? (
          <label className="flex shrink-0 items-center gap-2 text-xs font-medium text-slate-700">
            <input
              type="checkbox"
              checked={autoSend}
              disabled={!canEdit}
              onChange={(event) => onToggleAutoSend(event.target.checked)}
              className="h-4 w-4 accent-indigo-600"
            />
            {autoSendLabel}
          </label>
        ) : (
          <span className="shrink-0 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
            {triggerLabel ?? 'Manual'}
          </span>
        )}
      </div>

      {/* Body — the SAME region is the preview (view) or the editor (edit) */}
      <div className="p-5">
        <p className="text-xs font-medium text-slate-700">Message template</p>
        <div ref={contentRef}>
          {/* Keyed by mode: the incoming content fades in while the region's
              height animates — the preview "transforms" into the editor. */}
          <div key={editing ? 'edit' : 'view'} className="content-fade-in mt-2">
            {editing ? (
              <TemplateTokenEditor
                value={draft}
                onChange={onDraftChange}
                autoFocus
                aria-label={`${label} message template`}
                placeholder="Write the message customers will receive…"
              />
            ) : (
              <div className="whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-xs leading-relaxed text-slate-600">
                {template ? (
                  templateToPreview(template, type)
                ) : (
                  <span className="text-slate-400">
                    {canEdit
                      ? 'No template saved yet — click Edit to write the customer message.'
                      : 'No template saved yet.'}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Action footer — same geometry in every mode (owner only) */}
      {canEdit && (
        <div className="flex min-h-[58px] items-center justify-end gap-2 border-t border-slate-100 bg-slate-50/50 px-5 py-3">
          {editing ? (
            <>
              <Button size="sm" variant="outline" onClick={onCancel} disabled={saving}>
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={onSave}
                disabled={saving}
                isLoading={saving}
                className="gap-1.5 bg-indigo-600 text-xs hover:bg-indigo-700"
              >
                {/* Icon always mounted — the Button's loading overlay keeps the
                    reserved footprint identical in every state. */}
                <Save className="h-3.5 w-3.5" />
                Save Changes
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={onBeginEdit}
              className="gap-1.5 text-xs"
            >
              <Pencil className="h-3.5 w-3.5" />
              Edit
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
