'use client';

/**
 * WhatsAppTemplatesPage — the dedicated WhatsApp Templates page
 * (Settings → WhatsApp → Manage Templates).
 *
 * A focused, templates-ONLY surface: the page header, a pointer back to the
 * automatic-sending configuration (which lives on the Settings → WhatsApp
 * page — one source of truth), and the eight message template cards. The
 * parent Settings Profile/WhatsApp tab navigation is deliberately NOT
 * rendered here: the Templates page is its own destination, not a third
 * Settings tab.
 */
import { Link } from 'react-router';
import { PageHeader } from '@/components/PageHeader';
import { WhatsAppMessageSettingsPanel } from '@/components/settings/WhatsAppMessageSettingsPanel';

export default function WhatsAppTemplatesPage() {
  return (
    <div className="space-y-5">
      <PageHeader
        title="WhatsApp Templates"
        subtitle="The WhatsApp messages customers receive — invoices, payment receipts, payment statements, and reminders."
        backTo="/settings#whatsapp"
        backLabel="Back to WhatsApp Settings"
      />

      {/* Cross-reference — the automatic-sending SWITCHES are configuration
          and live on the Settings → WhatsApp page, not on this templates
          page. */}
      <p className="text-[11px] text-slate-400">
        Automatic sending switches live in{' '}
        <Link
          to="/settings#whatsapp"
          className="font-medium text-indigo-600 hover:text-indigo-700 hover:underline"
        >
          WhatsApp settings
        </Link>
        .
      </p>

      <WhatsAppMessageSettingsPanel />
    </div>
  );
}
