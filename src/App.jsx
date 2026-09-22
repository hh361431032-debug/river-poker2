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
  const [room,setRoom]=useState(initialState),[pendingAction,setPendingAction]=useState(null), busy=useRef(false), roomJsonRef=useRef(initialState?JSON.stringify(initialState):""), roomUpdatedAtRef=useRef(null), roomVersionRef=useRef(initialState?.version||0), playerTokenRef=useRef(initialPlayerToken||"");
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
  const load=useCallback(async(payload=null,force=false)=>{
    if(busy.current&&!force)return;
    const incomingVersion=Number(payload?.new?.version||0);
    if(incomingVersion&&incomingVersion<=Number(roomVersionRef.current||0))return;
    try{
      const token=playerTokenRef.current;
      let res;
      if(token)res=await pokerActions.getRoom(code,username,token);
      else res=await pokerActions.joinRoom(code,username,avatar||null);
      if(res?.deleted){onLeaveLobby();return;}
      if(res?.member===false)res=await pokerActions.joinRoom(code,username,avatar||null);
      applyServerResult(res);
    }catch(err){
      console.error("[河畔牌局] 房间加载失败：",err);
      onLeaveLobby();
    }
  },[code,username,avatar,onLeaveLobby,applyServerResult]);
  useEffect(()=>{
    let stopped=false;
    if(!initialState)load();

    if(isLocalBackend){
      const unsubscribe=subscribeLocalEvents(event=>{
        if(stopped)return;
        try{
          const payload=JSON.parse(event.data);
          if(payload?.table==="poker_rooms")load(payload);
        }catch{}
      });
      return()=>{stopped=true;unsubscribe();};
    }

    const realtimeReadyRef={current:false};
    const channel=supabase.channel(`poker-room-${code}`)
      .on("postgres_changes",{event:"*",schema:"public",table:"poker_rooms",filter:`code=eq.${code}`},payload=>load(payload))
      .subscribe(status=>{
        realtimeReadyRef.current=status==="SUBSCRIBED";
        console.info("[河畔牌局] Realtime:",status);
      });
    const fallback=setInterval(()=>{
      if(realtimeReadyRef.current)return;
      load();
    },2500);
    return()=>{stopped=true;clearInterval(fallback);supabase.removeChannel(channel);};
  },[load,code,initialState]);
  const serverAction=useCallback(async(action,extra={})=>{
    if(busy.current)return false;
    busy.current=true;
    setPendingAction(action);
    try{
      const res=await pokerActions[action](code,username,playerTokenRef.current,...Object.values(extra));
      if(res?.deleted){onLeaveLobby();return true;}
      return applyServerResult(res);
    }catch(err){
      console.warn("[河畔牌局] 服务器拒绝操作：",err);
      if(err?.message==="NOT_YOUR_TURN"){
        try{await load(null,true);}catch{}
      }
      return false;
    }finally{busy.current=false;setPendingAction(null);}
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
