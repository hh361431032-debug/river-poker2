const SUITS = ["s", "h", "d", "c"] as const;
const SMALL_BLIND = 10;
const BIG_BLIND = 20;
const HAND_NAMES = ["高牌", "一对", "两对", "三条", "顺子", "同花", "葫芦", "四条", "同花顺"];

export const THROW_ITEMS: Record<string, { name: string; emoji: string; cost: number }> = {
  egg: { name: "鸡蛋", emoji: "🥚", cost: 10 },
  tomato: { name: "番茄", emoji: "🍅", cost: 15 },
  brick: { name: "板砖", emoji: "🧱", cost: 30 },
};

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

function freshDeck() {
  const d: any[] = [];
  for (const s of SUITS) for (let r = 2; r <= 14; r++) d.push({ r, s });
  return d;
}
function shuffle(deck: any[]) {
  const d = [...deck];
  for (let i = d.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}
function compareScore(a: number[], b: number[]) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] ?? 0, bv = b[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}
function evaluate5(cards: any[]) {
  const ranks = cards.map(c => c.r).sort((a,b)=>b-a);
  const suits = cards.map(c => c.s);
  const isFlush = suits.every(s => s === suits[0]);
  const counts: Record<string, number> = {};
  for (const r of ranks) counts[r] = (counts[r] || 0) + 1;
  const byCount = Object.entries(counts).map(([r,c])=>[Number(r),c] as [number,number])
    .sort((a,b)=>(b[1]-a[1])||(b[0]-a[0]));
  const uniq = [...new Set(ranks)];
  let straightHigh: number | null = null;
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0];
    else if (uniq.join(",") === "14,5,4,3,2") straightHigh = 5;
  }
  if (straightHigh && isFlush) return [8, straightHigh];
  if (byCount[0][1] === 4) return [7, byCount[0][0], byCount[1][0]];
  if (byCount[0][1] === 3 && byCount[1][1] === 2) return [6, byCount[0][0], byCount[1][0]];
  if (isFlush) return [5, ...ranks];
  if (straightHigh) return [4, straightHigh];
  if (byCount[0][1] === 3) return [3, byCount[0][0], ...byCount.slice(1).map(x=>x[0])];
  if (byCount[0][1] === 2 && byCount[1][1] === 2) {
    const pairs = [byCount[0][0], byCount[1][0]].sort((a,b)=>b-a);
    return [2, ...pairs, byCount[2][0]];
  }
  if (byCount[0][1] === 2) return [1, byCount[0][0], ...byCount.slice(1).map(x=>x[0])];
  return [0, ...ranks];
}
function combinations5(c: any[]) {
  const o:any[]=[];
  for(let a=0;a<c.length;a++) for(let b=a+1;b<c.length;b++) for(let d=b+1;d<c.length;d++)
    for(let e=d+1;e<c.length;e++) for(let f=e+1;f<c.length;f++) o.push([c[a],c[b],c[d],c[e],c[f]]);
  return o;
}
function bestScore(cards:any[]) {
  if(cards.length<5) return [-1];
  let best:number[]|null=null;
  for(const combo of combinations5(cards)){
    const s=evaluate5(combo);
    if(!best||compareScore(s,best)>0) best=s;
  }
  return best!;
}
function nextSeat(room:any, from:number, fn:(p:any)=>boolean) {
  const n=room.players.length;
  for(let step=1;step<=n;step++){
    const i=(from+step)%n;
    if(fn(room.players[i])) return i;
  }
  return -1;
}
function awardSingle(r:any){
  const w=r.players.find((p:any)=>p.inHand&&!p.folded);
  if(w){w.chips+=r.pot;r.log.push(`${w.name} 赢得彩池 ${r.pot} 筹码（其他玩家弃牌）`);}
  r.pot=0;r.currentBet=0;r.stage="handover";
}
export function buildPots(r:any){
  const contributors=r.players.filter((p:any)=>p.totalContributed>0);
  const levels=[...new Set(contributors.map((p:any)=>p.totalContributed))].sort((a,b)=>a-b);
  let prev=0;
  return levels.map((level:any)=>{
    const layerContributors=contributors.filter((p:any)=>p.totalContributed>=level);
    const amount=(level-prev)*layerContributors.length;
    prev=level;
    return {
      level,
      amount,
      contributors:layerContributors,
      eligible:layerContributors.filter((p:any)=>!p.folded),
    };
  }).filter((pot:any)=>pot.amount>0);
}

function orderWinners(r:any,winners:any[]){
  const n=r.players.length;
  const dealer=Number.isInteger(r.dealerIndex)?r.dealerIndex:-1;
  if(n<=0||dealer<0)return winners;
  return [...winners].sort((a:any,b:any)=>{
    const ai=r.players.indexOf(a.p),bi=r.players.indexOf(b.p);
    const ad=(ai-dealer+n)%n,bd=(bi-dealer+n)%n;
    return ad-bd;
  });
}

function awardPot(r:any,amount:number,winners:any[]){
  if(!winners.length||amount<=0)return;
  const share=Math.floor(amount/winners.length);
  const remainder=amount-share*winners.length;
  const ordered=orderWinners(r,winners);
  ordered.forEach((w:any,i:number)=>{
    w.p.chips+=share+(i<remainder?1:0);
  });
}

function distributePots(r:any){
  const pots=buildPots(r);
  let pending=0;
  let lastWinners:any[]=[];

  // Each contribution layer is a separate contestable pot. Folded players
  // contribute to the amount but are never eligible to win it.
  for(const pot of pots){
    if(!pot.eligible.length){
      // This layer contains only dead money. Keep it attached to the last
      // contestable pot instead of silently deleting committed chips.
      pending+=pot.amount;
      continue;
    }

    if(pending>0&&lastWinners.length){
      awardPot(r,pending,lastWinners);
      pending=0;
    }

    const scored=pot.eligible.map((p:any)=>({
      p,
      score:bestScore([...p.cards,...r.community])
    }));
    const top=scored.reduce((best:any,current:any)=>
      !best||compareScore(current.score,best.score)>0?current:best,null as any).score;
    const winners=scored.filter((x:any)=>compareScore(x.score,top)===0);

    awardPot(r,pot.amount,winners);
    lastWinners=winners;
    r.log.push(
      `${winners.map((w:any)=>w.p.name).join("、")} 以「${HAND_NAMES[top[0]]}」赢得 ${pot.amount} 筹码`
    );
  }

  // Normally there is always at least one contestable pot when this function
  // runs. This fallback protects against malformed/legacy states.
  if(pending>0){
    if(lastWinners.length)awardPot(r,pending,lastWinners);
    else {
      const winner=r.players.find((p:any)=>p.inHand&&!p.folded);
      if(winner){
        winner.chips+=pending;
        r.log.push(`${winner.name} 赢得 ${pending} 筹码（无其他有效竞争者）`);
      }
    }
  }

  r.pot=0;
  r.currentBet=0;
  r.stage="handover";
}
function contestants(r:any){return r.players.filter((p:any)=>p.inHand&&!p.folded&&!p.allIn);}
function dealCommunity(r:any,n:number){r.deck.pop();for(let i=0;i<n;i++)r.community.push(r.deck.pop());}
function resetBets(r:any){
  r.players.forEach((p:any)=>{
    p.bet=0;
    p.lastActedBet=0;
    if(p.inHand&&!p.folded&&!p.allIn)p.hasActed=false;
  });
  r.currentBet=0;r.minRaise=BIG_BLIND;
}
function advanceStage(r:any){
  const remaining=r.players.filter((p:any)=>p.inHand&&!p.folded);
  if(remaining.length<=1){awardSingle(r);return r;}
  if(r.stage==="preflop"){resetBets(r);dealCommunity(r,3);r.stage="flop";}
  else if(r.stage==="flop"){resetBets(r);dealCommunity(r,1);r.stage="turn";}
  else if(r.stage==="turn"){resetBets(r);dealCommunity(r,1);r.stage="river";}
  else if(r.stage==="river"){distributePots(r);return r;}
  if(contestants(r).length<2)return advanceStage(r);
  r.turnIndex=nextSeat(r,r.dealerIndex,(p:any)=>p.inHand&&!p.folded&&!p.allIn);
  r.turnStartedAt=Date.now();
  return r;
}
export function startHand(room:any){
  const r=clone(room);
  r.players=r.players.filter((p:any)=>p.chips>0&&!p.kicked);
  if(r.players.length<2){r.stage="waiting";r.status="waiting";return r;}
  r.players.forEach((p:any)=>Object.assign(p,{cards:[],folded:false,allIn:false,bet:0,totalContributed:0,hasActed:false,lastActedBet:0,inHand:true,waitingForNext:false,kicked:false}));
  r.deck=shuffle(freshDeck());r.community=[];r.pot=0;r.currentBet=0;r.minRaise=BIG_BLIND;
  r.log=[];r.handNumber=(r.handNumber||0)+1;r.status="playing";r.stage="preflop";
  r.turnStartedAt=Date.now();r.dealerIndex=r.dealerIndex==null?0:(r.dealerIndex+1)%r.players.length;
  for(let i=0;i<2;i++)r.players.forEach((p:any)=>p.cards.push(r.deck.pop()));
  const n=r.players.length;let sb:number,bb:number,first:number;
  if(n===2){sb=r.dealerIndex;bb=(r.dealerIndex+1)%n;first=sb;}
  else{sb=nextSeat(r,r.dealerIndex,()=>true);bb=nextSeat(r,sb,()=>true);first=nextSeat(r,bb,()=>true);}
  const blind=(idx:number,amount:number)=>{const p=r.players[idx],pay=Math.min(amount,p.chips);p.chips-=pay;p.bet+=pay;p.totalContributed+=pay;if(!p.chips)p.allIn=true;r.pot+=pay;};
  blind(sb,SMALL_BLIND);blind(bb,BIG_BLIND);r.currentBet=BIG_BLIND;
  r.turnIndex=nextSeat(r,(first+r.players.length-1)%r.players.length,(p:any)=>p.inHand&&!p.folded&&!p.allIn);
  r.turnStartedAt=Date.now();
  r.log.push(`第 ${r.handNumber} 局开始，庄家：${r.players[r.dealerIndex].name}`);
  if(r.turnIndex<0)return advanceStage(r);
  return r;
}
export function applyAction(room:any,name:string,action:string,amount?:number){
  const idx=room.players.findIndex((p:any)=>p.name===name);
  if(idx<0||idx!==room.turnIndex) throw new Error("NOT_YOUR_TURN");
  const src=room.players[idx];
  if(!src.inHand||src.folded||src.allIn) throw new Error("INVALID_PLAYER_STATE");
  const r=clone(room),p=r.players[idx];
  if(action==="fold"){p.folded=true;p.hasActed=true;p.lastActedBet=p.bet;r.log.push(`${p.name} 弃牌`);}
  else if(action==="check"){if(r.currentBet>p.bet)throw new Error("CANNOT_CHECK");p.hasActed=true;p.lastActedBet=p.bet;r.log.push(`${p.name} 过牌`);}
  else if(action==="call"){
    const call=Math.min(r.currentBet-p.bet,p.chips);
    if(call<=0)throw new Error("NOTHING_TO_CALL");
    p.chips-=call;p.bet+=call;p.totalContributed+=call;r.pot+=call;if(!p.chips)p.allIn=true;p.hasActed=true;p.lastActedBet=p.bet;r.log.push(`${p.name} 跟注 ${call}`);
  } else if(action==="raise"){
    const maxRaiseTo=p.bet+p.chips;
    const raiseTo=Math.min(Number(amount)||0,maxRaiseTo),delta=raiseTo-p.bet;
    const isAllIn=raiseTo===maxRaiseTo;
    if(delta<=0||raiseTo<=r.currentBet)throw new Error("INVALID_RAISE");
    if(p.hasActed&&r.currentBet>p.bet)throw new Error("REOPEN_REQUIRED");
    const previousMinRaise=r.minRaise;
    const minimumRaiseTo=r.currentBet+previousMinRaise;
    if(raiseTo<minimumRaiseTo&&!isAllIn)throw new Error("MINIMUM_RAISE");
    p.chips-=delta;p.bet=raiseTo;p.totalContributed+=delta;r.pot+=delta;if(!p.chips)p.allIn=true;
    const size=raiseTo-r.currentBet;r.currentBet=raiseTo;if(size>=previousMinRaise)r.minRaise=size;
    r.players.forEach((pl:any,i:number)=>{
      if(i===idx||!pl.inHand||pl.folded||pl.allIn)return;
      const facedSinceLastAction=r.currentBet-(Number(pl.lastActedBet)||0);
      if(pl.hasActed&&facedSinceLastAction>=previousMinRaise)pl.hasActed=false;
    });
    p.hasActed=true;p.lastActedBet=p.bet;r.log.push(`${p.name} 加注到 ${raiseTo}`);
  } else throw new Error("UNKNOWN_ACTION");
  r.log=r.log.slice(-30);
  const remaining=r.players.filter((pl:any)=>pl.inHand&&!pl.folded);
  if(remaining.length<=1){awardSingle(r);return r;}
  const acting=contestants(r),done=acting.length===0||acting.every((pl:any)=>pl.hasActed&&pl.bet===r.currentBet);
  if(done)return advanceStage(r);
  r.turnIndex=nextSeat(r,idx,(pl:any)=>pl.inHand&&!pl.folded&&!pl.allIn);r.turnStartedAt=Date.now();
  return r;
}
export function throwItem(room:any,fromName:string,targetName:string,itemKey:string){
  const item=THROW_ITEMS[itemKey];
  if(!item||room.status!=="playing"||fromName===targetName)throw new Error("INVALID_THROW");
  const r=clone(room),from=r.players.find((p:any)=>p.name===fromName),target=r.players.find((p:any)=>p.name===targetName);
  if(!from||!target||from.kicked||target.kicked||from.chips<item.cost)throw new Error("INVALID_THROW");
  from.chips-=item.cost;r.effects=Array.isArray(r.effects)?r.effects.slice(-14):[];
  r.effects.push({id:`${Date.now()}-${crypto.randomUUID().slice(0,5)}`,from:fromName,to:targetName,item:itemKey,emoji:item.emoji,at:Date.now()});
  r.log=(r.log||[]).slice(-29);r.log.push(`${fromName} 花 ${item.cost} 筹码向 ${targetName} 丢了${item.name} ${item.emoji}`);
  return r;
}
export function kickPlayer(room:any,hostName:string,targetName:string){
  if(room.hostName!==hostName||hostName===targetName)throw new Error("NOT_HOST");
  const target=room.players.find((x:any)=>x.name===targetName);if(!target)throw new Error("PLAYER_NOT_FOUND");
  if(room.status==="playing"&&target.inHand&&!target.folded){
    const r=target.name===room.players[room.turnIndex]?.name?applyAction(room,targetName,"fold"):clone(room);
    const p=r.players.find((x:any)=>x.name===targetName);
    if(p){p.kicked=true;r.log.push(`${targetName} 被房主踢出，本局按弃牌处理`);}
    return r;
  }
  const r=clone(room);r.players=r.players.filter((x:any)=>x.name!==targetName);return r;
}
export function leaveRoom(room:any,name:string){
  let r=clone(room);
  const leaving=r.players.find((p:any)=>p.name===name);if(!leaving)throw new Error("PLAYER_NOT_IN_ROOM");
  if(r.status==="playing"&&leaving.inHand&&!leaving.folded){
    if(leaving.name===r.players[r.turnIndex]?.name)r=applyAction(r,name,"fold");
    else {const p=r.players.find((x:any)=>x.name===name);p.folded=true;p.hasActed=true;}
  }
  r.players=r.players.filter((p:any)=>p.name!==name);
  if(!r.players.length)return null;
  if(r.hostName===name)r.hostName=r.players[0].name;
  if(r.status==="playing"&&r.players.filter((p:any)=>p.inHand&&!p.folded).length<=1)awardSingle(r);
  return r;
}
export function publicView(room:any,viewer="",admin=false){
  const r=clone(room);
  delete r.deck;
  r.players=r.players.map((p:any)=>{
    const {sessionToken,...safe}=p;
    return {
      ...safe,
      cards:(admin||r.stage==="handover")?p.cards:[],
    };
  });
  return r;
}
export function privateView(room:any,viewer:string,admin=false){
  const r=publicView(room,"",admin);
  if(!admin && r.stage!=="handover"){
    const source=room.players.find((p:any)=>p.name===viewer);
    const target=r.players.find((p:any)=>p.name===viewer);
    if(source&&target)target.cards=source.cards;
  }
  return r;
}
export function validateRoomState(room:any){
  if(!room||!Array.isArray(room.players)||room.players.length>8)throw new Error("INVALID_ROOM_STATE");
  const names=new Set<string>();
  for(const p of room.players){
    if(!p||typeof p.name!=="string"||!p.name.trim()||names.has(p.name))throw new Error("INVALID_ROOM_STATE");
    names.add(p.name);
    for(const k of ["chips","bet","totalContributed"]) if(!Number.isInteger(p[k])||p[k]<0)throw new Error("INVALID_ROOM_STATE");
    if(p.totalContributed<p.bet)throw new Error("INVALID_ROOM_STATE");
    if(p.allIn&&p.chips!==0)throw new Error("INVALID_ROOM_STATE");
    if(!Array.isArray(p.cards)||p.cards.length>2)throw new Error("INVALID_ROOM_STATE");
  }
  for(const k of ["pot","currentBet","minRaise","handNumber"]) if(!Number.isInteger(room[k])||room[k]<0)throw new Error("INVALID_ROOM_STATE");
  if(room.minRaise<=0||!Array.isArray(room.community)||room.community.length>5||!Array.isArray(room.deck)||room.deck.length>52)throw new Error("INVALID_ROOM_STATE");
  if(room.status==="playing"){
    const live=room.players.filter((p:any)=>p.inHand&&!p.folded);
    if(live.length<1||room.turnIndex==null||room.turnIndex<0||room.turnIndex>=room.players.length)throw new Error("INVALID_ROOM_STATE");
    const expectedPot=room.players.reduce((sum:number,p:any)=>sum+p.totalContributed,0);
    if(expectedPot!==room.pot)throw new Error("INVALID_ROOM_STATE");
    const maxBet=Math.max(0,...live.map((p:any)=>p.bet));
    if(room.currentBet!==maxBet)throw new Error("INVALID_ROOM_STATE");
  }
  return true;
}
export function fullView(room:any){return clone(room);}
