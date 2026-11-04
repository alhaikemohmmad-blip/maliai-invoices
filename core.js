// MaliAI — المحرّك المشترك بين إضافة إكسل وإضافة وورد:
// الإعدادات والصرف، قراءة الملفات، المحادثة مع Claude، الخزنة (ذاكرة + مسودات)، الصوت، والحكي من التلفون.
// كل صفحة بتعرّف MALI (التعليمات، الأدوات، اسم البرنامج…) وبتنادي maliStart() بالآخر.
const PROVIDERS = {
  gemini:     { label: "Google Gemini (سريع، مفتاح مجاني من aistudio.google.com)", url: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-flash-latest" },
  anthropic:  { label: "Anthropic Claude Sonnet 5.5 (مفتاح من console.anthropic.com)", url: "https://api.anthropic.com", model: "claude-sonnet-5-5" },
  openrouter: { label: "OpenRouter", url: "https://openrouter.ai/api/v1", model: "google/gemini-2.5-flash" },
  custom:     { label: "مخصّص (صيغة OpenAI)", url: "", model: "" }
};
const CFG_KEY = "maliai.invoices.cfg";
const MAX_SIDE = 1600;    // أكبر ضلع للصورة المرسلة: أصغر = أسرع رفع
const MAX_PAGES = 3;      // ponytail: أوّل 3 صفحات من كل PDF/TIFF، زيدها إذا في فواتير أطول
const MAX_TEXT = 60000;   // ponytail: أوّل 60 ألف حرف من الملفات النصّيّة (Excel/Word/XML)
const PARALLEL = 4;       // فواتير بنفس الوقت، نزّلها إذا المزوّد بيرجّع 429
const MAX_FILES = 5;      // حدّ إجباري: ٥ ملفات بالمرّة بتبويب الفواتير وبالرسالة الوحدة بالمساعد (بكل الطرق: زرّ، سحب، لصق)

// قرّاء الصيغ الثانية بينحمّلوا بس لمّا ييجي ملف بيحتاجهم
const LIBS = {
  xlsx:    "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js",
  mammoth: "https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js",
  heic:    "https://cdnjs.cloudflare.com/ajax/libs/heic2any/0.0.4/heic2any.min.js",
  utif:    "https://cdn.jsdelivr.net/npm/utif@3.1.0/UTIF.js",
  jszip:   "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js",
  qr:      "https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js",
  // كاشف الكلام (Silero VAD): بيعرف وين بتبلّش وبتخلّص كل جملة
  ort:     "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/ort.wasm.min.js",
  vad:     "https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.31/dist/bundle.min.js"
};
const VAD_ASSETS = "https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.31/dist/";
const ORT_ASSETS = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/";
const ANTHROPIC_SDK = "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.131.0/+esm";

const SYSTEM = `You are a senior chartered accountant in Jordan with audit experience.
You read every invoice the way an accountant books it: carefully, never guessing, and you flag anything an auditor would question.
You know the Jordanian General Sales Tax: the standard rate is 16%; some goods and services are 0%, exempt, or at special rates; a valid tax invoice shows the seller's tax number.`;

const $ = id => document.getElementById(id);
let inHost = false;   // جوّا إكسل/وورد (حسب MALI.host)
// ---------- الإعدادات (على الجهاز فقط) ----------
// النموذج ثابت عشان ميزانية الشهر تكفي: Sonnet 5.5 لكل الشغل، وOpus 5.5 بس لفاتورة أرقامها ما طابقت حتى بعد قراءتين
const CLAUDE = "claude-sonnet-5-5", CLAUDE_STRONG = "claude-opus-5-5";
const DEFAULT_BUDGET = 50;   // ponytail: ٢٠٠$ بالشهر ÷ ٤ موظفين؛ الحدّ اللي بيجمع كل الأجهزة بينحطّ من console.anthropic.com ← Limits
const readCfg = () => {
  let c = {};
  try { c = JSON.parse(localStorage.getItem(CFG_KEY)) || {}; } catch (e) {}
  if (c.provider === "anthropic") c.model = CLAUDE;   // حتى لو محفوظ نموذج ثاني من نسخة قديمة
  if (!(c.budget > 0)) c.budget = DEFAULT_BUDGET;
  return c;
};
const lockModel = p => { $("model").disabled = p === "anthropic"; if (p === "anthropic") $("model").value = (typeof MALI !== "undefined" && MALI.model) || CLAUDE; };
function fillCfg() {
  const c = readCfg(), p = c.provider || "gemini";
  $("prov").innerHTML = Object.entries(PROVIDERS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join("");
  $("prov").value = p;
  $("url").value = c.url || PROVIDERS[p].url;
  $("model").value = c.model || PROVIDERS[p].model;
  lockModel(p);
  $("key").value = c.key || "";
  $("budget").value = c.budget || "";
  renderSpend();
  if (!c.key) $("settings").open = true;
}

// ---------- الصرف: كلفة كل طلب لـ Anthropic بالدولار، ومجموع الشهر على هالجهاز ----------
// ponytail: أسعار Anthropic لكل مليون توكن (تشرين أوّل ٢٠٢٦): [أوّل اسم النموذج، إدخال، إخراج، قراءة من الكاش]؛ حدّثها إذا تغيّرت
const PRICES = [
  ["claude-fable-5-1", 10, 50, 0.25], ["claude-mythos-5-1", 10, 50, 0.25], ["claude-fable-5", 10, 50, 1], ["claude-mythos-5", 10, 50, 1],
  ["claude-opus-5-5", 4, 20, 0.20], ["claude-opus", 5, 25, 0.50],
  ["claude-sonnet-5", 2, 10, 0.20], ["claude-sonnet", 3, 15, 0.30],
  ["claude-haiku-5", 0.10, 0.50, 0.01], ["claude-haiku", 1, 5, 0.10]
];
// كتابة الكاش: ١.٢٥ من سعر الإدخال لمدّة ٥ دقايق، و٢ لمدّة ساعة
function costOf(model, u) {
  const [, inp, out, read] = PRICES.find(([k]) => String(model || "").startsWith(k)) || PRICES[4];
  const one = x => {
    const w1h = (x.cache_creation && x.cache_creation.ephemeral_1h_input_tokens) || 0;
    const w5m = Math.max(0, (x.cache_creation_input_tokens || 0) - w1h);
    return ((x.input_tokens || 0) * inp + (x.output_tokens || 0) * out + (x.cache_read_input_tokens || 0) * read + w5m * inp * 1.25 + w1h * inp * 2) / 1e6;
  };
  const searches = (u.server_tool_use && u.server_tool_use.web_search_requests) || 0;   // البحث بالنت: ١٠$ لكل ألف بحثة
  // مع التلخيص: الأرقام فوق ما بتشمل نداء التلخيص، فمنجمع كل iterations
  const its = Array.isArray(u.iterations) && u.iterations.length ? u.iterations : [u];
  return its.reduce((s, x) => s + one(x), 0) + searches * 0.01;
}
const SPEND_KEY = "maliai.spend";
const thisMonth = () => new Date().toISOString().slice(0, 7);
function readSpend() {
  try { const s = JSON.parse(localStorage.getItem(SPEND_KEY)); if (s && s.month === thisMonth()) return s; } catch (e) {}
  return { month: thisMonth(), usd: 0, requests: 0 };
}
function addSpend(model, u) {
  const cost = costOf(model, u || {}), s = readSpend();
  s.usd += cost; s.requests++;
  try { localStorage.setItem(SPEND_KEY, JSON.stringify(s)); } catch (e) {}
  renderSpend();
  return cost;
}
const usd = n => n > 0 && n < 0.01 ? "أقلّ من $0.01" : "$" + n.toFixed(2);
function renderSpend() {
  const s = readSpend(), b = readCfg().budget;
  $("spendNow").textContent = `صرفت هالشهر ${usd(s.usd)} على ${s.requests} طلب` + (b ? ` من حدّ ${usd(b)}` : "") +
    ". هاد حساب الإضافة على هالجهاز، والرقم الرسمي بـ console.anthropic.com ← Usage.";
}
// قبل أيّ طلب: إذا المحاسب حاطط حدّ ووصله، منوقف هون بدل ما يتفاجأ إنّ الرصيد خلص
function overBudget() {
  const b = readCfg().budget, s = readSpend();
  return b && s.usd >= b ? `وصلت حدّ الصرف اللي حطّيته لهالشهر (${usd(s.usd)} من ${usd(b)}). إذا بدّك تكمّل، زيد الحدّ من الإعدادات.` : "";
}
const budgetNote = () => { const b = readCfg().budget, s = readSpend(); return b && s.usd >= b * 0.8 ? ` · ⚠️ قرّبت من حدّ الصرف (${usd(s.usd)} من ${usd(b)})` : ""; };
const NO_CREDIT = "خلص رصيد Anthropic، فما قدرت أكمّل. اشحن من console.anthropic.com ← Billing (وإذا بدّك ما يوقف فجأة مرّة ثانية فعّل Auto reload من نفس الصفحة)، وبعدها اكتبلي «كمّل» وبكمّل من مكان ما وقفت.";
const creditOut = e => /credit balance|purchase credits|billing/i.test(String(e && e.message || e));
$("prov").onchange = () => {
  const p = PROVIDERS[$("prov").value];
  if (p.url) { $("url").value = p.url; $("model").value = p.model; }
  lockModel($("prov").value);
};
$("save").onclick = () => {
  const b = parseFloat($("budget").value);
  const c = { provider: $("prov").value, url: $("url").value.trim(), model: $("model").value.trim(), key: $("key").value.trim(),
    budget: b > 0 ? b : DEFAULT_BUDGET };
  try { localStorage.setItem(CFG_KEY, JSON.stringify(c)); setStatus("انحفظت الإعدادات."); } catch (e) { setStatus("ما قدرت أحفظ الإعدادات بهالجهاز."); }
  renderSpend();
  if (c.key) $("settings").open = false;
};

// ---------- أيّ ملف ← صور JPEG صغيرة أو نصّ ----------
const loaded = {};
const lib = name => loaded[name] || (loaded[name] = new Promise((ok, bad) => {
  const s = document.createElement("script");
  s.src = LIBS[name]; s.onload = ok;
  s.onerror = () => { delete loaded[name]; bad(new Error("ما قدرت أحمّل قارئ هالصيغة — تأكّد من النت")); };
  document.head.append(s);
}));
function canvasFor(w, h) {
  const c = document.createElement("canvas");
  c.width = Math.round(w); c.height = Math.round(h);
  const g = c.getContext("2d");
  g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);   // الشفاف بيطلع أسود بـ JPEG
  return [c, g];
}
function shrink(src, w, h) {   // src: صورة أو canvas بحجمها الأصلي
  const s = Math.min(1, MAX_SIDE / Math.max(w, h));
  const [c, g] = canvasFor(w * s, h * s);
  g.drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.85);
}
const isPdf = (file, ext) => file.type === "application/pdf" || ext === "pdf";
async function openPdf(file) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  return pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
}
async function pdfPageImage(pdf, n) {
  const page = await pdf.getPage(n);
  const v1 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: MAX_SIDE / Math.max(v1.width, v1.height) });
  const [c, g] = canvasFor(vp.width, vp.height);
  // intent "print": الرسم ما بيستنّى requestAnimationFrame، اللي بيوقف إذا اللوحة مخفيّة
  await page.render({ canvasContext: g, viewport: vp, intent: "print" }).promise;
  return c.toDataURL("image/jpeg", 0.85);
}
async function toParts(file) {
  const ext = (file.name || "").toLowerCase().split(".").pop();
  if (isPdf(file, ext)) {
    const pdf = await openPdf(file), images = [];
    for (let n = 1; n <= Math.min(pdf.numPages, MAX_PAGES); n++) images.push(await pdfPageImage(pdf, n));
    return { images };
  }
  if (/^(heic|heif)$/.test(ext) || /hei[cf]/.test(file.type)) {   // صور الآيفون
    await lib("heic");
    const jpg = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.9 });
    const bmp = await createImageBitmap(Array.isArray(jpg) ? jpg[0] : jpg);
    return { images: [shrink(bmp, bmp.width, bmp.height)] };
  }
  if (/^tiff?$/.test(ext) || file.type === "image/tiff") {           // السكانرات
    await lib("utif");
    const buf = await file.arrayBuffer();
    const pages = UTIF.decode(buf).filter(p => p.t256).slice(0, MAX_PAGES);   // t256 = العرض؛ width بينعبّى بعد decodeImage
    return { images: pages.map(p => {
      UTIF.decodeImage(buf, p);
      const c = document.createElement("canvas"); c.width = p.width; c.height = p.height;
      c.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(UTIF.toRGBA8(p)), p.width, p.height), 0, 0);
      return shrink(c, p.width, p.height);
    }) };
  }
  if (/^(xlsx|xlsm|xlsb|xls|ods)$/.test(ext)) {
    await lib("xlsx");
    const wb = XLSX.read(await file.arrayBuffer());
    return { text: wb.SheetNames.map(n => "# " + n + "\n" + XLSX.utils.sheet_to_csv(wb.Sheets[n])).join("\n\n") };
  }
  if (ext === "docx") {
    await lib("mammoth");
    const r = await mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() },
      { convertImage: mammoth.images.imgElement(() => Promise.resolve({ src: "" })) });
    return { text: r.value };
  }
  try {
    const bmp = await createImageBitmap(file);
    return { images: [shrink(bmp, bmp.width, bmp.height)] };
  } catch (e) {}
  const text = await file.text();   // XML / CSV / TXT / HTML / EML…
  if (!text.trim() || text.slice(0, 2000).includes("\u0000"))
    throw new Error(`صيغة .${ext} مش مدعومة — حوّلها PDF أو صورة`);
  return { text };
}

// ---------- نداء واحد للنموذج لكل فاتورة ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function askClaude(images, prompt, c, signal) {
  const { default: Anthropic } = await import(ANTHROPIC_SDK);
  // المفتاح من إعدادات هالجهاز، مش من كود الصفحة
  const client = new Anthropic({ apiKey: c.key, baseURL: c.url || undefined, dangerouslyAllowBrowser: true });
  // fallbacks بيشتغل على هالنماذج بس (Haiku ما بيدعمه)
  const fb = /^claude-(opus-5|fable-5|sonnet-5-5)/.test(c.model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {};
  try {
    const msg = await client.beta.messages.create({
      model: c.model, max_tokens: 16000,
      output_config: { effort: "low" },   // استخراج بسيط: low أسرع
      ...fb,
      system: SYSTEM,
      messages: [{ role: "user", content: [
        ...images.map(url => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: url.slice(url.indexOf(",") + 1) } })),
        { type: "text", text: prompt }
      ] }]
    }, { signal });
    addSpend(msg.model || c.model, msg.usage);
    if (msg.stop_reason === "refusal") throw new Error("Claude رفض يقرأ هالملف");
    return msg.content.filter(b => b.type === "text").map(b => b.text).join("");
  } catch (e) {
    if (e instanceof Anthropic.APIUserAbortError) throw new Error("اتوقّف");
    if (creditOut(e)) throw new Error(NO_CREDIT);
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) throw new Error("المفتاح مرفوض — صلّحه من الإعدادات");
    if (e instanceof Anthropic.NotFoundError) throw new Error("اسم النموذج غلط — صلّحه من الإعدادات");
    if (e instanceof Anthropic.RateLimitError) throw new Error("وصلت حدّ Anthropic، استنّى دقيقة وجرّب");
    if (e instanceof Anthropic.APIError) throw new Error("Anthropic: " + e.message);
    throw e;
  }
}

async function askOpenAI(images, prompt, c, signal) {
  const body = JSON.stringify({
    model: c.model, temperature: 0,
    messages: [{ role: "system", content: SYSTEM },
               { role: "user", content: [{ type: "text", text: prompt }, ...images.map(url => ({ type: "image_url", image_url: { url } }))] }]
  });
  for (let attempt = 1; ; attempt++) {
    let r;
    try {
      r = await fetch(c.url.replace(/\/+$/, "") + "/chat/completions", {
        method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + c.key }, body, signal
      });
    } catch (e) { if (e.name === "AbortError") throw new Error("اتوقّف"); throw e; }
    const raw = await r.text();
    if ((r.status === 429 || r.status >= 500) && attempt < 3) { await sleep(2000 * attempt); continue; }
    if (r.status === 401 || r.status === 403) throw new Error("المفتاح مرفوض — صلّحه من الإعدادات");
    if (r.status === 404) throw new Error("اسم النموذج أو الرابط غلط — صلّحه من الإعدادات");
    if (r.status === 429) throw new Error("وصلت حدّ المزوّد، استنّى دقيقة وجرّب");
    let j = null; try { j = JSON.parse(raw); } catch (e) {}
    if (!r.ok) throw new Error((j && j.error && j.error.message) || ("خطأ " + r.status));
    return (j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
  }
}

async function fileHash(file) {
  const d = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
}
const day = t => new Date(t).toISOString().slice(0, 10);
const MAX_STEPS = 30;     // ponytail: حدّ خطوات الطلب الواحد، زيده إذا الطلبات الكبيرة بتوقف قبل ما تخلص
const MAX_READ_LINES = 400, MAX_READ_CHARS = 30000;   // حدّ قراءة الخزنة بالنداء الواحد
const MAX_HITS = 60;      // حدّ نتائج البحث بالخزنة
const VAULT_TOOLS = [
  { name: "vault_search", description: `Search your vault (memory notes and file drafts) for a name, number or word; several words must all appear on the same line. Arabic letter forms and Arabic-Indic digits match their plain forms. Returns up to ${MAX_HITS} matching lines grouped by note with their line numbers; for Excel drafts each group also gives the sheet and its header row.`,
    input_schema: { type: "object", properties: {
      query: { type: "string" }, folder: { type: "string", enum: ["ذاكرة", "مسودات"], description: "Optional: search one folder only" } }, required: ["query"] } },
  { name: "vault_read", description: `Read a note or draft from your vault, whole or a range of lines (at most ${MAX_READ_LINES} lines per call; continue from next_from). Also returns the note's [[links]] and the notes that link to it.`,
    input_schema: { type: "object", properties: {
      path: { type: "string", description: "e.g. ذاكرة/الشركة.md or مسودات/كشف البنك.xlsx.md" }, from_line: { type: "integer" }, lines: { type: "integer" } }, required: ["path"] } },
  { name: "vault_write", description: "Create or update one of your memory notes under ذاكرة/ (Markdown; link related notes with [[note name]]). mode: create (fails if the note exists), append (adds to its end), replace (rewrites it). Drafts under مسودات/ are read-only.",
    input_schema: { type: "object", properties: {
      path: { type: "string", description: "e.g. ذاكرة/الموردين.md" }, content: { type: "string" }, mode: { type: "string", enum: ["create", "append", "replace"] } }, required: ["path", "content", "mode"] } },
  { name: "vault_delete", description: "Delete one of your memory notes under ذاكرة/ that is wrong or no longer needed.",
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }
];

// شكل طلب المحادثة ثابت بالزبط عشان الكاش: الأدوات والتعليمات ما بتتغيّر أبداً (بينكاشوا ساعة وبيخدموا كل المحادثات)،
// الخزنة بتنحطّ بأوّل رسالة بالمحادثة مش بالتعليمات، وآخر السجلّ بينكاش لحاله مع كل نداء
// كل صفحة بتقدر تثبّت نموذجها (MALI.model): إكسل Sonnet 5.5 من الإعدادات، ووورد Haiku 5.5
// الكلفة الكبيرة كانت حجم المحادثة (٢٠٠–٧٥٠ ألف توكن بكل نداء، ٤ تشرين ثاني ٢٠٢٦)، فـ:
// ١) لمّا المحادثة توصل COMPACT_AT، Anthropic بتلخّص القديم بنفسها (compaction) وبنكمّل من الملخّص
// ٢) آخر المحادثة بينكاش ساعة مش ٥ دقايق: المحاسب بيرجع بعد ربع ساعة، وبدل ما تنكتب المحادثة كلها من جديد بتنقرا من الكاش
const COMPACT_AT = 80000;   // ponytail: أقلّ إشي 50 ألف؛ أصغر = أرخص بس بينسى التفاصيل أسرع
const COMPACT_PROMPT = `Summarize the conversation so far inside <summary></summary> tags so the work can continue in a fresh context window.
Keep: what the accountant asked for (in their Arabic wording), which workbook, sheets, ranges and tables were read or changed and how, numbers and results later turns may need, decisions and preferences the accountant stated, attached files and their vault paths, and anything still pending or promised.
Leave out raw cell dumps that can be read again with read_range.
Do not call any tools while writing this summary; respond with text only.`;
const chatModel = c => MALI.model || c.model;
const chatParams = (c, messages) => {
  // fallbacks بيشتغل على هالنماذج بس (Haiku ما بيدعمه)
  const fb = /^claude-(opus-5|fable-5|sonnet-5-5)/.test(chatModel(c));
  return {
    model: chatModel(c), max_tokens: 16000,
    betas: [...(fb ? ["server-side-fallback-2026-07-01"] : []), "compact-2026-01-12"],
    ...(fb ? { fallbacks: "default" } : {}),
    output_config: { effort: MALI.effort || "medium" },
    cache_control: { type: "ephemeral", ttl: "1h" },
    context_management: { edits: [{ type: "compact_20260112", trigger: { type: "input_tokens", value: COMPACT_AT }, instructions: COMPACT_PROMPT }] },
    system: [{ type: "text", text: MALI.system, cache_control: { type: "ephemeral", ttl: "1h" } }],
    tools: MALI.tools, messages
  };
};

const VAULT_LABELS = {
  vault_search: a => `🧠 بدوّر بالخزنة عن «${a.query}»`, vault_read: a => `🧠 بقرأ ${a.path}${a.from_line > 1 ? " من سطر " + a.from_line : ""}`,
  vault_write: a => `🧠 ${a.mode === "append" ? "زدت على" : "حفظت"} ${a.path}`, vault_delete: a => `🧠 مسحت ${a.path}`
};

const VAULT_HANDLERS = {
  vault_search: ({ query, folder }) => searchVault(query, folder),
  vault_read: readNote,
  vault_write: writeNote,
  vault_delete: async ({ path }) => {
    const n = findNote(path);
    if (!n.path.startsWith(MEM_DIR)) throw new Error("only your memory notes under ذاكرة/ can be deleted; the accountant removes drafts from the vault list");
    await removeNote(n.path);
    return { deleted: n.path };
  }
};

// ---------- المحادثة ----------
let CHAT = [];          // سجلّ المحادثة كامل: بينضاف عليه بس، ما بنعدّل اللي قبل
let UI = [];            // اللي معروض بالشاشة، بينحفظ مع المحادثة
let ctxSent = false;    // فهرس الخزنة انبعت بأوّل رسالة بهالمحادثة؟
let stopAsked = false, chatAbort = null;
let lastAt = 0;         // وقت آخر طلب بهالمحادثة (١ = محادثة قديمة من قبل هالميزة)
let prevChat = "";      // مسار المحادثة اللي قبلها بالخزنة، بينذكر بأوّل رسالة بالجديدة

// Markdown بسيط وآمن لردود MaliAI: كل النصّ بيتعقّم أوّل، وبعدين عناوين ونقاط وجداول وخطّ عريض بس
function md(src) {
  const esc = s => s.replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  const inline = s => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>");
  const isRow = l => /^\s*\|.*\|\s*$/.test(l);
  const cells = l => l.trim().replace(/^\||\|$/g, "").split("|").map(x => x.trim());
  const lines = String(src).split("\n");
  let html = "", list = null;
  const close = () => { if (list) { html += `</${list}>`; list = null; } };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m;
    if (isRow(l) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      close();
      html += "<table><tr>" + cells(l).map(x => `<th>${inline(x)}</th>`).join("") + "</tr>";
      i++;
      while (i + 1 < lines.length && isRow(lines[i + 1])) html += "<tr>" + cells(lines[++i]).map(x => `<td>${inline(x)}</td>`).join("") + "</tr>";
      html += "</table>";
    } else if ((m = l.match(/^\s*#{1,6}\s+(.*)/))) { close(); html += `<h4>${inline(m[1])}</h4>`; }
    else if ((m = l.match(/^\s*[-*•]\s+(.*)/))) { if (list !== "ul") { close(); html += "<ul>"; list = "ul"; } html += `<li>${inline(m[1])}</li>`; }
    else if ((m = l.match(/^\s*\d+[.)]\s+(.*)/))) { if (list !== "ol") { close(); html += "<ol>"; list = "ol"; } html += `<li>${inline(m[1])}</li>`; }
    else if (!l.trim()) close();
    else { close(); html += `<p>${inline(l)}</p>`; }
  }
  close();
  return html;
}

function say(cls, text) {
  const d = document.createElement("div"), item = { cls, text };
  d.className = "msg " + cls;
  const paint = () => { if (cls === "ai") d.innerHTML = md(item.text); else d.textContent = item.text; };
  paint();
  $("chat").append(d); d.scrollIntoView({ block: "end" });
  $("empty").hidden = true;
  UI.push(item);
  return { set(t) { item.text = t; paint(); } };
}

// ---------- حفظ المحادثة على الجهاز (IndexedDB: بتساع الصور، وبتضلّ لو سكّرت إكسل) ----------
const idb = (() => {
  let p = null;
  const open = () => p || (p = new Promise((ok, bad) => {
    const r = indexedDB.open("maliai", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error);
  }));
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((ok, bad) => { const t = db.transaction("kv", mode), req = fn(t.objectStore("kv")); t.oncomplete = () => ok(req.result); t.onerror = () => bad(t.error); });
  };
  return { get: k => tx("readonly", s => s.get(k)), set: (k, v) => tx("readwrite", s => s.put(v, k)),
    del: k => tx("readwrite", s => s.delete(k)),
    all: prefix => tx("readonly", s => s.getAll(IDBKeyRange.bound(prefix, prefix + "￿"))) };
})();
const saveChat = () => idb.set(MALI.chatKey, { CHAT, UI, ctxSent, at: lastAt }).catch(() => {});
async function loadChat() {
  try {
    const s = await idb.get(MALI.chatKey);
    if (!s || !Array.isArray(s.CHAT)) return;
    CHAT = s.CHAT; ctxSent = !!s.ctxSent;
    lastAt = s.at || (s.CHAT.length ? 1 : 0);   // محادثة محفوظة قبل هالتحديث: الطلب الجاي بيبلّش جديدة
    for (const it of s.UI || []) say(it.cls, it.text);
  } catch (e) {}
}

// ---------- خزنة MaliAI بصيغة Obsidian: ذاكرة/ ملاحظاته، ومسودات/ الملفات اللي انقرت مرّة وحدة ----------
const MEM_DIR = "ذاكرة/", DRAFT_DIR = "مسودات/", CHAT_DIR = DRAFT_DIR + "محادثات/";
const SHOW_CHATS = 5;      // ponytail: آخر كم محادثة محفوظة بتنذكر بأوّل كل محادثة جديدة، الأقدم بالبحث
const VAULT = new Map();   // path → { path, text, at, + للمسودات: src, meta, hash }
const INLINE_MEM = 6000;   // ponytail: ذاكرة أصغر من هيك بتنبعت كاملة بأوّل المحادثة، الأكبر فهرس بس وبيقرأ اللي بدّه
const MAX_NOTE = 20000;    // ponytail: حدّ ملاحظة الذاكرة الوحدة، الأكبر بتنقسم لملاحظات مربوطة
const title = p => p.split("/").pop().replace(/\.md$/i, "");
const safeName = s => String(s).replace(/[\\/:*?"<>|#^[\]]/g, "-").trim() || "ملاحظة";   // أسماء بيقبلها Obsidian
function cleanPath(p) {
  let s = String(p || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!s || s.split("/").some(x => !x || x === "." || x === "..")) throw new Error("bad path: " + p);
  return /\.md$/i.test(s) ? s : s + ".md";
}
function findNote(p) {
  const s = cleanPath(p);
  const n = VAULT.get(s) || VAULT.get(MEM_DIR + s) || VAULT.get(DRAFT_DIR + s) || [...VAULT.values()].find(n => title(n.path) === title(s));
  if (!n) throw new Error(`${s} is not in the vault; use vault_search`);
  return n;
}
async function putNote(n) {
  n.at = Date.now();
  await idb.set("note:" + n.path, n);
  VAULT.set(n.path, n); renderVault();
  return n;
}
async function removeNote(path) {
  await idb.del("note:" + path);
  VAULT.delete(path); renderVault();
}
async function loadVault() {
  try { for (const n of await idb.all("note:")) VAULT.set(n.path, n); } catch (e) {}
  // ذاكرة النسخة القديمة (حقائق قصيرة بـ localStorage) بتنتقل مرّة وحدة لملاحظة بالخزنة
  try {
    const old = JSON.parse(localStorage.getItem("maliai.memory")) || [];
    if (old.length) {
      const p = MEM_DIR + "ملاحظات عامّة.md", n = VAULT.get(p);
      await putNote({ path: p, text: (n ? n.text : "# ملاحظات عامّة") + "\n" + old.map(f => "- " + f.fact).join("\n") });
      localStorage.removeItem("maliai.memory");
    }
  } catch (e) {}
  renderVault();
}

// بحث عربي مرن: أشكال الألف والياء والتاء المربوطة والتشكيل والأرقام الهندية بتطابق العاديّة
const norm = s => String(s).normalize("NFKC").toLowerCase()
  .replace(/[٠-٩]/g, d => "٠١٢٣٤٥٦٧٨٩".indexOf(d)).replace(/[۰-۹]/g, d => "۰۱۲۳۴۵۶۷۸۹".indexOf(d))
  .replace(/[ً-ْـ]/g, "").replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه");
function searchVault(query, folder) {
  const terms = norm(query || "").split(/\s+/).filter(Boolean);
  if (!terms.length) throw new Error("query is empty");
  const has = s => { const x = norm(s); return terms.every(t => x.includes(t)); };
  const notes = [];
  let count = 0;
  for (const n of VAULT.values()) {
    if (folder && !n.path.startsWith(folder + "/")) continue;
    const lines = n.text.split("\n"), groups = [];
    let sect = -1, g = null;
    lines.forEach((l, i) => {
      if (l.startsWith("## ")) sect = i;
      if (count >= MAX_HITS || !has(l)) return;
      if (!g || g.at !== sect) groups.push(g = { at: sect, section: sect >= 0 ? lines[sect] : undefined,
        header: n.kind === "excel" && sect >= 0 && i !== sect + 1 ? lines[sect + 1] : undefined, hits: [] });
      g.hits.push({ line: i + 1, text: l.length > 300 ? l.slice(0, 300) + "…" : l });
      count++;
    });
    if (groups.length || has(title(n.path))) notes.push({ path: n.path, total_lines: lines.length, groups: groups.map(({ at, ...x }) => x) });
  }
  return { query, notes, ...(count >= MAX_HITS ? { more: "too many matches; search for something more specific" } : {}) };
}
function readNote({ path, from_line = 1, lines: want = MAX_READ_LINES }) {
  const n = findNote(path), all = n.text.split("\n"), t = title(n.path);
  const from = Math.min(Math.max(1, Math.floor(from_line) || 1), all.length);
  let to = Math.min(all.length, from - 1 + Math.min(MAX_READ_LINES, Math.max(1, Math.floor(want) || MAX_READ_LINES)));
  let text = all.slice(from - 1, to).join("\n");
  while (text.length > MAX_READ_CHARS && to > from) { to = from + Math.floor((to - from) / 2); text = all.slice(from - 1, to).join("\n"); }
  const links = [...new Set([...n.text.matchAll(/\[\[([^\]|#]+)/g)].map(m => m[1].trim()))];
  const backlinks = [...VAULT.values()].filter(o => o !== n && ["]]", "|", "#"].some(e => o.text.includes("[[" + t + e))).map(o => o.path);
  return { path: n.path, ...(n.src ? { file: n.src, about: n.meta } : {}), from_line: from, to_line: to, total_lines: all.length,
    ...(to < all.length ? { next_from: to + 1 } : {}), text: text.slice(0, MAX_READ_CHARS),
    ...(links.length ? { links } : {}), ...(backlinks.length ? { backlinks } : {}) };
}
async function writeNote({ path, content, mode }) {
  let p = cleanPath(path);
  if (p.startsWith(DRAFT_DIR)) throw new Error("drafts under مسودات/ are read-only; write your notes under ذاكرة/");
  if (!p.startsWith(MEM_DIR)) p = MEM_DIR + p;
  p = MEM_DIR + p.slice(MEM_DIR.length).split("/").map(safeName).join("/");
  content = String(content || "").trim();
  if (!content) throw new Error("content is empty");
  const n = VAULT.get(p);
  if (mode === "create" && n) throw new Error(`${p} already exists; use append or replace`);
  const text = mode === "append" && n ? n.text.replace(/\s+$/, "") + "\n" + content : (/^#\s/.test(content) ? content : `# ${title(p)}\n${content}`);
  if (text.length > MAX_NOTE) throw new Error(`${p} would be ${text.length} characters (max ${MAX_NOTE}); split it into linked notes`);
  await putNote({ path: p, text });
  return { saved: p, total_lines: text.split("\n").length };
}

// أوّل رسالة بكل محادثة: فهرس الخزنة (والذاكرة كاملة إذا صغيرة)، عشان التعليمات نفسها تضلّ ثابتة بالكاش
const gist = n => (n.text.split("\n").find(l => l.trim() && !l.startsWith("#")) || "").trim().slice(0, 120);
const draftLine = n => `- ${n.path} — ${n.meta}, ${n.text.split("\n").length} lines, ${day(n.at)}`;
function vaultContext() {
  const all = [...VAULT.values()].sort((a, b) => a.path.localeCompare(b.path, "ar"));
  const mem = all.filter(n => n.path.startsWith(MEM_DIR)), drafts = all.filter(n => n.path.startsWith(DRAFT_DIR) && !n.path.startsWith(CHAT_DIR));
  const chats = all.filter(n => n.path.startsWith(CHAT_DIR)).sort((a, b) => b.at - a.at);
  const memText = !mem.length ? "Your memory is empty so far."
    : mem.reduce((a, n) => a + n.text.length, 0) <= INLINE_MEM ? "Your memory notes, in full:\n\n" + mem.map(n => `=== ${n.path}\n${n.text}`).join("\n\n")
    : "Your memory notes (open them with vault_read):\n" + mem.map(n => `- ${n.path} — ${gist(n)}`).join("\n");
  const draftText = drafts.length ? "Drafts of files uploaded earlier (read-only; vault_search / vault_read):\n" + drafts.map(draftLine).join("\n") : "No file drafts yet.";
  const chatText = chats.length ? `\n\nEarlier conversations, saved word for word (latest ${Math.min(SHOW_CHATS, chats.length)} of ${chats.length}; vault_search in مسودات finds older ones):\n` +
    chats.slice(0, SHOW_CHATS).map(n => `- ${n.path} — ${gist(n)}`).join("\n") : "";
  return `[Your vault at the start of this conversation]\n${memText}\n\n${draftText}${chatText}`;
}

function renderVault() {
  const all = [...VAULT.values()].sort((a, b) => a.path.localeCompare(b.path, "ar"));
  $("vaultN").textContent = all.length;
  $("vaultList").innerHTML = "";
  for (const [dir, label] of [[MEM_DIR, "🧠 ذاكرة"], [DRAFT_DIR, "📄 مسودات"], [CHAT_DIR, "💬 محادثات"]]) {
    const items = all.filter(n => n.path.startsWith(dir) && (dir !== DRAFT_DIR || !n.path.startsWith(CHAT_DIR)));
    if (!items.length) continue;
    const h = document.createElement("li");
    h.className = "h"; h.textContent = `${label} (${items.length})`;
    $("vaultList").append(h);
    for (const n of items) {
      const li = document.createElement("li"), x = document.createElement("button");
      li.textContent = title(n.path) + (n.meta ? " · " + n.meta : "") + " ";
      li.title = n.text.slice(0, 400);
      x.type = "button"; x.textContent = "✕"; x.title = "امسح من الخزنة";
      x.onclick = () => removeNote(n.path).catch(() => {});
      li.append(x); $("vaultList").append(li);
    }
  }
}

// Obsidian: الخزنة بتنزل zip بنفس المجلّدات، بتفكّه وبتفتحه بـ «Open folder as vault»؛ والملاحظات اللي بتعدّلها هناك بترجع بالاستيراد
$("vexport").onclick = async () => {
  try {
    await lib("jszip");
    const zip = new JSZip();
    for (const n of VAULT.values()) zip.file("MaliAI/" + n.path, n.text);
    const url = URL.createObjectURL(await zip.generateAsync({ type: "blob" }));
    const a = document.createElement("a");
    a.href = url; a.download = "MaliAI-vault.zip"; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) { $("cstatus").textContent = "ما قدرت أنزّل الخزنة: " + (e.message || e); }
};
$("vimport").onclick = () => $("vfiles").click();
$("vfiles").onchange = async e => {
  const files = [...e.target.files];
  e.target.value = "";
  try {
    for (const f of files) await putNote({ path: MEM_DIR + safeName(f.name.replace(/\.md$/i, "")) + ".md", text: (await f.text()).trim() });
    $("cstatus").textContent = `انضافت ${files.length} ملاحظة لذاكرة MaliAI.`;
  } catch (err) { $("cstatus").textContent = "ما قدرت أستورد: " + (err.message || err); }
};
// ---------- مرفقات المحادثة ----------
let attached = [];
function attachFiles(files) {
  let skipped = 0;
  for (const f of files) if (attached.length < MAX_FILES) attached.push(f); else skipped++;
  $("chips").hidden = !attached.length;
  $("chips").innerHTML = attached.length ? `📎 ${attached.length}: <span></span><button type="button" title="شيل المرفقات">✕</button>` : "";
  if (attached.length) {
    $("chips").querySelector("span").textContent = attached.map(f => f.name || "صورة ملصوقة").join("، ");
    $("chips").querySelector("button").onclick = () => { attached = []; attachFiles([]); };
  }
  if (skipped) $("cstatus").textContent = `الحدّ ${MAX_FILES} ملفات بالرسالة، فما انضاف ${skipped}. ابعت هدول أوّل وبعدين ضيف الباقي.`;
}
$("attach").onclick = () => $("cfiles").click();
$("cfiles").onchange = e => { attachFiles(e.target.files); e.target.value = ""; };
const chatTab = $("tab-chat");
chatTab.ondragover = e => { e.preventDefault(); chatTab.classList.add("over"); };
chatTab.ondragleave = () => chatTab.classList.remove("over");
chatTab.ondrop = e => { e.preventDefault(); chatTab.classList.remove("over"); attachFiles(e.dataTransfer.files); };

// ---------- كل ملف بينقرا مرّة وحدة ← مسودة بالخزنة؛ نفس الملف مرّة ثانية (حتى بمحادثة جديدة) = نفس المسودة بدون ولا توكن ----------
const MAX_DRAFT_PAGES = 60;   // ponytail: أوّل 60 صفحة من الـPDF، زيدها إذا في ملفات أطول
const INLINE_DRAFT = 8000;    // مسودة أصغر من هيك بتنبعت كاملة مع الرسالة، الأكبر أوّل PREVIEW_LINES سطر والباقي بأدوات الخزنة
const PREVIEW_LINES = 40;
const OCR_PROMPT = `Transcribe this page into plain text exactly as printed, in reading order and in its original language.
Keep every number, date, name and code exactly as written. Write each table row on one line with | between cells, keeping دينار and فلس columns as printed.
Mark anything illegible with [؟]. No summary, translation, comments or added text.`;
const ocr = (img, c, signal) => (c.provider === "anthropic" ? askClaude : askOpenAI)([img], OCR_PROMPT, c, signal);
const nPages = n => n === 1 ? "صفحة وحدة" : n === 2 ? "صفحتين" : n <= 10 ? `${n} صفحات` : `${n} صفحة`;

async function fileToDraft(file, c, signal) {
  const name = file.name || "صورة ملصوقة", ext = name.toLowerCase().split(".").pop();
  const pages = (list, label) => list.map((t, i) => `## ${label} ${i + 1}\n${t}`).join("\n\n");
  if (/^(xlsx|xlsm|xlsb|xls|ods)$/.test(ext)) {   // إكسل: كل شيت CSV، بدون صفوف فاضية
    await lib("xlsx");
    const wb = XLSX.read(await file.arrayBuffer());
    return { kind: "excel", meta: `إكسل، ${wb.SheetNames.length} شيت`,
      text: wb.SheetNames.map(s => `## شيت «${s}»\n` + XLSX.utils.sheet_to_csv(wb.Sheets[s], { blankrows: false, strip: true })).join("\n\n") };
  }
  if (isPdf(file, ext)) {   // PDF: نصّ الصفحات مجّاناً، والصفحات المصوّرة بس بتروح للنموذج
    const pdf = await openPdf(file), n = Math.min(pdf.numPages, MAX_DRAFT_PAGES), text = new Array(n), scanned = [];
    for (let p = 1; p <= n; p++) {
      const tc = await (await pdf.getPage(p)).getTextContent();
      const t = tc.items.map(i => (i.str || "") + (i.hasEOL ? "\n" : "")).join("").normalize("NFKC").replace(/[ \t]+\n/g, "\n").trim();
      if (t.replace(/\s/g, "").length < 20) scanned.push(p); else text[p - 1] = t;
    }
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(PARALLEL, scanned.length) }, async () => {
      while (next < scanned.length) { const p = scanned[next++]; text[p - 1] = await ocr(await pdfPageImage(pdf, p), c, signal); }
    }));
    return { kind: "pdf", text: pages(text, "صفحة"),
      meta: `PDF، ${nPages(pdf.numPages)}` + (scanned.length ? `، ${scanned.length} منها انقرت بالنموذج` : "") + (pdf.numPages > n ? `، أوّل ${n} بس` : "") };
  }
  const parts = await toParts(file);   // Word وXML وCSV نصّ؛ الصور بتنقرا بالنموذج مرّة وحدة
  if (parts.text) return { kind: "text", meta: `ملف .${ext}`, text: parts.text };
  const text = [];
  for (const img of parts.images) text.push(await ocr(img, c, signal));
  return { kind: "image", meta: text.length > 1 ? `صور، ${nPages(text.length)}، انقرت بالنموذج` : "صورة، انقرت بالنموذج", text: pages(text, "صفحة") };
}

async function draftFor(file, c, signal) {
  const hash = await fileHash(file).catch(() => null);
  const have = hash && [...VAULT.values()].find(n => n.hash === hash);
  if (have) return { note: have, reused: true };
  const d = await fileToDraft(file, c, signal);
  if (!d.text.trim()) throw new Error("ما لقيت إشي أقرأه بالملف");
  const base = DRAFT_DIR + safeName(file.name || "صورة ملصوقة");
  let path = base + ".md";
  for (let i = 2; VAULT.has(path); i++) path = `${base} (${i}).md`;   // نفس الاسم لملف مختلف
  return { note: await putNote({ path, text: `# ${file.name || "صورة ملصوقة"}\n\n${d.text}`, src: file.name || "", meta: d.meta, kind: d.kind, hash }), reused: false };
}

async function attachmentBlocks(files, c, signal) {
  const res = await Promise.all(files.map(f => draftFor(f, c, signal).catch(e => ({ error: e.message || String(e) }))));
  const blocks = [], failed = [], news = [], olds = [];
  res.forEach((r, i) => {
    const name = files[i].name || "صورة ملصوقة";
    if (r.error) { failed.push(`${name}: ${r.error}`); return; }
    const n = r.note, lines = n.text.split("\n");
    (r.reused ? olds : news).push(title(n.path));
    const head = `Attached file «${name}» ${r.reused ? "was read before; its draft is" : "is now read and saved as"} ${n.path} (${n.meta}, ${lines.length} lines)`;
    blocks.push({ type: "text", text: n.text.length <= INLINE_DRAFT ? `${head}:\n${n.text}`
      : `${head}. First ${PREVIEW_LINES} lines; read the rest with vault_search / vault_read:\n${lines.slice(0, PREVIEW_LINES).join("\n").slice(0, INLINE_DRAFT)}` });
  });
  return { blocks, failed, news, olds };
}

async function chatSend() {
  const spendAtStart = readSpend().usd;   // «هالطلب» بيشمل كل إشي: قراءة المرفقات، البحث القانوني، وكل خطوة
  const files = attached;
  const text = $("ask").value.trim() || (files.length ? MALI.defaultAsk : "");
  if (!text) return;
  const c = readCfg();
  if (c.provider !== "anthropic" || !c.key) { $("settings").open = true; say("err", "مساعد إكسل بيشتغل مع Claude: اختار Anthropic من الإعدادات وحط المفتاح."); return; }
  if (overBudget()) { say("err", overBudget()); return; }
  // رجع بعد ساعة أو أكثر وطلب إشي جديد (مش «كمّل»): محادثة جديدة لحالها، والقديمة بتنحفظ بالخزنة
  if (CHAT.length && lastAt && Date.now() - lastAt > NEW_CHAT_AFTER && CHAT[CHAT.length - 1].role === "assistant" && !KEEP_GOING.test(text)) {
    const old = await archiveChat().catch(() => null), why = lastAt > 1 ? `لأنّ آخر رسالة كانت قبل ${ago((Date.now() - lastAt) / 60e3)}` : "لأنّ المحادثة القديمة طويلة";
    clearChat(); prevChat = old ? old.path : "";
    say("step", `🆕 بلّشت محادثة جديدة لحالها ${why}، عشان الطلب يضلّ رخيص.` + (old ? ` القديمة انحفظت بالخزنة «${title(old.path)}» وبرجعلها إذا احتجتها.` : ""));
  }
  if (!inHost) say("err", MALI.notInHost);
  $("ask").value = ""; attached = []; attachFiles([]);
  say("me", text + (files.length ? "\n📎 " + files.map(f => f.name || "صورة ملصوقة").join("، ") : ""));
  $("send").hidden = true; $("stop").hidden = false; $("cstatus").classList.add("busy"); stopAsked = false;
  chatAbort = new AbortController();
  // فهرس الخزنة قبل مرفقات هالرسالة، عشان ما تنذكر مرّتين
  const ctx = ctxSent ? [] : [{ type: "text", text: vaultContext() +
    (prevChat ? `\n\nThe previous conversation is saved as ${prevChat}; read it with vault_read only if the request refers to earlier work.` : "") }];
  prevChat = "";
  let blocks = [];
  if (files.length) {
    $("cstatus").textContent = "بقرأ المرفقات مرّة وحدة وبحفظها بالخزنة…";
    const a = await attachmentBlocks(files, c, chatAbort.signal);
    blocks = a.blocks;
    if (a.news.length) say("step", "📄 انقرت وانحفظت بالخزنة: " + a.news.join("، "));
    if (a.olds.length) say("step", "📄 مقروءة من قبل، من الخزنة بدون قراءة جديدة: " + a.olds.join("، "));
    if (a.failed.length) say("err", "ما قدرت أقرأ:\n" + a.failed.join("\n"));
  }
  // إذا الدور اللي قبل وقف (خطأ أو «وقّف») بعد نتائج أدوات ما انبعتت، الكلام الجديد بينضمّ لنفس رسالة المستخدم
  const note = [...ctx, ...blocks, { type: "text", text: text + await MALI.contextNote() }];
  const last = CHAT[CHAT.length - 1];
  if (last && last.role === "user") last.content.push(...note); else CHAT.push({ role: "user", content: note });
  ctxSent = true;
  saveChat();
  if (MALI.turnStart) MALI.turnStart(text);   // إكسل: بيبلّش «نقطة رجوع» لهالطلب
  let Anthropic = null, cached = 0, total = 0;
  try {
    ({ default: Anthropic } = await import(ANTHROPIC_SDK));
    const client = new Anthropic({ apiKey: c.key, baseURL: c.url || undefined, dangerouslyAllowBrowser: true });
    for (let step = 1; ; step++) {
      if (stopAsked) { say("step", "وقّفت بطلبك."); break; }
      if (step > MAX_STEPS) { say("err", `وصلت ${MAX_STEPS} خطوة ولسّا ما خلّصت — قلّي «كمّل» إذا بدّك أكمّل.`); break; }
      $("cstatus").textContent = "بفكّر";
      const msg = await client.beta.messages.create(chatParams(c, CHAT), { signal: chatAbort.signal });
      const u = msg.usage || {};
      console.info("MaliAI usage", u);   // للتأكّد من الكاش: cache_read_input_tokens لازم يكبر نداء ورا نداء
      addSpend(msg.model || chatModel(c), u);
      cached += u.cache_read_input_tokens || 0;
      total += (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      CHAT.push({ role: "assistant", content: msg.content });
      // انعمل تلخيص: Anthropic بتتجاهل كل إشي قبله، فمنشيله من هون كمان عشان الطلب والتخزين يضلّوا صغار
      // (لو التلخيص فشل content بيكون null، ومنخلّي المحادثة زي ما هي)
      if (msg.content.some(b => b.type === "compaction" && b.content)) {
        CHAT = CHAT.slice(-1);
        ctxSent = false;   // فهرس الخزنة كان بأوّل رسالة وراح معها، فبينبعت مرّة ثانية مع الرسالة الجاية
        say("step", "🗜️ المحادثة طوّلت، فلخّصت القديم منها عشان تضلّ رخيصة. الملفّات والذاكرة محفوظين.");
      }
      for (const b of msg.content) if (b.type === "text" && b.text.trim()) say("ai", b.text.trim());
      saveChat();
      if (msg.stop_reason === "refusal") { say("err", "Claude رفض هالطلب."); break; }
      if (msg.stop_reason === "pause_turn") continue;
      if (msg.stop_reason !== "tool_use") break;
      const results = [];
      for (const b of msg.content.filter(b => b.type === "tool_use")) {
        const label = MALI.labels[b.name] ? MALI.labels[b.name](b.input || {}) : b.name;
        // كل tool_use لازم يرجعله نتيجة، حتى لو وقّفنا، عشان السجلّ يضلّ سليم
        if (stopAsked) { results.push({ type: "tool_result", tool_use_id: b.id, content: "Stopped by the accountant before this ran.", is_error: true }); continue; }
        const line = say("step", "• " + label + "…");
        try {
          if (!MALI.handlers[b.name]) throw new Error("unknown tool " + b.name);
          // صورة من الشيت قبل أوّل تعديل عليه، عشان زرّ «تراجع» (لو فشلت، التعديل بيمشي عادي)
          if (MALI.beforeTool) await MALI.beforeTool(b.name, b.input || {}).catch(e => console.warn("MaliAI undo snapshot", e));
          const out = await MALI.handlers[b.name](b.input || {});
          results.push({ type: "tool_result", tool_use_id: b.id, content: JSON.stringify(out) });
          line.set("✓ " + label + (out.errors && out.errors.length ? ` (${out.errors.length} خطأ بالمعادلات، بصلّحهم)` : ""));
        } catch (e) {
          results.push({ type: "tool_result", tool_use_id: b.id, content: String((e && (e.debugInfo && e.debugInfo.message || e.message)) || e), is_error: true });
          line.set("✗ " + label);
        }
      }
      CHAT.push({ role: "user", content: results });
      saveChat();
    }
  } catch (e) {
    let m = e && e.message || String(e);
    if (!Anthropic) m = "ما قدرت أحمّل مكتبة Claude — تأكّد من النت";
    else if (e instanceof Anthropic.APIUserAbortError) m = "";
    else if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) m = "المفتاح مرفوض — صلّحه من الإعدادات";
    else if (e instanceof Anthropic.NotFoundError) m = "اسم النموذج غلط — صلّحه من الإعدادات";
    else if (e instanceof Anthropic.RateLimitError) m = "وصلت حدّ Anthropic، استنّى دقيقة وجرّب";
    else if (creditOut(e)) m = NO_CREDIT;
    if (m) say("err", m); else say("step", "وقّفت بطلبك.");
  }
  if (MALI.turnEnd) MALI.turnEnd();   // إذا تغيّر إشي بالملف بيطلع زرّ «↩️ تراجع»
  lastAt = Date.now();
  saveChat();
  $("cstatus").textContent = total ? `💰 هالطلب ${usd(readSpend().usd - spendAtStart)} · هالشهر ${usd(readSpend().usd)} · ⚡ ${Math.round(cached / total * 100)}% من الكاش${budgetNote()}` : "";
  $("cstatus").classList.remove("busy");
  $("send").hidden = false; $("stop").hidden = true;
}
$("send").onclick = chatSend;
$("ask").onkeydown = e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) chatSend(); };
document.querySelectorAll(".sugg button").forEach(b => b.onclick = () => { $("ask").value = b.textContent; $("ask").focus(); });
$("stop").onclick = () => { stopAsked = true; if (chatAbort) chatAbort.abort(); $("cstatus").textContent = "بوقّف…"; };
$("newchat").onclick = async () => {   // كبستين عشان ما تنمسح المحادثة بالغلط؛ القديمة بتنحفظ بالخزنة
  const b = $("newchat");
  if (!b.dataset.sure) {
    b.dataset.sure = "1"; b.textContent = "متأكّد؟ اكبس كمان";
    setTimeout(() => { delete b.dataset.sure; b.textContent = "محادثة جديدة"; }, 3000);
    return;
  }
  delete b.dataset.sure; b.textContent = "محادثة جديدة";
  const old = await archiveChat().catch(() => null);
  clearChat(); prevChat = old ? old.path : ""; lastAt = 0;
  if (old) $("cstatus").textContent = `المحادثة القديمة انحفظت بالخزنة «${title(old.path)}».`;
  saveChat();
};

// ---------- المحادثة الجديدة: القديمة بتنحفظ بالخزنة بصيغة Obsidian (بدون ولا توكن)، والجديدة بتبلّش صغيرة ورخيصة ----------
const NEW_CHAT_AFTER = 60 * 60e3;   // ponytail: بعد ساعة بدون رسائل الكاش بيكون انتهى، فالطلب الجاي بيبلّش محادثة جديدة لحاله
const KEEP_GOING = /^\s*(كم+ّ?ل|كمان|تابع|و?بعدين|continue)/i;   // «كمّل» بعد الاستراحة بتكمّل نفس المحادثة
const ago = m => { m = Math.round(m); const h = Math.round(m / 60), d = Math.round(m / 1440);
  return m < 120 ? `${m} دقيقة` : h < 24 ? (h === 2 ? "ساعتين" : `${h} ساعات`) : d === 1 ? "يوم" : d === 2 ? "يومين" : d <= 10 ? `${d} أيام` : `${d} يوم`; };
function clearChat() { CHAT = []; UI = []; ctxSent = false; $("chat").innerHTML = ""; $("cstatus").textContent = ""; $("empty").hidden = false; }
async function archiveChat() {
  const items = UI.filter(it => ["me", "ai", "step", "err"].includes(it.cls) && String(it.text || "").trim());
  const asks = items.filter(it => it.cls === "me");
  if (!asks.length) return null;
  const p2 = n => String(n).padStart(2, "0"), t = new Date(lastAt > 1 ? lastAt : Date.now());
  const stamp = `${t.getFullYear()}-${p2(t.getMonth() + 1)}-${p2(t.getDate())} ${p2(t.getHours())}-${p2(t.getMinutes())}`;
  let path = `${CHAT_DIR}محادثة ${stamp}.md`;
  for (let i = 2; VAULT.has(path); i++) path = `${CHAT_DIR}محادثة ${stamp} (${i}).md`;
  // روابط Obsidian لكل ملاحظة أو مسودة انذكرت بالمحادثة
  const links = [...new Set([...JSON.stringify(CHAT).matchAll(/(?:ذاكرة|مسودات)\/[^"\\\n]+?\.md/g)].map(m => title(m[0])))];
  const who = { me: "**الطلب:** ", ai: "**الرد:** ", step: "- ", err: "- ⚠️ " };
  const n = asks.length, count = n === 1 ? "طلب واحد" : n === 2 ? "طلبين" : n <= 10 ? `${n} طلبات` : `${n} طلب`;
  const text = [`# محادثة ${stamp}`, `${count}، أوّلها «${asks[0].text.split("\n")[0].slice(0, 80)}»`,
    ...(links.length ? ["", "مربوطة بـ: " + links.map(x => `[[${x}]]`).join(" ")] : []), "", "## المحادثة",
    ...items.map(it => who[it.cls] + it.text)].join("\n");
  return putNote({ path, text, meta: `محادثة، ${count}`, kind: "chat" });
}

// =====================================================================
// كتابة بالصوت مجّاناً بدون مفتاح:
// ١) تفريغ المتصفّح (فوري، والكلام بينكتب وإنت بتحكي) إذا موجود وشغّال
// ٢) وإلّا Whisper على جهاز المحاسب نفسه (transformers.js): بينزل مرّة وحدة وبعدها بيشتغل بدون نت
// =====================================================================
const MAX_REC = 300;   // ponytail: أطول تسجيل 5 دقايق
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const SR_OFF = "maliai.sr.off";   // إذا تفريغ المتصفّح فشل مرّة بهالجهاز، ما بنرجع نجرّبه
const ASR_LIB = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1";
// مع كرت شاشة (WebGPU): large-v3-turbo، أدقّ بكثير بالعربي والأرقام (~560 ميجا مرّة وحدة)؛ بدونه: small على المعالج (~250 ميجا)
const ASR_GPU = { model: "onnx-community/whisper-large-v3-turbo", dtype: { encoder_model: "q4f16", decoder_model_merged: "q4f16" }, size: "٥٦٠" };
const ASR_CPU = { model: "onnx-community/whisper-small", dtype: "q8", size: "٢٥٠" };
const JUNK = /نانسي قنقر|اشترك(وا)? (في|ب)القناة|لا تنسوا الاشتراك|شكرا للمشاهدة/;   // جمل بيألّفها Whisper لمّا الصوت فاضي
let rec = null;
const setC = (t, busy = false) => { $("cstatus").textContent = t; $("cstatus").classList.toggle("busy", busy); };
const winH = " اكبس بمربّع الكتابة واضغط Win + H، وويندوز بيكتب كلامك مجّاناً.";
const srOff = () => { try { return !!localStorage.getItem(SR_OFF); } catch (e) { return false; } };

// إكسل على النت بيطلب إذن المايك أوّل مرّة، وبعد أوّل موافقة لازم اللوحة تعيد تحميل
async function micAllowed() {
  if (inHost && Office.context.platform === Office.PlatformType.OfficeOnline && Office.devicePermission) {
    if (await Office.devicePermission.requestPermissions([Office.DevicePermissionType.microphone])) {
      try { sessionStorage.setItem("maliai.mic", "1"); } catch (e) {}
      location.reload();
      return false;
    }
  }
  return true;
}

function setRecUI(on, hint) {
  $("composer").classList.toggle("rec", on);
  $("recbar").hidden = !on;
  $("ask").readOnly = on;
  $("mic").setAttribute("aria-pressed", on);
  $("mic").setAttribute("aria-label", on ? "خلّصت" : "احكي بدل ما تكتب");
  $("send").disabled = on; $("attach").disabled = on;
  if (hint) $("livehint").textContent = hint;
  if (on) $("rectime").textContent = "0:00";
}
const runTimer = me => setInterval(() => {
  const s = Math.floor((Date.now() - me.t0) / 1000);
  $("rectime").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  if (s >= MAX_REC) stopRec();
}, 250);

// أيّ محرّك؟ الأقوى Whisper على كرت الشاشة مع كاشف الكلام (نفس طريقة RealtimeSTT وWhisperLive على GitHub):
// كل جملة بتنكتب مرّة وحدة بعد ما تخلّصها، بالتنقيط ومرتّبة. أوّل مرّة بس (Whisper لسّا ما نزل) بنستعمل Google وبننزّله بالخلفية
const ASR_READY = "maliai.asr.ready";
const asrReady = () => { try { return !!localStorage.getItem(ASR_READY); } catch (e) { return false; } };
const warmWhisper = () => whisper(null).then(() => { try { localStorage.setItem(ASR_READY, "1"); } catch (e) {} }).catch(() => {});
let gpuCheck = null;
const hasGpu = () => gpuCheck || (gpuCheck = (async () => { try { return !!(navigator.gpu && await navigator.gpu.requestAdapter()); } catch (e) { return false; } })());
let micStarting = false;   // كبستين ورا بعض وهو بيجهّز ما بيفتحوا تسجيلين
async function startRec() {
  if (micStarting) return;
  micStarting = true;
  try {
    try { if (!(await micAllowed())) return; }
    catch (e) { setC("إكسل مانع المايك عن الإضافة." + winH); return; }
    const gpu = await hasGpu();
    if (gpu && asrReady()) return await startVad();
    if (SR && !srOff()) { if (gpu) warmWhisper(); return startLive(); }
    await startVad();
  } finally { micStarting = false; }
}

// ---------- ٠) Whisper + كاشف الكلام: الكلام بيتقطّع جمل، وكل جملة بتروح لـ Whisper مرّة وحدة ----------
let vadTestStream = null;   // للتجربة بس: مايك مُحاكى
async function startVad() {
  const a = $("ask"), base = a.value.trim();
  const me = { t0: Date.now(), text: "", chain: Promise.resolve(), busy: 0, err: "", vad: null };
  const show = () => { if (!me.cancelled) a.value = [base, me.text].filter(Boolean).join(" "); };   // بعد «إلغاء» ولا جملة بتنكتب
  const hint = t => { if (rec === me) $("livehint").textContent = t; };
  setC("بجهّز المايك…", true);
  try { await lib("ort"); await lib("vad"); }
  catch (e) { return startLocal(); }   // كاشف الكلام ما نزل: بنسجّل كلّه وبنفرّغه مرّة وحدة بالآخر
  warmWhisper();   // بيحمّل المحرّك (أو بينزّله أوّل مرّة) وإنت بتحكي
  try {
    me.vad = await vad.MicVAD.new({
      model: "v5", baseAssetPath: VAD_ASSETS, onnxWASMBasePath: ORT_ASSETS,
      positiveSpeechThreshold: 0.5, negativeSpeechThreshold: 0.35,
      redemptionMs: 700, minSpeechMs: 250, preSpeechPadMs: 300, submitUserSpeechOnPause: true,
      ...(vadTestStream ? { getStream: vadTestStream } : {}),
      onSpeechStart: () => hint("🎙 بسمعك…"),
      onSpeechEnd: audio => {
        me.busy++; hint("✍️ بكتب الجملة…");
        me.chain = me.chain.then(async () => {
          try {
            const t = (await whisper(audio)).trim();
            // كل مقطع صوت لحاله وما في تداخل بينهم، فبينضاف زي ما هو (جملة بتعيدها بتنكتب مرّتين، زي ما حكيتها)
            if (t && !JUNK.test(t)) { me.text = [me.text, t].filter(Boolean).join(" "); show(); }
          } catch (e) { me.err = e.message || String(e); }
          finally { if (--me.busy === 0) hint("🎙 كمّل احكي، أو اكبس المايك لمّا تخلّص"); }
        });
      }
    });
  } catch (e) {
    setC((e && e.name === "NotFoundError" ? "ما لقيت مايك. تأكّد إنّ مايك السمّاعة هو المختار بإعدادات الصوت بويندوز، أو"
      : "إكسل مانع المايك عن الإضافات بهالجهاز، وما في مكتبة بتقدر تتخطّى هاد.") + winH + ` (${(e && e.name) || e})`);
    return;
  }
  me.stop = async cancel => {
    if (cancel) me.cancelled = true;
    await me.vad.pause();   // آخر جملة لسّا بتنحكى بتنبعت للتفريغ
    clearInterval(me.timer);
    setRecUI(false);
    if (cancel) { if (me.vad.destroy) me.vad.destroy(); a.value = base; setC("انلغى التسجيل."); return; }
    $("mic").disabled = true;
    await new Promise(ok => setTimeout(ok, 400));
    if (me.busy) setC("بخلّص آخر جملة", true);
    while (me.busy > 0) await me.chain;
    if (me.vad.destroy) me.vad.destroy();
    $("mic").disabled = false;
    if (!me.text) setC(me.err ? "ما قدرت أحوّل الصوت لنصّ: " + me.err : "ما سمعت كلام واضح، جرّب كمان مرّة.");
    else { a.focus(); setC("✓ انكتب كلامك. راجعه وابعت."); }
  };
  me.timer = runTimer(me);
  rec = me;
  me.vad.start();
  setRecUI(true, "🎙 بسمعك… والكلام بينكتب بعد كل جملة"); setC("");
}

// ---------- ١) تفريغ المتصفّح ----------
function startLive() {
  const sr = new SR(), a = $("ask"), base = a.value.trim();
  const me = { sr, t0: Date.now(), started: Date.now(), quick: 0, langs: ["ar-JO", "ar-SA", "ar"], done: false, cancel: false };
  let done = "", cur = "", err = "";   // done: الجلسات اللي خلصت، cur: الجلسة هلّق (بتنبني من جديد مع كل نتيجة)
  sr.lang = me.langs.shift(); sr.continuous = true; sr.interimResults = true;
  sr.onresult = e => {
    cur = MaliSpeech.session(e.results);
    me.heard = true;
    a.value = [base, MaliSpeech.join(done, cur)].filter(Boolean).join(" ");
  };
  sr.onerror = e => { err = e.error; };
  sr.onend = () => {
    done = MaliSpeech.join(done, cur); cur = "";
    const final = done;
    // بيوقف لحاله بعد سكتة: بنرجّع نشغّله لحدّ ما المحاسب يكبس «خلّصت»
    if (!me.done) {
      if (err === "language-not-supported" && me.langs.length) { sr.lang = me.langs.shift(); err = ""; }
      const quickEnd = Date.now() - me.started < 1500 && !me.heard;
      me.quick = quickEnd ? me.quick + 1 : 0;
      const fatal = ["not-allowed", "service-not-allowed", "network", "audio-capture", "language-not-supported"].includes(err);
      if (!fatal && me.quick < 3 && Date.now() - me.t0 < MAX_REC * 1000) {
        err = ""; me.heard = false; me.started = Date.now();
        try { sr.start(); return; } catch (e) {}
      }
      if (!err && me.quick >= 3) err = "ends-at-once";
    }
    if (rec === me) rec = null;
    clearInterval(me.timer);
    setRecUI(false);
    if (me.cancel) { a.value = base; setC("انلغى التسجيل."); return; }
    a.value = [base, final.trim()].filter(Boolean).join(" ");
    // تفريغ المتصفّح مش شغّال هون (زي إكسل الكمبيوتر): من هلّق Whisper على الجهاز
    if (err && err !== "no-speech" && err !== "aborted" && !final.trim()) {
      try { localStorage.setItem(SR_OFF, err); } catch (e) {}
      setC(`تفريغ المتصفّح مش شغّال هون (${err})، بشغّلك محرّك الصوت اللي على جهازك.`);
      startVad();
      return;
    }
    if (!final.trim()) setC("ما سمعت كلام واضح، جرّب كمان مرّة.");
    else { a.focus(); setC("✓ انكتب كلامك. راجعه وابعت."); }
  };
  me.timer = runTimer(me);
  rec = me;
  sr.start();
  setRecUI(true, "بسمعك… والكلام بينكتب فوق"); setC("");
}

// ---------- ٢) Whisper على الجهاز، بـ Worker عشان اللوحة ما تعلق وهو بيشتغل ----------
const ASR_WORKER = `
import { pipeline } from "${ASR_LIB}";
let asr = null, cpuOnly = false;
const progress_callback = p => { if (p.status === "progress") self.postMessage({ type: "progress", file: p.file, loaded: p.loaded, total: p.total }); };
const GPU = ${JSON.stringify(ASR_GPU)}, CPU = ${JSON.stringify(ASR_CPU)};
async function make(useGpu) {
  const m = useGpu ? GPU : CPU;
  self.postMessage({ type: "plan", size: m.size, gpu: useGpu });
  return pipeline("automatic-speech-recognition", m.model, { device: useGpu ? "webgpu" : "wasm", dtype: m.dtype, progress_callback });
}
function load() {
  if (!asr) asr = (async () => {
    const hasGpu = !cpuOnly && !!(self.navigator.gpu && await self.navigator.gpu.requestAdapter().catch(() => null));
    if (hasGpu) try { return await make(true); } catch (e) {}
    return make(false);
  })();
  return asr;
}
const opts = { language: "arabic", task: "transcribe", chunk_length_s: 30, stride_length_s: 5 };
self.onmessage = async ({ data }) => {
  if (data.cpu) cpuOnly = true;
  try {
    const t = await load();
    if (!data.audio) return self.postMessage({ id: data.id, type: "done" });
    const out = await t(data.audio, opts);
    self.postMessage({ id: data.id, type: "done", text: out.text });
  } catch (e) { self.postMessage({ id: data.id, type: "error", message: String(e && e.message || e) }); }
};`;
// كرت الشاشة ممكن «يعلّق» (بيخرب المحرّك كلّه): بنفتح محرّك جديد، وإذا علّق كمان مرّة بنكمّل على المعالج
let asrWorker = null, asrSeq = 0, asrSize = "٢٥٠", asrCpu = false, asrUsedGpu = false;
const asrJobs = {}, asrFiles = {};
const DL = "بنزّل محرّك الصوت لجهازك";
async function whisper(audio) {
  for (let tries = 0; ; tries++) {
    try { return await whisperOnce(audio); }
    catch (e) {
      if (!asrUsedGpu || tries >= 2) throw e;
      if (asrWorker) asrWorker.terminate();
      asrWorker = null;
      if (tries >= 1) asrCpu = true;
    }
  }
}
function whisperOnce(audio) {
  if (!asrWorker) {
    asrUsedGpu = false;
    asrWorker = new Worker(URL.createObjectURL(new Blob([ASR_WORKER], { type: "text/javascript" })), { type: "module" });
    asrWorker.onmessage = ({ data: m }) => {
      if (m.type === "plan") { asrSize = m.size; asrUsedGpu = asrUsedGpu || m.gpu; return; }
      if (m.type === "progress") {
        asrFiles[m.file] = m;
        const f = Object.values(asrFiles), pct = Math.floor(100 * f.reduce((a, x) => a + (x.loaded || 0), 0) / Math.max(1, f.reduce((a, x) => a + (x.total || 0), 0)));
        if (pct < 100) setC(`${DL}، مرّة وحدة بس (حوالي ${asrSize} ميجا): ${pct}%`, true);
        return;
      }
      if ($("cstatus").textContent.startsWith(DL)) setC("");   // خلص التنزيل
      const j = asrJobs[m.id];
      delete asrJobs[m.id];
      if (j) m.type === "error" ? j.bad(new Error(m.message)) : j.ok(m.text || "");
    };
    asrWorker.onerror = e => { for (const k in asrJobs) { asrJobs[k].bad(new Error(e.message || "محرّك الصوت ما اشتغل")); delete asrJobs[k]; } asrWorker = null; };
  }
  const id = ++asrSeq;
  return new Promise((ok, bad) => { asrJobs[id] = { ok, bad }; asrWorker.postMessage({ id, audio, cpu: asrCpu }); });
}
// Whisper بياخد صوت 16kHz قناة وحدة
async function toPcm16k(blob) {
  const ac = new AudioContext({ sampleRate: 16000 });
  try { return (await ac.decodeAudioData(await blob.arrayBuffer())).getChannelData(0); } finally { ac.close().catch(() => {}); }
}

async function startLocal() {
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
  catch (e) {
    setC((e.name === "NotFoundError" ? "ما لقيت مايك. تأكّد إنّ مايك السمّاعة هو المختار بإعدادات الصوت بويندوز، أو"
      : "إكسل مانع المايك عن الإضافات بهالجهاز، وما في مكتبة بتقدر تتخطّى هاد.") + winH + ` (${e.name})`);
    return;
  }
  whisper(null).catch(() => {});   // بيبلّش ينزّل المحرّك وإنت بتحكي
  const mr = new MediaRecorder(stream), chunks = [], a = $("ask");
  const me = { mr, t0: Date.now(), cancel: false };
  mr.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  mr.onstop = async () => {
    stream.getTracks().forEach(t => t.stop());
    clearInterval(me.timer);
    if (rec === me) rec = null;
    setRecUI(false);
    if (me.cancel || !chunks.length) { setC(me.cancel ? "انلغى التسجيل." : ""); return; }
    $("mic").disabled = true;
    try {
      const audio = await toPcm16k(new Blob(chunks, { type: mr.mimeType }));
      setC("بحوّل صوتك لنصّ على جهازك", true);
      const text = (await whisper(audio)).trim();
      if (!text || JUNK.test(text)) { setC("ما سمعت كلام واضح، جرّب كمان مرّة."); return; }
      a.value = [a.value.trim(), text].filter(Boolean).join(" ");
      a.focus();
      setC("✓ انكتب كلامك. راجعه وابعت.");
    } catch (e) { setC("ما قدرت أحوّل الصوت لنصّ: " + (e.message || e)); }
    finally { $("mic").disabled = false; }
  };
  me.timer = runTimer(me);
  rec = me;
  mr.start(250);
  setRecUI(true, "بسمعك… اكبس المايك لمّا تخلّص"); setC("");
}

function stopRec(cancel = false) {
  if (!rec) return;
  const r = rec;
  rec = null;
  r.done = true; r.cancel = cancel;
  if (r.stop) r.stop(cancel); else if (r.mr) r.mr.stop(); else if (cancel) r.sr.abort(); else r.sr.stop();
}
$("mic").onclick = () => rec ? stopRec() : startRec();
$("reccancel").onclick = () => stopRec(true);
document.addEventListener("keydown", e => { if (e.key === "Escape" && rec) stopRec(true); });
try { if (sessionStorage.getItem("maliai.mic")) { sessionStorage.removeItem("maliai.mic"); setC("صار في إذن للمايك. اكبس 🎙 واحكي."); } } catch (e) {}

// =====================================================================
// 📱 الحكي من التلفون: QR بيربط تلفون الموظف بهالكمبيوتر بالزبط، والكلام بيوصل مشفّر عبر وسيطنا على أوراكل
// =====================================================================
// عنوان الوسيط (TryCloudflare) بيتغيّر، فـ MaliPair.relay() بيلاقيه لحاله من relay.json اللي بيكتبه السيرفر
const pairKey = () => MALI.pairKey;
let stopPhone = null, relayHint = "";
const seenPhone = new Set();
function pairSecret(renew) {
  let s = null;
  try { s = localStorage.getItem(pairKey()); } catch (e) {}
  if (!s || renew) { s = MaliPair.newSecret(); try { localStorage.setItem(pairKey(), s); } catch (e) {} }
  return s;
}
// السرّ بعد # عشان المتصفّح ما يبعته لـ GitHub ولا لأيّ سيرفر
const phoneUrl = s => location.href.split("#")[0].replace(/[^/]*$/, "phone.html") + "#k=" + s + (relayHint ? "&r=" + encodeURIComponent(relayHint) : "");
const pairState = (t, on = false) => { $("pairstate").textContent = t; $("pairstate").classList.toggle("on", on); };

async function listenPhone() {
  let s = null;
  try { s = localStorage.getItem(pairKey()); } catch (e) {}
  if (!s) return;
  if (stopPhone) stopPhone();
  const { topic, key } = await MaliPair.derive(s);
  stopPhone = MaliPair.listen(topic, async m => {
    if (seenPhone.has(m.id)) return;
    seenPhone.add(m.id);
    let p;
    try { p = await MaliPair.open(key, m.message); } catch (x) { return; }   // مش من تلفوننا: بنتجاهله
    if (p.ack) return;   // ردّنا إحنا
    // بنردّ «وصلني» عشان التلفون ما يكتب ✓ إلّا لمّا الكلام يوصل فعلاً
    if (p.n) MaliPair.seal(key, { ack: p.n }).then(b => MaliPair.post(topic, b)).catch(() => {});
    if (p.hello) { pairState("✓ التلفون مربوط. احكي فيه والكلام بيوصل هون.", true); return; }
    if (!p.text || !String(p.text).trim()) return;
    const a = $("ask");
    a.value = [a.value.trim(), String(p.text).trim()].filter(Boolean).join(" ");
    MALI.showChat(); a.focus();
    pairState("✓ وصل كلام من التلفون.", true);
    setC("📱 وصل كلامك من التلفون. راجعه وابعت.");
  });
}

async function showPair(renew) {
  relayHint = await MaliPair.relay();
  if (!relayHint) { pairState("الوسيط على السيرفر مش واصل هلّق، جرّب كمان شوي."); return; }
  const s = pairSecret(renew);
  try {
    await lib("qr");
    const q = qrcode(0, "M");
    q.addData(phoneUrl(s));
    q.make();
    $("qr").innerHTML = q.createSvgTag(4, 0);
  } catch (e) { $("qr").textContent = "ما قدرت أرسم الرمز، استعمل «انسخ الرابط»."; }
  if (renew) pairState("رمز جديد: التلفون القديم انفصل. صوّر الرمز من جديد.");
  else if (!$("pairstate").classList.contains("on")) pairState("بستنّى التلفون…");
  listenPhone();
}
$("phone").onclick = () => {
  const open = $("pairbox").hidden;
  $("pairbox").hidden = !open;
  $("phone").setAttribute("aria-expanded", open);
  if (open) showPair(false);
};
$("pairnew").onclick = () => showPair(true);
$("paircopy").onclick = async () => {
  try { await navigator.clipboard.writeText(phoneUrl(pairSecret(false))); pairState("✓ انتسخ الرابط. ابعته لتلفونك وافتحه هناك."); }
  catch (e) { pairState("ما قدرت أنسخ، صوّر الرمز."); }
};


// رسالة حالة عامّة: تبويب الفواتير بإكسل إله سطره، والباقي بسطر المحادثة
function setStatus(t) { const el = $("status") || $("cstatus"); if (el) el.textContent = t; }
document.onpaste = e => attachFiles(e.clipboardData.files);   // الصفحة بتقدر تبدّلها

function maliStart() {
  fillCfg();
  loadVault();
  loadChat();
  listenPhone();   // إذا التلفون مربوط من قبل، الكلام بيوصل حتى لو اللوحة مسكّرة
  Office.onReady(info => { inHost = info.host === MALI.host; });
}
