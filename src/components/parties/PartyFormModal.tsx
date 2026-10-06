'use client';

import { useState } from 'react';
import { supabase } from '@/platform/supabase/client';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Field } from '@/components/ui/form';
import { useToast } from '@/components/ui/Toast';
import { normalizePhoneIN, validatePhoneIN } from '@/features/validation/fields';
import { useFieldErrors, focusFirstInvalid } from '@/features/validation/use-field-errors';

import type { Party } from '@/features/types';

export type { Party };

interface PartyFormModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (party: Party) => void;
  initialData?: Party | null;
}

export function PartyFormModal({ isOpen, onClose, onSuccess, initialData }: PartyFormModalProps) {
  const [name, setName] = useState('');
  const [number, setNumber] = useState('');
  const [address, setAddress] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { error, success } = useToast();

  // Inline field errors — the app-wide interaction model (untouched →
  // quiet, blurred → validate, Save → validate all + focus first invalid).
  const fieldErrors = useFieldErrors<'name' | 'number'>();

  // Reset the fields DURING RENDER whenever the dialog's target changes
  // (open/close, or a different party). React discards the in-flight render
  // and re-renders with the new state before committing to the DOM, so the
  // first PAINTED frame always shows the correct values — the previous
  // setTimeout(0)-deferred reset painted one frame of stale/empty fields.
  const formTarget = isOpen ? (initialData ? `edit:${initialData.id}` : 'new') : 'closed';
  const [appliedTarget, setAppliedTarget] = useState(formTarget);
  if (formTarget !== appliedTarget) {
    setAppliedTarget(formTarget);
    fieldErrors.reset();
    if (isOpen && initialData) {
      setName(initialData.name);
      setNumber(initialData.number ?? '');
      setAddress(initialData.address || '');
    } else {
      setName('');
      setNumber('');
      setAddress('');
    }
  }

  // ── Validation (per field; the DB trigger canonicalizes + enforces too) ──
  const nameError = name.trim() ? null : 'Name is required.';
  const numberError = validatePhoneIN(number);

  // Completion boundary for the phone: on blur a recognizable Indian
  // mobile form settles into its canonical +91XXXXXXXXXX form (typing is
  // never rewritten mid-keystroke).
  const handleNumberBlur = () => {
    fieldErrors.touch('number');
    const trimmed = number.trim();
    const canonical = trimmed ? normalizePhoneIN(trimmed) : null;
    if (canonical) setNumber(canonical);
    else if (trimmed !== number) setNumber(trimmed);
  };

  const handleSave = async () => {
    const trimmedName = name.trim();
    const trimmedAddress = address.trim();

    // Validate the complete form: show every error inline, focus the first
    // invalid field — no validation toast.
    fieldErrors.beginSubmit();
    if (nameError || numberError) { focusFirstInvalid(); return; }

    // Persist the canonical +91XXXXXXXXXX form (the DB trigger
    // canonicalizes too — belt and braces).
    const canonicalNumber = normalizePhoneIN(number.trim()) ?? number.trim();

    setIsSubmitting(true);
    try {
      if (initialData) {
        const { data, error: updateErr } = await supabase
          .from('parties')
          .update({ name: trimmedName, number: canonicalNumber, address: trimmedAddress || null })
          .eq('id', initialData.id)
          .select()
          .single();

        if (updateErr) throw updateErr;
        success('Success', 'Party updated successfully.');
        onSuccess(data);
      } else {
        const { data, error: insertErr } = await supabase
          .from('parties')
          .insert({ name: trimmedName, number: canonicalNumber, address: trimmedAddress || null })
          .select()
          .single();

        if (insertErr) throw insertErr;
        success('Success', 'Party added successfully.');
        onSuccess(data);
      }
      onClose();
    } catch (err: any) {
      error('Error', err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={initialData ? "Edit Party" : "Add Party"}
      hideClose
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={isSubmitting}>Cancel</Button>
          <Button onClick={handleSave} isLoading={isSubmitting}>Save Party</Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name" required error={fieldErrors.show('name', nameError)}>
          <Input
            placeholder="e.g. Acme Corp"
            value={name}
            onBlur={() => fieldErrors.touch('name')}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Phone Number" required error={fieldErrors.show('number', numberError)} hint="Indian mobile number">
          <Input
            placeholder="98765 43210"
            value={number}
            onBlur={handleNumberBlur}
            onChange={(e) => setNumber(e.target.value)}
          />
        </Field>
        <Field label="Address">
          <Input
            placeholder="e.g. 123 Business Rd"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
        </Field>
      </div>
    </Modal>
  );
}
