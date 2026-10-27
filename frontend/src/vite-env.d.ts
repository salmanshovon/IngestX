/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Absolute backend origin. Empty (the default) means same-origin. */
  readonly VITE_API_BASE_URL?: string
  /** Dev-server proxy target for /api, /healthz and /readyz. */
  readonly VITE_DEV_PROXY_TARGET?: string
  /** Broadcast channel timezone. Defaults to Asia/Dhaka. */
  readonly VITE_CHANNEL_TIMEZONE?: string
  readonly VITE_PORT?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}