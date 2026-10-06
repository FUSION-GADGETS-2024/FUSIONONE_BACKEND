'use client';

import { useEffect, useRef, useState } from 'react';
import { Lock } from 'lucide-react';
import { supabase } from '@/platform/supabase/client';
import { useSession } from '@/components/providers/SessionProvider';
import { useToast } from '@/components/ui/Toast';
import { useSkeletonDelay } from '@/components/ui/Skeleton';
import { cn } from '@/components/ui/utils';
import { invalidateWhatsAppState } from '@/features/invalidate';
import type { MessageSettings } from '@/features/messages/settings';
import type { TemplateCardType } from '@/features/whatsapp/templateTokens';
import { useWhatsAppMessageSettings } from '@/features/whatsapp/useWhatsAppMessageSettings';
import { WhatsAppTemplateCard } from './WhatsAppTemplateCard';

/**
 * WhatsAppMessageSettingsPanel — the WhatsApp TEMPLATES section: the eight message
 * template cards (invoices, payment receipts In/Out, payment statements
 * In/Out, reminder), each with its rendered preview and in-place editor.
 * Rendered by the dedicated WhatsApp Templates page — template editing is
 * the page's ONE concern. The automatic-sending SWITCHES (configuration)
 * live on the Settings → WhatsApp page, not here; each card therefore shows
 * a fixed trigger descriptor instead of a control.
 *
 * STATE MODEL:
 *   - `settings` — the SAVED per-type configuration (raw template for every
 *     card; the autoSend flags belong to the Settings page), initialized
 *     exactly once from the shared `whatsapp_settings` query (the same
 *     init-once pattern as before; never re-clobbered by refetches).
 *   - `editingType` + `draft` — the ONE open editor (view → edit transition
 *     happens inside the card itself). At most one editor is open at a time;
 *   - persistence is PER CARD: each template saves on its own Save Changes
 *     (partial upsert of just that column — every column of the singleton
 *     row has a NOT NULL DEFAULT, so a first-time partial insert is safe).
 *     There is deliberately NO page-level save action.
 *
 * The one-editor-at-a-time guard: switching to another template while the
 * current editor has unsaved changes is BLOCKED with a warning — changes are
 * never silently discarded. A clean editor is simply closed by switching.
 */

interface TemplateField {
  type: TemplateCardType;
  label: string;
  description: string;
  /** Fixed trigger descriptor — the sending POLICY, not a control (the
   *  automatic-sending switches live on the Settings → WhatsApp page). */
  triggerLabel: string;
}

const TEMPLATE_FIELDS: ReadonlyArray<TemplateField> = [
  { type: 'sale', label: 'Sales Invoice', description: 'Sent to the customer number when an invoice is created (if Auto Send is on) or shared manually.', triggerLabel: 'Auto Send' },
  { type: 'purchase', label: 'Purchase Bill', description: 'Sent to the party number when a purchase bill is created (if Auto Send is on) or shared manually.', triggerLabel: 'Auto Send' },
  { type: 'proforma', label: 'Quotation / Proforma', description: 'Sent to the customer number when a quotation is created (if Auto Send is on) or shared manually.', triggerLabel: 'Auto Send' },
  { type: 'payment_in', label: 'Payment Receipt (In)', description: 'Automatically send a receipt when a payment is received against an existing invoice. The initial payment made during invoice creation never triggers one — the invoice itself already carries it.', triggerLabel: 'Automatic sending' },
  { type: 'payment_out', label: 'Payment Receipt (Out)', description: 'Automatically send a receipt when a payment is made against an existing purchase bill. The initial payment made during bill creation never triggers one — the bill itself already carries it.', triggerLabel: 'Automatic sending' },
  { type: 'statement_in', label: 'Payment Statement (In)', description: 'Sent manually from an invoice\u2019s Payments dialog — the complete payment history for the invoice, including the initial payment.', triggerLabel: 'Manual send' },
  { type: 'statement_out', label: 'Payment Statement (Out)', description: 'Sent manually from a purchase bill\u2019s Payments dialog — the complete payment history for the bill, including the initial payment.', triggerLabel: 'Manual send' },
  { type: 'reminder', label: 'Payment Reminder', description: 'Sent automatically on the schedule configured per invoice, or triggered manually.', triggerLabel: 'Per invoice' },
];

const LABEL_BY_TYPE: Record<TemplateCardType, string> = {
  sale: 'Sales Invoice',
  purchase: 'Purchase Bill',
  proforma: 'Quotation / Proforma',
  payment_in: 'Payment Receipt (In)',
  payment_out: 'Payment Receipt (Out)',
  statement_in: 'Payment Statement (In)',
  statement_out: 'Payment Statement (Out)',
  reminder: 'Payment Reminder',
};

/** The `whatsapp_settings` column that stores each card's template. */
const TEMPLATE_COLUMN: Record<TemplateCardType, string> = {
  sale: 'sale_message_template',
  purchase: 'purchase_message_template',
  proforma: 'proforma_message_template',
  payment_in: 'payment_in_message_template',
  payment_out: 'payment_out_message_template',
  statement_in: 'payment_statement_in_message_template',
  statement_out: 'payment_statement_out_message_template',
  reminder: 'reminder_message_template',
};

const NEUTRAL_SETTINGS: MessageSettings = {
  sale: { autoSend: false, template: '' },
  purchase: { autoSend: false, template: '' },
  proforma: { autoSend: false, template: '' },
  paymentIn: { autoSend: false, template: '' },
  paymentOut: { autoSend: false, template: '' },
  statementIn: { template: '' },
  statementOut: { template: '' },
  reminder: { template: '' },
};

function fromQuerySettings(d: ReturnType<typeof useWhatsAppMessageSettings>['settings']): MessageSettings {
  return {
    sale: { autoSend: d.sale.autoSend, template: d.sale.template ?? '' },
    purchase: { autoSend: d.purchase.autoSend, template: d.purchase.template ?? '' },
    proforma: { autoSend: d.proforma.autoSend, template: d.proforma.template ?? '' },
    paymentIn: { autoSend: d.paymentIn.autoSend, template: d.paymentIn.template ?? '' },
    paymentOut: { autoSend: d.paymentOut.autoSend, template: d.paymentOut.template ?? '' },
    statementIn: { template: d.statementIn.template ?? '' },
    statementOut: { template: d.statementOut.template ?? '' },
    reminder: { template: d.reminder.template ?? '' },
  };
}

/** The saved template string for any card type (panel-local view). */
function templateOf(settings: MessageSettings, type: TemplateCardType): string {
  switch (type) {
    case 'sale':
    case 'purchase':
    case 'proforma':
      return settings[type].template;
    case 'payment_in':
      return settings.paymentIn.template;
    case 'payment_out':
      return settings.paymentOut.template;
    case 'statement_in':
      return settings.statementIn.template;
    case 'statement_out':
      return settings.statementOut.template;
    case 'reminder':
      return settings.reminder.template;
  }
}

function withTemplate(settings: MessageSettings, type: TemplateCardType, template: string): MessageSettings {
  switch (type) {
    case 'sale':
    case 'purchase':
    case 'proforma':
      return { ...settings, [type]: { ...settings[type], template } };
    case 'payment_in':
      return { ...settings, paymentIn: { ...settings.paymentIn, template } };
    case 'payment_out':
      return { ...settings, paymentOut: { ...settings.paymentOut, template } };
    case 'statement_in':
      return { ...settings, statementIn: { template } };
    case 'statement_out':
      return { ...settings, statementOut: { template } };
    case 'reminder':
      return { ...settings, reminder: { template } };
  }
}

export function WhatsAppMessageSettingsPanel() {
  const { toast, success, error } = useToast();
  const { isOwner } = useSession();
  const settingsQuery = useWhatsAppMessageSettings();

  // ── Saved settings — initialized synchronously when cached, otherwise
  // exactly once when the first fetch settles (never from the EMPTY
  // placeholder the hook returns while loading).
  const [settings, setSettings] = useState<MessageSettings>(() =>
    settingsQuery.isReady ? fromQuerySettings(settingsQuery.settings) : NEUTRAL_SETTINGS,
  );
  const settingsLoadedRef = useRef(settingsQuery.isReady);
  useEffect(() => {
    if (settingsLoadedRef.current || !settingsQuery.isReady) return;
    settingsLoadedRef.current = true;
    setSettings(fromQuerySettings(settingsQuery.settings));
  }, [settingsQuery.isReady, settingsQuery.settings]);

  // ── The one open editor
  const [editingType, setEditingType] = useState<TemplateCardType | null>(null);
  const [draft, setDraft] = useState('');
  const [savingType, setSavingType] = useState<TemplateCardType | null>(null);

  // While the settings genuinely load (first visit, nothing cached), keep the
  // section's structure with a threshold-gated pulse instead of presenting
  // empty defaults as if they were real values.
  const settingsPulsing = useSkeletonDelay(!settingsQuery.isReady);

  const dirty = editingType != null && draft !== templateOf(settings, editingType);

  // ── Edit lifecycle ────────────────────────────────────────────────
  const beginEdit = (type: TemplateCardType) => {
    // One editor at a time — never silently discard unsaved changes.
    if (editingType != null && editingType !== type) {
      if (dirty) {
        toast({
          type: 'warning',
          title: 'Unsaved changes',
          message: `Save or cancel the ${LABEL_BY_TYPE[editingType]} template first.`,
        });
        return;
      }
      // A clean editor is simply replaced — nothing to lose.
    }
    setEditingType(type);
    setDraft(templateOf(settings, type));
  };

  const cancelEdit = () => {
    setEditingType(null);
    setDraft('');
  };

  const saveTemplate = async (type: TemplateCardType) => {
    if (savingType != null) return;
    setSavingType(type);
    try {
      // Partial upsert of JUST this type's template column (the singleton
      // row's other columns keep their values; all columns have defaults,
      // so a first-time insert is safe too).
      const { error: dbError } = await supabase
        .from('whatsapp_settings')
        .upsert({ [TEMPLATE_COLUMN[type]]: draft } as any, { onConflict: 'singleton' });
      if (dbError) throw dbError;
      setSettings((current) => withTemplate(current, type, draft));
      // Invalidate the query key used by useWhatsAppMessageSettings so
      // newly created documents immediately pick up the saved template.
      await invalidateWhatsAppState();
      success('Saved', `${LABEL_BY_TYPE[type]} template updated`);
      setEditingType(null);
      setDraft('');
    } catch (cause) {
      // Stay IN edit mode — the draft is never lost on failure.
      error('Save failed', cause instanceof Error ? cause.message : 'Unable to save the template');
    } finally {
      setSavingType(null);
    }
  };

  return (
    <div className="space-y-4">
      {!isOwner && (
        <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2.5 text-[11px] text-slate-500">
          <Lock className="h-3.5 w-3.5 shrink-0 text-slate-400" />
          Read-only — only the owner can change message settings.
        </div>
      )}

      {settingsQuery.isReady ? (
        TEMPLATE_FIELDS.map(({ type, label, description, triggerLabel }) => (
          <WhatsAppTemplateCard
            key={type}
            type={type}
            label={label}
            description={description}
            triggerLabel={triggerLabel}
            template={templateOf(settings, type)}
            editing={editingType === type}
            draft={editingType === type ? draft : templateOf(settings, type)}
            saving={savingType === type}
            canEdit={isOwner}
            onBeginEdit={() => beginEdit(type)}
            onDraftChange={setDraft}
            onCancel={cancelEdit}
            onSave={() => saveTemplate(type)}
          />
        ))
      ) : (
        /* Loading — the skeleton mirrors the REAL card structure
           (header row, template label, preview block, action footer) so the
           page does not resize when the saved settings arrive. */
        <div
          className={cn('space-y-4', settingsPulsing && 'animate-pulse')}
          role="status"
          aria-live="polite"
        >
          <span className="sr-only">Loading WhatsApp message settings…</span>
          {TEMPLATE_FIELDS.map(({ label }) => (
            <div key={label} className="overflow-hidden rounded-xl border border-slate-200 bg-white">
              <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-3.5">
                <div className="space-y-1.5">
                  <div className="h-4 w-28 rounded bg-slate-100" />
                  <div className="h-3 w-52 rounded bg-slate-100" />
                </div>
                <div className="h-4 w-20 rounded bg-slate-100" />
              </div>
              <div className="space-y-2 p-5">
                <div className="h-3.5 w-28 rounded bg-slate-100" />
                <div className="h-[120px] rounded-lg border border-slate-100 bg-slate-50" />
              </div>
              <div className="flex min-h-[58px] items-center justify-end border-t border-slate-100 bg-slate-50/50 px-5 py-3">
                <div className="h-8 w-16 rounded-md bg-slate-100" />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
