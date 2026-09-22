export const BACKEND_MODE = String(import.meta.env.VITE_BACKEND_MODE || "supabase").toLowerCase();
export const isLocalBackend = BACKEND_MODE === "local";
