本次最终修复说明

1. 保留 v6 互动功能：鸡蛋 10、番茄 15、板砖 30。
2. 修复聊天输入时页面被强制向下滚动的问题。
3. Supabase 配置已直接内置到 src/services/supabase.js。
   因此腾讯云从 GitHub 拉取代码构建时，不再需要配置 VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY 环境变量。
4. 直接把本项目内容提交到原 river-poker 仓库即可。

注意：该项目使用的是 Supabase Publishable Key，适用于浏览器端使用；数据库安全仍由 Supabase RLS/权限规则负责。
