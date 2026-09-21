import {
  applyAction,
  buildPots,
  distributePots,
  startHand,
} from "./gameEngine.ts";

function player(name:string, contributed:number, chips:number, extra:any={}) {
  return {
    name,
    chips,
    cards: extra.cards || [],
    folded: !!extra.folded,
    allIn: chips === 0,
    bet: extra.bet ?? 0,
    totalContributed: contributed,
    hasActed: extra.hasActed ?? true,
    lastActedBet: extra.lastActedBet ?? (extra.bet ?? 0),
    inHand: true,
    waitingForNext: false,
    kicked: false,
  };
}

function room(players:any[], extra:any={}) {
  return {
    players,
    community: extra.community || [
      {r:14,s:"s"},
      {r:13,s:"h"},
      {r:12,s:"d"},
      {r:11,s:"c"},
      {r:2,s:"s"},
    ],
    pot: players.reduce((n,p)=>n+p.totalContributed,0),
    currentBet: Math.max(0,...players.map(p=>p.bet)),
    minRaise: 20,
    dealerIndex: extra.dealerIndex ?? 0,
    stage: "river",
    status: "playing",
    turnIndex: extra.turnIndex ?? 0,
    turnStartedAt: Date.now(),
    log: [],
  };
}

function chipsTotal(r:any) {
  return r.players.reduce((n:number,p:any)=>n+p.chips,0)+r.pot;
}

function assertThrows(fn:()=>unknown,message:string) {
  try {
    fn();
  } catch (e:any) {
    if (e?.message !== message) throw e;
    return;
  }
  throw new Error(`expected ${message}`);
}

Deno.test("pot ledger: builds main pot and one side pot from unequal all-ins", () => {
  const r=room([
    player("A",50,0),
    player("B",100,0),
    player("C",100,0),
  ]);
  const pots=buildPots(r);
  if (pots.length!==2) throw new Error("expected 2 pots");
  if (pots[0].amount!==150||pots[0].eligible.length!==3) throw new Error("main pot is wrong");
  if (pots[1].amount!==100||pots[1].eligible.length!==2) throw new Error("side pot is wrong");
});

Deno.test("side pots: short all-in wins only the main pot", () => {
  const r=room([
    player("A",50,0,{cards:[{r:14,s:"h"},{r:14,d:"d"}]}),
    player("B",100,0,{cards:[{r:2,s:"h"},{r:3,s:"h"}]}),
    player("C",100,0,{cards:[{r:4,s:"h"},{r:5,s:"h"}]}),
  ]);
  const before=chipsTotal(r);
  distributePots(r);
  if (r.players.find((p:any)=>p.name==="A").chips !== 150) throw new Error("A should win main pot only");
  if (r.players.find((p:any)=>p.name==="B").chips !== 0) throw new Error("B should lose both pots");
  if (r.players.find((p:any)=>p.name==="C").chips !== 100) throw new Error("C should win the side pot");
  if (chipsTotal(r)!==before) throw new Error("chips were created or destroyed");
  if (r.pot!==0||r.stage!=="handover") throw new Error("hand was not settled");
});

Deno.test("multiple side pots: each layer is limited to players who reached it", () => {
  const r=room([
    player("A",50,0,{cards:[{r:2,s:"h"},{r:3,s:"h"}]}),
    player("B",100,0,{cards:[{r:14,s:"h"},{r:14,d:"d"}]}),
    player("C",150,0,{cards:[{r:13,s:"h"},{r:12,d:"d"}]}),
    player("D",150,0,{cards:[{r:11,s:"h"},{r:10,d:"d"}]}),
  ]);
  const before=chipsTotal(r);
  const pots=buildPots(r);
  if (pots.map((p:any)=>p.amount).join(",")!=="200,100,100") throw new Error("multi-pot amounts are wrong");
  distributePots(r);
  const stacks=Object.fromEntries(r.players.map((p:any)=>[p.name,p.chips]));
  if (stacks.B!==300) throw new Error("B should win main pot plus first side pot");
  if (stacks.C!==100) throw new Error("C should win the deepest side pot");
  if (stacks.A!==0||stacks.D!==0) throw new Error("unexpected side-pot winner");
  if (chipsTotal(r)!==before) throw new Error("chips were created or destroyed");
});

Deno.test("folded contribution stays in the pot but folded player cannot win", () => {
  const r=room([
    player("A",100,0,{folded:true,cards:[{r:14,s:"h"},{r:14,d:"d"}]}),
    player("B",100,0,{cards:[{r:2,s:"h"},{r:3,s:"h"}]}),
    player("C",100,0,{cards:[{r:4,s:"h"},{r:5,s:"h"}]}),
  ]);
  const before=chipsTotal(r);
  distributePots(r);
  if (r.players.find((p:any)=>p.name==="B").chips !== 300) throw new Error("B should receive the full contestable pot");
  if (r.players.find((p:any)=>p.name==="A").chips !== 0) throw new Error("folded player must not win");
  if (chipsTotal(r)!==before) throw new Error("folded contribution disappeared");
});

Deno.test("odd chip goes to the first tied player clockwise from the button", () => {
  const r=room([
    player("A",50,0,{cards:[{r:2,s:"h"},{r:3,s:"d"}]}),
    player("B",50,0,{cards:[{r:4,s:"h"},{r:5,s:"d"}]}),
    player("C",1,0,{folded:true}),
  ],{dealerIndex:2});
  distributePots(r);
  const a=r.players.find((p:any)=>p.name==="A");
  const b=r.players.find((p:any)=>p.name==="B");
  if (a.chips!==50||b.chips!==51) throw new Error("odd chip was not assigned clockwise from the button");
});

Deno.test("short all-in does not reopen betting after a full raise", () => {
  const r={
    players:[
      player("A",20,80,{bet:20}),
      player("B",20,80,{bet:20}),
      player("C",20,30,{bet:20}),
    ],
    community:[],
    pot:60,
    currentBet:20,
    minRaise:20,
    dealerIndex:0,
    stage:"preflop",
    status:"playing",
    turnIndex:0,
    turnStartedAt:Date.now(),
    log:[],
  };
  const aRaised=applyAction(r,"A","raise",40);
  const bCalled=applyAction(aRaised,"B","call");
  const cShort=applyAction(bCalled,"C","raise",50);

  if (cShort.turnIndex!==0) throw new Error("action should return to A");
  if (cShort.players[0].hasActed) throw new Error("A should be forced to respond to the new bet");
  assertThrows(()=>applyAction(cShort,"A","raise",70),"MINIMUM_RAISE");
});

Deno.test("multiple short all-ins cumulatively reopen betting", () => {
  const r={
    players:[
      player("A",40,60,{bet:40}),
      player("B",40,10,{bet:40}),
      player("C",50,10,{bet:50}),
      player("D",60,0,{bet:60}),
    ],
    community:[],
    pot:190,
    currentBet:40,
    minRaise:20,
    dealerIndex:0,
    stage:"preflop",
    status:"playing",
    turnIndex:0,
    turnStartedAt:Date.now(),
    log:[],
  };
  const b=applyAction(r,"A","raise",40);
  const c=applyAction(b,"B","raise",50);
  const d=applyAction(c,"C","raise",60);
  if (d.turnIndex!==0) throw new Error("action should return to A");
  if (!d.players[0].hasActed) throw new Error("cumulative short all-ins should reopen A");
  const reopened=applyAction(d,"A","raise",80);
  if (reopened.currentBet!==80) throw new Error("A should be able to make the full minimum raise");
});

Deno.test("raise below the minimum is rejected unless it is an all-in", () => {
  const r={
    players:[
      player("A",20,100,{bet:20}),
      player("B",20,100,{bet:20}),
    ],
    community:[],
    pot:40,
    currentBet:20,
    minRaise:20,
    dealerIndex:0,
    stage:"preflop",
    status:"playing",
    turnIndex:0,
    turnStartedAt:Date.now(),
    log:[],
  };
  assertThrows(()=>applyAction(r,"A","raise",30),"MINIMUM_RAISE");
  const allIn=applyAction(r,"A","raise",30);
  if (allIn.currentBet!==30||!allIn.players[0].allIn) {
    // The fixture deliberately gives A 100 chips, so 30 is not all-in.
    throw new Error("fixture unexpectedly treated a non-all-in as legal");
  }
});

Deno.test("all-in blind hand auto-runs out when nobody can act", () => {
  const r={
    code:"TEST",
    name:"test",
    hostName:"A",
    status:"waiting",
    stage:"waiting",
    startingChips:10,
    turnSeconds:30,
    players:[
      player("A",0,10,{bet:0}),
      player("B",0,10,{bet:0}),
    ],
    dealerIndex:0,
    turnIndex:null,
    turnStartedAt:null,
    deck:[],
    community:[],
    pot:0,
    currentBet:0,
    minRaise:20,
    log:[],
    handNumber:0,
  };
  const started=startHand(r);
  if (started.stage!=="handover"||started.pot!==0) throw new Error("all-in blind hand did not run out");
  if (started.community.length!==5) throw new Error("runout did not deal all five board cards");
  if (started.players.reduce((n:number,p:any)=>n+p.chips,0)!==20) throw new Error("chip total changed");
});

Deno.test("folding to one live player awards the whole pot", () => {
  const r={
    players:[
      player("A",20,80,{bet:20}),
      player("B",20,80,{bet:20}),
    ],
    community:[],
    pot:40,
    currentBet:20,
    minRaise:20,
    dealerIndex:0,
    stage:"preflop",
    status:"playing",
    turnIndex:0,
    turnStartedAt:Date.now(),
    log:[],
  };
  const next=applyAction(r,"A","fold");
  if (next.stage!=="handover"||next.pot!==0) throw new Error("fold did not settle the hand");
  if (next.players.find((p:any)=>p.name==="B").chips!==120) throw new Error("surviving player did not receive the pot");
});

Deno.test("showdown payout preserves the total chip count", () => {
  const r=room([
    player("A",50,50,{cards:[{r:14,s:"h"},{r:14,d:"d"}]}),
    player("B",50,50,{cards:[{r:2,s:"h"},{r:3,s:"h"}]}),
  ]);
  const before=chipsTotal(r);
  distributePots(r);
  if (chipsTotal(r)!==before) throw new Error("showdown broke chip conservation");
});
