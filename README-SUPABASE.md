# 河畔牌局 — Supabase 版

本版本已改为浏览器直接使用 Supabase：

- 用户、头像、房间、聊天均走 Supabase 数据库
- 荷官图片保存到 `poker_users.dealer_image_url`
- 荷官图片通过 Supabase Realtime 跨设备同步
- 本地 SQLite / `server/index.js` 不再参与业务数据读写

## 部署前

1. 在 Supabase Dashboard → SQL Editor 执行 `supabase/schema.sql`
2. 确认 `poker_users`、`poker_rooms`、`poker_messages` 已开启 Realtime（schema.sql 已包含 publication 配置）
3. 配置环境变量：
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_PUBLISHABLE_KEY`
4. `npm install`
5. `npm run build`
6. 将项目部署到 EdgeOne Pages / Makers 或其他静态托管

本项目已经不需要你家的电脑作为数据库服务器。
