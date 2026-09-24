import React, { useCallback, useEffect, useRef, useState } from "react";
import { storage } from "./services/storage";
import { pokerActions } from "./services/gameActions";
import { isLocalBackend } from "./services/backendMode";
import { subscribeLocalEvents } from "./services/localEvents";
import { supabase } from "./services/supabase";
import AuthScreen from "./components/AuthScreen";
import Lobby from "./components/Lobby";
import GameTable, { WaitingRoom } from "./components/PokerTable";

function RoomController({code,username,avatar,initialState=null,initialPlayerToken="",onAvatarChange,onLeaveLobby}){
  const [room,setRoom]=useState(initialState),[pendingAction,setPendingAction]=useState(null),busy=useRef(false);
  const roomJsonRef=useRef(initialState?JSON.stringify(initialState):"");
  const roomUpdatedAtRef=useRef(null);
  const roomVersionRef=useRef(initialState?.version||0);
  const playerTokenRef=useRef(initialPlayerToken||"");
  const retryTimerRef=useRef(null);
  const stoppedRef=useRef(false);

  const applyServerResult=useCallback((res)=>{
    if(!res?.state)return false;
    const json=JSON.stringify(res.state);
    roomJsonRef.current=json;
    roomUpdatedAtRef.current=res.updatedAt||roomUpdatedAtRef.current;
    if(res.version!=null)roomVersionRef.current=res.version;
    if(res.playerToken)playerTokenRef.current=res.playerToken;
    setRoom(res.state);
    return true;
  },[]);

  const scheduleRetry=useCallback(()=>{
    if(stoppedRef.current||retryTimerRef.current)return;
    retryTimerRef.current=setTimeout(()=>{
      retryTimerRef.current=null;
      load(null,true);
    },2000);
  },[]);

  const load=useCallback(async(payload=null,force=false)=>{
    if(stoppedRef.current)return;
    const incomingVersion=Number(payload?.new?.version||0);
    if(incomingVersion&&incomingVersion<=Number(roomVersionRef.current||0))return;
    if(busy.current&&!force)return;

    try{
      const token=playerTokenRef.current;
      const res=token
        ? await pokerActions.getRoom(code,username,token)
        : await pokerActions.joinRoom(code,username,avatar||null);

      if(stoppedRef.current)return;

      // 房间确实被删除，或者服务端明确返回“你已不在房间”时才退出。
      // 普通网络/Realtime/请求失败绝不能把正在对局的玩家踢回大厅。
      if(res?.deleted){
        onLeaveLobby();
        return;
      }
      if(res?.member===false){
        onLeaveLobby();
        return;
      }

      applyServerResult(res);
    }catch(err){
      console.error("[河畔牌局] 房间同步失败，不退出牌桌：",err);
      // 已经有牌桌状态时保留当前画面，后台重试。
      // 这条路径专门防止 Supabase/网络瞬时错误导致 onLeaveLobby()。
      if(roomJsonRef.current)scheduleRetry();
      else if(!stoppedRef.current){
        // 初次进入且还没有任何房间状态，才允许继续重试；
        // 仍然不因为一次请求失败直接回大厅。
        scheduleRetry();
      }
    }
  },[code,username,avatar,onLeaveLobby,applyServerResult,scheduleRetry]);

  useEffect(()=>{
    let stopped=false;
    stoppedRef.current=false;

    if(!initialState)load();

    if(isLocalBackend){
      const unsubscribe=subscribeLocalEvents(event=>{
        if(stopped)return;
        try{
          const payload=JSON.parse(event.data);
          if(payload?.table==="poker_rooms")load(payload);
        }catch{}
      });
      return()=>{
        stopped=true;
        stoppedRef.current=true;
        if(retryTimerRef.current)clearTimeout(retryTimerRef.current);
        retryTimerRef.current=null;
        unsubscribe();
      };
    }

    const realtimeReadyRef={current:false};
    const channel=supabase.channel(`poker-room-${code}`)
      .on("postgres_changes",{event:"*",schema:"public",table:"poker_rooms",filter:`code=eq.${code}`},payload=>load(payload))
      .subscribe(status=>{
        realtimeReadyRef.current=status==="SUBSCRIBED";
        console.info("[河畔牌局] Realtime:",status);
        if(status!=="SUBSCRIBED")scheduleRetry();
      });

    // Realtime 断线后不再依赖“永远等它恢复”。
    // 定期轻量拉取只用于兜底，版本号会阻止重复覆盖。
    const fallback=setInterval(()=>{
      load();
    },5000);

    return()=>{
      stopped=true;
      stoppedRef.current=true;
      clearInterval(fallback);
      if(retryTimerRef.current)clearTimeout(retryTimerRef.current);
      retryTimerRef.current=null;
      supabase.removeChannel(channel);
    };
  },[load,code,initialState,scheduleRetry]);

  const serverAction=useCallback(async(action,extra={})=>{
    if(busy.current)return false;
    busy.current=true;
    setPendingAction(action);
    try{
      const res=await pokerActions[action](code,username,playerTokenRef.current,...Object.values(extra));
      if(res?.deleted){
        onLeaveLobby();
        return true;
      }
      return applyServerResult(res);
    }catch(err){
      console.warn("[河畔牌局] 服务器拒绝操作：",err);
      if(err?.message==="NOT_YOUR_TURN"){
        try{await load(null,true);}catch{}
      }
      return false;
    }finally{
      busy.current=false;
      setPendingAction(null);
    }
  },[code,username,applyServerResult,onLeaveLobby,load]);

  const kick=name=>serverAction("kick",{targetName:name});
  const leave=async()=>{const ok=await serverAction("leave");if(ok)onLeaveLobby();};

  useEffect(()=>{
    if(!room||room.hostName!==username||room.stage==="handover"||room.stage==="waiting"||!room.turnStartedAt||room.turnIndex==null)return;
    let cancelled=false;
    const startedAt=Number(room.turnStartedAt);
    const limit=Math.max(1,Number(room.turnSeconds||30))*1000;
    const checkTimeout=async()=>{
      if(cancelled)return;
      const remaining=startedAt+limit-Date.now();
      if(remaining>0){setTimeout(checkTimeout,Math.min(remaining+50,1000));return;}
      const ok=await serverAction("tick");
      if(!ok&&!cancelled)setTimeout(checkTimeout,500);
    };
    checkTimeout();
    return()=>{cancelled=true;};
  },[room?.turnStartedAt,room?.turnIndex,room?.stage,room?.handNumber,room?.turnSeconds,room?.hostName,username,serverAction]);

  if(!room)return <div className="page loading">加载房间中…</div>;
  if(room.status!=="playing"||room.stage==="waiting")return <WaitingRoom room={room} username={username} pendingAction={pendingAction} onStart={()=>serverAction("startHand")} onLeave={leave} onKick={kick}/>;
  return <GameTable
    pendingAction={pendingAction}
    onThrow={(target,item)=>serverAction("throw",{targetName:target,itemKey:item})}
    room={room}
    username={username}
    avatar={avatar}
    onAvatarChange={async data=>{await onAvatarChange(data);await serverAction("updateAvatar",{avatar:data});}}
    onAction={(action,value)=>serverAction(action,{amount:value})}
    onNextHand={()=>serverAction("nextHand")}
    onLeave={leave}
    onKick={kick}
  />;
}

export default function App(){
  const [username,setUsername]=useState(null),[avatar,setAvatar]=useState(null),[roomCode,setRoomCode]=useState(null),[roomEntry,setRoomEntry]=useState(null),[checking,setChecking]=useState(true);
  useEffect(()=>{(async()=>{
    const res=await storage.get("poker:session");
    if(res?.value){
      setUsername(res.value);
      try{const profile=await storage.getUserProfile(res.value);setAvatar(profile?.avatarUrl||null);}
      catch{setAvatar(null);}
    }
    setChecking(false);
  })();},[]);
  const login=useCallback(async(u,avatarOverride=null)=>{setUsername(u);setAvatar(avatarOverride||null);await storage.set("poker:session",u);},[]);
  const logout=useCallback(async()=>{setUsername(null);setAvatar(null);setRoomCode(null);setRoomEntry(null);await storage.delete("poker:session");},[]);
  const leaveLobby=useCallback(()=>{setRoomCode(null);setRoomEntry(null);},[]);
  const saveAvatar=useCallback(async data=>{await storage.setUserAvatar(username,data);setAvatar(data);},[username]);
  const enterRoom=useCallback((code,state,playerToken)=>{setRoomCode(code);setRoomEntry({state,playerToken});},[]);
  useEffect(()=>{const code=new URLSearchParams(location.search).get("room");if(username&&code){setRoomCode(code.trim().toUpperCase());setRoomEntry(null);}},[username]);
  if(checking)return <div className="page loading">正在进入河畔牌局…</div>;
  return <div className="app">{!username?<AuthScreen onLogin={login}/>:roomCode?<RoomController code={roomCode} username={username} avatar={avatar} initialState={roomEntry?.state||null} initialPlayerToken={roomEntry?.playerToken||""} onAvatarChange={saveAvatar} onLeaveLobby={leaveLobby}/>:<Lobby username={username} avatar={avatar} onAvatarChange={saveAvatar} onEnterRoom={enterRoom} onLogout={logout}/>}</div>;
}
const ADMIN_USERNAME = "莫拉咕";
const ADMIN_PASSWORD = "1234";
