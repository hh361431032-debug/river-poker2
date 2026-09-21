import {
  distributePots,
  applyAction,
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
    hasActed: true,
    lastActedBet: contributed,
    inHand: true,
    waitingForNext: false,
    kicked: false,
  };
}

function room(players:any[]) {
  return {
    players,
    community: [
      {r:14,s:"s"},
      {r:13,s:"h"},
      {r:12,s:"d"},
      {r:11,s:"c"},
      {r:2,s:"s"},
    ],
    pot: players.reduce((n,p)=>n+p.totalContributed,0),
    currentBet: Math.max(...players.map(p=>p.bet)),
    minRaise: 20,
    stage: "river",
    status: "playing",
    log: [],
  };
}

Deno.test("side pots: short all-in creates main pot and side pot", () => {
  const r = room([
    player("A",50,0,{cards:[{r:2,s:"h"},{r:3,s:"h"}]}),
    player("B",100,0,{cards:[{r:14,s:"h"},{r:14,s:"d"}]}),
    player("C",100,0,{cards:[{r:4,s:"h"},{r:5,s:"h"}]}),
  ]);
  distributePots(r);
  if (r.pot !== 0) throw new Error("pot was not cleared");
  if (r.players.find((p:any)=>p.name==="B").chips !== 250) throw new Error("B should win main + side pot");
  if (r.players.find((p:any)=>p.name==="A").chips !== 0) throw new Error("short all-in player cannot win side pot");
  if (r.players.find((p:any)=>p.name==="C").chips !== 0) throw new Error("C should lose both pots");
});

Deno.test("folded over-contribution remains in the contestable pot", () => {
  const r = room([
    player("A",100,0,{folded:true,cards:[{r:2,s:"h"},{r:3,s:"h"}]}),
    player("B",50,0,{cards:[{r:14,s:"h"},{r:14,s:"d"}]}),
    player("C",50,0,{cards:[{r:4,s:"h"},{r:5,s:"h"}]}),
  ]);
  distributePots(r);
  const b=r.players.find((p:any)=>p.name==="B");
  const c=r.players.find((p:any)=>p.name==="C");
  if (b.chips+c.chips !== 200) throw new Error("all committed chips must be awarded");
  if (b.chips !== 200) throw new Error("B should receive the dead folded contribution");
  if (c.chips !== 0) throw new Error("C should lose");
});

Deno.test("short all-in does not reopen betting after a full raise", () => {
  const r = {
    players: [
      player("A",20,80,{bet:20,cards:[{r:2,s:"h"},{r:3,s:"h"}]}),
      player("B",20,80,{bet:20,cards:[{r:4,s:"h"},{r:5,s:"h"}]}),
      player("C",20,30,{bet:20,cards:[{r:6,s:"h"},{r:7,s:"h"}]}),
    ],
    community: [],
    pot: 60,
    currentBet: 20,
    minRaise: 20,
    stage: "preflop",
    status: "playing",
    turnIndex: 0,
    turnStartedAt: Date.now(),
    log: [],
  };

  const aRaised=applyAction(r,"A","raise",40);
  const bCalled=applyAction(aRaised,"B","call");
  const cShort=applyAction(bCalled,"C","raise",50);

  if (cShort.turnIndex !== 0) throw new Error("action should return to A");
  try {
    applyAction(cShort,"A","raise",70);
    throw new Error("A was incorrectly allowed to re-raise");
  } catch (e:any) {
    if (e?.message !== "MINIMUM_RAISE") throw e;
  }
});
