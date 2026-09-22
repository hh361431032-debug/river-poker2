import { isLocalBackend } from "./backendMode";
import { supabase } from "./supabase";

const localKey = key => `river-poker:${key}`;

function notify() {
  try { window.dispatchEvent(new Event("river-poker-storage")); } catch {}
}

async function localDb(table, { method = "GET", query = {}, body } = {}) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null) qs.set(key, String(value));
  }
  const response = await fetch(`/api/db/${table}${qs.toString() ? `?${qs}` : ""}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.error) {
    throw new Error(data?.error?.message || data?.error || `本地数据库请求失败（${response.status}）`);
  }
  return data?.data;
}

function roomMetaFromState(state) {
  return {
    code: state.code,
    name: state.name,
    host_name: state.hostName,
    player_count: Array.isArray(state.players) ? state.players.length : 0,
    status: state.status || "waiting",
    updated_at: new Date().toISOString(),
  };
}

async function uploadDataUrl(dataUrl, folder, name) {
  if (!dataUrl || !String(dataUrl).startsWith("data:image/")) return dataUrl || null;
  const match = String(dataUrl).match(/^data:(image\\/[^;]+);base64,(.+)$/);
  if (!match) throw new Error("图片格式无效");
  const mime = match[1];
  const bytes = Uint8Array.from(atob(match[2]), ch => ch.charCodeAt(0));
  if (bytes.byteLength > 2 * 1024 * 1024) throw new Error("图片不能超过 2MB");
  const ext = (mime.split("/")[1] || "jpeg").replace("jpeg", "jpg").replace(/[^a-z0-9]/gi, "") || "jpg";
  const path = `${folder}/${String(name || "image").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 32)}-${crypto.randomUUID()}.${ext}`;
  const { error } = await supabase.storage.from("poker-assets").upload(path, bytes, {
    contentType: mime,
    cacheControl: "31536000",
    upsert: false,
  });
  if (error) throw error;
  return supabase.storage.from("poker-assets").getPublicUrl(path).data.publicUrl;
}

function mapUser(row) {
  if (!row) return null;
  return {
    passwordHash: row.password_hash || "",
    chips: Number(row.chips ?? 1000),
    avatarUrl: row.avatar_url || null,
  };
}

async function getLocalUser(username) {
  return mapUser(await localDb("poker_users", {
    query: { eq: `username:${username}`, single: 1, select: "username,password_hash,chips,avatar_url" },
  }));
}

async function getLocalUserProfile(username) {
  const row = await localDb("poker_users", {
    query: { eq: `username:${username}`, single: 1, select: "username,avatar_url" },
  });
  return row ? { username: row.username, avatarUrl: row.avatar_url || null } : null;
}

const onlineStorage = {
  async get(key) {
    if (key === "poker:session") {
      const value = localStorage.getItem(localKey(key));
      return value === null ? null : { value };
    }

    if (key === "poker:users") {
      const { data, error } = await supabase.from("poker_users").select("username,password_hash,chips,avatar_url").order("username", { ascending: true });
      if (error) throw error;
      const users = Object.fromEntries((data || []).map(row => [row.username, mapUser(row)]));
      return { value: JSON.stringify(users) };
    }

    if (key === "poker:rooms-index") {
      const { data, error } = await supabase.from("poker_rooms").select("code,name,host_name,player_count,status").order("updated_at", { ascending: false });
      if (error) throw error;
      return { value: JSON.stringify((data || []).map(r => ({
        code: r.code, name: r.name, hostName: r.host_name, playerCount: r.player_count, status: r.status,
      }))) };
    }

    if (key.startsWith("poker:room:")) {
      const code = key.replace("poker:room:", "");
      const { data, error } = await supabase.from("poker_rooms").select("state").eq("code", code).maybeSingle();
      if (error) throw error;
      if (!data) return null;
      const state = typeof data.state === "string" ? JSON.parse(data.state) : data.state;
      return { value: JSON.stringify(state) };
    }

    return null;
  },

  async getUser(username) {
    const { data, error } = await supabase.from("poker_users").select("username,password_hash,avatar_url").eq("username", username).maybeSingle();
    if (error) throw error;
    return mapUser(data);
  },

  async getUserProfile(username) {
    const { data, error } = await supabase.from("poker_users").select("username,avatar_url").eq("username", username).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    let avatarUrl = data.avatar_url || null;
    if (avatarUrl?.startsWith("data:image/")) {
      avatarUrl = await uploadDataUrl(avatarUrl, "avatars", username);
      const { error: migrateError } = await supabase.from("poker_users").update({ avatar_url: avatarUrl }).eq("username", username);
      if (migrateError) throw migrateError;
    }
    return { username: data.username, avatarUrl };
  },

  async setUserAvatar(username, avatarUrl) {
    avatarUrl = await uploadDataUrl(avatarUrl, "avatars", username);
    const { data: old, error: readError } = await supabase.from("poker_users").select("username").eq("username", username).maybeSingle();
    if (readError) throw readError;
    if (old) {
      const { error } = await supabase.from("poker_users").update({ avatar_url: avatarUrl || null }).eq("username", username);
      if (error) throw error;
    } else {
      const { error } = await supabase.from("poker_users").insert({ username, password_hash: "", chips: 1000, avatar_url: avatarUrl || null, dealer_image_url: null });
      if (error) throw error;
    }
    notify();
    return { success: true };
  },

  async getDealerImage() {
    const { data, error } = await supabase.from("poker_users").select("dealer_image_url").eq("username", "莫拉咕").maybeSingle();
    if (error) throw error;
    let imageUrl = data?.dealer_image_url || null;
    if (imageUrl?.startsWith("data:image/")) {
      imageUrl = await uploadDataUrl(imageUrl, "dealer", "luna");
      const { error: migrateError } = await supabase.from("poker_users").update({ dealer_image_url: imageUrl }).eq("username", "莫拉咕");
      if (migrateError) throw migrateError;
    }
    return imageUrl;
  },

  async setDealerImage(imageUrl) {
    imageUrl = await uploadDataUrl(imageUrl, "dealer", "luna");
    const { data: old, error: readError } = await supabase.from("poker_users").select("username").eq("username", "莫拉咕").maybeSingle();
    if (readError) throw readError;
    if (old) {
      const { error } = await supabase.from("poker_users").update({ dealer_image_url: imageUrl || null }).eq("username", "莫拉咕");
      if (error) throw error;
    } else {
      const { error } = await supabase.from("poker_users").insert({ username: "莫拉咕", password_hash: "", chips: 1000, avatar_url: null, dealer_image_url: imageUrl || null });
      if (error) throw error;
    }
    notify();
    return { success: true };
  },

  async set(key, value, options = {}) {
    if (key === "poker:session") {
      localStorage.setItem(localKey(key), value);
      notify();
      return { success: true };
    }

    if (key === "poker:users") {
      const users = JSON.parse(value || "{}");
      for (const [username, u] of Object.entries(users)) {
        const { data: existing, error: readError } = await supabase.from("poker_users").select("username").eq("username", username).maybeSingle();
        if (readError) throw readError;

        const payload = {
          password_hash: u.passwordHash || "",
          chips: Number(u.chips ?? 1000),
          avatar_url: u.avatarUrl || null,
        };

        if (existing) {
          const { error } = await supabase.from("poker_users").update(payload).eq("username", username);
          if (error) throw error;
        } else {
          const { error } = await supabase.from("poker_users").insert({ username, ...payload, dealer_image_url: null });
          if (error) throw error;
        }
      }

      notify();
      return { success: true };
    }

    if (key.startsWith("poker:room:")) {
      const code = key.replace("poker:room:", "");
      const state = JSON.parse(value);
      const meta = roomMetaFromState(state);
      const expectedUpdatedAt = options.expectedUpdatedAt || null;

      if (!expectedUpdatedAt) {
        const { data: existing, error: readError } = await supabase.from("poker_rooms").select("code").eq("code", code).maybeSingle();
        if (readError) throw readError;
        if (existing) throw new Error("ROOM_VERSION_REQUIRED");

        const { error } = await supabase.from("poker_rooms").insert({ ...meta, state });
        if (error) throw error;
        return { success: true };
      }

      const nextUpdatedAt = new Date().toISOString();
      const { data, error } = await supabase.from("poker_rooms")
        .update({ ...meta, state, updated_at: nextUpdatedAt })
        .eq("code", code)
        .eq("updated_at", expectedUpdatedAt)
        .select("updated_at")
        .maybeSingle();

      if (error) throw error;
      if (!data) return { success: false, conflict: true };
      return { success: true, updatedAt: data.updated_at };
    }

    return { success: true };
  },

  async delete(key) {
    if (key === "poker:session") {
      localStorage.removeItem(localKey(key));
      notify();
      return { success: true };
    }

    if (key.startsWith("poker:room:")) {
      const code = key.replace("poker:room:", "");
      const { error } = await supabase.from("poker_rooms").delete().eq("code", code);
      if (error) throw error;
      notify();
    }

    return { success: true };
  },
};

const localStorageAdapter = {
  async get(key) {
    if (key === "poker:session") {
      const value = localStorage.getItem(localKey(key));
      return value === null ? null : { value };
    }
    if (key === "poker:users") {
      const rows = await localDb("poker_users", { query: { select: "username,password_hash,chips,avatar_url", order: "username.asc" } });
      return { value: JSON.stringify(Object.fromEntries((rows || []).map(row => [row.username, mapUser(row)]))) };
    }
    if (key === "poker:rooms-index") {
      const rows = await localDb("poker_rooms", { query: { select: "code,name,host_name,player_count,status", order: "updated_at.desc" } });
      return { value: JSON.stringify((rows || []).map(r => ({ code: r.code, name: r.name, hostName: r.host_name, playerCount: r.player_count, status: r.status }))) };
    }
    if (key.startsWith("poker:room:")) {
      const code = key.replace("poker:room:", "");
      const row = await localDb("poker_rooms", { query: { eq: `code:${code}`, single: 1, select: "state" } });
      if (!row) return null;
      const state = typeof row.state === "string" ? JSON.parse(row.state) : row.state;
      return { value: JSON.stringify(state) };
    }
    return null;
  },

  async getUser(username) { return getLocalUser(username); },
  async getUserProfile(username) { return getLocalUserProfile(username); },

  async setUserAvatar(username, avatarUrl) {
    await localDb("poker_users", {
      method: "POST",
      body: { username, password_hash: "", chips: 1000, avatar_url: avatarUrl || null, __upsert: true },
    });
    notify();
    return { success: true };
  },

  async getDealerImage() {
    const row = await localDb("poker_users", { query: { eq: "username:莫拉咕", single: 1, select: "dealer_image_url" } });
    return row?.dealer_image_url || null;
  },

  async setDealerImage(imageUrl) {
    const existing = await localDb("poker_users", { query: { eq: "username:莫拉咕", single: 1, select: "username" } });
    if (existing) {
      await localDb("poker_users", {
        method: "PATCH",
        query: { eq: "username:莫拉咕" },
        body: { dealer_image_url: imageUrl || null },
      });
    } else {
      await localDb("poker_users", {
        method: "POST",
        body: { username: "莫拉咕", password_hash: "", chips: 1000, avatar_url: null, dealer_image_url: imageUrl || null },
      });
    }
    notify();
    return { success: true };
  },

  async set(key, value, options = {}) {
    if (key === "poker:session") {
      localStorage.setItem(localKey(key), value); notify(); return { success: true };
    }
    if (key === "poker:users") {
      const users = JSON.parse(value || "{}");
      for (const [username, u] of Object.entries(users)) {
        await localDb("poker_users", {
          method: "POST",
          body: { username, password_hash: u.passwordHash || "", chips: Number(u.chips ?? 1000), avatar_url: u.avatarUrl || null, __upsert: true },
        });
      }
      notify();
      return { success: true };
    }
    if (key.startsWith("poker:room:")) {
      const code = key.replace("poker:room:", "");
      const state = JSON.parse(value);
      const expectedUpdatedAt = options.expectedUpdatedAt || null;
      if (!expectedUpdatedAt) {
        const existing = await localDb("poker_rooms", { query: { eq: `code:${code}`, single: 1, select: "code" } });
        if (existing) throw new Error("ROOM_VERSION_REQUIRED");
        await localDb("poker_rooms", { method: "POST", body: { ...roomMetaFromState(state), state } });
        return { success: true };
      }
      const data = await localDb("poker_rooms", { method: "PATCH", query: { eq: `code:${code}` }, body: { ...roomMetaFromState(state), state } });
      return { success: true, updatedAt: data?.[0]?.updated_at || null };
    }
    return { success: true };
  },

  async delete(key) {
    if (key === "poker:session") {
      localStorage.removeItem(localKey(key)); notify(); return { success: true };
    }
    if (key.startsWith("poker:room:")) {
      const code = key.replace("poker:room:", "");
      await localDb("poker_rooms", { method: "DELETE", query: { eq: `code:${code}` } });
      notify();
    }
    return { success: true };
  },
};

export const storage = isLocalBackend ? localStorageAdapter : onlineStorage;
