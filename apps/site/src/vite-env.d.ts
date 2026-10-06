/// <reference types="vite/client" />

/** Base URL of the build service; `VITE_BUILD_SERVICE` overrides it. */
interface ImportMetaEnv {
  readonly VITE_BUILD_SERVICE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
