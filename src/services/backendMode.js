const explicitMode = String(import.meta.env.VITE_BACKEND_MODE || "").trim().toLowerCase();

const inferredMode =
  explicitMode ||
  (import.meta.env.DEV || (typeof location !== "undefined" && location.port === "8787")
    ? "local"
    : "supabase");

export const BACKEND_MODE = inferredMode;
export const isLocalBackend = BACKEND_MODE === "local";
