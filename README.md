# 饭记 · 我们去哪儿吃

记录「和谁在哪儿吃了什么、哪道菜好吃」。纯前端单页 + Supabase 做后端，朋友之间共用一个空间。

**在线地址：<https://fanji-e9w.pages.dev>**（Cloudflare Pages，国内实测 0.7 秒打开）

**状态：已用真实 Supabase 跑通端到端测试**（注册 → 建空间 → 记一顿带照片 → 刷新持久化 → 第二个账号用邀请码加入并看到同一份数据 → 部署到公网后重跑一遍）。

## 怎么用

直接在手机或电脑浏览器打开 <https://fanji-e9w.pages.dev>。

### 你自己（已经是 owner）

打开网址 → 点「登录」（**不是注册**，账号已经存在）→ 用你注册时的邮箱和密码。
进去后右上角 **⚙** 里能看到空间名和 **8 位邀请码**。

### 朋友

1. 打开 <https://fanji-e9w.pages.dev>
2. 点「登录 / 注册」→ 用**自己的**邮箱注册
3. 填你发给他的 8 位邀请码 → 加入

之后谁记的都立刻出现在对方那里（刷新一下，暂未做实时推送）。

> 邀请码相当于门禁密码，只通过私聊发给朋友，**不要写进代码仓库或公开的地方**。

### 手机上

浏览器打开网址后，用浏览器菜单里的「添加到主屏幕」，之后就像 App 一样从桌面进入。

也可以不联网站，直接用本地单文件版：跑一次 `node build.mjs` 生成 `dist/index.html`，双击就能用（数据存在本机浏览器，登录后才同步到云端）。

## 功能

**一餐多人**是核心设定：一顿饭是共享的，谁都能在下面留自己的评价，显示的是大家的平均分。

- 记一顿：店名、日期、餐次、菜单、照片（发起人顺便留下自己的评分）
- 其他人点「我也吃了」→ 给整体打分 + 评论，还能给每道菜单独打分
- 卡片上显示平均分和人数：`4.3 ★★★★☆ · 3 人`；菜品也显示均分
- 统计：店铺排行按**所有人的投票**算，菜品榜同理，踩雷清单只看均分 ≤ 2.5 的
- 拍照上传，自动压到长边 1280px 再存
- 导出 / 导入 JSON 备份（含照片；别人的评分因权限原因不跟着搬）
- 离线也能看：没网时退回本机数据模式

## 数据模型

```
meals          一顿饭（共享）：店名、日期、餐次、说明、创建者
 └ dishes      菜单：只有名字和顺序
 └ meal_reviews   每人一条：评分 + 评论（这条同时代表「我吃了」）
     └ dish_reviews  每人对每道菜的打分（可空）
 └ photos      照片
```

平均分不存库，读出来时按 `meal_reviews.rating` / `dish_reviews.rating` 现算，这样谁都不用去抢「更新平均分」这件事。

## 架构

```
index.html           界面 + 本机存储 + DB 门面
cloud.js             Supabase REST 客户端（不用 SDK，直接打接口）
config.js            部署配置（项目 URL + publishable key）
schema.sql           建表 + RLS + 函数（已在你的项目上执行）
```

```
界面 → DB 门面 ─┬─ Local  → IndexedDB（本机/离线）
                └─ Cloud  → Supabase REST
                             ├── /auth/v1      邮箱+密码
                             ├── /rest/v1      数据（RLS 按空间隔离）
                             └── /storage/v1   照片（私有桶 + 1 小时签名 URL）
```

## 权限模型

- 每个账号能看到的数据，只有自己加入的空间
- `owner` / `editor` 能建餐、改自己的评价，`viewer` 只读
- 建空间和加入空间都走数据库函数（`create_workspace` / `join_workspace`），前端没有直接写成员表的权限
- 评价只能改自己的：`meal_reviews` / `dish_reviews` 的 update/delete 都限制 `user_id = auth.uid()`
- 给菜打分前必须先在 `meal_reviews` 里有一条报名记录（`is_participant()` 函数校验）
- 照片存在私有桶里，只有空间成员能拿到临时签名链接

## 花费

0 元。Supabase 免费档：数据库 500MB、存储 1GB（压到 ~200KB 一张 ≈ 5000 张照片）、出网 5GB/月。

## 放到网上（有网址，扫码就能用）

代码已经打包成单文件 `dist/index.html`（61KB，`node build.mjs` 生成）。拖动部署即可：

1. 打开 <https://dash.cloudflare.com/sign-up>，邮箱 + 密码注册并验证邮箱（免费）
2. 登录后左侧 **Workers & Pages** → **Create application** → **Pages** → **Upload assets**
3. 项目名填 `fan-ji`（会变成网址的一部分）
4. 把 `dist` 文件夹整个拖进去 → **Deploy**
5. 拿到 `https://fan-ji-xxx.pages.dev`，发给朋友

部署到网上之后：每个人打开网址 → ⚙ → 用**同一个空间的账号登录**（不是注册新账号）→ 就能看到同一份数据。

> 换托管也不用改代码：`config.js` 里是 Supabase 的地址和公开 key，跟托管位置无关。

## 还没做的

- **待办：还没有公网网址**。托管这一步需要注册一个免费账号（Cloudflare Pages，步骤见上）。在你注册之前，把 `dist/index.html` 单个文件微信发给朋友也能用，只是每台设备都要单独存一份。
- 删空间的功能没做（只能去 Supabase 控制台删）
- 朋友之间看不到「谁记的」，只有记录本身

## 测试脚本

- `test.mjs` —— 本机模式回归
- `test-cloud.mjs` —— 假 Supabase 跑界面逻辑
- `test-real.mjs` —— **真后端**端到端（会真的建账号，跑完要用 `cleanup-test.sql` 清）
- `test-join.mjs` —— 两个账号 + 邀请码共享

## 已知遗留

Supabase 项目里有个空的 public 桶 `app`（当初试过用它托管网页，Supabase 把 HTML 降级成 `text/plain` + `nosniff`，走不通）。不影响使用，想清理在 Storage 里删掉即可。
