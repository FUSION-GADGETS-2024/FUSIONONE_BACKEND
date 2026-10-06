'use client';

/**
 * RamRomInput — the application's ONE RAM/ROM field.
 *
 * A plain Input with the canonical RAM/ROM entry rule applied to each
 * change (acceptsRamRomInput from the ONE validation module — same
 * contract the database enforces):
 *
 *   - a change enters the field only when its value could be produced by
 *     allowed typing: digits and at most one "/" ("12", "12/", "12/256");
 *   - anything else — letters, "GB", hyphens, spaces, a second "/" — is
 *     rejected AS ENTERED: typing the character does nothing and an
 *     invalid paste is refused whole. The application never silently
 *     rewrites what the user entered ("12GB/256GB" never becomes
 *     "12/256");
 *   - deleting characters from a valid value naturally yields
 *     typing-producible values ("12/256" → "12/25" → "12/" → "12"), so
 *     normal editing always works; a field can always be cleared
 *     wholesale with select-all + Backspace;
 *   - an incomplete "12/" is allowed while typing (a natural intermediate
 *     state) and is judged by validateRamRom on blur/submit.
 */
import React from 'react';
import { Input, type InputProps } from '@/components/ui/Input';
import { acceptsRamRomInput } from '@/features/validation/fields';

export interface RamRomInputProps extends Omit<InputProps, 'value' | 'onChange' | 'inputMode'> {
  value: string;
  onChange: (value: string) => void;
}

export const RamRomInput = React.forwardRef<HTMLInputElement, RamRomInputProps>(
  ({ value, onChange, className, ...props }, ref) => (
    <Input
      ref={ref}
      value={value}
      onChange={e => {
        const next = e.target.value;
        if (acceptsRamRomInput(next)) {
          onChange(next);
        } else {
          // Rejected as entered — restore the last accepted value so the
          // field never holds (and the app never saves) what it rejected.
          e.target.value = value;
        }
      }}
      inputMode="text"
      autoComplete="off"
      className={className}
      {...props}
    />
  ),
);
RamRomInput.displayName = 'RamRomInput';
