import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CONFIG } from "./config.js";
import * as C from "./crypto.js";

const sb = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
const $ = (s) => document.querySelector(s);
const AI = { id: "ai", username: "CoChatAI", isAI: true };

const S = {
  recovering: false, afterRecovery: null,
  user: null, profile: null, priv: null,
  contacts: [], active: null,
  unread: {}, seen: new Set(),
  typingCh: null, typingTimer: null, lastTypingSent: 0,
};

// ───────── Hilfsfunktionen ─────────
const show = (id) => {
  ["auth", "setup", "unlock", "recovery", "newpass", "app"].forEach((x) => $("#" + x).classList.toggle("hidden", x !== id));
};
function showFatal(e) {
  console.error(e);
  show("auth");
  say($("#auth-msg"), "Fehler beim Start: " + errText(e));
}
const say = (el, text, ok = false) => { el.textContent = text; el.classList.toggle("ok", ok); };
const fmtTime = (d) => new Date(d).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
const fmtDay = (d) => new Date(d).toLocaleDateString("de-DE", { weekday: "long", day: "numeric", month: "long" });
const validCode = (c) => /^[\x21-\x7E]{8,32}$/.test(c) && /[A-Za-z]/.test(c) && /\d/.test(c);
const errText = (e) => e?.message || String(e);

// ───────── Start ─────────
async function init() {
  wireAuthUI();
  sb.auth.onAuthStateChange((ev) => {
    if (ev === "PASSWORD_RECOVERY") { S.recovering = true; show("newpass"); }
    if (ev === "SIGNED_OUT") location.reload();
  });
  const { data: { session } } = await sb.auth.getSession();
  if (S.recovering) return;                    // Nutzer kommt vom „Passwort vergessen"-Link
  if (!session) return show("auth");
  await afterLogin(session.user);
}

/** Einen Wiederherstellungsschlüssel anzeigen; der Nutzer muss bestätigen, dass er ihn gesichert hat. */
function showRecovery(key, label, next) {
  $("#recovery-key").textContent = key;
  $("#btn-recovery-done").textContent = label;
  $("#recovery-ack").checked = false;
  $("#btn-recovery-done").disabled = true;
  S.afterRecovery = next;
  show("recovery");
}

/** Passwort neu setzen (Login + Verschlüsselung) mit dem Wiederherstellungsschlüssel. */
async function recoverWith(recoveryKey, newPassword) {
  const r = await C.recoverWithKey(S.profile, recoveryKey, newPassword);   // prüft den Schlüssel zuerst
  const { error: e1 } = await sb.auth.updateUser({ password: newPassword });
  if (e1) throw e1;
  const { error: e2 } = await sb.from("profiles").update(r.fields).eq("id", S.user.id);
  if (e2) throw e2;
  Object.assign(S.profile, r.fields);
  S.priv = r.key;
}

async function afterLogin(user) {
  S.user = user;
  const { data: profile } = await sb.from("profiles").select("*").eq("id", user.id).maybeSingle();
  if (!profile) return show("setup");          // z. B. nach Google-Login
  S.profile = profile;
  show("unlock");                              // Schlüssel braucht das Passwort
}

// ───────── Auth-UI ─────────
function wireAuthUI() {
  const tabL = $("#tab-login"), tabR = $("#tab-register");
  tabL.onclick = () => { tabL.classList.add("active"); tabR.classList.remove("active"); $("#form-login").classList.remove("hidden"); $("#form-register").classList.add("hidden"); };
  tabR.onclick = () => { tabR.classList.add("active"); tabL.classList.remove("active"); $("#form-register").classList.remove("hidden"); $("#form-login").classList.add("hidden"); };
  $("#gen-code").onclick = () => { $("#form-register [name=code]").value = C.randomCode(); };
  $("#gen-code2").onclick = () => { $("#form-setup [name=code]").value = C.randomCode(); };

  // Anmelden
  $("#form-login").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target), msg = $("#auth-msg");
    say(msg, "Anmelden …");
    const { data, error } = await sb.auth.signInWithPassword({ email: f.get("email").trim(), password: f.get("password") });
    if (error) return say(msg, error.message === "Email not confirmed" ? "Bitte bestätige zuerst deine E-Mail." : "Anmeldung fehlgeschlagen: " + error.message);
    S.user = data.user;
    const { data: profile } = await sb.from("profiles").select("*").eq("id", data.user.id).maybeSingle();
    if (!profile) return show("setup");
    S.profile = profile;
    try { S.priv = await C.unlockPrivateKey(profile, f.get("password")); }
    catch { return say(msg, "Schlüssel konnte nicht entsperrt werden (falsches Passwort?)."); }
    startApp();
  };

  // Registrieren
  $("#form-register").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target), msg = $("#auth-msg");
    const username = f.get("username").trim(), code = f.get("code").trim();
    if (!/^[\w.-]{3,24}$/.test(username)) return say(msg, "Benutzername: 3–24 Zeichen (Buchstaben, Zahlen, . _ -).");
    if (!validCode(code)) return say(msg, "Sicherheitscode: 8–32 Zeichen, mindestens ein Buchstabe und eine Zahl, keine Leerzeichen.");
    say(msg, "Prüfe Verfügbarkeit …");
    const { data: av, error: avErr } = await sb.rpc("is_available", { p_username: username, p_code: code });
    if (avErr) return say(msg, errText(avErr));
    if (!av.username_free) return say(msg, "Dieser Benutzername ist schon vergeben.");
    if (!av.code_free) return say(msg, "Dieser Sicherheitscode ist schon vergeben – bitte einen anderen wählen.");
    say(msg, "Erzeuge Schlüssel …");
    const { meta: keys, recoveryKey } = await C.generateKeyMaterial(f.get("password"));
    const { error } = await sb.auth.signUp({
      email: f.get("email").trim(), password: f.get("password"),
      options: { emailRedirectTo: location.origin + location.pathname, data: { username, security_code: code, ...keys } },
    });
    if (error) return say(msg, error.message);
    // Wiederherstellungsschlüssel einmalig anzeigen; danach Bestätigungs-E-Mail abwarten
    showRecovery(recoveryKey, "Weiter zur Anmeldung", () => {
      show("auth");
      say($("#auth-msg"), "Fast geschafft! Wir haben dir einen Bestätigungslink per E-Mail gesendet. Danach kannst du dich anmelden.", true);
    });
  };

  // Passwort vergessen (Login-Seite): Reset-Link per E-Mail
  $("#btn-forgot").onclick = async () => {
    const msg = $("#auth-msg"), email = $("#form-login [name=email]").value.trim();
    if (!email) return say(msg, "Bitte zuerst oben deine E-Mail eintragen.");
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
    if (error) return say(msg, error.message);
    say(msg, "Wenn die E-Mail existiert, haben wir dir einen Link zum Zurücksetzen geschickt. Du brauchst danach deinen Wiederherstellungsschlüssel.", true);
  };

  // Neues Passwort nach Reset-Link (zusammen mit dem Wiederherstellungsschlüssel)
  $("#form-newpass").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target), msg = $("#newpass-msg");
    say(msg, "Prüfe Schlüssel …");
    try {
      const { data: { user } } = await sb.auth.getUser();
      S.user = user;
      const { data: profile } = await sb.from("profiles").select("*").eq("id", user.id).maybeSingle();
      if (!profile) return say(msg, "Kein Profil gefunden.");
      S.profile = profile;
      await recoverWith(f.get("recovery"), f.get("password"));
      S.recovering = false;
      startApp();
    } catch (err) {
      say(msg, "Das hat nicht geklappt – Wiederherstellungsschlüssel prüfen. (" + errText(err) + ")");
    }
  };

  // Wiederherstellungsschlüssel-Bildschirm
  $("#btn-copy-recovery").onclick = async () => {
    const key = $("#recovery-key").textContent;
    try { await navigator.clipboard.writeText(key); $("#btn-copy-recovery").textContent = "Kopiert ✓"; }
    catch { const r = document.createRange(); r.selectNodeContents($("#recovery-key")); getSelection().removeAllRanges(); getSelection().addRange(r); }
  };
  $("#recovery-ack").onchange = (e) => { $("#btn-recovery-done").disabled = !e.target.checked; };
  $("#btn-recovery-done").onclick = () => S.afterRecovery?.();

  // Google
  $("#btn-google").onclick = () => sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: location.origin + location.pathname } });

  // Profil nach Google anlegen
  $("#form-setup").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target), msg = $("#setup-msg");
    const username = f.get("username").trim(), code = f.get("code").trim();
    if (!/^[\w.-]{3,24}$/.test(username)) return say(msg, "Benutzername: 3–24 Zeichen (Buchstaben, Zahlen, . _ -).");
    if (!validCode(code)) return say(msg, "Sicherheitscode: 8–32 Zeichen, mindestens ein Buchstabe und eine Zahl.");
    const { data: av } = await sb.rpc("is_available", { p_username: username, p_code: code });
    if (!av?.username_free) return say(msg, "Benutzername schon vergeben.");
    if (!av?.code_free) return say(msg, "Sicherheitscode schon vergeben.");
    say(msg, "Erzeuge Schlüssel …");
    const { meta: keys, recoveryKey } = await C.generateKeyMaterial(f.get("password"));
    const { error } = await sb.rpc("create_profile", {
      p_username: username, p_code: code, p_public_key: keys.public_key,
      p_enc_private_key: keys.enc_private_key, p_salt: keys.key_salt, p_iv: keys.key_iv,
      p_rec_enc: keys.rec_enc_private_key, p_rec_salt: keys.rec_salt, p_rec_iv: keys.rec_iv,
    });
    if (error) return say(msg, errText(error));
    const { data: profile } = await sb.from("profiles").select("*").eq("id", S.user.id).single();
    S.profile = profile;
    S.priv = await C.unlockPrivateKey(profile, f.get("password"));
    showRecovery(recoveryKey, "Weiter zu CoChat", startApp);
  };

  // Entsperren
  $("#form-unlock").onsubmit = async (e) => {
    e.preventDefault();
    try {
      S.priv = await C.unlockPrivateKey(S.profile, new FormData(e.target).get("password"));
      startApp();
    } catch { say($("#unlock-msg"), "Falsches Passwort."); }
  };
  $("#btn-logout-unlock").onclick = logout;

  // Passwort vergessen (nach Neuladen, schon eingeloggt): per Wiederherstellungsschlüssel
  $("#btn-forgot-unlock").onclick = () => {
    $("#form-unlock").classList.add("hidden");
    $("#form-recover").classList.remove("hidden");
  };
  $("#btn-recover-back").onclick = () => {
    $("#form-recover").classList.add("hidden");
    $("#form-unlock").classList.remove("hidden");
  };
  $("#form-recover").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target), msg = $("#unlock-msg");
    say(msg, "Prüfe Schlüssel …");
    try { await recoverWith(f.get("recovery"), f.get("password")); startApp(); }
    catch (err) { say(msg, "Das hat nicht geklappt – Wiederherstellungsschlüssel prüfen. (" + errText(err) + ")"); }
  };
}

const logout = async () => { await sb.auth.signOut(); location.reload(); };

// ───────── App ─────────
async function startApp() {
  show("app");
  $("#p-name").textContent = S.profile.username;
  $("#p-code").textContent = S.profile.security_code;
  $("#btn-profile").onclick = () => $("#dlg-profile").showModal();
  $("#btn-close-profile").onclick = () => $("#dlg-profile").close();
  $("#btn-logout").onclick = logout;
  $("#btn-clear-ai").onclick = async () => {
    await sb.from("ai_messages").delete().eq("user_id", S.user.id);
    if (S.active?.isAI) { $("#messages").innerHTML = ""; }
    $("#dlg-profile").close();
  };
  $("#btn-add").onclick = () => { $("#add-msg").textContent = ""; $("#form-add").reset(); $("#dlg-add").showModal(); };
  $("#form-add").onsubmit = async (e) => {
    if (e.submitter?.value !== "ok") return;
    e.preventDefault();
    const q = new FormData(e.target).get("q").trim();
    const { error } = await sb.rpc("add_contact", { p_query: q });
    if (error) return say($("#add-msg"), error.message);
    $("#dlg-add").close();
    await loadContacts();
  };
  $("#btn-back").onclick = () => { $("#app").classList.remove("chat-open"); S.active = null; renderContacts(); };
  $("#composer").onsubmit = onSend;
  $("#input").addEventListener("input", onTypingInput);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) markRead(); });
  window.addEventListener("focus", markRead);

  await loadContacts();
  await sb.from("messages").update({ status: "delivered" }).eq("recipient_id", S.user.id).eq("status", "sent");
  subscribe();
}

async function loadContacts() {
  const { data: links } = await sb.from("contacts").select("contact_id").eq("owner_id", S.user.id);
  const ids = (links ?? []).map((l) => l.contact_id);
  let profiles = [];
  if (ids.length) {
    const { data } = await sb.from("profiles").select("id, username, public_key").in("id", ids);
    profiles = data ?? [];
  }
  profiles.sort((a, b) => a.username.localeCompare(b.username, "de"));
  S.contacts = [AI, ...profiles];

  // ungelesene Nachrichten zählen
  const { data: unread } = await sb.from("messages").select("sender_id").eq("recipient_id", S.user.id).neq("status", "read");
  S.unread = {};
  (unread ?? []).forEach((m) => { S.unread[m.sender_id] = (S.unread[m.sender_id] || 0) + 1; });
  renderContacts();
}

function renderContacts() {
  const ul = $("#contact-list");
  ul.innerHTML = "";
  for (const c of S.contacts) {
    const li = document.createElement("li");
    if (S.active?.id === c.id) li.classList.add("active");
    const av = document.createElement("div");
    av.className = "avatar" + (c.isAI ? " ai" : "");
    av.textContent = c.isAI ? "✦" : c.username[0].toUpperCase();
    const body = document.createElement("div");
    body.className = "li-body";
    const name = document.createElement("strong");
    name.textContent = c.username;
    if (c.isAI) { const b = document.createElement("span"); b.className = "ai-badge"; b.textContent = "KI"; name.append(b); }
    const sub = document.createElement("small");
    sub.textContent = c.isAI ? "Dein KI-Assistent" : "Ende-zu-Ende-verschlüsselt";
    body.append(name, sub);
    li.append(av, body);
    if (S.unread[c.id]) { const b = document.createElement("span"); b.className = "badge"; b.textContent = S.unread[c.id]; li.append(b); }
    li.onclick = () => openChat(c);
    ul.append(li);
  }
}

// ───────── Chat öffnen ─────────
async function openChat(c) {
  S.active = c;
  S.seen.clear();
  $("#empty-state").classList.add("hidden");
  $("#chat-pane").classList.remove("hidden");
  $("#app").classList.add("chat-open");
  const av = $("#chat-avatar");
  av.className = "avatar" + (c.isAI ? " ai" : "");
  av.textContent = c.isAI ? "✦" : c.username[0].toUpperCase();
  $("#chat-title").textContent = c.username;
  $("#chat-sub").textContent = c.isAI ? "KI-Assistent · Gemini" : "Ende-zu-Ende-verschlüsselt";
  $("#messages").innerHTML = "";
  setupTypingChannel(c);
  renderContacts();

  if (c.isAI) {
    const { data } = await sb.from("ai_messages").select("*").eq("user_id", S.user.id).order("created_at");
    (data ?? []).forEach(addAiBubble);
  } else {
    const me = S.user.id, o = c.id;
    const { data } = await sb.from("messages").select("*")
      .or(`and(sender_id.eq.${me},recipient_id.eq.${o}),and(sender_id.eq.${o},recipient_id.eq.${me})`)
      .order("created_at");
    for (const m of data ?? []) await addMessageBubble(m);
    await markRead();
  }
  scrollDown();
  $("#input").focus();
}

// ───────── Darstellung ─────────
let lastDay = "";
function maybeDay(ts) {
  const d = new Date(ts).toDateString();
  if (d === lastDay) return;
  lastDay = d;
  const el = document.createElement("div");
  el.className = "day"; el.textContent = fmtDay(ts);
  $("#messages").append(el);
}
const scrollDown = () => { const m = $("#messages"); m.scrollTop = m.scrollHeight; };

function tickEl(status) {
  const t = document.createElement("span");
  t.className = "tick" + (status === "read" ? " read" : "");
  t.textContent = status === "sent" ? "✓" : "✓✓";
  return t;
}

function bubble({ id, text, out, ts, status, ai }) {
  if (S.seen.has(id)) return;
  S.seen.add(id);
  const m = $("#messages");
  if (m.children.length === 0) lastDay = "";
  maybeDay(ts);
  const b = document.createElement("div");
  b.className = "bubble" + (out ? " out" : "") + (ai ? " ai" : "");
  b.dataset.id = id;
  if (ai) { const w = document.createElement("span"); w.className = "who"; w.textContent = "CoChatAI · KI"; b.append(w); }
  const t = document.createElement("span"); t.textContent = text; b.append(t);
  const meta = document.createElement("div"); meta.className = "meta";
  meta.append(fmtTime(ts));
  if (out && status) meta.append(tickEl(status));
  b.append(meta);
  m.append(b);
  hideTyping();
}

function addAiBubble(r) { bubble({ id: r.id, text: r.content, out: r.role === "user", ts: r.created_at, ai: r.role === "model" }); }

async function addMessageBubble(m) {
  let text;
  try {
    const mine = m.sender_id === S.user.id;
    text = await C.decryptMessage(S.priv, mine ? m.key_for_sender : m.key_for_recipient, m.iv, m.ciphertext);
  } catch { text = "🔒 Nachricht konnte nicht entschlüsselt werden."; }
  bubble({ id: m.id, text, out: m.sender_id === S.user.id, ts: m.created_at, status: m.status });
}

function setTick(id, status) {
  const b = document.querySelector(`.bubble[data-id="${id}"] .meta`);
  if (!b) return;
  b.querySelector(".tick")?.remove();
  b.append(tickEl(status));
}

// ───────── Tippen-Indikator ─────────
function showTyping() {
  if ($("#typing-bubble")) { scrollDown(); return; }
  const el = document.createElement("div");
  el.id = "typing-bubble"; el.className = "bubble typing";
  el.innerHTML = "<i></i><i></i><i></i>";
  $("#messages").append(el); scrollDown();
}
function hideTyping() { $("#typing-bubble")?.remove(); }

function setupTypingChannel(c) {
  if (S.typingCh) { sb.removeChannel(S.typingCh); S.typingCh = null; }
  if (c.isAI) return;
  const key = [S.user.id, c.id].sort().join("_");
  S.typingCh = sb.channel("typing:" + key)
    .on("broadcast", { event: "typing" }, ({ payload }) => {
      if (payload.from !== c.id) return;
      showTyping();
      clearTimeout(S.typingTimer);
      S.typingTimer = setTimeout(hideTyping, 3000);
    })
    .subscribe();
}
function onTypingInput() {
  if (!S.typingCh || !S.active || S.active.isAI) return;
  const now = Date.now();
  if (now - S.lastTypingSent < 1500) return;
  S.lastTypingSent = now;
  S.typingCh.send({ type: "broadcast", event: "typing", payload: { from: S.user.id } });
}

// ───────── Senden ─────────
async function onSend(e) {
  e.preventDefault();
  const input = $("#input"), text = input.value.trim();
  if (!text || !S.active) return;
  input.value = "";
  if (S.active.isAI) return sendToAI(text);

  const c = S.active;
  try {
    const enc = await C.encryptMessage(text, c.public_key, S.profile.public_key);
    const { data, error } = await sb.from("messages")
      .insert({ sender_id: S.user.id, recipient_id: c.id, ...enc }).select().single();
    if (error) throw error;
    bubble({ id: data.id, text, out: true, ts: data.created_at, status: "sent" });
    scrollDown();
  } catch (err) {
    input.value = text;
    alert("Senden fehlgeschlagen: " + errText(err));
  }
}

async function sendToAI(text) {
  const { data, error } = await sb.from("ai_messages")
    .insert({ user_id: S.user.id, role: "user", content: text }).select().single();
  if (error) return alert(errText(error));
  addAiBubble(data); showTyping(); scrollDown();
  const { error: fnErr } = await sb.functions.invoke("cochat-ai");
  if (fnErr) { hideTyping(); }
}

// ───────── Gelesen-Status ─────────
async function markRead() {
  const c = S.active;
  if (!c || c.isAI || document.hidden) return;
  const { error } = await sb.from("messages").update({ status: "read" })
    .eq("recipient_id", S.user.id).eq("sender_id", c.id).neq("status", "read");
  if (!error && S.unread[c.id]) { delete S.unread[c.id]; renderContacts(); }
}

// ───────── Realtime ─────────
function subscribe() {
  const me = S.user.id;
  sb.channel("inbox:" + me)
    // eingehende Nachrichten
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages", filter: `recipient_id=eq.${me}` }, async ({ new: m }) => {
      if (!S.contacts.some((c) => c.id === m.sender_id)) await loadContacts();
      await sb.from("messages").update({ status: "delivered" }).eq("id", m.id).eq("status", "sent");
      if (S.active?.id === m.sender_id) {
        m.status = "delivered";
        await addMessageBubble(m); scrollDown();
        await markRead();
      } else {
        S.unread[m.sender_id] = (S.unread[m.sender_id] || 0) + 1;
        renderContacts();
      }
    })
    // Status-Änderungen eigener Nachrichten (angekommen / gelesen)
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "messages", filter: `sender_id=eq.${me}` }, ({ new: m }) => setTick(m.id, m.status))
    // KI-Antworten
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "ai_messages", filter: `user_id=eq.${me}` }, ({ new: r }) => {
      if (S.active?.isAI) { addAiBubble(r); scrollDown(); }
    })
    // jemand hat mich als Kontakt hinzugefügt
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "contacts", filter: `owner_id=eq.${me}` }, () => loadContacts())
    .subscribe();
}

// Ganz am Ende starten, damit alle Konstanten und Funktionen oben schon definiert sind
init().catch(showFatal);
