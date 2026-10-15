# MicroLend DApp 部署交接日志

**日期**：2026-10-15
**项目**：SC6113 Individual Assignment — MicroLend（点对池微贷 DeFi DApp）
**操作人**：M1kan22（GitHub）
**协助**：Claude Code

---

## 1. 项目概况

| 维度 | 内容 |
|---|---|
| 技术栈 | Python Flask 后端 + 原生 HTML/JS 前端 + Solidity 0.8.24 单合约 |
| 后端 | `backend/app.py`（Flask），纯标准库实现 secp256k1 签名恢复 + Keccak-256（`auth.py` / `keccak.py`），raw JSON-RPC 访问链（`chain.py`，无 web3.py），SQLite 存储（`db.py`） |
| 前端 | `frontend/index.html` + `frontend/js/`（config / api / app / wallet / contract / demo / ui） |
| 合约 | `contracts/MicroLendPool.sol`（单合约、无外部 import、checked arithmetic、custom errors） |
| 测试 | 13 个 Solidity 测试套件 + Flask pytest + 前端 .mjs 测试 |
| 部署目标 | GitHub（公开仓库）→ Render（后端 Web Service + 前端 Static Site） |

## 2. 本次完成的工作（时间线）

1. **本地 Git 初始化**：`git init -b main`，暂存 87 个文件（`.gitignore` 已正确排除 `.env`、`*.db`、`node_modules` 等敏感/生成文件）。
2. **安装 GitHub CLI**：`winget install --id GitHub.cli`（v2.102.0）。
3. **登录认证**：`gh auth login --web`（device flow，浏览器授权），登录为 `M1kan22`。
4. **配置 Git 身份**：`user.name = M1kan22`，`user.email = 325190946+M1kan22@users.noreply.github.com`（GitHub 隐私 noreply 邮箱，避免暴露真实邮箱）。
5. **首次提交**：commit `f3002ca`。
6. **创建公开仓库并推送**：`gh repo create microlend-dapp --public --source . --remote origin --push` → https://github.com/M1kan22/microlend-dapp
7. **后端部署**：Render Web Service → https://microlend-dapp.onrender.com
8. **前端改造**：修改 `frontend/js/config.js`（commit `08d8afc`），指向后端绝对地址。
9. **前端部署**：Render Static Site → https://microlend-dapp-1.onrender.com

## 3. 部署架构

采用**双服务架构**（前后端分离，因为 Flask 本身不托管静态前端页面）：

```
浏览器 ──► 前端 Static Site (microlend-dapp-1.onrender.com)
                 │  fetch() + CORS
                 ▼
           后端 Web Service (microlend-dapp.onrender.com/api)
                 │
                 ├─ CHAIN_MODE=mock（离线模拟，不依赖外部 RPC）
                 └─ SQLite（临时磁盘，AUTO_SEED 自动灌演示数据）
```

## 4. 关键技术决策

| 决策 | 理由 |
|---|---|
| 后端用 `CHAIN_MODE=mock` | 演示无需外部 Infura RPC 和真实测试币，开箱即用、最稳 |
| 双服务而非单服务 | Flask 不托管前端，改造 Flask 会侵入已测试通过的 `app.py`，风险大于收益 |
| 前端 `apiBase` 写死为后端绝对地址 | 前端默认 `/api` 是相对路径，跨域时无法命中后端 |
| 前端用原生 JS、后端用纯标准库加密 | 与作业要求一致，依赖面小，部署轻量 |

## 5. 遇到的问题与解决方案（实验报告重点）

这是本实验最有价值的部分——三个「必须踩的坑」：

### 坑 1：Flask 默认只监听 127.0.0.1，外部访问不到

- **现象**：后端 `app.run()` 的 `host` 默认 `127.0.0.1`，容器外无法访问。
- **解决**：Render 环境变量设 `HOST=0.0.0.0`（代码 `os.environ.get("HOST", "127.0.0.1")` 支持覆盖）。

### 坑 2：健康检查路径默认 `/` 会 404

- **现象**：后端只有 `/api/*` 路由，没有根路由 `/`。Render 默认健康检查打 `/` → 404 → 被判定不健康。
- **解决**：Render 里把 **Health Check Path 改为 `/api/health`**。

### 坑 3：后端返回的相对 `apiBase` 会覆盖前端的绝对地址

- **现象**：后端 `/api/config` 返回 `"apiBase":"/api"`（相对路径），前端 `applyRemote()` 会用这个相对值**覆盖**配置好的绝对地址，导致跨域请求又变回相对路径 → 404。
- **解决**：两处修改（commit `08d8afc`）：
  1. `config.js` 的 `DEFAULTS.apiBase` 从 `'/api'` 改为 `'https://microlend-dapp.onrender.com/api'`；
  2. 在 `applyRemote()` 增加防护：当后端返回相对路径、而本地已是绝对地址时，保留绝对地址不降级。

### 附带说明

- **npm 漏洞警告（38 个）**：来自根 `package.json` 的 `ganache@7` 等 devDependencies，仅本地编译测试合约用，前端静态站点零依赖，线上无风险，可忽略。
- **SQLite 数据易失**：Render 免费版磁盘临时，重启会清库，但 `AUTO_SEED=true` 启动时自动重灌演示数据（7 笔贷款、10 条事件、13 条交易）。
- **Flask 开发服务器**：用内置 `app.run(threaded=True)`，Render 会提示 warning，演示规模足够。

## 6. 验证结果（全部通过）

| 检查项 | 结果 |
|---|---|
| 后端 `/api/health` | ✅ `status: ok`，mock 模式，自动 seed 成功 |
| 后端 `/api/loans` | ✅ HTTP 200 |
| CORS 预检 | ✅ `access-control-allow-origin` 正确反射来源，跨域放行 |
| 前端首页 | ✅ HTTP 200，标题 `MicroLend — peer-to-pool micro-lending on Sepolia` |
| 部署版 `config.js` 的 `apiBase` | ✅ 已指向后端绝对地址 |
| 前端关键资源（config / app / css） | ✅ 全部 200 |

## 7. 最终交付清单

| 项 | 地址 |
|---|---|
| GitHub 仓库 | https://github.com/M1kan22/microlend-dapp |
| 前端入口 | https://microlend-dapp-1.onrender.com |
| 后端 API | https://microlend-dapp.onrender.com/api |

## 8. Render 完整配置（备份用）

### 后端 Web Service

| 字段 | 值 |
|---|---|
| Environment | Python 3 |
| Build Command | `pip install -r backend/requirements.txt` |
| Start Command | `python backend/app.py` |
| Health Check Path | `/api/health` |
| 环境变量 | `HOST=0.0.0.0`、`FLASK_SECRET_KEY=<随机串>`、`CHAIN_MODE=mock` |

### 前端 Static Site

| 字段 | 值 |
|---|---|
| Root Directory | `frontend`（或留空） |
| Build Command | 留空 |
| Publish Directory | `frontend` |

## 9. 关键命令记录

```bash
git init -b main
git config --global user.name "M1kan22"
git config --global user.email "325190946+M1kan22@users.noreply.github.com"
winget install --id GitHub.cli
gh auth login --hostname github.com --git-protocol https --web
gh repo create microlend-dapp --public --source . --remote origin --push
git push origin main   # 后续更新代码只需这一条，两个服务自动重部署
```
