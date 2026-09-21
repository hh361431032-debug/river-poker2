const SUITS = ["s", "h", "d", "c"];
const SMALL_BLIND = 10, BIG_BLIND = 20, STARTING_CHIPS = 1000, MIN_PLAYERS = 2, MAX_PLAYERS = 8;
const HAND_NAMES = ["高牌", "一对", "两对", "三条", "顺子", "同花", "葫芦", "四条", "同花顺"];
const THROW_ITEMS = { egg: { name: "鸡蛋", emoji: "🥚", cost: 10 }, tomato: { name: "番茄", emoji: "🍅", cost: 15 }, brick: { name: "板砖", emoji: "🧱", cost: 30 } };

function freshDeck(){const d=[];for(const s of SUITS)for(let r=2;r<=14;r++)d.push({r,s});return d;}
function shuffle(deck){const d=[...deck];for(let i=d.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[d[i],d[j]]=[d[j],d[i]];}return d;}
function rankLabel(r){return r===14?"A":r===13?"K":r===12?"Q":r===11?"J":r===10?"10":String(r);}
function simpleHash(str){let h1=0xdeadbeef,h2=0x41c6ce57;for(let i=0;i<str.length;i++){const ch=str.charCodeAt(i);h1=Math.imul(h1^ch,2654435761);h2=Math.imul(h2^ch,1597334677);}h1=Math.imul(h1^(h1>>>16),2246822507)^Math.imul(h2^(h2>>>13),3266489909);h2=Math.imul(h2^(h2>>>16),2246822507)^Math.imul(h1^(h1>>>13),3266489909);return(4294967296*(2097151&h2)+(h1>>>0)).toString(36);}
function genRoomCode(){const c="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";return Array.from({length:5},()=>c[Math.floor(Math.random()*c.length)]).join("");}
function deepClone(o){return JSON.parse(JSON.stringify(o));}
function validateRoomState(room){
  if(!room||typeof room!=="object")return{ok:false,error:"room 不是对象"};
  const players=Array.isArray(room.players)?room.players:[];
  if(players.length<0||players.length>MAX_PLAYERS)return{ok:false,error:"玩家数量非法"};
  const ints=[["pot",room.pot],["currentBet",room.currentBet],["minRaise",room.minRaise],["handNumber",room.handNumber]];
  for(const [name,value] of ints)if(!Number.isInteger(value)||value<0)return{ok:false,error:`${name} 非法`};
  if(room.minRaise<=0)return{ok:false,error:"minRaise 必须大于 0"};
  if(!Array.isArray(room.community)||room.community.length>5)return{ok:false,error:"公共牌数量非法"};
  if(!Array.isArray(room.deck)||room.deck.length>52)return{ok:false,error:"牌堆数量非法"};
  const names=new Set();
  for(const p of players){
    if(!p||typeof p!=="object"||typeof p.name!=="string"||!p.name)return{ok:false,error:"玩家数据非法"};
    if(names.has(p.name))return{ok:false,error:`玩家重名：${p.name}`};
    names.add(p.name);
    for(const [name,value] of [["chips",p.chips],["bet",p.bet],["totalContributed",p.totalContributed]])if(!Number.isInteger(value)||value<0)return{ok:false,error:`${p.name} 的 ${name} 非法`};
    if(p.totalContributed<p.bet)return{ok:false,error:`${p.name} 的累计下注小于当前下注`};
    if(!Array.isArray(p.cards)||p.cards.length>2)return{ok:false,error:`${p.name} 的底牌数量非法`};
    if(p.allIn&&p.chips!==0)return{ok:false,error:`${p.name} 标记 all-in 但仍有筹码`};
  }
  if(room.status==="playing"){
    if(room.players.length<2)return{ok:false,error:"进行中的牌局玩家不足 2 人"};
    if(room.turnIndex!==null&&(!Number.isInteger(room.turnIndex)||room.turnIndex<0||room.turnIndex>=players.length))return{ok:false,error:"turnIndex 非法"};
    if(room.dealerIndex!==null&&(!Number.isInteger(room.dealerIndex)||room.dealerIndex<0||room.dealerIndex>=players.length))return{ok:false,error:"dealerIndex 非法"};
    if(room.stage!=="handover"){
      const betTotal=players.reduce((sum,p)=>sum+p.bet,0);
      if(room.pot!==betTotal)return{ok:false,error:`底池与玩家下注不一致：pot=${room.pot}, bets=${betTotal}`};
      const allBets=players.filter(p=>p.inHand&&!p.folded).map(p=>p.bet);
      if(allBets.length&&room.currentBet!==Math.max(...allBets))return{ok:false,error:"currentBet 与本街最高下注不一致"};
    }
  }else if(room.pot!==0)return{ok:false,error:"非进行中牌局的底池应为 0"};
  const seen=new Set();
  const addCards=(cards,label)=>{for(const c of cards){if(!c||!Number.isInteger(c.r)||c.r<2||c.r>14||!Number.isInteger(c.s)||c.s<0||c.s>3)return`${label} 中存在非法牌`;const key=`${c.r}-${c.s}`;if(seen.has(key))return`发现重复牌：${key}`;seen.add(key);}return null;};
  let error=addCards(room.deck,"牌堆");if(error)return{ok:false,error};
  error=addCards(room.community,"公共牌");if(error)return{ok:false,error};
  for(const p of players){error=addCards(p.cards,`${p.name} 底牌`);if(error)return{ok:false,error};}
  if(seen.size>52)return{ok:false,error:"已知牌数量超过 52 张"};
  return{ok:true};
}
function evaluate5(cards){const ranks=cards.map(c=>c.r).sort((a,b)=>b-a),suits=cards.map(c=>c.s),isFlush=suits.every(s=>s===suits[0]);const counts={};for(const r of ranks)counts[r]=(counts[r]||0)+1;const byCount=Object.entries(counts).map(([r,c])=>[Number(r),c]).sort((a,b)=>(b[1]-a[1])||(b[0]-a[0]));const uniq=[...new Set(ranks)];let straightHigh=null;if(uniq.length===5){if(uniq[0]-uniq[4]===4)straightHigh=uniq[0];else if(uniq.join(",")==="14,5,4,3,2")straightHigh=5;}if(straightHigh&&isFlush)return[8,straightHigh];if(byCount[0][1]===4)return[7,byCount[0][0],byCount[1][0]];if(byCount[0][1]===3&&byCount[1][1]===2)return[6,byCount[0][0],byCount[1][0]];if(isFlush)return[5,...ranks];if(straightHigh)return[4,straightHigh];if(byCount[0][1]===3)return[3,byCount[0][0],...byCount.slice(1).map(x=>x[0])];if(byCount[0][1]===2&&byCount[1][1]===2){const pairs=[byCount[0][0],byCount[1][0]].sort((a,b)=>b-a);return[2,...pairs,byCount[2][0]];}if(byCount[0][1]===2)return[1,byCount[0][0],...byCount.slice(1).map(x=>x[0])];return[0,...ranks];}
function compareScore(a,b){for(let i=0;i<Math.max(a.length,b.length);i++){const av=a[i]??0,bv=b[i]??0;if(av!==bv)return av-bv;}return 0;}
function combinations5(c){const o=[];for(let a=0;a<c.length;a++)for(let b=a+1;b<c.length;b++)for(let d=b+1;d<c.length;d++)for(let e=d+1;e<c.length;e++)for(let f=e+1;f<c.length;f++)o.push([c[a],c[b],c[d],c[e],c[f]]);return o;}
function bestScore(cards){if(cards.length<5)return[-1];let best=null;for(const combo of combinations5(cards)){const s=evaluate5(combo);if(!best||compareScore(s,best)>0)best=s;}return best;}
function nextSeat(room,from,fn){const n=room.players.length;for(let step=1;step<=n;step++){const i=(from+step)%n;if(fn(room.players[i]))return i;}return-1;}
function startHand(room){const r=deepClone(room);r.players=r.players.filter(p=>p.chips>0&&!p.kicked);if(r.players.length<2){r.stage="waiting";r.status="waiting";return r;}r.players.forEach(p=>Object.assign(p,{cards:[],folded:false,allIn:false,bet:0,totalContributed:0,hasActed:false,inHand:true,waitingForNext:false,kicked:false}));r.deck=shuffle(freshDeck());r.community=[];r.pot=0;r.currentBet=0;r.minRaise=BIG_BLIND;r.log=[];r.handNumber=(r.handNumber||0)+1;r.status="playing";r.stage="preflop";r.turnStartedAt=Date.now();r.dealerIndex=r.dealerIndex==null?0:(r.dealerIndex+1)%r.players.length;for(let i=0;i<2;i++)r.players.forEach(p=>p.cards.push(r.deck.pop()));const n=r.players.length;let sb,bb,first;if(n===2){sb=r.dealerIndex;bb=(r.dealerIndex+1)%n;first=sb}else{sb=nextSeat(r,r.dealerIndex,()=>true);bb=nextSeat(r,sb,()=>true);first=nextSeat(r,bb,()=>true)}const blind=(idx,amount)=>{const p=r.players[idx],pay=Math.min(amount,p.chips);p.chips-=pay;p.bet+=pay;p.totalContributed+=pay;if(!p.chips)p.allIn=true;r.pot+=pay};blind(sb,SMALL_BLIND);blind(bb,BIG_BLIND);r.currentBet=BIG_BLIND;r.turnIndex=first;r.turnStartedAt=Date.now();r.log.push(`第 ${r.handNumber} 局开始，庄家：${r.players[r.dealerIndex].name}`);return r;}
function awardSingle(r){const w=r.players.find(p=>p.inHand&&!p.folded);if(w){w.chips+=r.pot;r.log.push(`${w.name} 赢得彩池 ${r.pot} 筹码（其他玩家弃牌）`);}r.pot=0;r.stage="handover";}
function distributePots(r){const contributors=r.players.filter(p=>p.totalContributed>0);const levels=[...new Set(contributors.map(p=>p.totalContributed))].sort((a,b)=>a-b);let prev=0;for(const level of levels){const eligible=contributors.filter(p=>p.totalContributed>=level),amount=(level-prev)*eligible.length;prev=level;if(amount<=0)continue;const contenders=eligible.filter(p=>!p.folded);if(!contenders.length)continue;const scored=contenders.map(p=>({p,score:bestScore([...p.cards,...r.community])})).sort((a,b)=>compareScore(b.score,a.score));const top=scored[0].score,winners=scored.filter(x=>compareScore(x.score,top)===0),share=Math.floor(amount/winners.length);winners.forEach((w,i)=>w.p.chips+=share+(i<amount-share*winners.length?1:0));r.log.push(`${winners.map(w=>w.p.name).join("、")} 以「${HAND_NAMES[top[0]]}」赢得 ${amount} 筹码`);}r.pot=0;r.stage="handover";}
function contestants(r){return r.players.filter(p=>p.inHand&&!p.folded&&!p.allIn);}
function dealCommunity(r,n){r.deck.pop();for(let i=0;i<n;i++)r.community.push(r.deck.pop());}
function resetBets(r){r.players.forEach(p=>{p.bet=0;if(p.inHand&&!p.folded&&!p.allIn)p.hasActed=false;});r.currentBet=0;r.minRaise=BIG_BLIND;}
function advanceStage(r){const remaining=r.players.filter(p=>p.inHand&&!p.folded);if(remaining.length<=1){awardSingle(r);return r;}if(r.stage==="preflop"){resetBets(r);dealCommunity(r,3);r.stage="flop";}else if(r.stage==="flop"){resetBets(r);dealCommunity(r,1);r.stage="turn";}else if(r.stage==="turn"){resetBets(r);dealCommunity(r,1);r.stage="river";}else if(r.stage==="river"){distributePots(r);return r;}if(contestants(r).length<2)return advanceStage(r);r.turnIndex=nextSeat(r,r.dealerIndex,p=>p.inHand&&!p.folded&&!p.allIn);r.turnStartedAt=Date.now();return r;}
function applyAction(room,name,action,amount){const idx=room.players.findIndex(p=>p.name===name);if(idx<0||idx!==room.turnIndex)return room;const src=room.players[idx];if(!src.inHand||src.folded||src.allIn)return room;const r=deepClone(room),p=r.players[idx];if(action==="fold"){p.folded=true;p.hasActed=true;r.log.push(`${p.name} 弃牌`);}else if(action==="check"){if(r.currentBet>p.bet)return room;p.hasActed=true;r.log.push(`${p.name} 过牌`);}else if(action==="call"){const call=Math.min(r.currentBet-p.bet,p.chips);p.chips-=call;p.bet+=call;p.totalContributed+=call;r.pot+=call;if(!p.chips)p.allIn=true;p.hasActed=true;r.log.push(`${p.name} 跟注 ${call}`);}else if(action==="raise"){const maxRaiseTo=p.bet+p.chips,raiseTo=Math.min(Number(amount)||0,maxRaiseTo),delta=raiseTo-p.bet,isAllIn=raiseTo===maxRaiseTo;if(delta<=0||raiseTo<=r.currentBet)return room;const minimumRaiseTo=r.currentBet+r.minRaise;if(raiseTo<minimumRaiseTo&&!isAllIn)return room;p.chips-=delta;p.bet=raiseTo;p.totalContributed+=delta;r.pot+=delta;if(!p.chips)p.allIn=true;const size=raiseTo-r.currentBet;r.currentBet=raiseTo;if(size>=r.minRaise)r.minRaise=size;r.players.forEach((pl,i)=>{if(i!==idx&&pl.inHand&&!pl.folded&&!pl.allIn)pl.hasActed=false;});p.hasActed=true;r.log.push(`${p.name} 加注到 ${raiseTo}`);}else return room;r.log=r.log.slice(-30);const remaining=r.players.filter(pl=>pl.inHand&&!pl.folded);if(remaining.length<=1){awardSingle(r);return r;}const acting=contestants(r),done=acting.length===0||acting.every(pl=>pl.hasActed&&pl.bet===r.currentBet);if(done)return advanceStage(r);r.turnIndex=nextSeat(r,idx,pl=>pl.inHand&&!pl.folded&&!pl.allIn);r.turnStartedAt=Date.now();return r;}
function throwItem(room,fromName,targetName,itemKey){const item=THROW_ITEMS[itemKey];if(!item||room.status!=="playing"||fromName===targetName)return room;const r=deepClone(room),from=r.players.find(p=>p.name===fromName),target=r.players.find(p=>p.name===targetName);if(!from||!target||from.kicked||target.kicked||!Number.isFinite(from.chips)||from.chips<item.cost)return room;from.chips-=item.cost;r.effects=Array.isArray(r.effects)?r.effects.slice(-14):[];r.effects.push({id:`${Date.now()}-${Math.random().toString(36).slice(2,7)}`,from:fromName,to:targetName,item:itemKey,emoji:item.emoji,at:Date.now()});r.log=(r.log||[]).slice(-29);r.log.push(`${fromName} 花 ${item.cost} 筹码向 ${targetName} 丢了${item.name} ${item.emoji}`);return r;}


export { SUITS, SMALL_BLIND, BIG_BLIND, STARTING_CHIPS, MIN_PLAYERS, MAX_PLAYERS, HAND_NAMES, THROW_ITEMS, deepClone, validateRoomState, evaluate5, compareScore, bestScore, nextSeat, startHand, awardSingle, distributePots, contestants, dealCommunity, resetBets, advanceStage, applyAction, throwItem, freshDeck, shuffle, rankLabel };
