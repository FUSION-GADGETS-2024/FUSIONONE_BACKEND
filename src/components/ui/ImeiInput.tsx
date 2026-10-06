'use client';

/**
 * ImeiInput — the application's ONE IMEI field.
 *
 * A plain Input with the canonical IMEI entry constraints applied as the
 * user types (filterImeiInput from the ONE validation module — same
 * contract the database enforces):
 *
 *   - only digits 0–9 can ever enter the field (letters, spaces, +,
 *     hyphens and every other character simply never appear);
 *   - the value is capped at 15 digits (the 16th digit never enters);
 *   - a mobile numeric keyboard (inputMode="numeric");
 *   - monospace digits (established IMEI styling in every form).
 *
 * The filter runs on change, including paste: pasting "12897abc" leaves
 * "12897", pasting an invalid value therefore shows the inline field error
 * immediately. The completed value is judged by validateImei (blur/submit).
 */
import React from 'react';
import { Input, type InputProps } from '@/components/ui/Input';
import { filterImeiInput, IMEI_LENGTH } from '@/features/validation/fields';

export interface ImeiInputProps extends Omit<InputProps, 'value' | 'onChange' | 'maxLength' | 'inputMode'> {
  value: string;
  onChange: (value: string) => void;
}

export const ImeiInput = React.forwardRef<HTMLInputElement, ImeiInputProps>(
  ({ value, onChange, className, ...props }, ref) => (
    <Input
      ref={ref}
      value={value}
      onChange={e => onChange(filterImeiInput(e.target.value))}
      maxLength={IMEI_LENGTH}
      inputMode="numeric"
      autoComplete="off"
      className={className}
      {...props}
    />
  ),
);
ImeiInput.displayName = 'ImeiInput';
