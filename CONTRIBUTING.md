# 共同开发须知

两个人以上改这个项目时，按下面的规则走，能避免 90% 的互相踩踏。

## 一、先明确谁有什么权限

| 东西 | 谁能拿 | 说明 |
|---|---|---|
| 代码仓库 | 所有开发者 | 私有仓库，加 collaborator |
| Supabase `publishable key` | 所有人，随便发 | 本来就写在 `config.js` 里，公开的 |
| Supabase 控制台 | 只给写后端的人 | 组织成员角色选 **Developer**，不要给 Administrator |
| Supabase `sb_secret_` / service_role | **谁都不给** | 它能绕过所有 RLS，等于数据库全权限 |
| Cloudflare 账号 | 一个人主控 | 别人要发布的话，单独给项目权限或 API Token |

> 建表和改表只能改 `schema.sql` 这个文件，改完在 SQL Editor 里整段重跑（脚本是幂等的，可以重复执行）。
> **不要在控制台里手动点着改表结构**，否则代码和数据库会慢慢对不上，谁都说不清线上是什么样。

## 二、环境要分开

- `development`：另建一个 Supabase 免费项目，或在本项目里建一个「dev 测试」空间，随便折腾、随便删
- `production`：就是 <https://fanji-e9w.pages.dev> 用的那个项目，**只有验证过的改动才上**

永远不要在真实数据上做实验。

## 三、日常流程（三个人以内够用）

```bash
git pull                 # 1. 改之前先拉
# ...改代码...
node build.mjs           # 2. 确认能打包
node test.mjs            # 3. 跑一遍本机模式回归
git add -A && git commit -m "改了什么"
git push                 # 4. 推上去
```

- 一次提交只做一件事，commit message 写「改了什么 + 为什么」
- 改到别人正在改的地方，先沟通，别硬合
- 发布前跑一次 `node test-cloud.mjs`（云端模式，用假后端）

## 四、发布（改完怎么上线）

```bash
node build.mjs           # 生成 dist/index.html
```

然后 Cloudflare 后台 → Workers & Pages → **fanji** → **Create deployment** →
把 `dist/index.html` 拖进去 → **Save and deploy**。

发布后刷新 <https://fanji-e9w.pages.dev> 自测一遍：能打开、能登录、能记一条。

## 五、当前的结构隐患

`index.html` 现在把 HTML + CSS + JS 全塞在一个文件里（1200 行）。两个人同时改必然冲突。

建议拆成 `index.html` / `app.js` / `styles.css`，`build.mjs` 负责再把它们内联成单文件部署。要拆的话说一声。

## 六、测试脚本

| 脚本 | 用途 | 会不会碰真数据 |
|---|---|---|
| `test.mjs` | 本机模式全流程 | 不会 |
| `test-cloud.mjs` | 云端模式（假后端） | 不会 |
| `test-real.mjs` | 真后端端到端 | **会建测试账号**，跑完要执行 `cleanup-test.sql` |
| `test-join.mjs` | 两个账号 + 邀请码共享 | **同上** |

## 七、数据结构变更（v2 之后）

一轮饭的评分模型：`meals`（共享） → `meal_reviews`（每人一条） → `dish_reviews`（每人对每道菜）。
平均分一律**读的时候现算**，不要往表里加 `avg` 字段，否则并发写入会打架。

要加字段时按这个顺序：`schema.sql` 加列（带 default）→ 控制台跑一遍 → `cloud.js` 的 select/save 各加一处 → 界面加输入 → `node build.mjs` + 三套测试。