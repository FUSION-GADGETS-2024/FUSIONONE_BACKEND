/**
 * Workbook assembly — the ONE composition layer of the export
 * architecture (implementation spec §8).
 *
 * `buildReportWorkbook` composes ONE report — one or more worksheets in
 * their declared order — as an individual export. Every sheet of every
 * export flows through the SAME dataset builders and the SAME shared
 * renderer: there are no per-report exporters, no second styling engine,
 * no charts and no floating objects anywhere.
 *
 * ExcelJS is imported dynamically: the spreadsheet engine stays out of the
 * application bundle and loads only when a report is actually exported
 * (the same pattern the invoice PDF renderer uses for pdfkit).
 */
import type { Workbook } from 'exceljs'
import type { ReportDataset, ReportMeta } from '../data'
import { renderReportSheets } from './renderer'

async function newWorkbook(storeName: string | null): Promise<Workbook> {
  const ExcelJS = await import('exceljs')
  const wb = new ExcelJS.Workbook()
  // The workbook's file metadata identifies the issuing business (the
  // configured store), not the application.
  const creator = storeName?.trim() || 'FUSION ONE Reports'
  wb.creator = creator
  wb.lastModifiedBy = creator
  wb.created = new Date()
  wb.modified = new Date()
  wb.properties.date1904 = false
  return wb
}

async function writeWorkbook(wb: Workbook): Promise<Uint8Array> {
  const buffer = await wb.xlsx.writeBuffer()
  return new Uint8Array(buffer as ArrayBuffer)
}

/**
 * Builds one report workbook: every sheet of the dataset, in declared
 * order, each with its own title masthead, records, totals and notes.
 */
export async function buildReportWorkbook(meta: ReportMeta, dataset: ReportDataset): Promise<Uint8Array> {
  const wb = await newWorkbook(meta.storeName)
  renderReportSheets(wb, meta, dataset)
  return writeWorkbook(wb)
}
