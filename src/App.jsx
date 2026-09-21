import React, { useCallback, useEffect, useRef, useState } from "react";
import { storage } from "./services/storage";
import { pokerActions } from "./services/gameActions";
import { supabase } from "./services/supabase";
import AuthScreen from "./components/AuthScreen";
import Lobby from "./components/Lobby";
import GameTable from "./components/PokerTable";

function RoomController({code,username,avatar,initialState=null,initialPlayerToken="",onAvatarChange,onLeaveLobby}){
  const [room,setRoom]=useState(initialState), busy=useRef(false), roomJsonRef=useRef(""), roomUpdatedAtRef=useRef(initialState?JSON.stringify(initialState):""), roomUpdatedAtRef=useRef(null), playerTokenRef=useRef(initialPlayerToken||"");
  const applyServerResult=useCallback((res)=>{
    if(!res?.state)return false;
    const json=JSON.stringify(res.state);
    roomJsonRef.current=json;
    roomUpdatedAtRef.current=res.updatedAt||roomUpdatedAtRef.current;
    if(res.playerToken)playerTokenRef.current=res.playerToken;
    setRoom(res.state);
    return true;
  },[]);
  const load=useCallback(async()=>{
    if(busy.current)return;
    try{
      const res=await pokerActions.joinRoom(code,username,avatar||null);
      if(res?.deleted){onLeaveLobby();return;}
      applyServerResult(res);
    }catch(err){
      console.error("[河畔牌局] 房间加载失败：",err);
      onLeaveLobby();
    }
  },[code,username,avatar,onLeaveLobby,applyServerResult]);
  useEffect(()=>{
    if(!initialState)load();
    const channel=supabase.channel(`poker-room-${code}`).on("postgres_changes",{event:"*",schema:"public",table:"poker_rooms",filter:`code=eq.${code}`},load).subscribe();
    const fallback=setInterval(load,5000);
    return()=>{clearInterval(fallback);supabase.removeChannel(channel);};
  },[load,code,initialState]);
  const serverAction=useCallback(async(action,extra={})=>{
    if(busy.current)return false;
    busy.current=true;
    try{
      const res=await pokerActions[action](code,username,playerTokenRef.current,...Object.values(extra));
      if(res?.deleted){onLeaveLobby();return true;}
      return applyServerResult(res);
    }catch(err){
      console.warn("[河畔牌局] 服务器拒绝操作：",err);
      await load();
      return false;
    }finally{busy.current=false;}
  },[code,username,load,applyServerResult,onLeaveLobby]);
  const kick=name=>serverAction("kick",{targetName:name});
  const leave=async()=>{await serverAction("leave");onLeaveLobby();};
  useEffect(()=>{
    if(!room||room.hostName!==username||room.stage==="handover"||room.stage==="waiting"||!room.turnStartedAt||room.turnIndex==null)return;
    const startedAt=room.turnStartedAt,turnIndex=room.turnIndex,stage=room.stage,handNumber=room.handNumber,ms=(room.turnSeconds||30)*1000-(Date.now()-startedAt);
    const expire=()=>serverAction("fold");
    if(ms<=0){const t=setTimeout(expire,100);return()=>clearTimeout(t);}
    const t=setTimeout(expire,ms+100);
    return()=>clearTimeout(t);
  },[room?.turnStartedAt,room?.turnIndex,room?.stage,room?.handNumber,room?.turnSeconds,room?.hostName,username,serverAction]);
  if(!room)return <div className="page loading">加载房间中…</div>;
  if(room.status!=="playing"||room.stage==="waiting")return <WaitingRoom room={room} username={username} onStart={()=>serverAction("startHand")} onLeave={leave} onKick={kick}/>;
  return <GameTable
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

export default function App(){const [username,setUsername]=useState(null),[avatar,setAvatar]=useState(null),[roomCode,setRoomCode]=useState(null),[roomEntry,setRoomEntry]=useState(null),[checking,setChecking]=useState(true);useEffect(()=>{(async()=>{const res=await storage.get("poker:session");if(res?.value){setUsername(res.value);try{const profile=await storage.getUserProfile(res.value);setAvatar(profile?.avatarUrl||null);}catch{setAvatar(null);}}setChecking(false);})();},[]);const login=async (u,avatarOverride=null)=>{setUsername(u);try{const profile=await storage.getUserProfile(u);setAvatar(avatarOverride || profile?.avatarUrl || null);}catch{setAvatar(avatarOverride || null);}await storage.set("poker:session",u);};const logout=async()=>{setUsername(null);setAvatar(null);setRoomCode(null);setRoomEntry(null);await storage.delete("poker:session");};useEffect(()=>{const code=new URLSearchParams(location.search).get("room");if(username&&code){setRoomCode(code.trim().toUpperCase());setRoomEntry(null);}},[username]);if(checking)return <div className="page loading">正在进入河畔牌局…</div>;const saveAvatar=async data=>{await storage.setUserAvatar(username,data);setAvatar(data);};return <div className="app">{!username?<AuthScreen onLogin={login}/>:roomCode?<RoomController code={roomCode} username={username} avatar={avatar} initialState={roomEntry?.state||null} initialPlayerToken={roomEntry?.playerToken||""} onAvatarChange={saveAvatar} onLeaveLobby={()=>{setRoomCode(null);setRoomEntry(null);}}/>:<Lobby username={username} avatar={avatar} onAvatarChange={saveAvatar} onEnterRoom={(code,state,playerToken)=>{setRoomCode(code);setRoomEntry({state,playerToken});}} onLogout={logout}/>}</div>;}
const ADMIN_USERNAME = "莫拉咕";
const ADMIN_PASSWORD = "1234";
