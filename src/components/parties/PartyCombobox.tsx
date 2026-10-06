'use client';

/**
 * PartyCombobox — the application's ONE customer/party picker.
 *
 * Wires the shared Combobox primitive to the party query architecture:
 *   - opens with the FIRST page of parties only (never the whole table),
 *     searching server-side by name or number (250ms debounce);
 *   - progressively loads further pages as the user scrolls (silent);
 *   - resolves a selected party id to its display label even when it is not
 *     in the loaded pages (e.g. proforma-conversion prefill, a party that
 *     was just created through the "+ New" workflow);
 *   - exposes the existing "+ New" workflow through the dropdown's pinned
 *     action row — the page opens PartyFormModal and sets the value on
 *     success, exactly as before.
 */
import { useCallback, useMemo, useState } from 'react';
import { Combobox } from '@/components/ui/Combobox';
import type { ComboboxOption } from '@/components/ui/Combobox';
import { useDebouncedValue } from '@/components/ui/use-debounced-value';
import { usePartyOption, usePartyOptions } from '@/features/parties/api';

export interface PartyComboboxProps {
  value: string;
  onChange: (partyId: string, party: { id: string; name: string; number: string | null } | null) => void;
  /** Opens the page's PartyFormModal (the existing "+ New" workflow). */
  onNew?: () => void;
  placeholder?: string;
  emptyMessage?: string;
  disabled?: boolean;
  error?: boolean;
  /** 'md' (default) for form fields; 'sm' for filter bars. */
  size?: 'sm' | 'md';
  allowClear?: boolean;
  className?: string;
  id?: string;
  'aria-label'?: string;
}

export function PartyCombobox({
  value,
  onChange,
  onNew,
  placeholder = 'Search customer…',
  emptyMessage = 'No matching parties.',
  disabled,
  error,
  size = 'md',
  allowClear,
  className,
  id,
  ...aria
}: PartyComboboxProps) {
  const [open, setOpen] = useState(false);
  const [searchText, setSearchText] = useState('');
  const debouncedSearch = useDebouncedValue(searchText, 250);
  const q = debouncedSearch.trim();

  const optionsQuery = usePartyOptions(q, open);

  const options: ComboboxOption[] = useMemo(
    () =>
      (optionsQuery.data?.pages ?? []).flatMap(page =>
        page.rows.map(row => ({ value: row.id, label: row.name, hint: row.number ?? undefined })),
      ),
    [optionsQuery.data],
  );

  // Resolve the selected id for the closed-state display — from the loaded
  // pages when possible, otherwise a single cached row fetch.
  const inList = options.find(o => o.value === value) ?? null;
  const resolvedQuery = usePartyOption(!inList && value ? value : undefined);
  const selected = inList ?? (resolvedQuery.data ? { value: resolvedQuery.data.id, label: resolvedQuery.data.name, hint: resolvedQuery.data.number ?? undefined } : null);

  // Silent next-page prefetch (guarded against duplicate in-flight requests).
  const loadMore = useCallback(() => {
    if (optionsQuery.hasNextPage && !optionsQuery.isFetchingNextPage && !optionsQuery.isLoading) {
      void optionsQuery.fetchNextPage();
    }
  }, [optionsQuery]);

  return (
    <Combobox
      id={id}
      value={value}
      onChange={(partyId, option) =>
        onChange(partyId, option ? { id: option.value, name: option.label, number: option.hint ?? null } : null)
      }
      options={options}
      selected={selected}
      placeholder={placeholder}
      emptyMessage={emptyMessage}
      disabled={disabled}
      error={error}
      size={size}
      allowClear={allowClear}
      className={className}
      isLoading={optionsQuery.isLoading}
      hasMore={!!optionsQuery.hasNextPage}
      onLoadMore={loadMore}
      onSearchChange={setSearchText}
      onOpenChange={setOpen}
      action={onNew ? { label: 'New Party', onSelect: onNew } : undefined}
      aria-label={aria['aria-label'] ?? 'Party'}
    />
  );
}
