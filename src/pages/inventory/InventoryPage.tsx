'use client';

import { useState } from 'react';
import { supabase } from '@/platform/supabase/client';
import { useFinancialYear } from '@/components/providers/FinancialYearProvider';
import { useToast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Modal } from '@/components/ui/Modal';
import { MoneyInput } from '@/components/ui/MoneyInput';
import { ImeiInput } from '@/components/ui/ImeiInput';
import { RamRomInput } from '@/components/ui/RamRomInput';
import { Field } from '@/components/ui/form';
import { Plus, Smartphone, Pencil } from 'lucide-react';
import { cn } from '@/components/ui/utils';
import { ViewButton } from '@/components/ui/ViewButton';
import { EditIconButton } from '@/components/ui/EditIconButton';
import { useSkeletonDelay } from '@/components/ui/Skeleton';
import {
  CellLines,
  DataTable,
  type DataTableColumn,
  ListHeaderSkeleton,
  RowActions,
  TableSearchInput,
} from '@/components/ui/tables';
import { ListPage } from '@/components/list-page/ListPage';
import { staticPagination } from '@/components/list-page/use-list-pagination';
import {
  type InventoryItem,
  useInventoryPageData,
  validateInventoryForm,
  isInventoryFormValid,
  type InventoryFormErrors,
} from '@/features/inventory/api';
import { imeiProgress } from '@/features/validation/fields';
import { useFieldErrors, focusFirstInvalid } from '@/features/validation/use-field-errors';
import { useInventorySearch } from '@/features/inventory/search';
import { invalidateInventory } from '@/features/invalidate';

const emptyForm = { brand: '', model: '', imei: '', ram_rom: '', color: '', purchase_price: '', base_selling_price: '' };

export default function InventoryPage() {
  const { selectedYear, isReadOnly, isLoading: fyLoading } = useFinancialYear();
  const { error, success } = useToast();
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'in_stock' | 'sold'>('all');
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isViewModalOpen, setIsViewModalOpen] = useState(false);
  const [selectedItem, setSelectedItem] = useState<InventoryItem | null>(null);
  const [formData, setFormData] = useState(emptyForm);

  // Inline field errors — the app-wide interaction model: untouched fields
  // stay quiet, blurred fields show their error, Save shows every error.
  const addErrors = useFieldErrors<keyof InventoryFormErrors>();
  const editErrors = useFieldErrors<keyof InventoryFormErrors>();
  // Async business check outcome (duplicate IMEI) — shown under the IMEI
  // field it concerns, not as a toast.
  const [addImeiDup, setAddImeiDup] = useState(false);
  const [editImeiDup, setEditImeiDup] = useState(false);

  // Edit state
  const [isEditMode, setIsEditMode] = useState(false);
  const [editFormData, setEditFormData] = useState(emptyForm);
  const [isSaving, setIsSaving] = useState(false);

  const inventoryQuery = useInventoryPageData(selectedYear, fyLoading);
  const items = inventoryQuery.data || [];

  // The search box routes through the ONE canonical ranked search (the
  // search_inventory RPC — debounced + server-side inside the hook). Browse
  // mode (empty query) keeps the full FY fetch, filtered by status only.
  const inventorySearch = useInventorySearch(searchQuery, {
    fyId: selectedYear?.id,
    status: statusFilter === 'all' ? null : statusFilter,
    limit: 50,
  });

  // Loading threshold: the skeleton geometry renders immediately, its
  // shimmer only starts if the wait becomes noticeable. Never delays data.
  const skeletonPulsing = useSkeletonDelay(fyLoading || inventoryQuery.isLoading);

  const validateForm = (data: typeof emptyForm) => validateInventoryForm(data);

  const handleSaveItem = async () => {
    const errors = validateForm(formData);
    addErrors.beginSubmit();
    setAddImeiDup(false);
    if (!isInventoryFormValid(errors)) { focusFirstInvalid(); return; }
    if (!selectedYear || isReadOnly) return;
    try {
      const { data: dup } = await supabase.from('inventory_items').select('id').eq('imei', formData.imei.trim()).eq('status', 'in_stock').limit(1).maybeSingle();
      if (dup) { addErrors.touch('imei'); setAddImeiDup(true); return; }
      const { error: insertErr } = await supabase.from('inventory_items').insert({ brand: formData.brand.trim(), model: formData.model.trim(), imei: formData.imei.trim(), ram_rom: formData.ram_rom.trim(), color: formData.color.trim(), purchase_price: Number(formData.purchase_price), base_selling_price: Number(formData.base_selling_price), status: 'in_stock', source: 'purchase', financial_year_id: selectedYear.id, opening_entry_type: 'direct' });
      if (insertErr) throw insertErr;
      success('Success', 'Item added.'); setIsAddModalOpen(false);
      setFormData(emptyForm);
      addErrors.reset();
      await invalidateInventory(selectedYear.id);
    } catch (err: any) { error('Error', err.message); }
  };

  const handleEditItem = async () => {
    if (!selectedItem || !selectedYear || isReadOnly) return;
    const errors = validateForm(editFormData);
    editErrors.beginSubmit();
    setEditImeiDup(false);
    if (!isInventoryFormValid(errors)) { focusFirstInvalid(); return; }

    setIsSaving(true);
    try {
      // IMEI duplicate check — only if IMEI changed
      if (editFormData.imei.trim() !== selectedItem.imei) {
        const { data: dup } = await supabase
          .from('inventory_items')
          .select('id')
          .eq('imei', editFormData.imei.trim())
          .eq('status', 'in_stock')
          .neq('id', selectedItem.id)
          .limit(1)
          .maybeSingle();
        if (dup) { editErrors.touch('imei'); setEditImeiDup(true); setIsSaving(false); return; }
      }

      const { error: updateErr } = await supabase
        .from('inventory_items')
        .update({
          brand: editFormData.brand.trim(),
          model: editFormData.model.trim(),
          imei: editFormData.imei.trim(),
          ram_rom: editFormData.ram_rom.trim(),
          color: editFormData.color.trim(),
          purchase_price: Number(editFormData.purchase_price),
          base_selling_price: Number(editFormData.base_selling_price),
        })
        .eq('id', selectedItem.id);

      if (updateErr) throw updateErr;

      success('Success', 'Item updated.');
      setIsEditMode(false);
      setIsViewModalOpen(false);
      setSelectedItem(null);
      editErrors.reset();
      await invalidateInventory(selectedYear.id);
    } catch (err: any) {
      error('Error', err.message);
    } finally {
      setIsSaving(false);
    }
  };

  const enterEditMode = (item?: InventoryItem) => {
    const target = item || selectedItem;
    if (!target) return;
    setEditFormData({
      brand: target.brand,
      model: target.model,
      imei: target.imei,
      ram_rom: target.ram_rom,
      color: target.color,
      purchase_price: String(target.purchase_price),
      base_selling_price: String(target.base_selling_price),
    });
    editErrors.reset();
    setEditImeiDup(false);
    setIsEditMode(true);
  };

  const exitEditMode = () => {
    setIsEditMode(false);
  };

  const closeViewModal = () => {
    setIsViewModalOpen(false);
    setIsEditMode(false);
    setSelectedItem(null);
  };

  const searchActive = searchQuery.trim() !== '';
  const searchRows = inventorySearch.rows.map((r): InventoryItem => ({
    id: r.id,
    brand: r.brand,
    model: r.model,
    imei: r.imei,
    ram_rom: r.ram_rom ?? '',
    color: r.color ?? '',
    purchase_price: r.purchase_price,
    base_selling_price: r.base_selling_price,
    status: r.status,
  }));
  const statusItems = items.filter(item => statusFilter === 'all' || item.status === statusFilter);
  // While the first search is in flight the table keeps showing the browse
  // list (never a false "No items found"); landed searches display exactly
  // what the RPC returned.
  const displayedItems = searchActive
    ? (inventorySearch.isSuccess ? searchRows : statusItems)
    : statusItems;
  const atSearchLimit = searchActive && inventorySearch.isSuccess && searchRows.length === 50;

  const columns: DataTableColumn<InventoryItem>[] = [
    {
      id: 'device',
      header: 'Device & IMEI',
      render: item => <CellLines primary={`${item.brand} ${item.model}`} secondary={item.imei} secondaryClassName="font-mono" />,
      mobile: 'identity',
      skeletonLines: 2,
    },
    {
      id: 'specs',
      header: 'Specs',
      render: item => <CellLines primary={item.ram_rom} secondary={item.color} />,
      mobile: 'secondary',
      skeletonLines: 2,
    },
    {
      id: 'purchase-price',
      header: 'Purchase Price',
      align: 'right',
      cellClassName: 'text-right',
      render: item => <span className="text-xs font-semibold text-slate-900 tabular-nums">{Number(item.purchase_price).toLocaleString('en-IN', { minimumFractionDigits: 2 })} Rs.</span>,
      mobile: 'amount',
      mobileLabel: 'Cost',
    },
    {
      id: 'selling-price',
      header: 'Selling Price',
      align: 'right',
      cellClassName: 'text-right',
      render: item => <span className="text-xs font-semibold text-slate-900 tabular-nums">{Number(item.base_selling_price).toLocaleString('en-IN', { minimumFractionDigits: 2 })} Rs.</span>,
      mobile: 'amount',
      mobileLabel: 'MRP',
    },
    {
      id: 'status',
      header: 'Status',
      align: 'center',
      cellClassName: 'text-center',
      render: item => (
        <span className={cn('inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider', item.status === 'in_stock' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500')}>
          {item.status === 'in_stock' ? 'In Stock' : 'Sold'}
        </span>
      ),
      mobile: 'meta',
    },
    {
      id: 'actions',
      header: '',
      align: 'center',
      // The reference row-action group: [VIEW][pencil]. The row itself is
      // not clickable — VIEW opens the item details, the pencil edits it.
      render: item => (
        <RowActions align="center">
          <ViewButton onClick={() => { setSelectedItem(item); setIsEditMode(false); setIsViewModalOpen(true); }} />
          {!isReadOnly && (
            <EditIconButton onClick={() => { setSelectedItem(item); enterEditMode(item); setIsViewModalOpen(true); }} />
          )}
        </RowActions>
      ),
      mobile: 'actions',
    },
  ];

  const toolbar = (
    <>
      <TableSearchInput value={searchQuery} onChange={setSearchQuery} placeholder="IMEI, brand or model…" />
      <Select
        value={statusFilter}
        onChange={v => setStatusFilter(v as any)}
        options={[
          { value: 'all', label: 'All' },
          { value: 'in_stock', label: 'In Stock' },
          { value: 'sold', label: 'Sold' },
        ]}
        size="sm"
        className="w-28"
      />
    </>
  );

  if (fyLoading || inventoryQuery.isLoading) {
    return (
      <ListPage header={<ListHeaderSkeleton pulsing={skeletonPulsing} titleWidth="w-20" subtitleWidth="w-52" actionWidth="w-20" />}>
        <DataTable columns={columns} rows={[]} rowKey={item => item.id} loading fill toolbar={toolbar} emptyMessage="No items found." />
      </ListPage>
    );
  }

  return (
    <ListPage
      header={
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-sm font-semibold text-slate-900 tracking-tight leading-none">Inventory</h1>
            <p className="text-[11px] text-slate-400 mt-1">Stock for the selected financial year</p>
          </div>
          {!isReadOnly && (
            <Button size="sm" onClick={() => { setFormData(emptyForm); addErrors.reset(); setAddImeiDup(false); setIsAddModalOpen(true); }} className="gap-1.5 text-xs h-8 bg-indigo-600 hover:bg-indigo-700">
              <Plus className="h-3.5 w-3.5" /> Add Item
            </Button>
          )}
        </div>
      }
    >
      <DataTable
        columns={columns}
        rows={displayedItems}
        rowKey={item => item.id}
        toolbar={toolbar}
        emptyMessage="No items found."
        fill
        pagination={staticPagination(inventoryQuery, { exhausted: !atSearchLimit })}
        footer={atSearchLimit ? (
          <div className="border-t border-slate-100 bg-slate-50/50 px-4 py-2.5">
            <p className="text-xs text-slate-400">Showing top 50 matches — refine your search to narrow results.</p>
          </div>
        ) : undefined}
      />

      {/* Add Item Modal — field errors inline (touched → validate, Save →
          validate all, focus the first invalid field; IMEI/RAM-ROM prevent
          impossible characters as the user types). */}
      <Modal isOpen={isAddModalOpen} onClose={() => setIsAddModalOpen(false)} title="Add Inventory Item"
      hideClose
        footer={<><Button variant="outline" onClick={() => setIsAddModalOpen(false)}>Cancel</Button><Button onClick={handleSaveItem}>Save Item</Button></>}>
        {(() => {
          const errors = validateForm(formData);
          const E = (field: keyof InventoryFormErrors) => addErrors.show(field, errors[field]);
          return (
            <div className="grid grid-cols-2 gap-3">
              {([['brand','Brand','e.g. Apple'],['model','Model','e.g. iPhone 15'],['ram_rom','RAM / ROM','12/256'],['color','Color','Black']] as const).map(([field, label, ph]) => (
                <Field key={field} label={label} required error={E(field)}
                  hint={field === 'ram_rom' ? 'Example: 12/256' : undefined}>
                  {field === 'ram_rom'
                    ? <RamRomInput placeholder={ph} value={formData.ram_rom} onBlur={() => addErrors.touch('ram_rom')}
                        onChange={v => setFormData(p => ({ ...p, ram_rom: v }))} className="text-xs" />
                    : <Input placeholder={ph} value={(formData as any)[field]} onBlur={() => addErrors.touch(field)}
                        onChange={e => setFormData(p => ({ ...p, [field]: e.target.value }))} className="text-xs" />}
                </Field>
              ))}
              <Field label="IMEI" required className="col-span-2"
                error={E('imei') ?? (addImeiDup ? 'This IMEI is already in stock.' : null)}
                hint={imeiProgress(formData.imei)}>
                <ImeiInput placeholder="15-digit IMEI" value={formData.imei} onBlur={() => addErrors.touch('imei')}
                  onChange={v => { setFormData(p => ({ ...p, imei: v })); if (addImeiDup) setAddImeiDup(false); }} className="font-mono text-xs" />
              </Field>
              <Field label="Purchase Price" required error={E('purchase_price')}>
                <MoneyInput placeholder="0.00" value={formData.purchase_price} onBlur={() => addErrors.touch('purchase_price')}
                  onChange={v => setFormData(p => ({ ...p, purchase_price: v }))} className="text-xs" />
              </Field>
              <Field label="Selling Price / MRP" required error={E('base_selling_price')}>
                <MoneyInput placeholder="0.00" value={formData.base_selling_price} onBlur={() => addErrors.touch('base_selling_price')}
                  onChange={v => setFormData(p => ({ ...p, base_selling_price: v }))} className="text-xs" />
              </Field>
            </div>
          );
        })()}
      </Modal>

      {/* View / Edit Item Modal */}
      <Modal
        isOpen={isViewModalOpen}
        onClose={closeViewModal}
        title={isEditMode ? 'Edit Inventory Item' : 'Item Details'}
        hideClose
        footer={
          isEditMode ? (
            <>
              <Button variant="outline" onClick={exitEditMode} disabled={isSaving}>Cancel</Button>
              <Button onClick={handleEditItem} isLoading={isSaving}>Save Changes</Button>
            </>
          ) : (
            <div className="flex items-center gap-2 w-full justify-between">
              <div>
                {!isReadOnly && (
                  <Button variant="outline" onClick={() => enterEditMode()} className="gap-1.5">
                    <Pencil className="h-3.5 w-3.5" /> Edit
                  </Button>
                )}
              </div>
              <Button variant="outline" onClick={closeViewModal}>Close</Button>
            </div>
          )
        }
      >
        {selectedItem && !isEditMode && (
          <div className="space-y-4">
            <div className="flex items-center gap-3 bg-slate-50 p-3 rounded-lg border border-slate-200">
              <div className="p-2 bg-white border border-slate-200 rounded-lg"><Smartphone className="h-5 w-5 text-slate-500" /></div>
              <div>
                <p className="text-sm font-semibold text-slate-900">{selectedItem.brand} {selectedItem.model}</p>
                <p className="text-xs text-slate-400 font-mono">{selectedItem.imei}</p>
              </div>
              <span className={cn('ml-auto text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded', selectedItem.status === 'in_stock' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500')}>
                {selectedItem.status === 'in_stock' ? 'In Stock' : 'Sold'}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-slate-50 rounded-lg p-3 border border-slate-100"><p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">Specs</p><p className="text-xs font-medium text-slate-900">{selectedItem.ram_rom} · {selectedItem.color}</p></div>
              <div className="bg-slate-50 rounded-lg p-3 border border-slate-100"><p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">Source</p><p className="text-xs font-medium text-slate-900 capitalize">{selectedItem.source ? selectedItem.source.replace('_', ' ') : '—'}</p></div>
              <div className="bg-slate-50 rounded-lg p-3 border border-slate-100"><p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">Purchase Price</p><p className="text-sm font-semibold text-slate-900 tabular-nums">{Number(selectedItem.purchase_price).toLocaleString('en-IN', { minimumFractionDigits: 2 })} Rs.</p></div>
              <div className="bg-slate-50 rounded-lg p-3 border border-slate-100"><p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">Selling Price</p><p className="text-sm font-semibold text-slate-900 tabular-nums">{Number(selectedItem.base_selling_price).toLocaleString('en-IN', { minimumFractionDigits: 2 })} Rs.</p></div>
            </div>
          </div>
        )}

        {selectedItem && isEditMode && (
          <div className="space-y-4">
            {selectedItem.status === 'sold' && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                <p className="text-xs text-amber-700 font-medium">This item has been sold — its identity (brand, model, IMEI, specs, color) is locked as historical record. Only the prices can still be adjusted; changes never affect the linked sale record.</p>
              </div>
            )}
            {(() => {
              const errors = validateForm(editFormData);
              const E = (field: keyof InventoryFormErrors) => editErrors.show(field, errors[field]);
              const locked = selectedItem.status === 'sold';
              return (
                <div className="grid grid-cols-2 gap-3">
                  {([['brand','Brand','e.g. Apple'],['model','Model','e.g. iPhone 15'],['ram_rom','RAM / ROM','12/256'],['color','Color','Black']] as const).map(([field, label, ph]) => (
                    <Field key={field} label={label} required error={E(field)}
                      hint={field === 'ram_rom' ? 'Example: 12/256' : undefined}>
                      {field === 'ram_rom'
                        ? <RamRomInput placeholder={ph} value={editFormData.ram_rom} disabled={locked}
                            onBlur={() => editErrors.touch('ram_rom')}
                            onChange={v => setEditFormData(p => ({ ...p, ram_rom: v }))} className="text-xs" />
                        : <Input placeholder={ph} value={(editFormData as any)[field]} disabled={locked}
                            onBlur={() => editErrors.touch(field)}
                            onChange={e => setEditFormData(p => ({ ...p, [field]: e.target.value }))} className="text-xs" />}
                    </Field>
                  ))}
                  <Field label="IMEI" required className="col-span-2"
                    error={E('imei') ?? (editImeiDup ? 'This IMEI is already in stock.' : null)}
                    hint={imeiProgress(editFormData.imei)}>
                    <ImeiInput placeholder="15-digit IMEI" value={editFormData.imei} disabled={locked}
                      onBlur={() => editErrors.touch('imei')}
                      onChange={v => { setEditFormData(p => ({ ...p, imei: v })); if (editImeiDup) setEditImeiDup(false); }} className="font-mono text-xs" />
                  </Field>
                  <Field label="Purchase Price" required error={E('purchase_price')}>
                    <MoneyInput placeholder="0.00" value={editFormData.purchase_price} onBlur={() => editErrors.touch('purchase_price')}
                      onChange={v => setEditFormData(p => ({ ...p, purchase_price: v }))} className="text-xs" />
                  </Field>
                  <Field label="Selling Price / MRP" required error={E('base_selling_price')}>
                    <MoneyInput placeholder="0.00" value={editFormData.base_selling_price} onBlur={() => editErrors.touch('base_selling_price')}
                      onChange={v => setEditFormData(p => ({ ...p, base_selling_price: v }))} className="text-xs" />
                  </Field>
                </div>
              );
            })()}
          </div>
        )}
      </Modal>
    </ListPage>
  );
}
