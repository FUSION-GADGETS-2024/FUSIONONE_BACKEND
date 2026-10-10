'use client';

/**
 * Party Documents tab — the ONE place document management lives.
 *
 * The third tab of Party Detail: lists the party's REAL document records
 * (active + archived) with their metadata — original filename, file type,
 * human-readable size, added date, lifecycle status — and provides
 * Add / Preview / Download / Replace / Archive.
 *
 *   - Preview opens the IN-APP DocumentPreviewDialog (never a new tab).
 *   - Download is a separate action (the authenticated backend route).
 *   - Replace exists ONLY here (Party Detail → Documents) — nowhere else
 *     in the application.
 *   - Every operation goes through the authenticated backend routes
 *     (features/party-documents/api.ts) — the browser never touches storage.
 *
 * Visual language: the existing FUSION ONE list architecture (DataTable +
 * RowActions + ActionMenu + the app's slate/emerald/rose badges and modals)
 * — no separate design system.
 */
import { useMemo, useRef, useState } from 'react';
import { Archive, Download, FileText, FileImage, Plus, RefreshCw } from 'lucide-react';
import { DataTable, RowActions, type DataTableColumn } from '@/components/ui/tables';
import { staticPagination } from '@/components/list-page/use-list-pagination';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { ViewButton } from '@/components/ui/ViewButton';
import { ActionMenu } from '@/components/ui/ActionMenu';
import { cn } from '@/components/ui/utils';
import { useToast } from '@/components/ui/Toast';
import {
  useArchivePartyDocument,
  usePartyDocuments,
  useReplacePartyDocument,
  useUploadPartyDocument,
  downloadPartyDocument,
  type PartyDocument,
} from '@/features/party-documents/api';
import { DocumentPreviewDialog } from './DocumentPreviewDialog';

const fmtSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const fmtDate = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

const typeLabel = (mime: string): string =>
  mime === 'application/pdf' ? 'PDF' : mime === 'image/jpeg' ? 'JPEG' : mime.replace('image/', '').toUpperCase();

/** The document-kind icon: a PDF icon for PDFs, an image icon for images. */
const TypeIcon = ({ mime }: { mime: string }) =>
  mime === 'application/pdf' ? (
    <FileText className="h-3.5 w-3.5 text-slate-400 shrink-0" aria-hidden="true" />
  ) : (
    <FileImage className="h-3.5 w-3.5 text-slate-400 shrink-0" aria-hidden="true" />
  );

export function PartyDocumentsTab({ partyId }: { partyId: string }) {
  const { error, success } = useToast();
  const documentsQuery = usePartyDocuments(partyId);
  const uploadMutation = useUploadPartyDocument(partyId);
  const replaceMutation = useReplacePartyDocument(partyId);
  const archiveMutation = useArchivePartyDocument(partyId);

  const addInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  /** The document being replaced by the current file-picker pass. */
  const [replaceTarget, setReplaceTarget] = useState<PartyDocument | null>(null);
  /** The document pending archive confirmation. */
  const [archiveTarget, setArchiveTarget] = useState<PartyDocument | null>(null);
  /** The document open in the in-app preview dialog. */
  const [previewTarget, setPreviewTarget] = useState<PartyDocument | null>(null);

  const documents = useMemo(() => documentsQuery.data ?? [], [documentsQuery.data]);
  const activeCount = useMemo(() => documents.filter((d) => d.status === 'active').length, [documents]);
  const archivedCount = useMemo(() => documents.filter((d) => d.status === 'archived').length, [documents]);

  // ── Upload (Add Document) ─────────────────────────────────────────────────
  const handleAddFile = (file: File | null | undefined) => {
    if (!file) return;
    uploadMutation.mutate(file, {
      onSuccess: (doc) => success('Document Added', `${doc.file_name} is ready to use.`),
      onError: (err) => error('Upload Failed', err instanceof Error ? err.message : 'The document could not be uploaded.'),
    });
  };

  // ── Replace (active documents only; exists ONLY on this tab) ──────────────
  const startReplace = (doc: PartyDocument) => {
    setReplaceTarget(doc);
    // Open the picker on the next tick so state settles first.
    requestAnimationFrame(() => replaceInputRef.current?.click());
  };

  const handleReplaceFile = (file: File | null | undefined) => {
    const target = replaceTarget;
    setReplaceTarget(null);
    if (!file || !target) return;
    replaceMutation.mutate(
      { documentId: target.id, file },
      {
        onSuccess: (result) =>
          success('Document Replaced', `${result.document.file_name} is now the active document; ${target.file_name} was archived.`),
        onError: (err) => error('Replace Failed', err instanceof Error ? err.message : 'The document could not be replaced.'),
      },
    );
  };

  // ── Archive (active documents only; nothing is ever deleted) ──────────────
  const confirmArchive = () => {
    const target = archiveTarget;
    if (!target) return;
    setArchiveTarget(null);
    archiveMutation.mutate(target.id, {
      onSuccess: (doc) => success('Document Archived', `${doc.file_name} is archived. Nothing was deleted.`),
      onError: (err) => error('Archive Failed', err instanceof Error ? err.message : 'The document could not be archived.'),
    });
  };

  // ── Preview (in-app dialog) / Download (separate action) ──────────────────
  //
  // Download is fully row-neutral: the menu closes synchronously when the
  // item is chosen (ActionMenu closes before invoking the handler), the
  // secure backend download runs, and ONLY a failure is reported (toast).
  // The download deliberately keeps NO row state — a busy flag on the row
  // would have to live on some row control (it previously rewrote the VIEW
  // label to an ellipsis, collapsing the row's action cluster for the whole
  // flight and sticking if the fetch hung), and no row control belongs to
  // this action. The document list state stays exactly as loaded: no
  // invalidation, no refetch, no remount — the existing document state is
  // still valid, so nothing is refetched.
  const handlePreview = (doc: PartyDocument) => setPreviewTarget(doc);

  const handleDownload = async (doc: PartyDocument) => {
    try {
      await downloadPartyDocument(partyId, doc.id);
    } catch (err) {
      error('Download Failed', err instanceof Error ? err.message : 'The document could not be downloaded.');
    }
  };

  // ── Table ─────────────────────────────────────────────────────────────────
  const columns: Array<DataTableColumn<PartyDocument>> = [
    {
      id: 'document',
      header: 'Document',
      render: (doc) => (
        <div className="flex items-center gap-2 min-w-0">
          <TypeIcon mime={doc.mime_type} />
          <p className="text-xs font-medium text-slate-900 truncate">{doc.file_name}</p>
        </div>
      ),
      mobile: 'identity',
    },
    {
      id: 'type',
      header: 'Type',
      render: (doc) => <span className="text-xs text-slate-500 whitespace-nowrap">{typeLabel(doc.mime_type)}</span>,
      mobile: 'meta',
    },
    {
      id: 'size',
      header: 'Size',
      render: (doc) => <span className="text-xs text-slate-500 tabular-nums whitespace-nowrap">{fmtSize(doc.file_size)}</span>,
      mobile: 'meta',
    },
    {
      id: 'added',
      header: 'Added',
      render: (doc) => <span className="text-xs text-slate-500 tabular-nums whitespace-nowrap">{fmtDate(doc.created_at)}</span>,
      mobile: 'meta',
    },
    {
      id: 'status',
      header: 'Status',
      render: (doc) =>
        doc.status === 'active' ? (
          <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">Active</span>
        ) : (
          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500 bg-slate-100 px-2 py-0.5 rounded border border-slate-200">Archived</span>
        ),
      mobile: 'meta',
    },
    {
      id: 'actions',
      align: 'right',
      mobile: 'actions',
      render: (doc) => (
        <RowActions>
          <ViewButton onClick={() => handlePreview(doc)} />
          <ActionMenu
            items={[
              { icon: Download, label: 'Download', onClick: () => void handleDownload(doc) },
              ...(doc.status === 'active'
                ? ([
                    { icon: RefreshCw, label: 'Replace', onClick: () => startReplace(doc) },
                    { icon: Archive, label: 'Archive', onClick: () => setArchiveTarget(doc), tone: 'warning' as const },
                  ] as const)
                : []),
            ]}
          />
        </RowActions>
      ),
    },
  ];

  const isMutating = uploadMutation.isPending || replaceMutation.isPending || archiveMutation.isPending;
  const isLoaded = !documentsQuery.isLoading && !documentsQuery.isError;

  return (
    // The list-page height chain: PartyDetailPage renders this tab inside
    // ListPage's bounded flex column (flex min-h-0 flex-1 flex-col). The root
    // must STAY a stretching flex item (flex-1 + min-h-0) and a flex
    // container itself — that is what gives the fill-mode DataTable card a
    // bounded height, so its absolute-inset-0 rows viewport (ListViewport)
    // resolves to a real height and the rows are actually visible. A plain
    // block wrapper (e.g. space-y-3) collapses the card to 0px and silently
    // clips every row while the counter line above still renders.
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {/* Tab toolbar — the ONE management entry point for this party's documents */}
      <div className="flex shrink-0 items-center justify-between gap-3">
        <p className="text-[11px] text-slate-400" aria-live="polite">
          {documentsQuery.isLoading
            ? 'Loading documents…'
            : documentsQuery.isError
              ? 'Documents unavailable.'
              : documents.length === 0
                ? 'No documents yet.'
                : `${activeCount} active · ${archivedCount} archived`}
        </p>
        <Button
          onClick={() => addInputRef.current?.click()}
          disabled={isMutating}
          variant="outline"
          size="sm"
          className="h-7 text-[11px]"
        >
          <Plus className="h-3 w-3" /> Add Document
        </Button>
        <input
          ref={addInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,.pdf"
          className="hidden"
          onChange={(e) => {
            handleAddFile(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
        {/* The replace picker (target captured before opening) */}
        <input
          ref={replaceInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,.pdf"
          className="hidden"
          onChange={(e) => {
            handleReplaceFile(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </div>

      {documentsQuery.isError && (
        <div className="shrink-0 text-center text-xs text-rose-500 py-2">
          Couldn&apos;t load documents.{' '}
          <button
            type="button"
            className="font-semibold text-rose-600 hover:text-rose-700 underline underline-offset-2"
            onClick={() => void documentsQuery.refetch()}
          >
            Try again
          </button>
        </div>
      )}

      {/* The real document records — rows, not summary counts. The table
          renders its own skeleton while loading (and keeps existing rows
          visible during a refetch). */}
      {(documentsQuery.isLoading || documents.length > 0) && (
        <DataTable
          columns={columns}
          rows={documents}
          rowKey={(doc) => doc.id}
          loading={documentsQuery.isLoading}
          skeletonRows={4}
          emptyMessage="No documents added yet."
          minWidth="min-w-[720px]"
          fill
          pagination={staticPagination(documentsQuery)}
          rowClassName={(doc) => (doc.status === 'archived' ? 'opacity-60' : undefined)}
        />
      )}

      {/* Proper empty state — the tab's purpose + the one action that fixes it. */}
      {isLoaded && documents.length === 0 && (
        <div className="flex shrink-0 flex-col items-center justify-center gap-2 py-10 text-center border-2 border-dashed border-slate-200 rounded-lg">
          <FileText className="h-6 w-6 text-slate-300" aria-hidden="true" />
          <p className="text-xs font-medium text-slate-600">No documents added yet.</p>
          <p className="text-[11px] text-slate-400 max-w-xs">
            Add an identity or declaration document for this party.
          </p>
          <Button
            onClick={() => addInputRef.current?.click()}
            disabled={isMutating}
            variant="outline"
            size="sm"
            className="mt-1 h-7 text-[11px]"
          >
            <Plus className="h-3 w-3" /> Add Document
          </Button>
        </div>
      )}

      {/* Upload/replace progress hint */}
      {(uploadMutation.isPending || replaceMutation.isPending) && (
        <p className={cn('shrink-0 text-[11px] text-slate-400 text-center animate-pulse')}>
          {uploadMutation.isPending ? 'Uploading document…' : 'Replacing document…'}
        </p>
      )}

      {/* Archive confirmation — the app's action-dialog pattern */}
      <Modal
        isOpen={!!archiveTarget}
        onClose={() => setArchiveTarget(null)}
        title="Archive Document"
        hideClose
        footer={
          <>
            <Button variant="outline" onClick={() => setArchiveTarget(null)}>Cancel</Button>
            <Button variant="outline" onClick={confirmArchive} className="text-amber-700 border-amber-200 hover:bg-amber-50">
              Archive
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-xs text-slate-600">
            Archive <span className="font-semibold text-slate-900">{archiveTarget?.file_name}</span>?
          </p>
          <p className="text-[11px] text-slate-400">
            The document is kept and stays available for preview and download, but it will no
            longer be the active document. Nothing is deleted.
          </p>
        </div>
      </Modal>

      {/* The in-app preview dialog (never a new browser tab) */}
      <DocumentPreviewDialog
        isOpen={!!previewTarget}
        onClose={() => setPreviewTarget(null)}
        partyId={partyId}
        document={previewTarget}
      />
    </div>
  );
}
