'use client';

/**
 * Edit Quotation — the ProformaEditor in edit mode. Only ACTIVE
 * quotations in an open financial year are editable; saving is ONE
 * transactional RPC (update_proforma) that replaces the quoted lines and
 * proposed trade-ins wholesale and recomputes totals server-side. The
 * bill number is preserved (a revision, not a new document).
 */
import { useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router';
import { useFinancialYear } from '@/components/providers/FinancialYearProvider';
import { useToast } from '@/components/ui/Toast';
import { PageHeader } from '@/components/PageHeader';
import { PartyFormModal } from '@/components/parties/PartyFormModal';
import { ProformaEditor } from '@/components/proformas/ProformaEditor';
import type { QuotedItemDraft, ProposedTradeInDraft } from '@/components/proformas/ProformaEditor';
import { useProformaDetail } from '@/features/proformas/api';
import type { ProformaItemRow } from '@/features/proformas/api';
import { updateProforma } from '@/features/proformas/mutations';
import { invalidateProformas, invalidateParties } from '@/features/invalidate';

/** Map the cached detail rows to editor drafts. Inventory-backed lines
 *  load their quoted price; legacy free-text lines load unmapped (the
 *  editor requires an explicit device selection before saving). */
function toDrafts(items: ProformaItemRow[] | undefined): {
  items: QuotedItemDraft[];
} {
  return {
    items: (items ?? []).map((item) => ({
      key: item.id,
      inventory_item_id: item.inventory_item_id ?? null,
      brand: item.inventory_items?.brand ?? '',
      model: item.inventory_items?.model ?? '',
      imei: item.inventory_items?.imei ?? '',
      ram_rom: item.inventory_items?.ram_rom ?? '',
      color: item.inventory_items?.color ?? '',
      base_selling_price: item.inventory_items
        ? String(item.inventory_items.base_selling_price ?? '')
        : '',
      rate: String(item.rate ?? ''),
      legacyDescription: item.inventory_item_id ? undefined : (item.description ?? undefined),
    })),
  };
}

export default function EditProformaPage() {
  const { id } = useParams() as { id: string };
  const navigate = useNavigate();
  const { selectedYear, isLoading: fyLoading } = useFinancialYear();
  const { error, success } = useToast();

  const detailQuery = useProformaDetail(id);
  const detail = detailQuery.data;
  const proforma = detail?.proforma ?? null;

  const [isSaving, setIsSaving] = useState(false);
  const [isPartyModalOpen, setIsPartyModalOpen] = useState(false);
  const [partyId, setPartyId] = useState('');
  const [partyInitialized, setPartyInitialized] = useState(false);

  // Initialize the controlled party selection once the detail loads.
  if (!partyInitialized && proforma) {
    setPartyId(proforma.party_id);
    setPartyInitialized(true);
  }

  const drafts = useMemo(() => toDrafts(detail?.items), [detail?.items]);
  const tradeInDrafts = useMemo<ProposedTradeInDraft[]>(
    () =>
      (detail?.tradeIns ?? []).map((ti) => ({
        key: ti.id,
        description: ti.description,
        qty: ti.qty === null ? '' : String(ti.qty),
        rate: String(ti.rate ?? ''),
      })),
    [detail?.tradeIns],
  );

  // Guards: only an ACTIVE quotation in an open FY can be edited.
  if (!fyLoading && detailQuery.isSuccess && proforma && proforma.status !== 'active') {
    error('Cannot Edit', `This quotation is ${proforma.status} and can no longer be edited.`);
    navigate(`/proformas/${id}`, { replace: true });
  }

  const handleSave = async (value: {
    partyId: string;
    date: string;
    discount: number;
    items: Array<{ inventory_item_id: string; rate: number }>;
    tradeIns: Array<{ description: string; qty: number | null; rate: number }>;
  }) => {
    setIsSaving(true);
    try {
      await updateProforma({
        proformaId: id,
        partyId: value.partyId,
        date: value.date,
        discount: value.discount,
        items: value.items,
        tradeIns: value.tradeIns,
      });
      await invalidateProformas(selectedYear?.id);
      success('Saved', 'Quotation updated.');
      // Successful save replaces the editor entry with the resulting
      // quotation — Back from the detail follows the user's real history
      // (the quotation, or wherever the editor was entered from), never
      // back into the completed editor.
      navigate(`/proformas/${id}`, { replace: true });
    } catch (err: any) {
      error('Error', err.message || 'Failed to update the quotation.');
      setIsSaving(false);
    }
  };

  if (fyLoading || detailQuery.isLoading || !selectedYear || !proforma) {
    return (
      <div className="space-y-5 animate-pulse">
        <div className="flex items-center justify-between">
          <div className="space-y-1.5"><div className="h-4 w-40 bg-slate-100 rounded" /><div className="h-3 w-64 bg-slate-100 rounded" /></div>
          <div className="h-8 w-28 bg-slate-100 rounded-md" />
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] gap-5 items-start">
          <div className="min-w-0 space-y-5">
            <div className="rounded-xl border border-slate-200 bg-white p-4 h-24" />
            <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-4"><div className="h-4 w-36 bg-slate-100 rounded" /><div className="h-10 w-full bg-slate-100 rounded-md" /><div className="h-14 w-full bg-slate-50 border border-slate-100 rounded-lg" /></div>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-4"><div className="h-4 w-24 bg-slate-100 rounded" /><div className="h-10 w-full bg-slate-100 rounded-md mt-4" /></div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title={`Edit Quotation — ${proforma.bill_number}`}
        subtitle="Revise the quoted devices, prices, or proposed exchange terms."
        backTo={`/proformas/${id}`}
        backLabel="Back to Quotation"
      />

      <ProformaEditor
        mode="edit"
        fy={selectedYear}
        isSaving={isSaving}
        submitLabel="Save Changes"
        partyId={partyId}
        onPartyChange={setPartyId}
        initial={{
          date: proforma.date,
          discount: String(proforma.discount ?? '0'),
          items: drafts.items,
          tradeIns: tradeInDrafts,
        }}
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
