'use client';

/**
 * StockSearchField — the application's ONE inventory device picker.
 *
 * A search input whose results appear in an anchored portal overlay
 * (never clipped by the page's scroll container), powered by the canonical
 * ranked inventory search (useInventorySearch → search_inventory RPC).
 * Shared by the sale editor, the proforma editor and the conversion
 * dialog's legacy-device mapping — one search implementation everywhere.
 */
import { useState, type Ref } from 'react';
import { createPortal } from 'react-dom';
import { Search, Loader2 } from 'lucide-react';
import { Input } from '@/components/ui/Input';
import { cn } from '@/components/ui/utils';
import { useAnchoredOverlay } from '@/components/ui/anchored-overlay';
import { useInventorySearch, type InventorySearchRow } from '@/features/inventory/search';
import { formatMoney } from '@/features/validation/fields';

export interface StockSearchFieldProps {
  /** Financial year scope for the search. */
  fyId: string | undefined;
  /** Called with the picked device; the field clears itself afterwards. */
  onSelect: (item: InventorySearchRow) => void;
  /** Rows hidden from the results (devices already on the document). */
  excludeIds?: string[];
  placeholder?: string;
  /** 'in_stock' (default) or 'sold'. */
  status?: 'in_stock' | 'sold';
  /** Result cap (default 10). */
  limit?: number;
  id?: string;
  'aria-label'?: string;
  className?: string;
  /** Ref to the underlying search input (e.g. focus after a failed save). */
  inputRef?: Ref<HTMLInputElement>;
}

export function StockSearchField({
  fyId,
  onSelect,
  excludeIds,
  placeholder = 'Search stock by brand, model or IMEI…',
  status = 'in_stock',
  limit = 10,
  id,
  'aria-label': ariaLabel = 'Search stock',
  className,
  inputRef,
}: StockSearchFieldProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const { rows, isSearching, isError } = useInventorySearch(searchQuery, {
    fyId,
    status,
    limit,
    excludeIds,
  });

  // Results layer — anchored portal (opens below the field, flips above
  // when the viewport has more room there).
  const { triggerRef, overlayRef, style } = useAnchoredOverlay<HTMLDivElement, HTMLDivElement>({
    open: !!searchQuery,
    matchWidth: true,
    gap: 4,
  });

  const handleSelect = (item: InventorySearchRow) => {
    onSelect(item);
    setSearchQuery('');
  };

  return (
    <div ref={triggerRef} className={className}>
      <Input
        ref={inputRef}
        id={id}
        icon={<Search className="h-4 w-4" />}
        placeholder={placeholder}
        value={searchQuery}
        onChange={e => setSearchQuery(e.target.value)}
        aria-label={ariaLabel}
        autoComplete="off"
      />

      {searchQuery && typeof window !== 'undefined' && createPortal(
        <div
          ref={overlayRef}
          style={style ?? undefined}
          className={cn(
            'z-[60] overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl',
            !style && 'invisible',
          )}
        >
          {isSearching ? (
            <div className="flex items-center justify-center gap-2 p-4 text-xs text-slate-400">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Searching stock…
            </div>
          ) : isError ? (
            <div className="p-4 text-center text-xs text-rose-500">
              Search failed. Check your connection and try again.
            </div>
          ) : rows.length > 0 ? (
            <div className="max-h-60 overflow-y-auto">
              {rows.map(item => (
                <div
                  key={item.id}
                  role="option"
                  aria-selected={false}
                  tabIndex={0}
                  className="p-2.5 border-b border-slate-100 last:border-b-0 hover:bg-slate-50 focus:bg-slate-50 cursor-pointer flex justify-between items-center gap-3 transition-colors"
                  onClick={() => handleSelect(item)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      handleSelect(item);
                    }
                  }}
                >
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-slate-900 truncate">{item.brand} {item.model}</p>
                    <p className="text-[11px] text-slate-500 font-mono mt-0.5 truncate">
                      {item.imei}{item.ram_rom ? ` • ${item.ram_rom}` : ''}{item.color ? ` • ${item.color}` : ''}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-xs font-semibold text-indigo-700 tabular-nums">{formatMoney(item.base_selling_price)} Rs.</p>
                    <span className="text-[10px] uppercase font-bold text-slate-400">Base Price</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="p-4 text-center text-xs text-slate-400">
              No matching items found.
            </div>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
