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
  // عنوان الوسيط (TryCloudflare) بيتغيّر لمّا السيرفر يعيد التشغيل، والسيرفر بيكتب الجديد بمستودع maliai-relay
  const RELAY_SRC = [
    ["https://api.github.com/repos/alhaikemohmmad-blip/maliai-relay/contents/relay.json", { Accept: "application/vnd.github.raw+json" }],
    ["https://raw.githubusercontent.com/alhaikemohmmad-blip/maliai-relay/main/relay.json", {}]
  ];
  let relayNow = "", lookedAt = 0;
  // رابط فشل منعلّمه «خربان» دقيقتين: ما منرجعله حتى لو الـQR أو نسخة قديمة من relay.json بتقول عليه
  const bad = new Map();
  const isBad = u => bad.has(u) && Date.now() - bad.get(u) < 120000;
  async function relay(hint, force) {
    try { const o = localStorage.getItem("maliai.relay"); if (o) return o; } catch (e) {}   // للتجربة بس
    if (relayNow) return relayNow;
    if (hint && !isBad(hint)) return (relayNow = hint);
    if (!force && Date.now() - lookedAt < 60000) return "";   // GitHub بيسمح بـ٦٠ سؤال بالساعة، فمرّة بالدقيقة بالكثير
    lookedAt = Date.now();
    for (const [u, headers] of RELAY_SRC) {
      try {
        const r = await fetch(u, { headers, cache: "no-store" });
        if (r.ok) { const j = await r.json(); if (j.url && !isBad(j.url)) return (relayNow = j.url); }
      } catch (e) {}
    }
    return "";
  }
  const forgetRelay = () => { if (relayNow) bad.set(relayNow, Date.now()); relayNow = ""; };
  async function post(topic, body, hint) {
    for (let i = 0; i < 2; i++) {
      // المرّة الثانية: المحاسب كبس «ابعت» هلّق، فمنسأل GitHub عن الرابط الجديد فوراً بدل ما نستنّى
      const base = await relay(i ? "" : hint, i > 0);
      if (!base) break;
      try { const r = await fetch(`${base}/${topic}`, { method: "POST", body }); if (r.ok) return; } catch (e) {}
      forgetRelay();
    }
    throw new Error("الوسيط مش واصل");
  }
  // TryCloudflare ما بيدعم الاستماع المباشر (SSE)، فمنسأل الوسيط كل كم ثانية عن الجديد
  function listen(topic, onMsg, hint, every = 3000) {
    let since = Math.floor(Date.now() / 1000), stopped = false, fails = 0;
    (async () => {
      while (!stopped) {
        const base = await relay(hint);
        if (base) {
          try {
            const r = await fetch(`${base}/${topic}/json?poll=1&since=${since}`, { cache: "no-store" });
            if (!r.ok) throw new Error(r.status);
            for (const line of (await r.text()).split("\n")) {
              if (!line.trim()) continue;
              const m = JSON.parse(line);
              if (m.event === "message") { since = m.id; await onMsg(m); }
            }
            fails = 0;
          } catch (e) { if (++fails >= 2) { forgetRelay(); hint = ""; } }
        }
        await new Promise(ok => setTimeout(ok, base ? every : 15000));
      }
    })();
    return () => { stopped = true; };
  }
  return { newSecret, derive, seal, open, relay, post, listen };
})();

// تفريغ Google (كروم وأندرويد) بيرجّع الجملة كلّها من أوّلها مع كل كلمة جديدة («يعطيك» ← «يعطيك العافية»)،
// وبيعيد آخر جملة لمّا يرجع يشتغل بعد السكتة. فمنبني النصّ من جديد مع كل نتيجة، وما منلزّق المكرّر
const MaliSpeech = (() => {
  const clean = s => String(s || "").replace(/\s+/g, " ").trim();
  // نصّ الجلسة من كل نتائجها: نتيجة بتبدأ بالّي قبلها (أو العكس) هي نفس الجملة بس أطول، فمنخلّي الأطول
  function session(results) {
    const segs = [];
    for (let i = 0; i < results.length; i++) {
      const t = clean(results[i][0] && results[i][0].transcript);
      if (!t) continue;
      const last = segs[segs.length - 1];
      if (last !== undefined && (t.startsWith(last) || last.startsWith(t))) segs[segs.length - 1] = t.length >= last.length ? t : last;
      else segs.push(t);
    }
    return segs.join(" ");
  }
  // جلسة جديدة على النصّ المحفوظ بدون تكرار آخره، ولو أوّلها نفس آخر كلمات المحفوظ منشيل التداخل
  function join(done, add) {
    done = clean(done); add = clean(add);
    if (!add) return done;
    if (!done) return add;
    if (done.endsWith(add)) return done;
    const d = done.split(" "), w = add.split(" ");
    for (let k = Math.min(d.length, w.length); k > 0; k--)
      if (d.slice(-k).join(" ") === w.slice(0, k).join(" ")) return clean(done + " " + w.slice(k).join(" "));
    return done + " " + add;
  }
  return { session, join };
})();
