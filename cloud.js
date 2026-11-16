/* ============================================================
   饭记 · Supabase 客户端
   不用 SDK，直接打 REST（auth / rest / storage 三个端点）。
   好处：单文件、无 CDN 依赖、国内加载不受影响。
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

  /* ---------- 登录（邮箱 + 密码，不发邮件、不跳转） ---------- */
  function applySession(r){
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

  // 从 #access_token=... 里把会话捡回来（旧魔法链接用，留着不碍事）
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
    // 项目开了「确认邮箱」时，signup 只返回 user，没有 session
    if (!r || !r.access_token){
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

  async function sendLoginLink(email) {
    const redirect = location.origin + location.pathname;
    await call("/auth/v1/otp", {
      method: "POST",
      body: { email: String(email).trim(), create_user: true, options: { email_redirect_to: redirect } }
    });
  }

  async function logout() {
    try { await call("/auth/v1/logout", { method: "POST" }); } catch (e) {}
    ses = null; wsId = null;
    localStorage.removeItem(SES_KEY);
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
    // 空间 + 成员关系在数据库端原子创建（前端没有直接插入 workspace_members 的权限）
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
  async function listMeals() {
    await ensureFresh();
    if (!wsId) throw new Error("还没加入空间");
    const rows = await call(
      "/rest/v1/meals?select=id,restaurant,eaten_on,meal_type,rating,note,created_at," +
      "dishes(id,name,rating,note,position),photos(id,storage_path)" +
      "&workspace_id=eq." + wsId + "&order=eaten_on.desc,created_at.desc"
    );
    (rows || []).forEach(r => (r.photos || []).forEach(p => { photoPaths[p.id] = p.storage_path; }));
    return (rows || []).map(r => ({
      id: r.id,
      restaurant: r.restaurant,
      date: r.eaten_on,
      mealType: r.meal_type,
      rating: r.rating,
      note: r.note || "",
      createdAt: Date.parse(r.created_at) || 0,
      dishes: (r.dishes || [])
        .slice()
        .sort((a, b) => (a.position || 0) - (b.position || 0))
        .map(d => ({ id: d.id, name: d.name, rating: d.rating, note: d.note || "" })),
      photoIds: (r.photos || []).map(p => p.id)
    }));
  }

  async function saveMeal(m, newPhotos, removedPhotoIds) {
    await ensureFresh();
    if (!wsId) throw new Error("还没加入空间");

    // 1) 主记录：upsert
    await call("/rest/v1/meals?on_conflict=id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: {
        id: m.id,
        workspace_id: wsId,
        restaurant: m.restaurant,
        eaten_on: m.date,
        meal_type: m.mealType,
        rating: m.rating,
        note: m.note || "",
        updated_at: new Date().toISOString()
      }
    });

    // 2) 菜：整体替换
    await call("/rest/v1/dishes?meal_id=eq." + m.id, { method: "DELETE", headers: { Prefer: "return=minimal" } });
    const dishes = (m.dishes || []).filter(d => (d.name || "").trim());
    if (dishes.length) {
      await call("/rest/v1/dishes", {
        method: "POST",
        headers: { Prefer: "return=minimal" },
        body: dishes.map((d, i) => ({
          meal_id: m.id, name: d.name.trim(), rating: d.rating || 4, note: d.note || "", position: i
        }))
      });
    }

    // 3) 新照片：先传存储，再落表
    for (const p of newPhotos) {
      const path = wsId + "/" + m.id + "/" + p.id + ".jpg";
      await call("/storage/v1/object/meal-photos/" + path, {
        method: "POST",
        raw: true,
        body: p.blob,
        headers: { "Content-Type": "image/jpeg", "x-upsert": "true" }
      });
      await call("/rest/v1/photos", {
        method: "POST",
        headers: { Prefer: "return=minimal" },
        body: { id: p.id, meal_id: m.id, storage_path: path }
      });
      photoPaths[p.id] = path;
    }

    // 4) 删掉的照片
    for (const pid of removedPhotoIds || []) {
      const path = photoPaths[pid];
      if (path) {
        try { await call("/storage/v1/object/meal-photos/" + path, { method: "DELETE" }); } catch (e) {}
      }
      try { await call("/rest/v1/photos?id=eq." + pid, { method: "DELETE", headers: { Prefer: "return=minimal" } }); } catch (e) {}
      delete photoPaths[pid];
    }
  }

  async function deleteMeal(id) {
    await ensureFresh();
    // 先删存储对象（表级 cascade 不会动 storage）
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
  const urlCache = new Map(); // photoId -> { url, exp }

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
    load, config, session, workspaceId, setConfig, clear,
    recoverHash, ensureFresh, fetchUser, signUp, signIn, logout,
    currentWorkspace, createWorkspace, joinWorkspace,
    listMeals, saveMeal, deleteMeal,
    photoURL, photoBlob, photoPaths,
    genId: () => crypto.randomUUID()
  };
})();
