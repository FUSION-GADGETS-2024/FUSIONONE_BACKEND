'use client';

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { ChevronRight, Lock, MessageSquareText, Send } from 'lucide-react';
import { supabase } from '@/platform/supabase/client';
import { useSession } from '@/components/providers/SessionProvider';
import { useToast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { useSkeletonDelay } from '@/components/ui/Skeleton';
import { cn } from '@/components/ui/utils';
import { invalidateWhatsAppState } from '@/features/invalidate';
import { useWhatsAppMessageSettings } from '@/features/whatsapp/useWhatsAppMessageSettings';
import { WhatsAppPlatformPanel } from './WhatsAppPlatformPanel';

/**
 * WhatsAppSettingsPanel — the Settings → WhatsApp tab: the WhatsApp-specific
 * CONFIGURATION surface.
 *
 *   WhatsApp Account   → the live connection panel (unchanged component)
 *   Delivery           → the automatic-sending switches (invoices, quotation,
 *                        payment receipts In/Out) + access to the message
 *                        templates
 *
 * The message TEMPLATE EDITING itself lives on the dedicated WhatsApp
 * Templates page (Settings → WhatsApp → Manage Templates) — configuration
 * and templates are separate concerns with ONE source of truth each. Every
 * switch persists to the SAME `whatsapp_settings` columns the message
 * pipeline reads (identical values, identical behavior — only the surface
 * moved); toggles save immediately and roll back on failure.
 */

/** The five switches, in message-pipeline order. */
type AutoSendKey = 'sale' | 'purchase' | 'proforma' | 'paymentIn' | 'paymentOut';

/** The `whatsapp_settings` column that stores each switch. */
const AUTO_SEND_COLUMN: Record<AutoSendKey, string> = {
  sale: 'auto_send_sale',
  purchase: 'auto_send_purchase',
  proforma: 'auto_send_proforma',
  paymentIn: 'auto_send_receipt_in',
  paymentOut: 'auto_send_receipt_out',
};

const AUTO_SEND_FIELDS: ReadonlyArray<{
  key: AutoSendKey;
  label: string;
  description: string;
}> = [
  { key: 'sale', label: 'Sales Invoice', description: 'Automatically send the invoice to the customer when it is created.' },
  { key: 'purchase', label: 'Purchase Bill', description: 'Automatically send the bill to the party when it is created.' },
  { key: 'proforma', label: 'Quotation / Proforma', description: 'Automatically send the quotation to the customer when it is created.' },
  { key: 'paymentIn', label: 'Payment Receipt (In)', description: 'Automatically send a receipt when a payment is received against an existing invoice. The initial payment made during invoice creation never triggers one — the invoice itself already carries it.' },
  { key: 'paymentOut', label: 'Payment Receipt (Out)', description: 'Automatically send a receipt when a payment is made against an existing purchase bill. The initial payment made during bill creation never triggers one — the bill itself already carries it.' },
];

type AutoSendState = Record<AutoSendKey, boolean>;

function switchesFromQuery(d: ReturnType<typeof useWhatsAppMessageSettings>['settings']): AutoSendState {
  return {
    sale: d.sale.autoSend,
    purchase: d.purchase.autoSend,
    proforma: d.proforma.autoSend,
    paymentIn: d.paymentIn.autoSend,
    paymentOut: d.paymentOut.autoSend,
  };
}

const NEUTRAL_SWITCHES: AutoSendState = {
  sale: false,
  purchase: false,
  proforma: false,
  paymentIn: false,
  paymentOut: false,
};

export function WhatsAppSettingsPanel() {
  const navigate = useNavigate();
  const { error } = useToast();
  const { isOwner } = useSession();
  const settingsQuery = useWhatsAppMessageSettings();

  // ── Switch state — initialized synchronously when cached, otherwise
  // exactly once when the first fetch settles (never from the EMPTY
  // placeholder while loading — the same init-once rule as the templates).
  const [switches, setSwitches] = useState<AutoSendState>(() =>
    settingsQuery.isReady ? switchesFromQuery(settingsQuery.settings) : NEUTRAL_SWITCHES,
  );
  const switchesLoadedRef = useRef(settingsQuery.isReady);
  useEffect(() => {
    if (switchesLoadedRef.current || !settingsQuery.isReady) return;
    switchesLoadedRef.current = true;
    setSwitches(switchesFromQuery(settingsQuery.settings));
  }, [settingsQuery.isReady, settingsQuery.settings]);

  const switchesPulsing = useSkeletonDelay(!settingsQuery.isReady);

  // ── Toggle — optimistic, persists immediately to the same column the
  // message pipeline reads, rolls back on failure.
  const toggleAutoSend = async (key: AutoSendKey, next: boolean) => {
    const previous = switches[key];
    setSwitches((current) => ({ ...current, [key]: next }));
    try {
      const { error: dbError } = await supabase
        .from('whatsapp_settings')
        .upsert({ [AUTO_SEND_COLUMN[key]]: next } as any, { onConflict: 'singleton' });
      if (dbError) throw dbError;
      await invalidateWhatsAppState();
    } catch (cause) {
      setSwitches((current) => ({ ...current, [key]: previous }));
      error('Update failed', cause instanceof Error ? cause.message : 'Unable to change Automatic sending');
    }
  };

  return (
    <div className="space-y-5">
      {/* ── Connection — live SSE state, unchanged ── */}
      <WhatsAppPlatformPanel />

      {/* ── Delivery — the automatic-sending configuration ── */}
      <div>
        <h2 className="text-sm font-semibold text-slate-900">Delivery</h2>
        <p className="mt-0.5 text-[11px] text-slate-400">
          Choose what FUSION ONE sends automatically, and manage the message templates.
        </p>
      </div>

      {!isOwner && (
        <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2.5 text-[11px] text-slate-500">
          <Lock className="h-3.5 w-3.5 shrink-0 text-slate-400" />
          Read-only — only the owner can change message settings.
        </div>
      )}

      {settingsQuery.isReady ? (
        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          {/* Card header */}
          <div className="flex items-center gap-2 px-5 py-3.5 border-b border-slate-100">
            <Send className="h-3.5 w-3.5 text-indigo-600" />
            <span className="text-xs font-semibold text-slate-900">Automatic sending</span>
          </div>

          {/* The five switches — one row each, same values/persistence as
              the message pipeline's configuration columns. */}
          <ul className="divide-y divide-slate-100">
            {AUTO_SEND_FIELDS.map(({ key, label, description }) => (
              <li key={key} className="flex items-start justify-between gap-4 px-5 py-3.5">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-slate-900">{label}</p>
                  <p className="mt-0.5 text-[11px] text-slate-400 leading-relaxed">{description}</p>
                </div>
                <input
                  type="checkbox"
                  checked={switches[key]}
                  disabled={!isOwner}
                  onChange={(event) => toggleAutoSend(key, event.target.checked)}
                  aria-label={`Automatic sending — ${label}`}
                  className="h-4 w-4 mt-0.5 shrink-0 accent-indigo-600 disabled:opacity-50"
                />
              </li>
            ))}
          </ul>

          {/* Fixed trigger policy — statements and reminders have no switch
              (statements are manual-only; reminder POLICY is per invoice). */}
          <div className="px-5 py-3 border-t border-slate-100 bg-slate-50/50">
            <p className="text-[11px] text-slate-400 leading-relaxed">
              Payment statements are sent manually from an invoice&rsquo;s Payments dialog.
              Payment reminders are configured per invoice.
            </p>
          </div>
        </div>
      ) : (
        /* Loading — mirrors the REAL card structure (header row, the five
           switch rows, policy footer) so the section does not resize when
           the saved settings arrive. */
        <div
          className={cn('rounded-xl border border-slate-200 bg-white overflow-hidden', switchesPulsing && 'animate-pulse')}
          role="status"
          aria-live="polite"
        >
          <span className="sr-only">Loading message settings…</span>
          <div className="flex items-center gap-2 px-5 py-3.5 border-b border-slate-100">
            <div className="h-3.5 w-3.5 rounded bg-slate-100" />
            <div className="h-4 w-28 rounded bg-slate-100" />
          </div>
          {[...Array(5)].map((_, i) => (
            <div key={i} className="flex items-start justify-between gap-4 px-5 py-3.5 border-b border-slate-100 last:border-b-0">
              <div className="space-y-1.5">
                <div className="h-3.5 w-32 rounded bg-slate-100" />
                <div className="h-2.5 w-52 max-w-full rounded bg-slate-100" />
              </div>
              <div className="h-4 w-4 mt-0.5 shrink-0 rounded bg-slate-100" />
            </div>
          ))}
          <div className="px-5 py-3 border-t border-slate-100 bg-slate-50/50">
            <div className="h-2.5 w-64 max-w-full rounded bg-slate-100" />
          </div>
        </div>
      )}

      {/* ── Message templates — access to the dedicated Templates page ── */}
      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3 min-w-0">
            <MessageSquareText className="h-4 w-4 text-indigo-600 mt-0.5 shrink-0" />
            <div className="min-w-0">
              <p className="text-xs font-semibold text-slate-900">Message templates</p>
              <p className="mt-0.5 text-[11px] text-slate-400 leading-relaxed">
                The WhatsApp messages for invoices, payment receipts, payment statements, and reminders.
              </p>
            </div>
          </div>
          <Button
            size="sm"
            onClick={() => navigate('/settings/whatsapp/templates')}
            className="gap-1.5 shrink-0 text-xs"
          >
            Manage Templates
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}
