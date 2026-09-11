# 河畔牌局：家庭服务器版

这个分支把原来的 Supabase 数据层替换成了本机 Node.js + SQLite 服务端，同时保留现有 React 游戏界面和牌局逻辑。

## 环境要求

- Node.js 22.13+（推荐当前 LTS）
- Windows / Linux / macOS 均可

Node 22.13+ 已可直接使用 `node:sqlite`，不需要额外安装 SQLite 驱动。

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
