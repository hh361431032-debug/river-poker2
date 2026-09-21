import React, { useState } from "react";
import { storage } from "../services/storage";
import { STARTING_CHIPS, simpleHash } from "../game/gameEngine";

const ADMIN_USERNAME = "莫拉咕";
const ADMIN_PASSWORD = "1234";

function AuthScreen({onLogin}){const [mode,setMode]=useState("login"),[username,setUsername]=useState(""),[password,setPassword]=useState(""),[error,setError]=useState(""),[busy,setBusy]=useState(false);const submit=async()=>{setError("");const u=username.trim();if(u.length<2||u.length>16)return setError("用户名需要 2–16 位");if(password.length<4)return setError("密码至少 4 位");setBusy(true);try{const users={};if(mode==="register"){const existing=await storage.getUser(u);if(existing||u===ADMIN_USERNAME){setError("用户名已被占用");setBusy(false);return;}users[u]={passwordHash:simpleHash(password),chips:STARTING_CHIPS,avatarUrl:null};await storage.set("poker:users",JSON.stringify(users));onLogin(u);}else{if(u===ADMIN_USERNAME&&password===ADMIN_PASSWORD){
        try{const profile=await storage.getUserProfile(u);onLogin(u,profile?.avatarUrl||null);}catch{onLogin(u);}
      }else{const user=await storage.getUser(u);if(!user||user.passwordHash!==simpleHash(password)){setError("用户名或密码不正确");setBusy(false);return;}onLogin(u,user.avatarUrl||null);}}}catch(err){console.error("[河畔牌局] 登录失败",err);setError(err?.message?`登录失败：${err.message}`:"登录失败，请检查网络后重试");}setBusy(false);};return <div className="auth-wrap"><form className="auth-card" onSubmit={e=>{e.preventDefault();if(!busy)submit();}}><div className="brand"><span>♠</span><h1>河畔牌局</h1></div><p>虚拟筹码德州扑克 · 2–8 人同桌</p><div className="tabs"><button className={mode==="login"?"active":""} onClick={()=>setMode("login")}>登录</button><button className={mode==="register"?"active":""} onClick={()=>setMode("register")}>注册</button></div><input placeholder="用户名" value={username} maxLength={16} onChange={e=>setUsername(e.target.value)}/><input placeholder="密码" type="password" value={password} onChange={e=>setPassword(e.target.value)} onKeyDown={e=>e.key==="Enter"&&submit()}/>{error&&<div className="error">{error}</div>}<button type="submit" className="primary full" disabled={busy}>{busy?"处理中…":mode==="login"?"登录":"注册并登录"}</button><small>大屁桃子把把赢。</small></form></div>;}

export default AuthScreen;
