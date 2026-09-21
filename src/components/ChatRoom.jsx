import React, { useEffect, useRef, useState } from 'react';
import { Send, MessageCircle, Eye, EyeOff } from 'lucide-react';
import { supabase } from '../services/supabase';
import { pokerActions } from '../services/gameActions';

const CHEAT_CODE = '透透透透';
const CHEAT_USER = '莫拉咕';
const HAND_NAMES = ['高牌', '一对', '两对', '三条', '顺子', '同花', '葫芦', '四条', '同花顺'];

function cardText(card) {
  if (!card) return '??';
  const rank = card.r === 14 ? 'A' : card.r === 13 ? 'K' : card.r === 12 ? 'Q' : card.r === 11 ? 'J' : String(card.r);
  const suit = { s: '♠', h: '♥', d: '♦', c: '♣' }[card.s] || '';
  return `${rank}${suit}`;
}

function evaluate5(cards) {
  const ranks = cards.map(c => c.r).sort((a, b) => b - a);
  const suits = cards.map(c => c.s);
  const isFlush = suits.every(s => s === suits[0]);
  const counts = {};
  for (const r of ranks) counts[r] = (counts[r] || 0) + 1;
  const byCount = Object.entries(counts)
    .map(([r, c]) => [Number(r), c])
    .sort((a, b) => (b[1] - a[1]) || (b[0] - a[0]));
  const uniq = [...new Set(ranks)];
  let straightHigh = null;
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0];
    else if (uniq.join(',') === '14,5,4,3,2') straightHigh = 5;
  }
  if (straightHigh && isFlush) return [8, straightHigh];
  if (byCount[0][1] === 4) return [7, byCount[0][0], byCount[1][0]];
  if (byCount[0][1] === 3 && byCount[1]?.[1] === 2) return [6, byCount[0][0], byCount[1][0]];
  if (isFlush) return [5, ...ranks];
  if (straightHigh) return [4, straightHigh];
  if (byCount[0][1] === 3) return [3, byCount[0][0], ...byCount.slice(1).map(x => x[0])];
  if (byCount[0][1] === 2 && byCount[1]?.[1] === 2) {
    const pairs = [byCount[0][0], byCount[1][0]].sort((a, b) => b - a);
    return [2, ...pairs, byCount[2][0]];
  }
  if (byCount[0][1] === 2) return [1, byCount[0][0], ...byCount.slice(1).map(x => x[0])];
  return [0, ...ranks];
}

function compareScore(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] ?? 0, bv = b[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

function bestScore(cards) {
  if (cards.length < 5) return [-1];
  let best = null;
  for (let a = 0; a < cards.length; a++) {
    for (let b = a + 1; b < cards.length; b++) {
      for (let c = b + 1; c < cards.length; c++) {
        for (let d = c + 1; d < cards.length; d++) {
          for (let e = d + 1; e < cards.length; e++) {
            const score = evaluate5([cards[a], cards[b], cards[c], cards[d], cards[e]]);
            if (!best || compareScore(score, best) > 0) best = score;
          }
        }
      }
    }
  }
  return best || [-1];
}

function handName(cards) {
  const score = bestScore(cards);
  return score[0] >= 0 ? HAND_NAMES[score[0]] : '牌型未形成';
}

function MiniCard({ card, muted = false }) {
  return <span className="god-card" style={{ color: muted ? '#777' : (card?.s === 'h' || card?.s === 'd' ? '#a12f3a' : '#1e1a17') }}>{card ? cardText(card) : '??'}</span>;
}

export default function ChatRoom({ roomCode, username, room }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [cheatOpen, setCheatOpen] = useState(false);
  const [godRoom, setGodRoom] = useState(null);
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
      const next=!cheatOpen;
      setCheatOpen(next);
      setInput('');
      if(next){
        pokerActions.godView(roomCode, username).then(res=>{
          if(res?.state) setGodRoom(res.state);
        }).catch(err=>console.warn('[河畔牌局] 上帝视角刷新失败',err));
      }
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
  const community = godRoom?.community || room?.community || [];
  const futureCommunity = godRoom?.futureCommunity || room?.futureCommunity || [];
  const knownBoard = [...community, ...futureCommunity].slice(0, 5);

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
              {player.cards?.length === 2 && knownBoard.filter(Boolean).length >= 3 && (
                <span className="god-hand-type">最大牌型：{handName([...player.cards, ...knownBoard.filter(Boolean)])}</span>
              )}
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