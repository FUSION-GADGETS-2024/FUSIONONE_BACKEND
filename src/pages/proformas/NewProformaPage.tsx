'use client';

/**
 * New Quotation — the ProformaEditor in create mode. Quotations quote
 * REAL in-stock devices at quoted prices; creating one never touches
 * inventory, payments, or accounting.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useFinancialYear } from '@/components/providers/FinancialYearProvider';
import { useToast } from '@/components/ui/Toast';
import { PageHeader } from '@/components/PageHeader';
import { PartyFormModal } from '@/components/parties/PartyFormModal';
import { ProformaEditor } from '@/components/proformas/ProformaEditor';
import { createProforma } from '@/features/proformas/mutations';
import { invalidateProformas, invalidateParties } from '@/features/invalidate';
import { useWhatsAppMessageSettings } from '@/features/whatsapp/useWhatsAppMessageSettings';
import { postAutoSend } from '@/platform/whatsapp/http';

export default function NewProformaPage() {
  const navigate = useNavigate();
  const { selectedYear, isReadOnly, isLoading: fyLoading } = useFinancialYear();
  const { error, success } = useToast();
  const { settings: messageSettings } = useWhatsAppMessageSettings();

  const [isSaving, setIsSaving] = useState(false);
  const [isPartyModalOpen, setIsPartyModalOpen] = useState(false);
  const [partyId, setPartyId] = useState('');

  if (!fyLoading && isReadOnly) {
    // Read-only FY guard (same rule as the sale editor; replace — the
    // unusable editor must not stay in history behind the redirect).
    error('Access Denied', 'Cannot create a quotation in a closed financial year.');
    navigate('/home', { replace: true });
  }

  const handleSave = async (value: {
    partyId: string;
    date: string;
    discount: number;
    items: Array<{ inventory_item_id: string; rate: number }>;
    tradeIns: Array<{ description: string; qty: number | null; rate: number }>;
  }) => {
    if (!selectedYear) return;
    setIsSaving(true);
    try {
      // One transactional RPC: counter + quotation + quoted items +
      // proposed trade-ins (totals computed server-side).
      const { proformaId, billNumber } = await createProforma({
        partyId: value.partyId,
        date: value.date,
        discount: value.discount,
        financialYear: selectedYear,
        items: value.items,
        tradeIns: value.tradeIns,
      });

      success('Success', `Quotation ${billNumber} created!`);
      // Durable server-side auto-send (backend-owned job; SSE reports the outcome).
      if (messageSettings.proforma.autoSend) void postAutoSend({ invoiceId: proformaId, invoiceType: 'proforma' });

      await invalidateProformas(selectedYear.id);

      // Successful save replaces the editor entry with the resulting
      // quotation — Back from the detail returns to where the editor was
      // entered from (Proformas, …), never to the completed editor.
      navigate(`/proformas/${proformaId}`, { replace: true });
    } catch (err: any) {
      error('Error', err.message || 'Failed to create quotation.');
      setIsSaving(false);
    }
  };

  if (fyLoading || !selectedYear) {
    return (
      <div className="space-y-5 animate-pulse">
        <div className="flex items-center justify-between">
          <div className="space-y-1.5"><div className="h-4 w-32 bg-slate-100 rounded" /><div className="h-3 w-56 bg-slate-100 rounded" /></div>
          <div className="h-8 w-28 bg-slate-100 rounded-md" />
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] gap-5 items-start">
          <div className="min-w-0 space-y-5">
            <div className="rounded-xl border border-slate-200 bg-white p-4 h-24" />
            <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-4"><div className="h-4 w-36 bg-slate-100 rounded" /><div className="h-10 w-full bg-slate-100 rounded-md" /><div className="h-14 w-full bg-slate-50 border border-slate-100 rounded-lg" /></div>
            <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3"><div className="h-4 w-32 bg-slate-100 rounded" /><div className="h-14 w-full bg-slate-50 rounded-lg" /></div>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-4"><div className="h-4 w-24 bg-slate-100 rounded" /><div className="h-10 w-full bg-slate-100 rounded-md mt-4" /></div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="New Quotation"
        subtitle="Quote in-stock devices with their prices and proposed exchange terms."
        backTo="/proformas"
        backLabel="Back to Proforma"
      />

      <ProformaEditor
        mode="create"
        fy={selectedYear}
        isSaving={isSaving}
        submitLabel="Save Quotation"
        partyId={partyId}
        onPartyChange={setPartyId}
        onSubmit={handleSave}
        onPartyModalOpen={() => setIsPartyModalOpen(true)}
      />

      <PartyFormModal
        isOpen={isPartyModalOpen}
        onClose={() => setIsPartyModalOpen(false)}
        onSuccess={(party) => {
          void invalidateParties();
          setPartyId(party.id);
        }}
      />
    </div>
  );
}
