'use client';

/**
 * EditIconButton — the shared compact pencil action for list rows.
 *
 * The icon-only edit control of the row-action language (the Inventory
 * pencil treatment): 7×7 target, slate → indigo hover, no text. Icon-only
 * controls must keep an accessible label — aria-label "Edit" plus a matching
 * title tooltip.
 */
import { Pencil } from 'lucide-react';

export function EditIconButton({
  onClick,
  disabled,
  title = 'Edit',
}: {
  onClick: () => void;
  disabled?: boolean;
  /** Accessible label / tooltip — defaults to "Edit". */
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label="Edit"
      className="shrink-0 h-7 w-7 flex items-center justify-center text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
    >
      <Pencil className="h-3.5 w-3.5" />
    </button>
  );
}
