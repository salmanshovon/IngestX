/** As-run reporting. */
import { api } from '@/lib/api-client'
import { API_PREFIX } from '@/config'
import type { LogReportResponse, MediaType, ScheduleStatus } from './types'

export interface LogReportParams {
  pipeline_id: number
  start_date?: string
  end_date?: string
  status?: ScheduleStatus
  lane?: string
  media_type?: MediaType
  offset?: number
  page_size?: number
}

export const reportsApi = {
  log: (params: LogReportParams, signal?: AbortSignal) =>
    api.get<LogReportResponse>(
      '/log-report',
      {
        pipeline_id: params.pipeline_id,
        start_date: params.start_date,
        end_date: params.end_date,
        status: params.status,
        lane: params.lane,
        media_type: params.media_type,
        offset: params.offset,
        page_size: params.page_size,
      },
      signal,
    ),

  /**
   * CSV export. Downloaded via `fetch` rather than a bare `<a href>` so the
   * session cookie is sent -- a plain navigation would work too, but going
   * through the client keeps CSRF/credential handling in one place and lets us
   * surface an error body instead of saving a 403 HTML page as a spreadsheet.
   */
  exportCsv: async (params: Omit<LogReportParams, 'offset' | 'page_size'>): Promise<Blob> => {
    const qs = new URLSearchParams({ pipeline_id: String(params.pipeline_id) })
    if (params.start_date) qs.set('start_date', params.start_date)
    if (params.end_date) qs.set('end_date', params.end_date)
    if (params.status) qs.set('status', params.status)
    if (params.lane) qs.set('lane', params.lane)
    if (params.media_type) qs.set('media_type', params.media_type)

    const response = await fetch(`${API_PREFIX}/log-report/export.csv?${qs.toString()}`, {
      credentials: 'include',
      headers: { Accept: 'text/csv' },
    })
    if (!response.ok) {
      throw new Error('The CSV export could not be generated. Try a narrower date range.')
    }
    return response.blob()
  },
}