import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { applyAction, kickPlayer, leaveRoom, privateView, publicView, startHand, throwItem, validateRoomState } from "./gameEngine.ts";
import { corsHeaders, json } from "./cors.ts";

const supabaseUrl=Deno.env.get("SUPABASE_URL")!;
const serviceKey=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db=createClient(supabaseUrl,serviceKey,{auth:{persistSession:false}});

function token(){return crypto.randomUUID()+crypto.randomUUID();}
function errorMessage(e:any){return e?.message||"操作失败";}
async function sendBroadcast(topic:string,event:string,payload:any){
  const projectUrl=supabaseUrl.replace(/\/$/,"");
  await fetch(`${projectUrl}/realtime/v1/api/broadcast/${encodeURIComponent(topic)}/events/${encodeURIComponent(event)}`,{
    method:"POST",
    headers:{"apikey":serviceKey,"Authorization":`Bearer ${serviceKey}`,"Content-Type":"application/json"},
    body:JSON.stringify(payload),
  });
}
async function broadcastLobby(){await sendBroadcast("poker-lobby-v2","lobby",{at:Date.now()})}
async function broadcast(code:string,state:any,version:number,updatedAt:string){
  // Public room state is emitted by the Postgres AFTER UPDATE trigger.
  // Keep this path only for per-player private state.
  await Promise.all(
    state.players.filter((p:any)=>p.sessionToken).map((p:any)=>
      sendBroadcast(`room:${code}:player:${p.sessionToken}`,"private_state",{
        version,updatedAt,
        state:privateView(state,p.name,p.name==="莫拉咕")
      })
    )
  );
}
function publish(code:string,state:any,version:number,updatedAt:string){
  EdgeRuntime.waitUntil(broadcast(code,state,version,updatedAt).catch(e=>console.error("broadcast failed",e)));
}
function publishLobby(){
  EdgeRuntime.waitUntil(broadcastLobby().catch(e=>console.error("lobby broadcast failed",e)));
}
async function readRoom(code:string){
  const {data,error}=await db.from("poker_rooms").select("code,state,version,updated_at").eq("code",code).maybeSingle();
  if(error)throw error;if(!data)throw new Error("ROOM_NOT_FOUND");return data;
}
async function writeRoom(code:string,state:any,expectedVersion:number,expectedUpdatedAt?:string){
  validateRoomState(state);
  const nextVersion=expectedVersion+1;
  const nextUpdatedAt=new Date(Math.max(Date.now(),(Date.parse(expectedUpdatedAt||"")||0)+1)).toISOString();
  const {data,error}=await db.from("poker_rooms").update({
    name:state.name,host_name:state.hostName,player_count:Array.isArray(state.players)?state.players.length:0,
    status:state.status||"waiting",state,version:nextVersion,updated_at:nextUpdatedAt,
  }).eq("code",code).eq("version",expectedVersion).select("version,updated_at").maybeSingle();
  if(error)throw error;
  if(!data)throw new Error("ROOM_VERSION_CONFLICT");
  return data;
}
function inferLegacyAction(current:any,desired:any,username:string){
  if(desired.players.length>current.players.length)return {action:"join_room"};
  if(desired.players.length<current.players.length){
    const removed=current.players.find((p:any)=>!desired.players.some((q:any)=>q.name===p.name));
    if(removed&&removed.name===username)return {action:"leave"};
    if(removed&&current.hostName===username)return {action:"kick",extra:{targetName:removed.name}};
    return {action:"leave"};
  }
  const me=current.players.find((p:any)=>p.name===username),nextMe=desired.players.find((p:any)=>p.name===username);
  if(!me||!nextMe)throw new Error("PLAYER_NOT_IN_ROOM");
  if((me.avatar||null)!==(nextMe.avatar||null))return {action:"update_avatar",extra:{avatar:nextMe.avatar||null}};
  const kicked=current.players.find((p:any)=>{const q=desired.players.find((x:any)=>x.name===p.name);return q&&q.kicked&&!p.kicked});
  if(kicked&&current.hostName===username)return {action:"kick",extra:{targetName:kicked.name}};
  if(current.stage==="waiting"&&desired.status==="playing")return {action:"start_hand"};
  if(current.stage==="handover"&&desired.stage==="playing"&&Number(desired.handNumber)>Number(current.handNumber))return {action:"next_hand"};
  const oldEffects=current.effects||[],newEffects=desired.effects||[];
  if(newEffects.length>oldEffects.length){const e=newEffects[newEffects.length-1];if(e?.from===username)return {action:"throw",extra:{targetName:e.to,itemKey:e.item}}}
  if(current.status==="playing"&&me.inHand&&!me.folded&&!me.allIn){
    if(nextMe.folded&&!me.folded)return {action:"fold"};
    if(Number(nextMe.bet)===Number(me.bet)&&nextMe.hasActed&&!me.hasActed&&Number(desired.currentBet)===Number(current.currentBet))return {action:"check"};
    if(Number(desired.currentBet)>Number(current.currentBet))return {action:"raise",extra:{amount:desired.currentBet}};
    if(Number(nextMe.bet)>Number(me.bet))return {action:"call"};
  }
  throw new Error("UNSUPPORTED_ROOM_MUTATION");
}
async function uploadDataUrl(dataUrl:string,folder:string,name:string){
  if(!dataUrl||!dataUrl.startsWith("data:image/"))return dataUrl||null;
  const m=dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if(!m)throw new Error("INVALID_IMAGE_DATA");
  const mime=m[1],raw=m[2];
  const binary=Uint8Array.from(atob(raw),ch=>ch.charCodeAt(0));
  if(binary.byteLength>2*1024*1024)throw new Error("IMAGE_TOO_LARGE");
  const ext=(mime.split("/")[1]||"jpeg").replace("jpeg","jpg").replace(/[^a-z0-9]/gi,"").slice(0,8)||"jpg";
  const path=`${folder}/${name}-${crypto.randomUUID()}.${ext}`;
  const {error}=await db.storage.from("poker-assets").upload(path,binary,{contentType:mime,cacheControl:"31536000",upsert:false});
  if(error)throw error;
  return db.storage.from("poker-assets").getPublicUrl(path).data.publicUrl;
}
async function normalizeRoomAvatars(room:any){
  // 旧房间可能还带 Base64 头像，而且部分旧牌局由历史引擎写入了
  // 与当前校验器不同的 pot/currentBet。读取/加入房间不应该因为头像迁移
  // 把这种历史房间直接判死。
  if(room.state.status==="playing")return room;
  const next=structuredClone(room.state);
  let changed=false;
  for(const p of next.players||[]){
    if(typeof p.avatar==="string"&&p.avatar.startsWith("data:image/")){
      p.avatar=await uploadDataUrl(p.avatar,"avatars",String(p.name||"player").replace(/[^a-zA-Z0-9_-]/g,"_").slice(0,24)||"player");
      changed=true;
    }
  }
  if(!changed)return room;
  try{
    const st=await writeRoom(room.code,next,room.version,room.updated_at);
    return {code:room.code,state:next,version:st.version,updated_at:st.updated_at};
  }catch(e){
    if(errorMessage(e)==="INVALID_ROOM_STATE")return room;
    throw e;
  }
}

function repairLegacyState(room:any){
  if(!room?.state||room.state.status!=="playing"||room.state.stage==="handover")return room;
  const next=structuredClone(room.state);
  let changed=false;

  // Older versions could leave pot/currentBet/turnIndex inconsistent with
  // the player records. Repair only derived fields so the current hand can
  // continue instead of every subsequent action failing with INVALID_ROOM_STATE.
  const contributionSum=next.players.reduce((sum:number,p:any)=>sum+(Number(p.totalContributed)||0),0);
  if(next.pot!==contributionSum){next.pot=contributionSum;changed=true;}

  const live=next.players.filter((p:any)=>p.inHand&&!p.folded);
  const maxBet=Math.max(0,...live.map((p:any)=>Number(p.bet)||0));
  if(next.currentBet!==maxBet){next.currentBet=maxBet;changed=true;}

  const turnValid=Number.isInteger(next.turnIndex)
    && next.turnIndex>=0
    && next.turnIndex<next.players.length
    && next.players[next.turnIndex]?.inHand
    && !next.players[next.turnIndex]?.folded
    && !next.players[next.turnIndex]?.allIn;
  if(!turnValid){
    const fallback=next.players.findIndex((p:any)=>p.inHand&&!p.folded&&!p.allIn&&(!p.hasActed||p.bet<next.currentBet));
    const anyLive=next.players.findIndex((p:any)=>p.inHand&&!p.folded&&!p.allIn);
    const replacement=fallback>=0?fallback:anyLive;
    if(replacement>=0){next.turnIndex=replacement;changed=true;}
  }

  if(!changed)return room;
  const st=writeRoom(room.code,next,room.version,room.updated_at);
  return st.then((saved:any)=>({
    code:room.code,state:next,version:saved.version,updated_at:saved.updated_at
  }));
}

function playerFor(room:any,username:string,playerToken:string){
  const p=room.state.players.find((x:any)=>x.name===username);
  if(!p||!playerToken||p.sessionToken!==playerToken)throw new Error("SESSION_INVALID");
  return p;
}
Deno.serve(async(req)=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:corsHeaders});
  const requestStarted=performance.now();
  const timing:any={};
  try{
    const parseStarted=performance.now();
    const body=await req.json();
    timing.parseMs=Math.round((performance.now()-parseStarted)*100)/100;
    const action=body?.action;
    const code=String(body?.roomCode||"").trim().toUpperCase();
    const username=String(body?.username||"").trim();
    const playerToken=String(body?.playerToken||"");
    if(action==="list_rooms"){
      const {data,error}=await db.from("poker_rooms").select("code,name,host_name,player_count,status,version").neq("status","closed").order("updated_at",{ascending:false});
      if(error)throw error;
      return json({success:true,rooms:(data||[]).map(r=>({code:r.code,name:r.name,hostName:r.host_name,playerCount:r.player_count,status:r.status,version:r.version}))});
    }
    if(action==="create_room"){
      if(!username)throw new Error("USERNAME_REQUIRED");
      const roomCode=code||Array.from({length:5},()=> "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random()*32)]).join("");
      const sessionToken=token();
      const chips=Math.max(100,Math.min(100000,Number(body.startingChips)||1000));
      const turnSeconds=Math.max(5,Math.min(300,Number(body.turnSeconds)||30));
      const avatar=await uploadDataUrl(String(body.avatar||""),"avatars",username.replace(/[^a-zA-Z0-9_-]/g,"_").slice(0,24)||"player");
      const room={code:roomCode,name:String(body.name||`${username} 的牌桌`).trim(),hostName:username,status:"waiting",stage:"waiting",startingChips:chips,turnSeconds,players:[{name:username,avatar,chips,cards:[],folded:false,allIn:false,bet:0,totalContributed:0,hasActed:false,inHand:false,waitingForNext:false,kicked:false,sessionToken}],dealerIndex:null,turnIndex:null,turnStartedAt:null,deck:[],community:[],pot:0,currentBet:0,minRaise:20,log:[],handNumber:0};
      const updatedAt=new Date().toISOString();
      const {error}=await db.from("poker_rooms").insert({code:roomCode,name:room.name,host_name:username,player_count:1,status:"waiting",state:room,version:1,updated_at:updatedAt});
      if(error)throw error;
      publish(roomCode,room,1,updatedAt);publishLobby();
      return json({success:true,code:roomCode,playerToken:sessionToken,state:privateView(room,username,username==="莫拉咕"),version:1,updatedAt});
    }
    if(action==="get_room"){
      let room=await readRoom(code);
      room=await normalizeRoomAvatars(room);
      let changed=false;
      let p=room.state.players.find((x:any)=>x.name===username);
      if(p&&!p.sessionToken){p.sessionToken=token();changed=true;}
      if(changed){
        const st=await writeRoom(code,room.state,room.version,room.updated_at);
        room.version=st.version;
        room.updated_at=st.updated_at;
        room.state=room.state;
        publish(code,room.state,room.version,room.updated_at);
      }
      if(!p){
        return json({
          success:true,
          member:false,
          state:publicView(room.state),
          version:room.version,
          updatedAt:room.updated_at,
          playerToken:null
        });
      }
      return json({success:true,member:true,state:privateView(room.state,username,username==="莫拉咕"),version:room.version,updatedAt:room.updated_at,playerToken:p.sessionToken});
    }
    if(!code||!username)throw new Error("ROOM_AND_USERNAME_REQUIRED");
    if(action==="join_room"){
      let room=await readRoom(code);
      room=await normalizeRoomAvatars(room);
      let p=room.state.players.find((x:any)=>x.name===username);
      if(p)return json({success:true,state:privateView(room.state,username,username==="莫拉咕"),version:room.version,updatedAt:room.updated_at,playerToken:p.sessionToken});
      if(room.state.players.length>=8)throw new Error("ROOM_FULL");
      const chips=Number(room.state.startingChips)||1000;
      const avatar=await uploadDataUrl(String(body.avatar||""),"avatars",username.replace(/[^a-zA-Z0-9_-]/g,"_").slice(0,24)||"player");
      p={name:username,avatar,chips,cards:[],folded:false,allIn:false,bet:0,totalContributed:0,hasActed:false,inHand:false,waitingForNext:room.state.status==="playing",kicked:false,sessionToken:token()};
      const next=structuredClone(room.state);next.players.push(p);
      const st=await writeRoom(code,next,room.version,room.updated_at);
      publish(code,next,st.version,st.updated_at);publishLobby();
      return json({success:true,state:privateView(next,username,username==="莫拉咕"),version:st.version,updatedAt:st.updated_at,playerToken:p.sessionToken});
    }
    const readStarted=performance.now();
    let room=await readRoom(code);
    timing.readMs=Math.round((performance.now()-readStarted)*100)/100;
    room=await normalizeRoomAvatars(room);
    room=await repairLegacyState(room);
    if(action==="delete_room"){
      if(username!=="莫拉咕")throw new Error("NOT_ADMIN");
      await db.from("poker_rooms").delete().eq("code",code);publishLobby();
      return json({success:true,deleted:true});
    }
    playerFor(room,username,playerToken);
    if(action==="reconcile"){
      const inferred=inferLegacyAction(room.state,body.desiredState,username);
      if(inferred.action==="join_room"){
        if(room.state.players.length>=8)throw new Error("ROOM_FULL");
        const next=structuredClone(room.state);
        next.players.push({
          name:username,avatar:body.desiredState.players.find((p:any)=>p.name===username)?.avatar||null,
          chips:Number(room.state.startingChips)||1000,cards:[],folded:false,allIn:false,bet:0,totalContributed:0,
          hasActed:false,inHand:false,waitingForNext:room.state.status==="playing",kicked:false,sessionToken:playerToken
        });
        const st=await writeRoom(code,next,room.version,room.updated_at);publish(code,next,st.version,st.updated_at);publishLobby();
        return json({success:true,state:privateView(next,username,username==="莫拉咕"),version:st.version,updatedAt:st.updated_at});
      }
      const reconciled=await (async()=>{
        switch(inferred.action){
          case "start_hand": return startHand(room.state);
          case "next_hand": return startHand(room.state);
          case "fold": return applyAction(room.state,username,"fold");
          case "check": return applyAction(room.state,username,"check");
          case "call": return applyAction(room.state,username,"call");
          case "raise": return applyAction(room.state,username,"raise",inferred.extra.amount);
          case "throw": return throwItem(room.state,username,inferred.extra.targetName,inferred.extra.itemKey);
          case "kick": return kickPlayer(room.state,username,inferred.extra.targetName);
          case "leave": return leaveRoom(room.state,username);
          case "update_avatar":{
            const n=structuredClone(room.state);const p=n.players.find((x:any)=>x.name===username);p.avatar=inferred.extra.avatar;return n;
          }
          default: throw new Error("UNKNOWN_ACTION");
        }
      })();
      if(reconciled===null){await db.from("poker_rooms").delete().eq("code",code);publishLobby();return json({success:true,deleted:true});}
      const st=await writeRoom(code,reconciled,room.version,room.updated_at);publish(code,reconciled,st.version,st.updated_at);publishLobby();
      return json({success:true,state:privateView(reconciled,username,username==="莫拉咕"),version:st.version,updatedAt:st.updated_at});
    }
    let next;
    const engineStarted=performance.now();
    switch(action){
      case "start_hand":
        if(room.state.hostName!==username)throw new Error("NOT_HOST");
        if(room.state.status!=="waiting"||room.state.stage!=="waiting")throw new Error("INVALID_GAME_STATE");
        if(room.state.players.length<2)throw new Error("NOT_ENOUGH_PLAYERS");
        next=startHand(room.state);break;
      case "next_hand":
        if(room.state.hostName!==username)throw new Error("NOT_HOST");
        if(room.state.status!=="playing"||room.state.stage!=="handover")throw new Error("INVALID_GAME_STATE");
        if(room.state.players.length<2)throw new Error("NOT_ENOUGH_PLAYERS");
        next=startHand(room.state);break;
      case "fold":
      case "check":
      case "call":
      case "raise":
        next=applyAction(room.state,username,action,body.amount);break;
      case "throw":
        next=throwItem(room.state,username,String(body.targetName||""),String(body.itemKey||""));break;
      case "kick":
        next=kickPlayer(room.state,username,String(body.targetName||""));break;
      case "leave":
        next=leaveRoom(room.state,username);break;
      case "update_avatar":{
        const nextState=structuredClone(room.state);
        const p=nextState.players.find((x:any)=>x.name===username);
        if(!p)throw new Error("PLAYER_NOT_IN_ROOM");
        p.avatar=await uploadDataUrl(String(body.avatar||""),"avatars",username.replace(/[^a-zA-Z0-9_-]/g,"_").slice(0,24)||"player");
        next=nextState;
        break;
      }
      case "tick":{
        if(room.state.status!=="playing"||!room.state.turnStartedAt) {
          return json({success:true,state:privateView(room.state,username,username==="莫拉咕"),version:room.version,updatedAt:room.updated_at});
        }
        const limit=Number(room.state.turnSeconds||30)*1000;
        if(Date.now()-Number(room.state.turnStartedAt)<limit) {
          return json({success:true,state:privateView(room.state,username,username==="莫拉咕"),version:room.version,updatedAt:room.updated_at});
        }
        const turnPlayer=room.state.players[room.state.turnIndex];
        if(!turnPlayer) return json({success:true,state:privateView(room.state,username,username==="莫拉咕"),version:room.version,updatedAt:room.updated_at});
        next=applyAction(room.state,turnPlayer.name,"fold");
        next.log.push(`${turnPlayer.name} 行动超时，自动弃牌`);
        break;
      }
      default:throw new Error("UNKNOWN_ACTION");
    }
    timing.engineMs=Math.round((performance.now()-engineStarted)*100)/100;
    timing.engineMs=Math.round((performance.now()-engineStarted)*100)/100;
    if(next===null){
      await db.from("poker_rooms").delete().eq("code",code);publishLobby();
      timing.totalMs=Math.round((performance.now()-requestStarted)*100)/100;
      return json({success:true,deleted:true,timing,edgeRegion:Deno.env.get("SB_REGION")||"unknown"});
    }
    const writeStarted=performance.now();
    const st=await writeRoom(code,next,room.version,room.updated_at);
    timing.writeMs=Math.round((performance.now()-writeStarted)*100)/100;
    publish(code,next,st.version,st.updated_at);publishLobby();
    timing.totalMs=Math.round((performance.now()-requestStarted)*100)/100;
    return json({success:true,state:privateView(next,username,username==="莫拉咕"),version:st.version,updatedAt:st.updated_at,timing,edgeRegion:Deno.env.get("SB_REGION")||"unknown"});
  }catch(e){
    timing.totalMs=Math.round((performance.now()-requestStarted)*100)/100;
    const msg=errorMessage(e);
    const map:any={ROOM_NOT_FOUND:404,PLAYER_NOT_IN_ROOM:403,SESSION_INVALID:403,NOT_YOUR_TURN:409,ROOM_VERSION_CONFLICT:409,ROOM_FULL:409,NOT_HOST:403,NOT_ENOUGH_PLAYERS:409,NOT_ADMIN:403,MINIMUM_RAISE:400,REOPEN_REQUIRED:400,INVALID_GAME_STATE:409};
    return json({success:false,error:msg,timing,edgeRegion:Deno.env.get("SB_REGION")||"unknown"},map[msg]||400);
  }
});