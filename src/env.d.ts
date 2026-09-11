declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }

  interface ImportMetaEnv {
    readonly VITE_APP_VERSION?: string;
    readonly VITE_ENVIRONMENT?: string;
    readonly VITE_OTLP_LOGS_ENDPOINT?: string;
    readonly VITE_DESIGN_SYSTEM_EXPLORER?: string;
    readonly VITE_BERD_G2_BASE_URL?: string;
    /** @deprecated use VITE_BERD_G2_BASE_URL. */
    readonly VITE_PREVIEW_READY_UPDATE?: string;
    readonly VITE_RELEASE_CHANNEL_PREVIEW?: string;
  }
}

export {};
