/**
 * useMessageJobEvents — app-scope reactions to settled durable message
 * jobs (MESSAGE_JOB_RESULT over the existing SSE connection).
 *
 * Behavior:
 *   - refresh the message-state queries (message-jobs / reminder-settings)
 *     so every open surface (invoice detail, reminder dialog, payments
 *     dialog) shows the current persistent state;
 *   - update the Messages page caches precisely (overview aggregate +
 *     by-id patch of the recent list — never a full-history refetch);
 *   - toast FIRE-AND-FORGET outcomes: invoice_send jobs (server-side
 *     auto-sends) and AUTOMATIC receipt jobs (created by the payment RPCs
 *     for subsequent payments when the store switch is ON — nobody awaits
 *     them, so this is their user feedback);
 *   - stay SILENT for manual executions (`trigger: 'manual'` — the
 *     sendReceipt/sendStatement/sendReminder HTTP responses carry their own
 *     toasts) and for scheduled reminders (status updates passively).
 *
 * Mounted once by the AppShell alongside the WhatsApp platform provider.
 */
import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { subscribeMessageJobResult } from '@/platform/whatsapp/message-events'
import type { MessageJobResultEvent } from '@/platform/whatsapp/backend'
import { useToast } from '@/components/ui/Toast'
import { messagesKeys, refreshRecentMessageAfterEvent } from '@/features/messages/api'

export function useMessageJobEvents(): void {
  const queryClient = useQueryClient()
  const { toast, success, error } = useToast()

  useEffect(() => {
    const unsubscribe = subscribeMessageJobResult((event: MessageJobResultEvent) => {
      // Refresh the persistent-state queries (prefix-level: every open
      // detail page / dialog updates).
      void queryClient.invalidateQueries({ queryKey: ['message-jobs'] })
      void queryClient.invalidateQueries({ queryKey: ['reminder-settings'] })

      // Messages page (the user-facing view over this same system): the
      // summary is one cheap aggregate refetch; the recent list is patched
      // precisely from the event (by-id fetch + in-place/prepend cache
      // update — loaded pages are never refetched); the scheduled list
      // only changes when a REMINDER job settles (chain advanced/stopped),
      // so it is invalidated for reminder events alone.
      void queryClient.invalidateQueries({ queryKey: messagesKeys.overview })
      if (event.jobType === 'reminder') {
        void queryClient.invalidateQueries({ queryKey: messagesKeys.scheduled })
      }
      void refreshRecentMessageAfterEvent(queryClient, event.jobId)

      // Fire-and-forget outcomes only. Manual inline executions toast from
      // their own HTTP responses (trigger === 'manual').
      if (event.trigger === 'manual') return

      if (event.jobType === 'invoice_send') {
        if (event.result === 'succeeded') {
          success('Invoice sent', 'The invoice was sent on WhatsApp automatically.')
        } else if (event.result === 'retrying') {
          toast({
            type: 'warning',
            title: 'Auto-send retrying',
            message: 'WhatsApp is unavailable right now — the invoice will be sent automatically once it reconnects.',
          })
        } else if (event.result === 'failed') {
          error('Auto-send failed', event.errorCode || 'The invoice could not be sent automatically.')
        }
        // cancelled auto-sends (e.g. superseded by a manual send) stay silent.
        return
      }

      // Automatic payment receipts (subsequent payments; the switch is ON).
      // Manual receipts return above — their dialogs/pages toast themselves.
      if (event.jobType === 'receipt') {
        if (event.result === 'succeeded') {
          success('Receipt sent', 'The payment receipt was sent on WhatsApp automatically.')
        } else if (event.result === 'retrying') {
          toast({
            type: 'warning',
            title: 'Receipt retrying',
            message: 'WhatsApp is unavailable right now — the payment receipt will be retried automatically.',
          })
        } else if (event.result === 'failed') {
          error('Receipt failed', event.errorCode || 'The automatic payment receipt could not be sent.')
        }
      }
    })
    return unsubscribe
  }, [queryClient, toast, success, error])
}
