/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string
  readonly VITE_SUPABASE_PUBLISHABLE_KEY: string
  readonly VITE_FUSIONONE_BACKEND_BASE: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
