import { supabase } from "./supabase";

const localKey = key => `river-poker:${key}`;

function notify() {
  try {
    window.dispatchEvent(new Event("river-poker-storage"));
  } catch {}
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

function mapUser(row) {
  if (!row) return null;
  return {
    passwordHash: row.password_hash || "",
    chips: Number(row.chips ?? 1000),
    avatarUrl: row.avatar_url || null,
  };
}

export const storage = {
  async get(key) {
    if (key === "poker:session") {
      const value = localStorage.getItem(localKey(key));
      return value === null ? null : { value };
    }

    if (key === "poker:users") {
      const { data, error } = await supabase
        .from("poker_users")
        .select("username,password_hash,chips,avatar_url")
        .order("username", { ascending: true });

      if (error) throw error;

      const users = Object.fromEntries(
        (data || []).map(row => [row.username, mapUser(row)])
      );

      return { value: JSON.stringify(users) };
    }

    if (key === "poker:rooms-index") {
      const { data, error } = await supabase
        .from("poker_rooms")
        .select("code,name,host_name,player_count,status")
        .order("updated_at", { ascending: false });

      if (error) throw error;

      return {
        value: JSON.stringify(
          (data || []).map(r => ({
            code: r.code,
            name: r.name,
            hostName: r.host_name,
            playerCount: r.player_count,
            status: r.status,
          }))
        ),
      };
    }

    if (key.startsWith("poker:room:")) {
      const code = key.replace("poker:room:", "");
      const { data, error } = await supabase
        .from("poker_rooms")
        .select("state")
        .eq("code", code)
        .maybeSingle();

      if (error) throw error;
      if (!data) return null;

      const state =
        typeof data.state === "string"
          ? JSON.parse(data.state)
          : data.state;

      return {
        value: JSON.stringify(state),
      };
    }

    return null;
  },

  async getUserProfile(username) {
    const { data, error } = await supabase
      .from("poker_users")
      .select("username,avatar_url")
      .eq("username", username)
      .maybeSingle();

    if (error) throw error;
    if (!data) return null;

    return {
      username: data.username,
      avatarUrl: data.avatar_url || null,
    };
  },

  async setUserAvatar(username, avatarUrl) {
    const { data: old, error: readError } = await supabase
      .from("poker_users")
      .select("username")
      .eq("username", username)
      .maybeSingle();

    if (readError) throw readError;

    if (old) {
      const { error } = await supabase
        .from("poker_users")
        .update({ avatar_url: avatarUrl || null })
        .eq("username", username);

      if (error) throw error;
    } else {
      const { error } = await supabase
        .from("poker_users")
        .insert({
          username,
          password_hash: "",
          chips: 1000,
          avatar_url: avatarUrl || null,
          dealer_image_url: null,
        });

      if (error) throw error;
    }

    notify();
    return { success: true };
  },

  async getDealerImage() {
    const { data, error } = await supabase
      .from("poker_users")
      .select("dealer_image_url")
      .eq("username", "莫拉咕")
      .maybeSingle();

    if (error) throw error;
    return data?.dealer_image_url || null;
  },

  async setDealerImage(imageUrl) {
    const { data: old, error: readError } = await supabase
      .from("poker_users")
      .select("username")
      .eq("username", "莫拉咕")
      .maybeSingle();

    if (readError) throw readError;

    if (old) {
      const { error } = await supabase
        .from("poker_users")
        .update({ dealer_image_url: imageUrl || null })
        .eq("username", "莫拉咕");

      if (error) throw error;
    } else {
      const { error } = await supabase
        .from("poker_users")
        .insert({
          username: "莫拉咕",
          password_hash: "",
          chips: 1000,
          avatar_url: null,
          dealer_image_url: imageUrl || null,
        });

      if (error) throw error;
    }

    notify();
    return { success: true };
  },

  async set(key, value) {
    if (key === "poker:session") {
      localStorage.setItem(localKey(key), value);
      notify();
      return { success: true };
    }

    if (key === "poker:users") {
      const users = JSON.parse(value || "{}");

      for (const [username, u] of Object.entries(users)) {
        const { data: existing, error: readError } = await supabase
          .from("poker_users")
          .select("username")
          .eq("username", username)
          .maybeSingle();

        if (readError) throw readError;

        const payload = {
          password_hash: u.passwordHash || "",
          chips: Number(u.chips ?? 1000),
          avatar_url: u.avatarUrl || null,
        };

        if (existing) {
          const { error } = await supabase
            .from("poker_users")
            .update(payload)
            .eq("username", username);

          if (error) throw error;
        } else {
          const { error } = await supabase
            .from("poker_users")
            .insert({
              username,
              ...payload,
              dealer_image_url: null,
            });

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

      const { error } = await supabase
        .from("poker_rooms")
        .upsert(
          {
            ...meta,
            state,
          },
          { onConflict: "code" }
        );

      if (error) throw error;

      return { success: true };
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
      const { error } = await supabase
        .from("poker_rooms")
        .delete()
        .eq("code", code);

      if (error) throw error;
      notify();
    }

    return { success: true };
  },
};
