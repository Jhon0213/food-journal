/* ============================================================
   饭记 · Supabase 客户端
   不用 SDK，直接打 REST（auth / rest / storage 三个端点）。
   v2 模型：一顿饭是共享实体，每人在下面留一条 meal_review，
            每道菜每人可以单独打分（dish_review）。
   ============================================================ */
window.Cloud = (function () {
  "use strict";

  const CFG_KEY = "fj.cloud.cfg";
  const SES_KEY = "fj.cloud.ses";

  let cfg = null;      // { url, key }
  let ses = null;      // { access_token, refresh_token, expires_at, user }
  let wsId = null;
  const photoPaths = {}; // photoId -> storage_path

  /* ---------- 配置 ---------- */
  function readJSON(k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } }
  function writeJSON(k, v) { localStorage.setItem(k, JSON.stringify(v)); }

  function load() { cfg = readJSON(CFG_KEY); ses = readJSON(SES_KEY); return cfg; }
  function config() { return cfg; }
  function session() { return ses; }
  function userId() { return ses && ses.user ? ses.user.id : null; }
  function workspaceId() { return wsId; }
  function setConfig(url, key) {
    cfg = { url: String(url).trim().replace(/\/+$/, ""), key: String(key).trim() };
    writeJSON(CFG_KEY, cfg);
    return cfg;
  }
  function clear() {
    cfg = null; ses = null; wsId = null;
    localStorage.removeItem(CFG_KEY);
    localStorage.removeItem(SES_KEY);
  }

  /* ---------- 请求 ---------- */
  function base() { return cfg.url; }

  async function call(path, opt) {
    opt = opt || {};
    if (!cfg) throw new Error("还没配置服务器地址");
    const headers = {
      apikey: cfg.key,
      Authorization: "Bearer " + (ses ? ses.access_token : cfg.key)
    };
    Object.assign(headers, opt.headers || {});
    let body = opt.body;
    if (body !== undefined && !opt.raw) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(body);
    }
    const res = await fetch(base() + path, { method: opt.method || "GET", headers, body });
    const txt = await res.text();
    let data = null;
    if (txt) { try { data = JSON.parse(txt); } catch (e) { data = txt; } }
    if (!res.ok) {
      const msg = (data && (data.msg || data.message || data.error_description || data.error || data.hint)) || ("HTTP " + res.status);
      const err = new Error(msg);
      err.status = res.status;
      err.body = data;
      if (res.status === 401) err.needLogin = true;
      throw err;
    }
    return data;
  }

  /* ---------- 登录（邮箱 + 密码） ---------- */
  function applySession(r) {
    if (!r || !r.access_token) throw new Error("登录响应异常");
    ses = {
      access_token: r.access_token,
      refresh_token: r.refresh_token,
      expires_at: r.expires_at,
      user: r.user ? { id: r.user.id, email: r.user.email } : null
    };
    writeJSON(SES_KEY, ses);
    return ses;
  }

  function recoverHash() {
    const h = location.hash || "";
    if (!h || h.indexOf("access_token") < 0) return false;
    const p = new URLSearchParams(h.slice(1));
    const at = p.get("access_token");
    if (!at) return false;
    ses = {
      access_token: at,
      refresh_token: p.get("refresh_token"),
      expires_at: Number(p.get("expires_at")) || 0,
      user: null
    };
    writeJSON(SES_KEY, ses);
    try { history.replaceState(null, "", location.pathname + location.search); } catch (e) {}
    return true;
  }

  async function signUp(email, password) {
    const r = await call("/auth/v1/signup", {
      method: "POST",
      body: { email: String(email).trim(), password: String(password) }
    });
    if (!r || !r.access_token) {
      throw new Error("注册成功，但这个项目还开着「确认邮箱」。去 Supabase 控制台关掉 Authentication → Sign In / Providers → Email → Confirm email。");
    }
    return applySession(r);
  }

  async function signIn(email, password) {
    const r = await call("/auth/v1/token?grant_type=password", {
      method: "POST",
      body: { email: String(email).trim(), password: String(password) }
    });
    return applySession(r);
  }

  async function ensureFresh() {
    if (!ses) { const e = new Error("未登录"); e.needLogin = true; throw e; }
    const now = Math.floor(Date.now() / 1000);
    if (ses.expires_at && ses.expires_at - 120 > now) return ses;
    if (!ses.refresh_token) { ses = null; localStorage.removeItem(SES_KEY); const e = new Error("登录已过期"); e.needLogin = true; throw e; }
    const r = await call("/auth/v1/token?grant_type=refresh_token", {
      method: "POST",
      body: { refresh_token: ses.refresh_token }
    });
    return applySession(r);
  }

  async function fetchUser() {
    const u = await call("/auth/v1/user");
    if (!u || !u.id) throw new Error("拿不到用户信息");
    ses.user = { id: u.id, email: u.email };
    writeJSON(SES_KEY, ses);
    return ses.user;
  }

  async function logout() {
    try { await call("/auth/v1/logout", { method: "POST" }); } catch (e) {}
    ses = null; wsId = null;
    localStorage.removeItem(SES_KEY);
  }

  // 显示名：邮箱 @ 前面那截
  function myName() {
    const email = ses && ses.user ? ses.user.email : "";
    return (email.split("@")[0] || "我").slice(0, 20);
  }

  /* ---------- 空间 ---------- */
  async function currentWorkspace() {
    await ensureFresh();
    if (!ses.user) await fetchUser();
    const rows = await call("/rest/v1/workspace_members?select=workspace_id,role,workspaces(id,name,invite_code)&limit=1");
    if (!rows || !rows.length) { wsId = null; return null; }
    const r = rows[0];
    wsId = r.workspace_id;
    const w = r.workspaces || {};
    return { id: wsId, role: r.role, name: w.name || "我们的饭记", inviteCode: w.invite_code || "" };
  }

  async function createWorkspace(name) {
    await ensureFresh();
    const id = await call("/rest/v1/rpc/create_workspace", {
      method: "POST",
      body: { ws_name: name || "我们的饭记" }
    });
    wsId = typeof id === "string" ? id : null;
    return await currentWorkspace();
  }

  async function joinWorkspace(code) {
    await ensureFresh();
    const r = await call("/rest/v1/rpc/join_workspace", {
      method: "POST",
      body: { code: String(code).trim().toUpperCase() }
    });
    wsId = typeof r === "string" ? r : null;
    return await currentWorkspace();
  }

  /* ---------- 数据 ---------- */
  const MEAL_SELECT =
    "id,restaurant,eaten_on,meal_type,note,created_by,created_at," +
    "dishes(id,name,position,dish_reviews(user_id,reviewer_name,rating,note))," +
    "meal_reviews(user_id,reviewer_name,rating,comment,created_at)," +
    "photos(id,storage_path)";

  function avgOf(list, key) {
    const vals = (list || []).map(x => Number(x[key])).filter(v => v > 0);
    if (!vals.length) return { avg: 0, count: 0 };
    return { avg: vals.reduce((a, b) => a + b, 0) / vals.length, count: vals.length };
  }

  function mapMeal(r) {
    const me = userId();
    const dishes = (r.dishes || [])
      .slice()
      .sort((a, b) => (a.position || 0) - (b.position || 0))
      .map(d => {
        const dr = (d.dish_reviews || []).map(x => ({
          userId: x.user_id, name: x.reviewer_name || "某人", rating: x.rating, note: x.note || ""
        }));
        const s = avgOf(dr, "rating");
        return { id: d.id, name: d.name, reviews: dr, avg: s.avg, count: s.count };
      });

    const reviews = (r.meal_reviews || []).map(x => ({
      userId: x.user_id, name: x.reviewer_name || "某人",
      rating: x.rating, comment: x.comment || "", createdAt: x.created_at
    }));
    const s = avgOf(reviews, "rating");
    const mine = reviews.find(x => x.userId === me) || null;

    return {
      id: r.id,
      restaurant: r.restaurant,
      date: r.eaten_on,
      mealType: r.meal_type,
      note: r.note || "",
      createdBy: r.created_by,
      createdAt: Date.parse(r.created_at) || 0,
      dishes,
      reviews,
      avg: s.avg,
      count: s.count,
      people: reviews.length,
      joined: !!mine,
      myRating: mine && mine.rating ? mine.rating : 0,
      myComment: mine ? mine.comment : "",
      isMine: r.created_by === me,
      photoIds: (r.photos || []).map(p => p.id)
    };
  }

  async function listMeals() {
    await ensureFresh();
    if (!wsId) throw new Error("还没加入空间");
    const rows = await call(
      "/rest/v1/meals?select=" + MEAL_SELECT +
      "&workspace_id=eq." + wsId + "&order=eaten_on.desc,created_at.desc"
    );
    (rows || []).forEach(r => (r.photos || []).forEach(p => { photoPaths[p.id] = p.storage_path; }));
    return (rows || []).map(mapMeal);
  }

  // 建一餐：主记录 + 菜单 + 我作为第一个参与者的评价 + 新照片
  async function createMeal(m, newPhotos) {
    await ensureFresh();
    if (!wsId) throw new Error("还没加入空间");

    await call("/rest/v1/meals", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: {
        id: m.id,
        workspace_id: wsId,
        restaurant: m.restaurant,
        eaten_on: m.date,
        meal_type: m.mealType,
        note: m.note || ""
      }
    });

    if (m.dishes.length) {
      await call("/rest/v1/dishes", {
        method: "POST",
        headers: { Prefer: "return=minimal" },
        body: m.dishes.map((d, i) => ({ meal_id: m.id, name: d.name.trim(), position: i }))
      });
    }

    // 我自己这条评价（点完「记一顿」就等于报名了）
    if (m.myRating) {
      await call("/rest/v1/meal_reviews?on_conflict=meal_id,user_id", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: {
          meal_id: m.id, user_id: userId(), reviewer_name: myName(),
          rating: m.myRating, comment: m.myComment || ""
        }
      });
    }

    await uploadPhotos(m.id, newPhotos);
  }

  // 改一餐：只改店名/日期/菜单/说明，不动别人的评价
  async function updateMeal(m, newPhotos, removedPhotoIds) {
    await ensureFresh();
    await call("/rest/v1/meals?id=eq." + m.id, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: {
        restaurant: m.restaurant,
        eaten_on: m.date,
        meal_type: m.mealType,
        note: m.note || "",
        updated_at: new Date().toISOString()
      }
    });

    // 菜单同步：已有的按 id 更新、缺的插入、多余的删（删菜会连带删掉它的评分）
    const existing = await call("/rest/v1/dishes?select=id&meal_id=eq." + m.id);
    const keepIds = new Set(m.dishes.filter(d => d.id).map(d => d.id));
    for (const row of existing || []) {
      if (!keepIds.has(row.id)) {
        await call("/rest/v1/dishes?id=eq." + row.id, { method: "DELETE", headers: { Prefer: "return=minimal" } });
      }
    }
    for (let i = 0; i < m.dishes.length; i++) {
      const d = m.dishes[i];
      if (d.id) {
        await call("/rest/v1/dishes?id=eq." + d.id, {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: { name: d.name.trim(), position: i }
        });
      }
    }
    const toInsert = m.dishes.filter(d => !d.id);
    if (toInsert.length) {
      // 新菜要拿到 id 才能给人打分，所以这里要回传
      const created = await call("/rest/v1/dishes", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: toInsert.map(d => ({
          meal_id: m.id, name: d.name.trim(),
          position: m.dishes.findIndex(x => x === d)
        }))
      });
      (created || []).forEach(row => {
        const target = toInsert.find(d => d.name.trim() === row.name);
        if (target) target.id = row.id;
      });
    }

    await uploadPhotos(m.id, newPhotos);
    await deletePhotos(removedPhotoIds);
  }

  async function uploadPhotos(mealId, newPhotos) {
    for (const p of newPhotos || []) {
      const path = wsId + "/" + mealId + "/" + p.id + ".jpg";
      await call("/storage/v1/object/meal-photos/" + path, {
        method: "POST",
        raw: true,
        body: p.blob,
        headers: { "Content-Type": "image/jpeg", "x-upsert": "true" }
      });
      await call("/rest/v1/photos", {
        method: "POST",
        headers: { Prefer: "return=minimal" },
        body: { id: p.id, meal_id: mealId, storage_path: path }
      });
      photoPaths[p.id] = path;
    }
  }

  async function deletePhotos(ids) {
    for (const pid of ids || []) {
      const path = photoPaths[pid];
      if (path) {
        try { await call("/storage/v1/object/meal-photos/" + path, { method: "DELETE" }); } catch (e) {}
      }
      try { await call("/rest/v1/photos?id=eq." + pid, { method: "DELETE", headers: { Prefer: "return=minimal" } }); } catch (e) {}
      delete photoPaths[pid];
    }
  }

  // 点「我也吃了」
  async function joinMeal(mealId) {
    await ensureFresh();
    await call("/rest/v1/meal_reviews?on_conflict=meal_id,user_id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: { meal_id: mealId, user_id: userId(), reviewer_name: myName() }
    });
  }

  // 保存我的评分和评论（含每道菜）
  async function saveMyReview(mealId, rating, comment, dishRatings) {
    await ensureFresh();
    await call("/rest/v1/meal_reviews?on_conflict=meal_id,user_id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: {
        meal_id: mealId, user_id: userId(), reviewer_name: myName(),
        rating: rating, comment: comment || "", updated_at: new Date().toISOString()
      }
    });

    const rows = (dishRatings || []).filter(d => d.rating > 0);
    if (rows.length) {
      await call("/rest/v1/dish_reviews?on_conflict=dish_id,user_id", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: rows.map(d => ({
          dish_id: d.dishId, user_id: userId(), reviewer_name: myName(),
          rating: d.rating, note: d.note || ""
        }))
      });
    }
    // 取消打分的菜，把记录删掉
    const clear = (dishRatings || []).filter(d => !d.rating).map(d => d.dishId);
    if (clear.length) {
      await call("/rest/v1/dish_reviews?user_id=eq." + userId() + "&dish_id=in.(" + clear.join(",") + ")", {
        method: "DELETE", headers: { Prefer: "return=minimal" }
      });
    }
  }

  async function deleteMeal(id) {
    await ensureFresh();
    try {
      const rows = await call("/rest/v1/photos?select=id,storage_path&meal_id=eq." + id);
      for (const r of rows || []) {
        try { await call("/storage/v1/object/meal-photos/" + r.storage_path, { method: "DELETE" }); } catch (e) {}
        delete photoPaths[r.id];
      }
    } catch (e) {}
    await call("/rest/v1/meals?id=eq." + id, { method: "DELETE", headers: { Prefer: "return=minimal" } });
  }

  /* ---------- 照片 ---------- */
  const urlCache = new Map();

  async function photoURL(id) {
    const path = photoPaths[id];
    if (!path) return null;
    const hit = urlCache.get(id);
    const now = Date.now();
    if (hit && hit.exp > now) return hit.url;
    const r = await call("/storage/v1/object/sign/meal-photos/" + path, {
      method: "POST",
      body: { expiresIn: 3600 }
    });
    const url = base() + "/storage/v1" + r.signedURL;
    urlCache.set(id, { url, exp: now + 50 * 60 * 1000 });
    return url;
  }

  async function photoBlob(id) {
    const path = photoPaths[id];
    if (!path) return null;
    const r = await call("/storage/v1/object/authenticated/meal-photos/" + path, { raw: true });
    return new Blob([r], { type: "image/jpeg" });
  }

  return {
    load, config, session, userId, workspaceId, setConfig, clear,
    recoverHash, ensureFresh, fetchUser, signUp, signIn, logout, myName,
    currentWorkspace, createWorkspace, joinWorkspace,
    listMeals, createMeal, updateMeal, deleteMeal, joinMeal, saveMyReview,
    photoURL, photoBlob, photoPaths,
    avgOf
  };
})();
