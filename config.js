/* 饭记 · 部署配置
   这两个值填好之后，朋友打开页面就不用再输服务器地址和 key。
   publishable key 是公开密钥，放在前端代码里是正常用法，安全性由数据库 RLS 保证。
   ⚠️ 绝对不要把 sb_secret_ / service_role 开头的密钥写进这个文件。 */
window.FJ_CONFIG = {
  url: "https://xlzivuxhgokvutyycefm.supabase.co",
  key: "sb_publishable_u-R8Ebr0lC3ocooyOlGMPQ_AAeg43LY"
};
