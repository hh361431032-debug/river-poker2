import { supabase } from "./supabase";

const FUNCTION_NAME = "game-action";
const FUNCTION_REGION = import.meta.env.VITE_FUNCTION_REGION || "ap-southeast-1";

export async function gameAction(payload) {
  const started = performance.now();

  const { data, error } = await supabase.functions.invoke(FUNCTION_NAME, {
    body: payload,
  });

  const clientMs = Math.round((performance.now() - started) * 100) / 100;

  if (data?.timing) {
    console.info("[河畔牌局] action timing", JSON.stringify({
      action: payload?.action,
      clientMs,
      ...data.timing,
      edgeRegion: data.edgeRegion,
    }));
  } else {
    console.info("[河畔牌局] action timing", JSON.stringify({
      action: payload?.action,
      clientMs,
      serverTiming: "missing",
    }));
  }

  if (error) {
    let detail = error.message || "牌局服务器请求失败";
    try {
      const response = error.context;
      if (response && typeof response.json === "function") {
        const body = await response.clone().json();
        if (body?.error) detail = body.error;
      }
    } catch {}
    console.warn("[河畔牌局] action failed", {
      action: payload?.action,
      clientMs,
      error: detail,
    });
    throw new Error(detail);
  }

  if (!data?.success) {
    throw new Error(data?.error || "牌局操作失败");
  }

  return data;
}

export const pokerActions = {
  listRooms: () => gameAction({ action: "list_rooms" }),

  getRoom: (roomCode, username, playerToken = "") =>
    gameAction({ action: "get_room", roomCode, username, playerToken }),

  godView: (roomCode, username) =>
    gameAction({ action: "god_view", roomCode, username }),

  joinRoom: (roomCode, username, avatar = null) =>
    gameAction({ action: "join_room", roomCode, username, avatar }),

  createRoom: (payload) =>
    gameAction({ action: "create_room", ...payload }),

  startHand: (roomCode, username, playerToken) =>
    gameAction({ action: "start_hand", roomCode, username, playerToken }),

  nextHand: (roomCode, username, playerToken) =>
    gameAction({ action: "next_hand", roomCode, username, playerToken }),

  fold: (roomCode, username, playerToken) =>
    gameAction({ action: "fold", roomCode, username, playerToken }),

  check: (roomCode, username, playerToken) =>
    gameAction({ action: "check", roomCode, username, playerToken }),

  call: (roomCode, username, playerToken) =>
    gameAction({ action: "call", roomCode, username, playerToken }),

  raise: (roomCode, username, playerToken, amount) =>
    gameAction({ action: "raise", roomCode, username, playerToken, amount }),

  throw: (roomCode, username, playerToken, targetName, itemKey) =>
    gameAction({ action: "throw", roomCode, username, playerToken, targetName, itemKey }),

  kick: (roomCode, username, playerToken, targetName) =>
    gameAction({ action: "kick", roomCode, username, playerToken, targetName }),

  leave: (roomCode, username, playerToken) =>
    gameAction({ action: "leave", roomCode, username, playerToken }),

  updateAvatar: (roomCode, username, playerToken, avatar) =>
    gameAction({ action: "update_avatar", roomCode, username, playerToken, avatar }),

  tick: (roomCode, username, playerToken) =>
    gameAction({ action: "tick", roomCode, username, playerToken }),

  deleteRoom: (roomCode, username) =>
    gameAction({ action: "delete_room", roomCode, username }),
};