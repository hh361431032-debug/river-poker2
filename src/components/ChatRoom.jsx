import React, { useEffect, useRef, useState } from 'react';
import { Send, MessageCircle, Eye, EyeOff } from 'lucide-react';
import { supabase } from '../services/supabase';

const CHEAT_CODE = '透透透透';
const CHEAT_USER = '莫拉咕';

function cardText(card) {
  if (!card) return '??';
  const rank = card.r === 14 ? 'A' : card.r === 13 ? 'K' : card.r === 12 ? 'Q' : card.r === 11 ? 'J' : String(card.r);
  const suit = { s: '♠', h: '♥', d: '♦', c: '♣' }[card.s] || '';
  return `${rank}${suit}`;
}

function MiniCard({ card, muted = false }) {
  return <span className="god-card" style={{ color: muted ? '#777' : (card?.s === 'h' || card?.s === 'd' ? '#a12f3a' : '#1e1a17') }}>{card ? cardText(card) : '??'}</span>;
}

export default function ChatRoom({ roomCode, username, room }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [cheatOpen, setCheatOpen] = useState(false);
  const messagesRef = useRef(null);
  const bottomRef = useRef(null);

  useEffect(() => {
    let alive = true;
    let channel = null;
    async function loadMessages() {
      const { data, error } = await supabase.from('poker_messages').select('id, username, text, created_at').eq('room_code', roomCode).order('created_at', { ascending: true }).limit(100);
      if (!error && alive) setMessages(data || []);
    }
    loadMessages();
    channel = supabase.channel('poker-chat-' + roomCode).on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'poker_messages', filter: 'room_code=eq.' + roomCode }, (payload) => {
      if (!alive) return;
      setMessages((prev) => prev.some((m) => m.id === payload.new.id) ? prev : [...prev, payload.new].slice(-100));
    }).subscribe();
    return () => { alive = false; if (channel) supabase.removeChannel(channel); };
  }, [roomCode]);

  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
  }, [messages.length]);

  async function send() {
    const text = input.trim();
    if (!text || sending) return;
    if (username === CHEAT_USER && text === CHEAT_CODE) {
      setCheatOpen((v) => !v);
      setInput('');
      return;
    }
    setSending(true);
    try {
      const { error } = await supabase.from('poker_messages').insert({ room_code: roomCode, username, text });
      if (!error) setInput('');
    } finally { setSending(false); }
  }

  function fmt(time) { return new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }

  const canCheat = username === CHEAT_USER;
  const community = room?.community || [];
  const deck = room?.deck || [];
  // 牌桌把未发出的牌留在 deck 中；上帝视角可以直接看到当前街道之后确定的发牌顺序。
  const knownBoard = Array.from({ length: 5 }, (_, i) => community[i] || deck[i - community.length]);

  return (
    <aside className="chat-panel" style={{ position: 'relative' }}>
      {canCheat && cheatOpen && room?.status === 'playing' && (
        <div className="god-view">
          <div className="god-view-head">
            <span className="god-title"><Eye size={14} /> 上帝视角</span>
            <button type="button" onClick={() => setCheatOpen(false)} title="关闭"><EyeOff size={14} /></button>
          </div>
          <div className="god-community">
            <div className="god-section-title">五张公牌</div>
            <div className="god-community-cards">
              {knownBoard.map((card, i) => <MiniCard key={i} card={card} muted={!card} />)}
            </div>
          </div>
          <div className="god-section-title god-players-title">所有玩家底牌</div>
          {(room?.players || []).map((player) => (
            <div className="god-player" key={player.name}>
              <span className={`god-player-name ${player.folded ? 'folded' : ''}`}>{player.name}{player.folded ? '（弃牌）' : ''}</span>
              <span className="god-player-cards">
                {(player.cards || []).map((card, i) => <MiniCard key={i} card={card} />)}
                {(!player.cards || player.cards.length === 0) && <span className="god-none">无底牌</span>}
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="chat-title"><MessageCircle size={17} /><span>房间聊天</span><span>{room?.players?.length || 0} 人</span></div>
      <div className="chat-messages" ref={messagesRef}>
        {messages.length === 0 && <div className="chat-empty">暂时还没有消息，来当第一个说话的人吧。</div>}
        {messages.map((m) => <div className={'chat-message ' + (m.username === username ? 'mine' : '')} key={m.id}><div className="chat-meta"><b>{m.username}</b><span>{fmt(m.created_at)}</span></div><div className="chat-bubble">{m.text}</div></div>)}
        <div ref={bottomRef} />
      </div>
      <div className="chat-input-row">
        <input value={input} maxLength={120} placeholder="说点什么..." onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') send(); }} />
        <button onClick={send} disabled={sending} title="发送"><Send size={17} /></button>
      </div>
    </aside>
  );
}
