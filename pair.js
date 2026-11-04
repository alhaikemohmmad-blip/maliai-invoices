// ربط تلفون الموظف بكمبيوتره: سرّ عشوائي بينحطّ بالـQR بعد علامة # (فما بيوصل لأيّ سيرفر، ولا GitHub)،
// ومنه بيطلع اسم القناة على الوسيط ومفتاح التشفير. الوسيط بيشوف حروف ملخبطة بس.
const MaliPair = (() => {
  const enc = new TextEncoder(), dec = new TextDecoder();
  const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));
  const newSecret = () => b64u(crypto.getRandomValues(new Uint8Array(24)));
  async function derive(secret) {
    const base = await crypto.subtle.importKey("raw", unb64u(secret), "HKDF", false, ["deriveKey", "deriveBits"]);
    const hkdf = info => ({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode(info) });
    const topic = "mv_" + b64u(await crypto.subtle.deriveBits(hkdf("maliai topic"), base, 192));   // أسماء قنوات ntfy: حروف وأرقام و_-
    const key = await crypto.subtle.deriveKey(hkdf("maliai key"), base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    return { topic, key };
  }
  async function seal(key, obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(obj))));
    const out = new Uint8Array(12 + ct.length);
    out.set(iv); out.set(ct, 12);
    return b64u(out);
  }
  async function open(key, s) {
    const b = unb64u(s);
    return JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: b.slice(0, 12) }, key, b.slice(12))));
  }
  return { newSecret, derive, seal, open };
})();
