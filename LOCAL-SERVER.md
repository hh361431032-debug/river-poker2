# 河畔牌局：家庭服务器版

这个家庭服务器模式使用本机 Node.js + SQLite，同时复用现有 React 游戏界面和 Supabase 版本的牌局引擎。在线部署仍可继续使用原来的 Supabase 后端；两种模式由 `VITE_BACKEND_MODE` 控制，本地服务器在 8787 端口会自动选择 SQLite。

## 环境要求

- Node.js 22.18+（推荐 Node 24/当前 LTS）
- Windows / Linux / macOS 均可

Node 22.18+ 已可直接使用 `node:sqlite`，并且可以直接运行本项目复用的 TypeScript 牌局引擎，不需要额外安装 SQLite 驱动或 TypeScript 运行器。

## 启动

第一次运行：

```bash
npm install
npm run local
```

`npm run local` 会先构建前端，再启动本地服务器。

服务器默认监听：

```text
http://localhost:8787
```

服务器绑定 IPv6 `::`，因此在你的家庭公网 IPv6 环境中可以直接提供网页服务。

## 数据库

数据库文件自动创建在：

```text
data/river-poker.sqlite
```

SQLite 开启 WAL 模式。`data/*.sqlite*` 已加入 `.gitignore`，不会提交到 GitHub。

## 开发模式

如果要边改边看：

终端 1：

```bash
npm run server
```

终端 2：

```bash
npm run dev
```

Vite 已配置 `/api` 代理到 `8787`。

## 公网部署

当前阶段建议先直接用公网 IPv6 测试：

```text
http://[你的公网IPv6]:8787
```

确认稳定后，再给 `gnlimys.asia` 配置 AAAA，并进一步加 HTTPS/Nginx。
