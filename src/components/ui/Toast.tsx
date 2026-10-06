import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import type { ReactNode } from 'react'
import { CheckCircle2, XCircle, AlertCircle, Info, X } from 'lucide-react'
import { createPortal } from 'react-dom'

export type ToastType = 'success' | 'error' | 'warning' | 'info'

export interface ToastMessage {
  id: string
  type: ToastType
  title: string
  message?: string
}

interface ToastContextType {
  toast: (toast: Omit<ToastMessage, 'id'>) => void
  success: (title: string, message?: string) => void
  error: (title: string, message?: string) => void
  remove: (id: string) => void
}

const ToastContext = createContext<ToastContextType | undefined>(undefined)

export function useToast() {
  const context = useContext(ToastContext)
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider')
  }
  return context
}

const ICONS = {
  success: <CheckCircle2 className="h-5 w-5 text-emerald-500" />,
  error: <XCircle className="h-5 w-5 text-rose-500" />,
  warning: <AlertCircle className="h-5 w-5 text-amber-500" />,
  info: <Info className="h-5 w-5 text-blue-500" />,
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastMessage[]>([])
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    const timeout = setTimeout(() => {
      setMounted(true)
    }, 0)
    return () => clearTimeout(timeout)
  }, [])

  const remove = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const toast = useCallback(
    (t: Omit<ToastMessage, 'id'>) => {
      const id = Math.random().toString(36).substring(2, 9)
      setToasts((prev) => [...prev, { ...t, id }])
      setTimeout(() => {
        remove(id)
      }, 5000)
    },
    [remove],
  )

  const success = useCallback(
    (title: string, message?: string) => {
      toast({ type: 'success', title, message })
    },
    [toast],
  )

  const error = useCallback(
    (title: string, message?: string) => {
      toast({ type: 'error', title, message })
    },
    [toast],
  )

  return (
    <ToastContext.Provider value={{ toast, success, error, remove }}>
      {children}
      {mounted &&
        createPortal(
          <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none max-w-sm w-full">
            {toasts.map((t) => (
              <div
                key={t.id}
                className="bg-white border border-slate-200 shadow-lg rounded-lg p-4 flex gap-3 pointer-events-auto"
              >
                <div className="shrink-0">{ICONS[t.type]}</div>
                <div className="flex-1 space-y-1">
                  <p className="text-sm font-medium text-slate-900">{t.title}</p>
                  {t.message && <p className="text-sm text-slate-500">{t.message}</p>}
                </div>
                <button
                  onClick={() => remove(t.id)}
                  className="shrink-0 text-slate-400 hover:text-slate-600 transition-colors"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>,
          document.body,
        )}
    </ToastContext.Provider>
  )
}
