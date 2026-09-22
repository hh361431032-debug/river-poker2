import { createClient } from "@supabase/supabase-js";
import { isLocalBackend } from "./backendMode";

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const HTTP_TIMEOUT_MS = 12000;

async function fetchWithTimeout(input, init = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

  if (init.signal) {
    if (init.signal.aborted) controller.abort();
    else init.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("网络请求超时（12 秒）。请检查手机的网络、VPN/代理、私有 DNS 或浏览器网络权限后重试。");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

if (!isLocalBackend && (!url || !key || url.includes("YOUR-PROJECT"))) {
  console.warn("Supabase 环境变量未配置：请检查 .env.local 中的 VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY");
}

export const supabase = isLocalBackend
  ? null
  : createClient(url || "", key || "", {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: {
        fetch: fetchWithTimeout,
      },
    });
