import React, { useEffect } from 'react'
import { cn } from '@/components/ui/utils'
import { X } from 'lucide-react'
import { Button } from './Button'
import { createPortal } from 'react-dom'

export interface ModalProps {
  isOpen: boolean
  onClose: () => void
  title: string
  description?: string
  children: React.ReactNode
  footer?: React.ReactNode
  className?: string
  /** Hide the header X button. Action dialogs (Cancel + primary action in
   *  the footer) pass this — one dismissal affordance, not two. Read-only
   *  detail dialogs keep the X and pass no footer. */
  hideClose?: boolean
  /** Extra classes for the body region (merged with the defaults via cn(),
   *  so conflicting utilities are replaced, not stacked). By default the
   *  body is one scrolling region that fills the space between the fixed
   *  header and footer; a stable-shell dialog that manages its own internal
   *  scroll regions instead passes e.g. 'flex flex-col overflow-hidden' so
   *  its own regions — not the whole body — absorb height and scrolling. */
  bodyClassName?: string
}

export function Modal({ isOpen, onClose, title, description, children, footer, className, bodyClassName, hideClose }: ModalProps) {
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = 'unset'
    }
    return () => {
      document.body.style.overflow = 'unset'
    }
  }, [isOpen])

  // Escape closes the dialog (keyboard accessibility).
  useEffect(() => {
    if (!isOpen) return
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [isOpen, onClose])

  if (!isOpen) return null

  const content = (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Simple dimming layer only — no blur, the page behind stays visually
          normal. Quick opacity-only enter; no scale, no translation. */}
      <div className="fixed inset-0 bg-slate-900/50 dialog-fade-in" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          'relative z-50 flex w-full max-w-lg flex-col m-4 max-h-[90vh] overflow-hidden bg-white rounded-xl border border-slate-200 shadow-xl dialog-fade-in',
          className,
        )}
      >
        <div className="flex-none flex items-center justify-between px-6 py-4 border-b border-slate-100">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
            {description && <p className="text-sm text-slate-500 mt-1">{description}</p>}
          </div>
          {hideClose ? null : (
            <button
              onClick={onClose}
              aria-label="Close"
              className="text-slate-400 hover:text-slate-600 transition-colors p-1 rounded-md hover:bg-slate-100"
            >
              <X className="h-5 w-5" />
            </button>
          )}
        </div>
        <div className={cn('flex-1 min-h-0 overflow-y-auto px-6 py-4', bodyClassName)}>{children}</div>
        {footer && (
          <div className="flex-none px-6 py-4 border-t border-slate-100 bg-slate-50/50 flex justify-end gap-2">
            {footer}
          </div>
        )}
      </div>
    </div>
  )

  if (typeof window !== 'undefined') {
    return createPortal(content, document.body)
  }
  return null
}

export interface ConfirmDialogProps extends Omit<ModalProps, 'children' | 'footer'> {
  onConfirm: () => void
  confirmText?: string
  cancelText?: string
  isDestructive?: boolean
  isLoading?: boolean
}

export function ConfirmDialog({
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  isDestructive = false,
  isLoading = false,
  onConfirm,
  onClose,
  ...props
}: ConfirmDialogProps) {
  return (
    <Modal
      {...props}
      onClose={onClose}
      className="max-w-md"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={isLoading}>
            {cancelText}
          </Button>
          <Button variant={isDestructive ? 'danger' : 'primary'} onClick={onConfirm} isLoading={isLoading}>
            {confirmText}
          </Button>
        </>
      }
    >
      <div className="py-2 text-slate-600">Are you sure you want to proceed? This action cannot be undone.</div>
    </Modal>
  )
}
