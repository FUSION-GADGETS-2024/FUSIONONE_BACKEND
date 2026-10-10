/**
 * useNotices — the ONE notice feed hook.
 *
 * Combines the three detector inputs into the derived, deduplicated notice
 * set (see detectors.ts):
 *   1. the cross-FY dataset (['notices', 'data', activeFyId] — refreshed by
 *      the semantic invalidation helpers on every business mutation),
 *   2. the shared acquisition timeline (the SAME ['analytics', …] query the
 *      analytics fold uses — one stock-age truth),
 *   3. the live WhatsApp platform state (context, not a query — it updates
 *      through SSE events) and the financial-year list from the provider.
 *
 * Consumers: the header NotificationsMenu and the Analytics Overview
 * attention card. Both see the identical feed.
 */
import { useMemo } from 'react'
import { useFinancialYear } from '@/components/providers/FinancialYearProvider'
import { useStore } from '@/features/settings/api'
import { useInventoryTimeline } from '@/features/analytics/fold'
import { timelineMap } from '@/features/analytics/metrics'
import { useWhatsAppPlatformContext } from '@/features/whatsapp/WhatsAppPlatformContext'
import { buildNotices } from './detectors'
import { useNoticesData } from './data'
import type { Notice } from './types'

export interface UseNoticesResult {
  notices: Notice[]
  isLoading: boolean
  isError: boolean
  error: unknown
  refetch: () => void
}

export function useNotices(): UseNoticesResult {
  const { data: store } = useStore()
  const activeFyId = (store as { active_financial_year_id?: string } | null | undefined)
    ?.active_financial_year_id ?? null
  const { financialYears } = useFinancialYear()
  const { status: whatsappStatus } = useWhatsAppPlatformContext()

  const dataQuery = useNoticesData(activeFyId)
  const timelineQuery = useInventoryTimeline()

  const notices = useMemo(() => {
    if (!dataQuery.data || !timelineQuery.data) return []
    return buildNotices({
      data: dataQuery.data,
      timeline: timelineMap(timelineQuery.data),
      financialYears,
      whatsapp: whatsappStatus
        ? { state: whatsappStatus.state, session: whatsappStatus.session, connected: whatsappStatus.connected }
        : null,
    })
  }, [dataQuery.data, timelineQuery.data, financialYears, whatsappStatus])

  return {
    notices,
    isLoading: (dataQuery.isLoading && !dataQuery.data) || (timelineQuery.isLoading && !timelineQuery.data),
    isError: dataQuery.isError || timelineQuery.isError,
    error: dataQuery.error ?? timelineQuery.error,
    refetch: () => {
      void dataQuery.refetch()
      void timelineQuery.refetch()
    },
  }
}
