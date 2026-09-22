import React, { useEffect, useRef, useState } from "react";
import { Camera, Settings, Smartphone, RotateCcw } from "lucide-react";
import { storage } from "../services/storage";
import { isLocalBackend } from "../services/backendMode";
import { supabase } from "../services/supabase";

const lines = {
  waiting: "欢迎来到河畔牌局，等大家到齐我们就开始。",
  preflop: "底牌已经发出，请各位玩家开始行动。",
  flop: "翻牌圈开始，看看牌面会给谁带来机会。",
  turn: "转牌已经发出，局势越来越紧张了。",
  river: "最后一张公共牌！这是决定胜负的关键时刻。",
  handover: "这一局结束啦，祝贺赢家！准备下一局吧。",
};

const DEFAULT_IMAGE = "https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=300&q=85";

function compressDealerImage(file) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type.startsWith("image/")) return reject(new Error("请选择图片文件"));
    if (file.size > 8 * 1024 * 1024) return reject(new Error("图片不能超过 8MB"));
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("图片读取失败"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("图片格式无法读取"));
      img.onload = () => {
        const max = 512;
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.86));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function OrientationSettings() {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState(() => {
    try { return localStorage.getItem("poker:orientation") || "portrait"; } catch { return "portrait"; }
  });

  useEffect(() => {
    document.documentElement.dataset.orientation = mode;
    try { localStorage.setItem("poker:orientation", mode); } catch {}
    return () => {
      delete document.documentElement.dataset.orientation;
    };
  }, [mode]);

  const choose = value => {
    setMode(value);
    setOpen(false);
  };

  return (
    <div className="orientation-settings">
      <button className="orientation-settings-btn" type="button" title="屏幕方向" onClick={() => setOpen(v => !v)}>
        <Settings size={16} />
      </button>
      {open && (
        <div className="orientation-menu">
          <div className="orientation-title">桌面方向</div>
          <button className={mode === "portrait" ? "active" : ""} onClick={() => choose("portrait")}>
            <Smartphone size={15} />竖屏
          </button>
          <button className={mode === "landscape" ? "active" : ""} onClick={() => choose("landscape")}>
            <RotateCcw size={15} />横屏
          </button>
        </div>
      )}
    </div>
  );
}

export default function Dealer({ room, dealing, username }) {
  const [text, setText] = useState(lines.waiting);
  const [image, setImage] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef(null);
  const canChangeImage = username === "莫拉咕" || room?.hostName === username;

  useEffect(() => {
    let alive = true;
    const load = () => {
      storage.getDealerImage().then(url => {
        if (alive) setImage(url || DEFAULT_IMAGE);
      }).catch(() => {
        if (alive) setImage(DEFAULT_IMAGE);
      });
    };
    load();

    // 本机事件：上传后立即刷新
    const handler = () => load();
    window.addEventListener("river-poker-storage", handler);

    let channel = null;
    let events = null;
    if (isLocalBackend) {
      events = new EventSource("/api/events");
      events.addEventListener("change", event => {
        try {
          const payload = JSON.parse(event.data);
          if (payload?.table === "poker_users" && payload?.new?.username === "莫拉咕") load();
        } catch {}
      });
    } else {
      // Supabase Realtime：房主/管理员在另一台设备修改后，所有用户立即同步
      channel = supabase.channel("poker-dealer-image")
        .on("postgres_changes", { event: "UPDATE", schema: "public", table: "poker_users", filter: "username=eq.莫拉咕" }, payload => {
          if (alive) setImage(payload.new?.dealer_image_url || DEFAULT_IMAGE);
        })
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "poker_users", filter: "username=eq.莫拉咕" }, payload => {
          if (alive) setImage(payload.new?.dealer_image_url || DEFAULT_IMAGE);
        })
        .subscribe();
    }

    return () => {
      alive = false;
      window.removeEventListener("river-poker-storage", handler);
      if (events) events.close();
      if (channel) supabase.removeChannel(channel);
    };
  }, []);

  useEffect(() => {
    if (dealing) {
      setText("正在发牌，请稍等……");
      return;
    }
    setText(lines[room?.stage] || lines.waiting);
  }, [room?.stage, dealing, room?.handNumber]);

  const pickImage = async e => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !canChangeImage) return;
    setError("");
    setUploading(true);
    try {
      const data = await compressDealerImage(file);
      await storage.setDealerImage(data);
      setImage(data);
    } catch (err) {
      setError(err.message || "荷官照片上传失败");
    } finally {
      setUploading(false);
    }
  };

  const currentImage = image || DEFAULT_IMAGE;

  return (
    <div className="dealer-box">
      <OrientationSettings />
      <div className={`dealer-avatar ${dealing ? "dealing" : ""}`} style={{ position: "relative" }}>
        <img
          src={currentImage}
          alt="荷官"
          style={{
            width: "88px",
            height: "105px",
            objectFit: "cover",
            objectPosition: "center 25%",
            borderRadius: "48% 48% 38% 38%",
            border: "2px solid #d5b75a",
            boxShadow: "0 4px 14px #0009",
            display: "block",
          }}
        />
        {canChangeImage && (
          <>
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={uploading}
              title="更换荷官照片"
              style={{
                position: "absolute",
                right: "-4px",
                bottom: "-4px",
                width: "28px",
                height: "28px",
                borderRadius: "50%",
                border: "2px solid #17130f",
                background: "#d5b75a",
                color: "#17130f",
                display: "grid",
                placeItems: "center",
                cursor: uploading ? "wait" : "pointer",
                padding: 0,
              }}
            >
              <Camera size={14} />
            </button>
            <input ref={inputRef} type="file" accept="image/*" onChange={pickImage} hidden />
          </>
        )}
      </div>
      <div className="dealer-info">
        <div className="dealer-name"><span className="live-dot"></span> Luna · 荷官</div>
        <div className="dealer-text">{text}</div>
        {canChangeImage && <div style={{ fontSize: "10px", opacity: 0.65, marginTop: "3px" }}>{uploading ? "正在更新照片…" : error || "房主：点击相机更换荷官照片"}</div>}
      </div>
      <div className="dealer-card-stack">
        <div className="mini-card"></div>
        <div className="mini-card"></div>
        <div className="mini-card"></div>
      </div>
    </div>
  );
}
