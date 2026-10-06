'use client';

import { useState, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/platform/supabase/client';
import { useSession } from '@/components/providers/SessionProvider';
import { useStore } from '@/features/settings/api';
import { useToast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { invalidateStore } from '@/features/invalidate';
import { normalizeGstin, softNormalizePhone, validateEmail, validateGstin } from '@/features/validation/fields';
import { useFieldErrors, focusFirstInvalid } from '@/features/validation/use-field-errors';
import { Field } from '@/components/ui/form';
import { Store, Upload, Save, Lock } from 'lucide-react';

import { cn } from '@/components/ui/utils';
import { useSkeletonDelay } from '@/components/ui/Skeleton';
import { SegmentedTabs } from '@/components/ui/SegmentedTabs';
import { WhatsAppSettingsPanel } from '@/components/settings/WhatsAppSettingsPanel';

// ─── Profile Panel ─────────────────────────────────────────────────────────

function ProfilePanel() {
  const { user, isOwner } = useSession();
  const { success, error } = useToast();
  const queryClient = useQueryClient();
  // Inline field errors — the app-wide interaction model (untouched →
  // quiet, blurred → validate, Save → validate all + focus first invalid).
  const fieldErrors = useFieldErrors<'email' | 'gstin'>();
  // Shared cached store query (RLS scopes it to the owner — the same row
  // the sidebar/FY provider consume; audit D2 fix). Called BEFORE the form
  // state so the initializers below can seed from its cached data — the
  // first painted frame already holds the real values (no empty-form flash).
  const storeQuery = useStore();
  const profilePulsing = useSkeletonDelay(storeQuery.isLoading);

  const [isSaving, setIsSaving] = useState(false);
  const [storeData, setStoreData] = useState<any>(() => storeQuery.data ?? null);
  const [formData, setFormData] = useState(() => {
    const data = storeQuery.data as Record<string, any> | null;
    return {
      name: data?.name || '',
      address: data?.address || '',
      phone: data?.phone || '',
      email: data?.email || '',
      website: data?.website || '',
      gstin: data?.gstin || '',
    };
  });
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [currentLogoUrl, setCurrentLogoUrl] = useState<string | null>(() => (storeQuery.data as Record<string, any> | null)?.logo_url ?? null);
  const [logoObjectUrl, setLogoObjectUrl] = useState<string | null>(null);
  const [signatureFile, setSignatureFile] = useState<File | null>(null);
  const [currentSignatureUrl, setCurrentSignatureUrl] = useState<string | null>(() => (storeQuery.data as Record<string, any> | null)?.signature_url ?? null);
  const [signatureObjectUrl, setSignatureObjectUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!logoFile) { setLogoObjectUrl(null); return; }
    const url = URL.createObjectURL(logoFile); setLogoObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [logoFile]);

  useEffect(() => {
    if (!signatureFile) { setSignatureObjectUrl(null); return; }
    const url = URL.createObjectURL(signatureFile); setSignatureObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [signatureFile]);

  // Fill the form when the store row arrives AFTER mount (genuine first
  // load — the cached case was already handled by the initializers above).
  useEffect(() => {
    const data = storeQuery.data as Record<string, any> | null;
    if (!data) return;
    setStoreData(data);
    setFormData({ name: data.name || '', address: data.address || '', phone: data.phone || '', email: data.email || '', website: data.website || '', gstin: data.gstin || '' });
    setCurrentLogoUrl(data.logo_url || null);
    setCurrentSignatureUrl(data.signature_url || null);
  }, [storeQuery.data]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setFormData(prev => ({ ...prev, [e.target.name]: e.target.value }));
  };

  const handleSave = async () => {
    if (!user || !storeData || !isOwner) return;
    // Trim everything; canonicalize the contact fields (phone soft-
    // normalized, GSTIN uppercased) BEFORE validating + persisting.
    const next = {
      name: formData.name.trim(),
      address: formData.address.trim(),
      phone: softNormalizePhone(formData.phone),
      email: formData.email.trim(),
      website: formData.website.trim(),
      gstin: normalizeGstin(formData.gstin),
    };
    // Validate the complete form: show every error inline, focus the first
    // invalid field — no validation toast.
    const gstinError = validateGstin(next.gstin);
    const emailError = validateEmail(next.email);
    fieldErrors.beginSubmit();
    if (gstinError || emailError) { focusFirstInvalid(); return; }

    setIsSaving(true);
    try {
      let logoUrl = currentLogoUrl;
      if (logoFile) {
        const filePath = `${user.id}_logo_${Date.now()}.${logoFile.name.split('.').pop()}`;
        const { error: uploadErr } = await supabase.storage.from('store_assets').upload(filePath, logoFile);
        if (uploadErr) throw new Error('Logo upload failed: ' + uploadErr.message);
        logoUrl = supabase.storage.from('store_assets').getPublicUrl(filePath).data.publicUrl;
      }

      let signatureUrl = currentSignatureUrl;
      if (signatureFile) {
        const filePath = `${user.id}_signature_${Date.now()}.${signatureFile.name.split('.').pop()}`;
        const { error: uploadErr } = await supabase.storage.from('store_assets').upload(filePath, signatureFile);
        if (uploadErr) throw new Error('Signature upload failed: ' + uploadErr.message);
        signatureUrl = supabase.storage.from('store_assets').getPublicUrl(filePath).data.publicUrl;
      }

      const nextStoreData = { ...storeData, ...next, logo_url: logoUrl, signature_url: signatureUrl };
      const { error: updateErr } = await supabase.from('store').update({ ...next, logo_url: logoUrl, signature_url: signatureUrl } as any).eq('id', storeData.id);
      if (updateErr) throw updateErr;
      // Update the SHARED store query cache (the key every consumer reads)
      // and invalidate so observers refetch the authoritative row.
      queryClient.setQueryData(['store', 'current'], nextStoreData);
      await invalidateStore();
      setStoreData(nextStoreData);
      setCurrentLogoUrl(logoUrl); setLogoFile(null);
      setCurrentSignatureUrl(signatureUrl); setSignatureFile(null);
      success('Saved', 'Business profile updated');
    } catch (err: any) { error('Error', err.message); } finally { setIsSaving(false); }
  };

  if (storeQuery.isLoading) {
    return (
      <div className={cn('space-y-5', profilePulsing && 'animate-pulse')}>
        <div className="space-y-1.5"><div className="h-4 w-20 bg-slate-100 rounded" /><div className="h-3 w-56 bg-slate-100 rounded" /></div>
        <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-5">
          <div className="flex gap-5"><div className="w-24 h-24 bg-slate-100 rounded-xl" /><div className="flex-1 space-y-3"><div className="h-3 w-16 bg-slate-100 rounded" /><div className="h-9 bg-slate-100 rounded-lg" /></div></div>
          <div className="h-16 bg-slate-100 rounded-lg" />
          <div className="grid grid-cols-2 gap-3"><div className="h-9 bg-slate-100 rounded-lg" /><div className="h-9 bg-slate-100 rounded-lg" /></div>
        </div>
      </div>
    );
  }

  const logoPreviewUrl = logoObjectUrl ?? currentLogoUrl;
  const signaturePreviewUrl = signatureObjectUrl ?? currentSignatureUrl;

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-sm font-semibold text-slate-900">Business Profile</h2>
        <p className="text-[11px] text-slate-400 mt-0.5">Used on all bills and PDFs</p>
      </div>

      {!isOwner && (
        <div className="flex items-center gap-2 rounded-lg bg-slate-50 border border-slate-200 px-4 py-2.5 text-[11px] text-slate-500">
          <Lock className="h-3.5 w-3.5 text-slate-400 shrink-0" />
          Read-only — only the owner can change store details.
        </div>
      )}

      {/* Profile card */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="flex items-center gap-2 px-5 py-3.5 border-b border-slate-100">
          <Store className="h-3.5 w-3.5 text-indigo-600" />
          <span className="text-xs font-semibold text-slate-900">Store Details</span>
        </div>
        <div className="p-5 space-y-4">
          <div className="flex flex-col sm:flex-row gap-5 items-start">
            <div className="flex gap-4 shrink-0">
              {/* Logo */}
              <div className="space-y-2">
                <div className="relative w-24 h-24 rounded-xl border-2 border-dashed border-slate-200 bg-slate-50 overflow-hidden flex items-center justify-center cursor-pointer hover:bg-slate-100 transition-colors">
                  {logoPreviewUrl
                    ? <img src={logoPreviewUrl} alt="Logo" className="absolute inset-0 w-full h-full object-contain p-2" referrerPolicy="no-referrer" />
                    : <div className="flex flex-col items-center text-slate-400"><Upload className="h-5 w-5 mb-1" /><span className="text-[9px] uppercase font-bold tracking-wider">Logo</span></div>}
                  <input type="file" accept="image/*" onChange={e => setLogoFile(e.target.files?.[0] || null)} disabled={!isOwner} className="absolute inset-0 opacity-0 cursor-pointer disabled:cursor-not-allowed" />
                </div>
                {logoFile && <button onClick={() => setLogoFile(null)} className="text-[11px] text-rose-500 font-medium w-full text-center hover:underline">Clear</button>}
              </div>
              {/* Signature */}
              <div className="space-y-2">
                <div className="relative w-24 h-24 rounded-xl border-2 border-dashed border-slate-200 bg-slate-50 overflow-hidden flex items-center justify-center cursor-pointer hover:bg-slate-100 transition-colors">
                  {signaturePreviewUrl
                    ? <img src={signaturePreviewUrl} alt="Signature" className="absolute inset-0 w-full h-full object-contain p-2" referrerPolicy="no-referrer" />
                    : <div className="flex flex-col items-center text-slate-400"><Upload className="h-5 w-5 mb-1" /><span className="text-[9px] uppercase font-bold tracking-wider">Signature</span></div>}
                  <input type="file" accept="image/*" onChange={e => setSignatureFile(e.target.files?.[0] || null)} disabled={!isOwner} className="absolute inset-0 opacity-0 cursor-pointer disabled:cursor-not-allowed" />
                </div>
                {signatureFile && <button onClick={() => setSignatureFile(null)} className="text-[11px] text-rose-500 font-medium w-full text-center hover:underline">Clear</button>}
              </div>
            </div>
            <div className="flex-1 w-full space-y-3">
              <Field label="Store Name" required htmlFor="name">
                <Input id="name" name="name" value={formData.name} onChange={handleChange} disabled={!isOwner} placeholder="e.g. Mobile World" className="text-xs disabled:bg-slate-50" />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Phone" required htmlFor="phone" hint="Indian mobile or landline">
                  <Input id="phone" name="phone" value={formData.phone} onChange={handleChange} disabled={!isOwner} placeholder="98765 43210" className="text-xs disabled:bg-slate-50" />
                </Field>
                <Field label="Email" htmlFor="email" error={fieldErrors.show('email', validateEmail(formData.email.trim()))}>
                  <Input id="email" name="email" type="email" value={formData.email} onBlur={() => fieldErrors.touch('email')} onChange={handleChange} disabled={!isOwner} placeholder="hello@example.com" className="text-xs disabled:bg-slate-50" />
                </Field>
              </div>
            </div>
          </div>
          <div className="space-y-1">
            <label htmlFor="address" className="text-xs font-medium text-slate-600">Address</label>
            <textarea id="address" name="address" rows={2} value={formData.address} onChange={handleChange} disabled={!isOwner} placeholder="Street, city, state, zip…"
              className="w-full border border-slate-200 rounded-lg bg-white px-3 py-2 text-xs text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent resize-none disabled:bg-slate-50 disabled:text-slate-500" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="GSTIN" htmlFor="gstin" error={fieldErrors.show('gstin', validateGstin(normalizeGstin(formData.gstin)))}>
              <Input id="gstin" name="gstin" value={formData.gstin} onBlur={() => fieldErrors.touch('gstin')} onChange={handleChange} disabled={!isOwner} placeholder="Optional" className="text-xs uppercase disabled:bg-slate-50" />
            </Field>
            <Field label="Website" htmlFor="website">
              <Input id="website" name="website" value={formData.website} onChange={handleChange} disabled={!isOwner} placeholder="www.example.com" className="text-xs disabled:bg-slate-50" />
            </Field>
          </div>
        </div>
        <div className="px-5 py-3 border-t border-slate-100 bg-slate-50/50 flex justify-end">
          {isOwner && (
            <Button size="sm" onClick={handleSave} isLoading={isSaving} disabled={!formData.name.trim() || !formData.phone.trim()} className="gap-1.5 text-xs h-8 bg-indigo-600 hover:bg-indigo-700">
              <Save className="h-3.5 w-3.5" /> Save Changes
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Settings navigation ─────────────────────────────────────────────────────

type ActiveTab = 'profile' | 'whatsapp';

/** All valid tab ids — the default tab is the first entry. */
const SETTINGS_TABS: readonly ActiveTab[] = ['profile', 'whatsapp'];
const DEFAULT_TAB: ActiveTab = 'profile';

/** The tab labels — the Settings navigation uses the SAME segmented tab
 *  selector as the Payments page (one shared visual language). */
const SETTINGS_TAB_ITEMS = [
  { value: 'profile' as const, label: 'Profile' },
  { value: 'whatsapp' as const, label: 'WhatsApp' },
];

/**
 * Read the active tab from the URL hash — the canonical tab state.
 * An empty or invalid hash safely falls back to the default tab.
 */
function tabFromHash(): ActiveTab {
  const raw = window.location.hash.replace(/^#/, '');
  return (SETTINGS_TABS as readonly string[]).includes(raw) ? (raw as ActiveTab) : DEFAULT_TAB;
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  // The URL hash is the single source of truth for the active tab:
  //   /settings          → default tab (Profile)
  //   /settings#profile  → Profile
  //   /settings#whatsapp → WhatsApp
  // Seeding state from the hash (not an effect) makes refresh, direct links,
  // and back/forward all render the correct tab on the FIRST frame.
  const [activeTab, setActiveTab] = useState<ActiveTab>(tabFromHash);

  // Keep-alive: once the WhatsApp tab has been visited, its panel stays
  // mounted (hidden) for the lifetime of the Settings page. Switching back
  // then restores it instantly — its live SSE state and the initialized
  // templates form are exactly where the user left them: no hydration
  // skeleton flash, no reconnect, no refetch. Navigating away from
  // /settings unmounts everything as before.
  const [whatsappVisited, setWhatsappVisited] = useState(() => tabFromHash() === 'whatsapp');

  // Back/Forward (and any other hash navigation) switches the tab. Without
  // this listener the tab state desynced from the URL after history
  // navigation — the old code only read the hash once on mount.
  useEffect(() => {
    const onHashChange = () => {
      const next = tabFromHash();
      setActiveTab(next);
      if (next === 'whatsapp') setWhatsappVisited(true);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // Tab click: switch immediately and push a history entry (no duplicate
  // entry when the tab is already reflected in the URL). The hashchange
  // listener re-syncs from the URL afterwards — idempotent.
  const selectTab = (tab: ActiveTab) => {
    setActiveTab(tab);
    if (tab === 'whatsapp') setWhatsappVisited(true);
    if (window.location.hash !== `#${tab}`) window.location.hash = tab;
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-sm font-semibold text-slate-900 tracking-tight leading-none">Settings</h1>
        <p className="text-[11px] text-slate-400 mt-1">Business profile and WhatsApp configuration</p>
      </div>

      {/* Profile / WhatsApp — the same segmented tab selector as the
          Payments page. The dedicated WhatsApp Templates page is NOT a tab:
          it is reached from the WhatsApp tab's Manage Templates action. */}
      <SegmentedTabs
        tabs={SETTINGS_TAB_ITEMS}
        value={activeTab}
        onChange={selectTab}
        aria-label="Settings sections"
      />

      {/* ── Content ── */}
      <div className="min-w-0">
        {activeTab === 'profile' && <ProfilePanel />}
        {/* Kept alive after first visit (see whatsappVisited above) — the
            wrapper only toggles visibility, never remounts the panel. */}
        {whatsappVisited && (
          <div className={activeTab === 'whatsapp' ? undefined : 'hidden'}>
            <WhatsAppSettingsPanel />
          </div>
        )}
      </div>
    </div>
  );
}
