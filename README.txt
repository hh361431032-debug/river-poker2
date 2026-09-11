河畔牌局 v2 - 真正多人联网版

最少操作步骤：
1. 注册 Supabase：https://supabase.com/dashboard
2. 新建一个免费项目，等待数据库准备完成。
3. 打开 SQL Editor → New query，把 supabase/schema.sql 全部复制进去 → Run。
4. 在项目 Connect/API 页面复制 Project URL 和 Publishable key。
5. 把 .env.example 复制一份并改名为 .env.local，然后填入：
   VITE_SUPABASE_URL=你的Project URL
   VITE_SUPABASE_PUBLISHABLE_KEY=你的Publishable key
6. 终端执行：npm install
7. 终端执行：npm run dev

测试多人：
- 你可以用电脑和手机分别打开同一个网址（局域网/部署后更方便）。
- 本地开发服务器只在你的电脑上运行；真正让外网朋友加入，需要下一步部署到 Vercel/Netlify。

注意：这是朋友之间使用的 Beta 联网版，筹码没有真实货币价值。
当前牌局逻辑仍运行在浏览器端，正式公开运营前需要升级为服务端权威判定，防止玩家通过浏览器查看或篡改游戏状态。
