import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// Roboto 300/400/500/700 — the same four weights the Next.js app self-hosted
// via next/font (display: swap). @fontsource ships identical font files.
import '@fontsource/roboto/300.css'
import '@fontsource/roboto/400.css'
import '@fontsource/roboto/500.css'
import '@fontsource/roboto/700.css'
import './index.css'

import { RouterProvider } from 'react-router'
import { router } from './components/router'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
