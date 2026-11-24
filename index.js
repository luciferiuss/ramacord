import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import bcrypt from "bcryptjs";
import { randomUUID, randomInt, timingSafeEqual, createHash } from "crypto";
import { fileURLToPath } from "url";
import multer from "multer";
import path from "path";
import fs from "fs";
import os from "os";
import dns from "dns";
import net from "net";
import httpLib from "http";
import httpsLib from "https";
import { AccessToken, RoomServiceClient } from "livekit-server-sdk";
import db from "./db.js";

// Все пути считаем от папки проекта, чтобы не зависеть от того, откуда запущен сервер
const ROOT = import.meta.dirname;
const STARTED_AT = Date.now(); // когда запущен этот процесс (по нему видно, что сервер действительно перезапустился)
const ENTRY_FILE = fileURLToPath(import.meta.url);
// Кто следит за процессом и поднимет его после перезапуска
function supervisor() {
  if (process.env.pm_id !== undefined || process.env.PM2_HOME) return "PM2";
  if (process.env.INVOCATION_ID || process.env.JOURNAL_STREAM) return "systemd";
  try { if (fs.existsSync("/.dockerenv")) return "Docker"; } catch {}
  return null;
}
const mtime = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
const UPLOADS = path.join(ROOT, "uploads");
const AVATARS = path.join(UPLOADS, "avatars");
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const sha = (v) => createHash("sha256").update(v).digest();
const same = (a, b) => timingSafeEqual(sha(a), sha(b)); // сравнение без утечки по времени

// Каналами управляет один администратор. Его ник можно задать в ADMIN_NAME,
// а если переменной нет, администратором считается самый первый зарегистрированный аккаунт
const ADMIN_NAME = (process.env.ADMIN_NAME || "").trim().toLowerCase();
function isAdminName(name) {
  if (ADMIN_NAME) return String(name).toLowerCase() === ADMIN_NAME;
  const first = db.prepare("SELECT name FROM users ORDER BY id LIMIT 1").get();
  return !!first && first.name === name;
}
const NOT_ADMIN = { error: "Управлять каналами может только администратор" };
const NOT_MOD = { error: "Нужны права модератора" };

// Настройки сервера хранятся в базе (переживают перезапуск)
const getSetting = (k, d = null) => db.prepare("SELECT value FROM settings WHERE key = ?").get(k)?.value ?? d;
const setSetting = (k, v) =>
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(k, String(v));
const delSetting = (k) => db.prepare("DELETE FROM settings WHERE key = ?").run(k);
const flag = (k) => getSetting(k) === "1";
const currentInvite = () => getSetting("invite_code") ?? INVITE_CODE; // код можно сменить из админ-панели

// Журнал действий администраторов и модераторов (храним последние 1000 записей)
function audit(actor, action, details = "") {
  db.prepare("INSERT INTO audit (ts, actor, action, details) VALUES (?, ?, ?, ?)").run(
    Date.now(), String(actor), String(action), String(details).slice(0, 300)
  );
  db.prepare("DELETE FROM audit WHERE id <= (SELECT MAX(id) FROM audit) - 1000").run();
}

function isModName(name) {
  if (isAdminName(name)) return true;
  return !!db.prepare("SELECT moderator AS m FROM users WHERE name = ?").get(String(name))?.m;
}

// Функции, которые администратор включает тумблерами (все выключены по умолчанию).
// Новая функция добавляется сюда: { id, group, label }
const FEATURES = [
  { id: "unread", group: "Чат", label: "Непрочитанные сообщения и упоминания @ник" },
  { id: "reply", group: "Чат", label: "Ответ на сообщение" },
  { id: "edit", group: "Чат", label: "Редактирование своих сообщений" },
  { id: "reactions", group: "Чат", label: "Реакции эмодзи" },
  { id: "media", group: "Чат", label: "Видео, аудио и просмотр картинок в чате" },
  { id: "paste", group: "Чат", label: "Вставка файлов через Ctrl+V и перетаскивание" },
  { id: "links", group: "Чат", label: "Кликабельные ссылки" },
  { id: "linkpreview", group: "Чат", label: "Предпросмотр ссылок (название и описание)" },
  { id: "format", group: "Чат", label: "Форматирование: жирный, курсив, код" },
  { id: "typing", group: "Чат", label: "Индикатор «печатает…»" },
  { id: "search", group: "Чат", label: "Поиск по каналу" },
  { id: "pins", group: "Чат", label: "Закреплённые сообщения" },
  { id: "notify", group: "Чат", label: "Уведомления и звук о новых сообщениях" },
  { id: "dm", group: "Личное общение", label: "Личные сообщения" },
  { id: "status", group: "Личное общение", label: "Статусы: в сети, отошёл, не беспокоить, своя строчка" },
  { id: "profile", group: "Личное общение", label: "Профиль: о себе, дата регистрации, где в голосе" },
  { id: "dm_clear", group: "Личное общение", label: "Очистка личной переписки (сообщения исчезают у обоих)" },
  { id: "dm_delete", group: "Личное общение", label: "Удаление личной переписки (исчезает у обоих)" },
  { id: "ns_pro", group: "Голос", label: "Улучшенное шумоподавление: умные ворота, de-click и сила" },
  { id: "ns_dfn", group: "Голос", label: "Усиленное шумоподавление DeepFilterNet3 (PoC)" },
];
const feat = (id) => flag("feat:" + id);
const FEATURE_OFF = { error: "Эта функция выключена администратором" };
const REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🎉", "🔥", "👀"];

// ===== Сообщения: ответы, реакции, упоминания =====
const MSG_COLS =
  "id, deleted, user_name AS name, text, file_url AS fileUrl, file_name AS fileName, created_at AS createdAt, reply_to AS replyTo, edited, pinned";

function reactionsOf(id) {
  const o = {};
  for (const r of db.prepare("SELECT emoji, user_name AS name FROM reactions WHERE message_id = ? ORDER BY rowid").all(id)) {
    (o[r.emoji] ||= []).push(r.name);
  }
  return o;
}

// Добавляем к сообщениям реакции и краткую цитату того, на что они отвечают
function decorateMessages(rows) {
  if (!rows.length) return rows;
  const marks = (n) => Array(n).fill("?").join(",");
  const byMsg = new Map();
  for (const r of db
    .prepare(`SELECT message_id AS id, emoji, user_name AS name FROM reactions WHERE message_id IN (${marks(rows.length)})`)
    .all(...rows.map((r) => r.id))) {
    if (!byMsg.has(r.id)) byMsg.set(r.id, {});
    (byMsg.get(r.id)[r.emoji] ||= []).push(r.name);
  }
  const replyIds = [...new Set(rows.map((r) => r.replyTo).filter(Boolean))];
  const replies = new Map();
  if (replyIds.length) {
    for (const r of db
      .prepare(`SELECT id, user_name AS name, text, deleted, file_name AS fileName FROM messages WHERE id IN (${marks(replyIds.length)})`)
      .all(...replyIds)) {
      replies.set(r.id, { id: r.id, name: r.name, text: r.deleted ? "" : String(r.text || "").slice(0, 120), deleted: !!r.deleted, file: !!r.fileName });
    }
  }
  return rows.map((r) => ({
    ...r,
    edited: !!r.edited,
    pinned: !!r.pinned,
    reactions: byMsg.get(r.id) || {},
    reply: r.replyTo ? replies.get(r.replyTo) || { id: r.replyTo, gone: true } : null,
  }));
}

function pruneReactions() {
  db.prepare("DELETE FROM reactions WHERE message_id NOT IN (SELECT id FROM messages)").run();
}

// ===== Личные сообщения: это скрытые каналы вида «dm», доступные только двум участникам =====
// Поэтому ответы, реакции, правка, поиск и файлы работают в них так же, как в обычных каналах.
const isDmChannel = (id) => !!db.prepare("SELECT 1 AS x FROM channels WHERE id = ? AND kind = 'dm'").get(Number(id));
const dmKey = (a, b) => "dm:" + Math.min(a, b) + ":" + Math.max(a, b);
const STATUS_MODES = ["online", "away", "dnd"];
function onlineNames() {
  const set = new Set();
  for (const [, s] of io.sockets.sockets) set.add(s.data.name);
  return set;
}
function dmListFor(uid) {
  const online = onlineNames();
  return db
    .prepare(
      `SELECT c.id AS id, u.name AS other, u.status_mode AS mode, u.status_text AS text,
              (SELECT MAX(id) FROM messages WHERE channel_id = c.id) AS lastId, c.keep AS keep
         FROM channels c
         JOIN dm_members me ON me.channel_id = c.id AND me.user_id = ?
         JOIN dm_members ot ON ot.channel_id = c.id AND ot.user_id != ?
         JOIN users u ON u.id = ot.user_id
        WHERE c.kind = 'dm' AND u.banned = 0
        ORDER BY lastId DESC`
    )
    .all(uid, uid)
    .filter((r) => r.lastId || r.keep) // пустые переписки не показываем, кроме специально очищенных
    .map((r) => ({ id: r.id, with: r.other, online: online.has(r.other), mode: r.mode || "online", text: r.text || "", lastId: r.lastId }));
}
const dmMembers = (id) => db.prepare("SELECT user_id FROM dm_members WHERE channel_id = ?").all(Number(id)).map((r) => r.user_id);
function emitToUsers(uids, event, payload) {
  const set = new Set(uids);
  for (const [, s] of io.sockets.sockets) if (set.has(s.data.uid)) s.emit(event, payload);
}
function notifyDm(chId) { // обоим участникам: список переписок изменился
  const uids = new Set(db.prepare("SELECT user_id FROM dm_members WHERE channel_id = ?").all(chId).map((r) => r.user_id));
  for (const [, s] of io.sockets.sockets) if (uids.has(s.data.uid)) s.emit("dm:update");
}

function mentionsUser(text, name) {
  try {
    const esc = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp("(?<![\\p{L}\\p{N}_])@" + esc + "(?![\\p{L}\\p{N}_-])", "iu").test(String(text));
  } catch {
    return false;
  }
}

// «Прочитано до»: запоминаем последнее сообщение канала, которое человек видел
function markRead(socket, chId) {
  const mx = db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM messages WHERE channel_id = ?").get(chId).m;
  db.prepare(
    "INSERT INTO reads (user_id, channel_id, last_id) VALUES (?, ?, ?) ON CONFLICT(user_id, channel_id) DO UPDATE SET last_id = excluded.last_id"
  ).run(socket.data.uid, chId, mx);
}

// Сколько непрочитанных (и упоминаний) в каждом доступном текстовом канале
function unreadState(socket) {
  const out = {};
  for (const ch of db.prepare("SELECT id, kind FROM channels WHERE kind IN ('text', 'dm')").all()) {
    if (ch.kind === "dm" ? !feat("dm") : !feat("unread")) continue;
    if (!hasAccess(socket, ch.id)) continue;
    const row = db.prepare("SELECT last_id FROM reads WHERE user_id = ? AND channel_id = ?").get(socket.data.uid, ch.id);
    if (!row) { // первый раз: всё старое считаем прочитанным, чтобы не было лавины
      markRead(socket, ch.id);
      continue;
    }
    const msgs = db
      .prepare("SELECT text FROM messages WHERE channel_id = ? AND id > ? AND deleted = 0 AND user_name != ?")
      .all(ch.id, row.last_id, socket.data.name);
    if (msgs.length) out[ch.id] = { n: msgs.length, m: msgs.filter((x) => mentionsUser(x.text, socket.data.name)).length };
  }
  return out;
}

// ===== Предпросмотр ссылок: сервер сам открывает страницу, поэтому закрываем доступ во внутреннюю сеть =====
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === "::1" || l === "::" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe8") || l.startsWith("fe9") || l.startsWith("fea") || l.startsWith("feb")) return true;
    const dotted = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (dotted) return isPrivateIp(dotted[1]);
    const hex = l.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const x = parseInt(hex[1], 16), y = parseInt(hex[2], 16);
      return isPrivateIp([x >> 8, x & 255, y >> 8, y & 255].join("."));
    }
    return false;
  }
  return true;
}
// Проверяем адрес в момент соединения, чтобы его нельзя было подменить между проверкой и запросом
function safeLookup(hostname, options, cb) {
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return cb(err);
    const list = Array.isArray(address) ? address : [{ address, family }];
    if (!list.length || list.some((a) => isPrivateIp(a.address))) return cb(new Error("blocked"));
    cb(null, address, family);
  });
}
function fetchPage(urlStr, hops = 0) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch { return reject(new Error("bad url")); }
    if (u.protocol !== "http:" && u.protocol !== "https:") return reject(new Error("bad protocol"));
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(host) && isPrivateIp(host)) return reject(new Error("blocked"));
    const lib = u.protocol === "https:" ? httpsLib : httpLib;
    const req = lib.get(
      u,
      { lookup: safeLookup, timeout: 5000, headers: { "User-Agent": "Mozilla/5.0 (compatible; RamacordBot/1.0)", Accept: "text/html,*/*;q=0.5" } },
      (res) => {
        const code = res.statusCode || 0;
        if (code >= 300 && code < 400 && res.headers.location) {
          res.resume();
          if (hops >= 3) return reject(new Error("redirects"));
          let next;
          try { next = new URL(res.headers.location, u).href; } catch { return reject(new Error("bad redirect")); }
          return resolve(fetchPage(next, hops + 1));
        }
        if (code !== 200 || !/text\/html|application\/xhtml/i.test(res.headers["content-type"] || "")) {
          res.resume();
          return reject(new Error("not html"));
        }
        const chunks = [];
        let size = 0, done = false;
        const finish = () => { if (done) return; done = true; resolve(Buffer.concat(chunks).toString("utf8")); };
        res.on("data", (c) => { chunks.push(c); size += c.length; if (size > 300_000) { res.destroy(); finish(); } });
        res.on("end", finish);
        res.on("close", finish);
        res.on("error", finish);
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}
function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(Math.min(Number(n), 0x10ffff)); } catch { return ""; } });
}
function metaContent(html, names) {
  for (const tag of html.match(/<meta\s[^>]*>/gi) || []) {
    const key = (tag.match(/(?:property|name)\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (!key || !names.includes(key.toLowerCase())) continue;
    const c = (tag.match(/content\s*=\s*"([^"]*)"/i) || tag.match(/content\s*=\s*'([^']*)'/i) || [])[1];
    if (c) return decodeEntities(c).trim();
  }
  return "";
}
const previewCache = new Map();
async function linkPreview(url) {
  const hit = previewCache.get(url);
  if (hit && Date.now() - hit.at < 3600e3) return hit.data;
  let data = null;
  try {
    const html = await fetchPage(url);
    const title =
      metaContent(html, ["og:title", "twitter:title"]) ||
      decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "").replace(/\s+/g, " ").trim();
    const description = metaContent(html, ["og:description", "twitter:description", "description"]);
    const site = metaContent(html, ["og:site_name"]) || new URL(url).hostname;
    if (title) data = { title: title.slice(0, 140), description: description.slice(0, 240), site: site.slice(0, 60) };
  } catch {}
  previewCache.set(url, { at: Date.now(), data });
  if (previewCache.size > 300) previewCache.delete(previewCache.keys().next().value);
  return data;
}
const featureList = () => FEATURES.map((f) => ({ ...f, on: flag("feat:" + f.id) }));
const enabledFeatures = () => FEATURES.filter((f) => flag("feat:" + f.id)).map((f) => f.id);
const meInfo = (name) => {
  const st = db.prepare("SELECT status_mode AS mode, status_text AS text FROM users WHERE name = ?").get(name) || {};
  return { name, admin: isAdminName(name), mod: isModName(name), features: enabledFeatures(), status: { mode: st.mode || "online", text: st.text || "" }, startedAt: STARTED_AT };
};

function tempPassword() {
  const abc = "abcdefghjkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < 10; i++) out += abc[randomInt(abc.length)];
  return out;
}

// Настройки LiveKit. По умолчанию подходят для локального запуска с --dev
const LIVEKIT_URL = process.env.LIVEKIT_URL || "ws://localhost:7880";
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || "devkey";
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || "secret";
// Адрес управления LiveKit (для заглушки администратором). По умолчанию берётся из LIVEKIT_URL
const LIVEKIT_API_URL = process.env.LIVEKIT_API_URL || LIVEKIT_URL.replace(/^ws/, "http");
const livekit = new RoomServiceClient(LIVEKIT_API_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);

// ===== Безопасность: код приглашения, сессии, защита от подбора пароля =====
const INVITE_CODE = process.env.INVITE_CODE || "";
if (!INVITE_CODE) console.warn("ВНИМАНИЕ: INVITE_CODE не задан, регистрация открыта всем");

// ===== Лимиты: загрузки, регистрации, пароли каналов =====
// Всё можно переопределить переменными окружения, значения по умолчанию — для небольшого сервера
const UPLOAD_PER_HOUR = Number(process.env.UPLOAD_PER_HOUR) || 30;       // файлов в час с одного аккаунта
const UPLOAD_USER_MB = Number(process.env.UPLOAD_USER_MB) || 250;        // мегабайт за 24 часа на аккаунт
const UPLOAD_TOTAL_MB = Number(process.env.UPLOAD_TOTAL_MB) || 2048;     // мегабайт за 24 часа на весь сервер
const REG_LIMIT_IP = Number(process.env.REG_LIMIT_IP) || 3;              // аккаунтов с одного IP за 24 часа
const REG_LIMIT_TOTAL = Number(process.env.REG_LIMIT_TOTAL) || 20;       // аккаунтов на сервер за 24 часа
const MIN_CHANNEL_PASSWORD = 8;                                          // минимум для пароля канала
const MIN_INVITE_CODE = 12;                                              // минимум для кода приглашения
// LiveKit проверяет exp только при подключении и сам продлевает токен, пока участник в комнате.
// Поэтому короткий срок не рвёт длинные звонки, но ограничивает окно, в которое выгнанный
// человек может вернуться со сохранённым токеном: было 6 часов, стало 10 минут.
const VOICE_TOKEN_TTL = process.env.VOICE_TOKEN_TTL || "10m";
if (INVITE_CODE && INVITE_CODE.length < MIN_INVITE_CODE) {
  console.warn(`ВНИМАНИЕ: INVITE_CODE короче ${MIN_INVITE_CODE} символов — его легко подобрать перебором`);
}

// В продакшене не стартуем с тестовыми ключами и открытой регистрацией
if (process.env.NODE_ENV === "production") {
  const missing = ["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "INVITE_CODE"].filter((k) => !process.env[k]);
  if (missing.length) {
    console.error("Не заданы переменные окружения: " + missing.join(", "));
    process.exit(1);
  }
  if (!LIVEKIT_URL.startsWith("wss://")) console.warn("ВНИМАНИЕ: LIVEKIT_URL не wss://, голос не заработает через HTTPS");
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // сессия живёт 30 дней

function cleanupSessions() {
  db.prepare("DELETE FROM sessions WHERE created_at < ?").run(Date.now() - SESSION_TTL_MS);
}
cleanupSessions();
setInterval(cleanupSessions, 60 * 60 * 1000);

// Возвращает { id, name } по токену или undefined, если токена нет или он просрочен
function getSessionUser(token) {
  if (typeof token !== "string") return undefined;
  return db
    .prepare(
      "SELECT users.id AS id, users.name AS name FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token = ? AND sessions.created_at > ? AND users.banned = 0"
    )
    .get(token, Date.now() - SESSION_TTL_MS);
}

// Защита от подбора пароля: считаем неудачные попытки по IP и по нику
const failures = new Map(); // ключ -> { count, since }
const FAIL_WINDOW_MS = 15 * 60 * 1000; // окно 15 минут
const MAX_FAILS_PER_NAME = 8;
const MAX_FAILS_PER_IP = 20;

// Сколько минут ещё ждать (0, если ограничения нет)
function blockedFor(key, max) {
  const f = failures.get(key);
  if (!f) return 0;
  if (Date.now() - f.since > FAIL_WINDOW_MS) {
    failures.delete(key);
    return 0;
  }
  return f.count >= max ? Math.ceil((f.since + FAIL_WINDOW_MS - Date.now()) / 60000) : 0;
}

function addFailure(key) {
  const f = failures.get(key);
  if (!f || Date.now() - f.since > FAIL_WINDOW_MS) failures.set(key, { count: 1, since: Date.now() });
  else f.count++;
}

setInterval(() => {
  for (const [k, f] of failures) {
    if (Date.now() - f.since > FAIL_WINDOW_MS) failures.delete(k);
  }
}, 10 * 60 * 1000);

function tooManyResponse(res, minutes) {
  return res.status(429).json({ error: `Слишком много попыток. Подождите ${minutes} мин.` });
}

// Ники: без различия заглавных и строчных, только буквы, цифры, пробел и _ . -
const NAME_RE = /^[\p{L}\p{N}_. -]+$/u;

function cleanName(v) {
  return String(v ?? "").trim().replace(/\s+/g, " ");
}

function findUserByName(name) {
  const exact = db.prepare("SELECT * FROM users WHERE name = ?").get(name);
  if (exact) return exact;
  const lower = name.toLowerCase();
  const matches = db
    .prepare("SELECT * FROM users")
    .all()
    .filter((u) => u.name.toLowerCase() === lower);
  return matches.length === 1 ? matches[0] : undefined;
}

function nameTaken(name) {
  const lower = name.toLowerCase();
  return db
    .prepare("SELECT name FROM users")
    .all()
    .some((u) => u.name.toLowerCase() === lower);
}

const DUMMY_HASH = bcrypt.hashSync("dummy-password", 10); // чтобы вход по несуществующему нику не отвечал быстрее

// ===== Аватарки =====

// ник -> ссылка на аватарку (только у тех, кто её поставил)
function avatarMap() {
  const map = {};
  for (const u of db.prepare("SELECT name, avatar FROM users WHERE avatar IS NOT NULL").all()) {
    map[u.name] = u.avatar;
  }
  return map;
}

// Удаляем файл старой аватарки (только из папки avatars)
function removeAvatarFile(url) {
  if (!url || !/^\/uploads\/avatars\/[\w-]+\.jpg$/.test(url)) return;
  fs.rm(path.join(AVATARS, path.basename(url)), { force: true }, () => {});
}

function bearerUser(req) {
  return getSessionUser((req.headers.authorization || "").replace("Bearer ", ""));
}

const app = express();
// Сервер стоит за Caddy: берём настоящий IP посетителя из заголовка X-Forwarded-For
app.set("trust proxy", 1);
const http = createServer(app);
const io = new Server(http);

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  next();
});
app.use(express.json());
// DFN-модель: 18 МБ, кэшируем надолго. WASM — на неделю, обвязка — на час.
app.use(
  "/voiceclarity",
  express.static(path.join(ROOT, "public", "voiceclarity"), {
    setHeaders: (res, filePath) => {
      res.setHeader(
        "Cache-Control",
        filePath.endsWith(".wasm") ? "public, max-age=604800" : "public, max-age=3600"
      );
    },
  })
);
app.use(express.static(path.join(ROOT, "public")));
// Клиентскую библиотеку LiveKit отдаём со своего сервера
app.use("/vendor", express.static(path.join(ROOT, "node_modules/livekit-client/dist")));

// ===== Шумоподавление (RNNoise): отдаём браузеру файлы библиотеки со своего сервера =====
// Папку пакета и нужные файлы ищем сами, чтобы не зависеть от его внутренней структуры
let nsRoot = null;
let nsManifest = null;
try {
  const NS_PKG = "@sapphi-red/web-noise-suppressor";
  const entry = fileURLToPath(import.meta.resolve(NS_PKG));
  nsRoot = path.dirname(entry);
  for (;;) {
    const pj = path.join(nsRoot, "package.json");
    if (isFile(pj) && JSON.parse(fs.readFileSync(pj, "utf8")).name === NS_PKG) break;
    const up = path.dirname(nsRoot);
    if (up === nsRoot) throw new Error("не найдена папка пакета");
    nsRoot = up;
  }
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules") walk(full); }
      else files.push(path.relative(nsRoot, full).split(path.sep).join("/"));
    }
  })(nsRoot);
  const find = (re) => files.find((f) => re.test(f));
  const m = {
    lib: path.relative(nsRoot, entry).split(path.sep).join("/"),
    worklet: find(/rnnoise[^/]*worklet[^/]*\.js$/i) || find(/rnnoise\/[^/]*worklet[^/]*\.js$/i),
    wasm: find(/(^|\/)rnnoise\.wasm$/),
    simd: find(/(^|\/)rnnoise_simd\.wasm$/),
  };
  if (!m.worklet || !m.wasm) throw new Error("не найдены файлы RNNoise");
  nsManifest = m;
} catch (e) {
  console.warn("Шумоподавление недоступно (выполните npm install):", e.message);
}
// Браузер просит модули без расширения: подставляем .js или /index.js
app.use("/vendor/ns", (req, res, next) => {
  if (nsRoot && !path.extname(req.path)) {
    for (const sfx of [".js", "/index.js"]) {
      if (isFile(path.join(nsRoot, req.path + sfx))) { req.url = req.path + sfx; break; }
    }
  }
  next();
});
app.use("/vendor/ns", (req, res, next) => (nsRoot ? express.static(nsRoot)(req, res, next) : next()));
app.get("/vendor/ns-manifest.json", (req, res) =>
  nsManifest ? res.json(nsManifest) : res.status(404).json({ error: "Шумоподавление не установлено на сервере" })
);

fs.mkdirSync(AVATARS, { recursive: true });

const IMAGE_EXT = [".png", ".jpg", ".jpeg", ".gif", ".webp"];

// Всё, кроме картинок, браузер только скачивает, а не открывает
app.use(
  "/uploads",
  express.static(UPLOADS, {
    setHeaders: (res, filePath) => {
      res.setHeader("X-Content-Type-Options", "nosniff");
      if (!IMAGE_EXT.includes(path.extname(filePath).toLowerCase())) {
        res.setHeader("Content-Disposition", "attachment");
      }
    },
  })
);

// Не больше 30 файлов в час и 250 МБ за сутки на аккаунт, 2 ГБ за сутки на весь сервер.
// Счётчики лежат в базе, поэтому перезапуск сервера их не обнуляет
function uploadCountAllowed(userId) {
  const n = db
    .prepare("SELECT COUNT(*) AS c FROM uploads_log WHERE user_id = ? AND ts >= ?")
    .get(userId, Date.now() - 3600e3).c;
  return n < UPLOAD_PER_HOUR;
}

function uploadBytesExceeded(userId, size) {
  const since = Date.now() - 24 * 3600e3;
  const mine = db
    .prepare("SELECT COALESCE(SUM(bytes), 0) AS s FROM uploads_log WHERE user_id = ? AND ts >= ?")
    .get(userId, since).s;
  if (mine + size > UPLOAD_USER_MB * 1024 * 1024) {
    return "Дневной лимит загрузок на аккаунт исчерпан. Попробуйте позже.";
  }
  const all = db.prepare("SELECT COALESCE(SUM(bytes), 0) AS s FROM uploads_log WHERE ts >= ?").get(since).s;
  if (all + size > UPLOAD_TOTAL_MB * 1024 * 1024) {
    return "На сервере закончилось место для загрузок. Попробуйте позже.";
  }
  return null;
}

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS,
    filename: (req, file, cb) => {
      const ext = path
        .extname(file.originalname)
        .toLowerCase()
        .replace(/[^.a-z0-9]/g, "")
        .slice(0, 10);
      cb(null, randomUUID() + ext);
    },
  }),
  limits: {
    fileSize: 25 * 1024 * 1024,
    files: 1,
    parts: 20,
    fields: 10,
    fieldNameSize: 100,
    fieldSize: 4096,
  },
});

app.post("/upload", (req, res) => {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  const me = getSessionUser(token);
  if (!me) return res.status(401).json({ error: "Не авторизован" });
  if (!uploadCountAllowed(me.id)) return res.status(429).json({ error: "Слишком много загрузок, попробуйте позже" });

  upload.single("file")(req, res, (err) => {
    if (err) {
      return res.status(400).json({
        error: err.code === "LIMIT_FILE_SIZE" ? "Файл больше 25 МБ" : "Ошибка загрузки",
      });
    }
    if (!req.file) return res.status(400).json({ error: "Файл не выбран" });
    // Размер знаем только после записи, поэтому превышение квоты проверяем здесь и файл убираем
    const tooMuch = uploadBytesExceeded(me.id, req.file.size);
    if (tooMuch) {
      fs.rm(req.file.path, { force: true }, () => {});
      return res.status(429).json({ error: tooMuch });
    }
    db.prepare("INSERT INTO uploads_log (user_id, ts, bytes) VALUES (?, ?, ?)").run(me.id, Date.now(), req.file.size);
    res.json({ url: "/uploads/" + req.file.filename });
  });
});

// Аватарка: клиент заранее уменьшает фото до 256x256 JPEG, сервер проверяет и сохраняет
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024, files: 1, parts: 10, fields: 5, fieldNameSize: 100, fieldSize: 1024 }, // не больше 1 МБ
});

app.post("/avatar", (req, res) => {
  const user = bearerUser(req);
  if (!user) return res.status(401).json({ error: "Не авторизован" });

  avatarUpload.single("avatar")(req, res, (err) => {
    if (err) {
      return res.status(400).json({
        error: err.code === "LIMIT_FILE_SIZE" ? "Фото больше 1 МБ" : "Ошибка загрузки",
      });
    }
    const buf = req.file?.buffer;
    // Настоящий JPEG начинается с байтов FF D8 FF
    if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) {
      return res.status(400).json({ error: "Нужна картинка" });
    }

    const url = "/uploads/avatars/" + randomUUID() + ".jpg";
    fs.writeFileSync(path.join(AVATARS, path.basename(url)), buf);

    const old = db.prepare("SELECT avatar FROM users WHERE id = ?").get(user.id)?.avatar;
    db.prepare("UPDATE users SET avatar = ? WHERE id = ?").run(url, user.id);
    removeAvatarFile(old);

    io.emit("avatar:update", { name: user.name, url }); // у всех обновится сразу
    res.json({ url });
  });
});

app.delete("/avatar", (req, res) => {
  const user = bearerUser(req);
  if (!user) return res.status(401).json({ error: "Не авторизован" });

  const old = db.prepare("SELECT avatar FROM users WHERE id = ?").get(user.id)?.avatar;
  db.prepare("UPDATE users SET avatar = NULL WHERE id = ?").run(user.id);
  removeAvatarFile(old);

  io.emit("avatar:update", { name: user.name, url: null });
  res.json({ ok: true });
});

function createSession(userId) {
  const token = randomUUID();
  db.prepare("INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)").run(
    token,
    userId,
    Date.now()
  );
  return token;
}

app.post("/register", async (req, res) => {
  const body = req.body ?? {};
  const ipKey = "ip:" + req.ip;
  const wait = blockedFor(ipKey, MAX_FAILS_PER_IP);
  if (wait) return tooManyResponse(res, wait);

  const name = cleanName(body.name);
  const password = String(body.password ?? "");
  const code = String(body.code ?? "");

  if (flag("reg_closed")) return res.status(403).json({ error: "Регистрация закрыта" });
  const invite = currentInvite();
  if (invite && !same(code, invite)) {
    addFailure(ipKey);
    return res.status(403).json({ error: "Неверный код приглашения" });
  }
  if (name.length < 2 || name.length > 24 || !NAME_RE.test(name)) {
    return res
      .status(400)
      .json({ error: "Ник: 2-24 символа, только буквы, цифры, пробел, _ . -" });
  }
  if (password.length < 6 || Buffer.byteLength(password) > 72) {
    return res.status(400).json({ error: "Пароль: от 6 символов, не больше 72 байт (около 36 русских букв)" });
  }
  if (nameTaken(name)) return res.status(409).json({ error: "Ник занят" });

  // Массовое создание аккаунтов: не больше REG_LIMIT_IP с одного адреса
  // и REG_LIMIT_TOTAL на сервер за сутки. Проверяем до bcrypt, чтобы не тратить CPU
  const dayAgo = Date.now() - 24 * 3600e3;
  const fromIp = db.prepare("SELECT COUNT(*) AS c FROM reg_log WHERE ip = ? AND ts >= ?").get(req.ip, dayAgo).c;
  if (fromIp >= REG_LIMIT_IP) {
    return res.status(429).json({ error: "С этого адреса уже создано слишком много аккаунтов. Попробуйте завтра." });
  }
  const total = db.prepare("SELECT COUNT(*) AS c FROM reg_log WHERE ts >= ?").get(dayAgo).c;
  if (total >= REG_LIMIT_TOTAL) {
    return res.status(429).json({ error: "Сегодня сервер принял максимум новых аккаунтов. Попробуйте завтра." });
  }

  const hash = await bcrypt.hash(password, 10);
  try {
    const result = db
      .prepare("INSERT INTO users (name, password_hash, created_at) VALUES (?, ?, ?)")
      .run(name, hash, Date.now());
    db.prepare("INSERT INTO reg_log (ip, ts) VALUES (?, ?)").run(req.ip, Date.now());
    const token = createSession(Number(result.lastInsertRowid));
    notifyAdmins();
    res.json({ token, name });
  } catch {
    res.status(409).json({ error: "Ник занят" });
  }
});

app.post("/login", async (req, res) => {
  const body = req.body ?? {};
  const name = cleanName(body.name);
  const password = String(body.password ?? "");
  if (!name || !password) {
    return res.status(400).json({ error: "Введи ник и пароль" });
  }

  const ipKey = "ip:" + req.ip;
  const nameKey = "name:" + name.toLowerCase();
  const wait = Math.max(
    blockedFor(ipKey, MAX_FAILS_PER_IP),
    blockedFor(nameKey, MAX_FAILS_PER_NAME)
  );
  if (wait) return tooManyResponse(res, wait);

  const user = findUserByName(name);
  const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok) {
    addFailure(ipKey);
    addFailure(nameKey);
    return res.status(401).json({ error: "Неверный ник или пароль" });
  }
  failures.delete(nameKey);
  if (user.banned) return res.status(403).json({ error: "Аккаунт заблокирован администратором" });
  if (flag("maintenance") && !isAdminName(user.name)) {
    return res.status(503).json({ error: "Идут технические работы. Попробуйте позже." });
  }
  res.json({ token: createSession(user.id), name: user.name });
});

// Выход: удаляем сессию на сервере и закрываем её сокеты
app.post("/logout", (req, res) => {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
  for (const [, sock] of io.sockets.sockets) if (sock.data.token === token) sock.disconnect(true);
  res.json({ ok: true });
});

// Смена своего пароля
app.post("/changepass", async (req, res) => {
  const user = bearerUser(req);
  if (!user) return res.status(401).json({ error: "Не авторизован" });
  const oldPassword = String(req.body?.oldPassword ?? "");
  const newPassword = String(req.body?.newPassword ?? "");
  if (newPassword.length < 6 || Buffer.byteLength(newPassword) > 72) {
    return res.status(400).json({ error: "Новый пароль: от 6 символов, не больше 72 байт" });
  }
  const key = "pw:" + user.id;
  const wait = blockedFor(key, MAX_FAILS_PER_NAME);
  if (wait) return tooManyResponse(res, wait);
  const row = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(user.id);
  if (!row || !(await bcrypt.compare(oldPassword, row.password_hash))) {
    addFailure(key);
    return res.status(401).json({ error: "Текущий пароль неверный" });
  }
  failures.delete(key);
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(await bcrypt.hash(newPassword, 10), user.id);
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  db.prepare("DELETE FROM sessions WHERE user_id = ? AND token != ?").run(user.id, token); // остальные устройства выходят
  res.json({ ok: true });
});

// Резервная копия базы (только администратор). Внутри пароли в виде хешей и токены входа: храните файл в тайне
const DB_FILE = path.join(ROOT, "mycord.db");
app.get("/admin/backup", (req, res) => {
  const me = bearerUser(req);
  if (!me || !isAdminName(me.name)) return res.status(403).json({ error: "Только для администратора" });
  const tmp = path.join(os.tmpdir(), "mycord-backup-" + Date.now() + ".db");
  try {
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  } catch (e) {
    console.error("backup:", e);
    return res.status(500).json({ error: "Не удалось создать копию" });
  }
  audit(me.name, "Скачана копия базы");
  res.download(tmp, "mycord-" + new Date().toISOString().slice(0, 10) + ".db", () => fs.rm(tmp, { force: true }, () => {}));
});

// Пускаем в чат только тех, у кого есть правильный токен
io.use((socket, next) => {
  const user = getSessionUser(socket.handshake.auth.token);
  if (!user) return next(new Error("unauthorized"));
  if (flag("maintenance") && !isAdminName(user.name)) return next(new Error("maintenance"));
  socket.data.uid = user.id;
  socket.data.name = user.name;
  socket.data.token = socket.handshake.auth.token;
  next();
});

function listChannels() {
  return db
    .prepare("SELECT id, name, kind, password_hash IS NOT NULL AS locked FROM channels WHERE kind != 'dm' ORDER BY pos, id")
    .all()
    .map((c) => ({ id: c.id, name: c.name, kind: c.kind, locked: !!c.locked }));
}

// Кто сейчас сидит в голосовых каналах: id канала -> (id сокета -> ник)
const voiceMembers = new Map();

function voiceState() {
  const state = {};
  const sm = new Set(db.prepare("SELECT name FROM users WHERE server_muted = 1").all().map((r) => r.name));
  const muteAll = flag("mute_all");
  for (const [id, members] of voiceMembers) state[id] = [...members].map(([sid, name]) => {
      const vs = io.sockets.sockets.get(sid)?.data.vs || {};
      return { name, muted: !!vs.muted, deaf: !!vs.deaf, smuted: sm.has(name) || (muteAll && !isAdminName(name)) }; // состояние видят все
    });
  return state;
}

function leaveVoice(socket) {
  for (const [id, members] of voiceMembers) {
    members.delete(socket.id);
    if (members.size === 0) voiceMembers.delete(id);
  }
}

// Говорим администраторам, что список аккаунтов изменился (кто-то зашёл, вышел, зарегистрировался)
function notifyAdmins() {
  try {
    for (const [, s] of io.sockets.sockets) if (isModName(s.data.name)) s.emit("users:dirty");
  } catch (e) {
    console.error("notifyAdmins:", e);
  }
}

// Выкидываем человека отовсюду: из голосовых комнат LiveKit и из чата.
// reason: banned | reset | deleted | maintenance (клиент покажет своё сообщение)
async function kickUser(name, reason = "banned") {
  const targets = [];
  for (const [chId, members] of voiceMembers) {
    for (const [sid, nm] of members) if (nm === name) targets.push({ chId, sid });
  }
  for (const t of targets) {
    try {
      await livekit.removeParticipant("voice-" + t.chId, name + "#" + t.sid);
    } catch (e) {
      console.error("LiveKit не смог выкинуть участника:", e.message);
    }
  }
  for (const [, s] of io.sockets.sockets) {
    if (s.data.name === name) {
      s.emit("account:ended", { reason });
      s.disconnect(true);
    }
  }
}

// Убираем человека из голосового канала (аккаунт остаётся). chId = null: из любого
async function kickFromVoice(name, chId = null) {
  const targets = [];
  for (const [id, members] of voiceMembers) {
    if (chId !== null && id !== chId) continue;
    for (const [sid, nm] of members) if (nm === name) targets.push({ id, sid });
  }
  for (const t of targets) {
    try {
      await livekit.removeParticipant("voice-" + t.id, name + "#" + t.sid);
    } catch (e) {
      console.error("LiveKit не смог выкинуть участника:", e.message);
    }
    const sock = io.sockets.sockets.get(t.sid);
    if (sock) {
      leaveVoice(sock);
      sock.emit("voice:kicked");
    }
  }
  io.emit("voice:update", voiceState());
  return targets.length;
}

// Разрешаем или запрещаем человеку говорить в его текущей комнате LiveKit
async function setPublish(chId, sid, name, canPublish) {
  io.to(sid).emit("servermute", { on: !canPublish });
  try {
    await livekit.updateParticipant("voice-" + chId, name + "#" + sid, undefined, {
      canPublish,
      canSubscribe: true,
      canPublishData: true,
    });
  } catch (e) {
    console.error("LiveKit не принял смену прав:", e.message);
  }
}

// Режим «Заглушить всех»: все, кроме администратора, в том числе зашедшие позже
async function applyMuteAll(on) {
  const individually = new Set(db.prepare("SELECT name FROM users WHERE server_muted = 1").all().map((r) => r.name));
  const targets = [];
  for (const [chId, members] of voiceMembers) {
    for (const [sid, nm] of members) if (!isAdminName(nm)) targets.push({ chId, sid, nm });
  }
  for (const t of targets) {
    if (on) await setPublish(t.chId, t.sid, t.nm, false);
    else if (!individually.has(t.nm)) await setPublish(t.chId, t.sid, t.nm, true); // личные заглушки остаются
  }
  io.emit("voice:update", voiceState());
}

// ===== Доступ к каналам с паролем =====
function hasAccess(socket, chId) {
  const ch = db.prepare("SELECT password_hash, kind FROM channels WHERE id = ?").get(chId);
  if (!ch) return false;
  if (ch.kind === "dm") { // личная переписка: только двое участников, даже администратор не читает чужие
    return feat("dm") && !!db.prepare("SELECT 1 AS x FROM dm_members WHERE channel_id = ? AND user_id = ?").get(chId, socket.data.uid);
  }
  if (!ch.password_hash) return true;
  if (isAdminName(socket.data.name)) return true; // администратор заходит без пароля
  return !!db.prepare("SELECT 1 AS x FROM channel_access WHERE user_id = ? AND channel_id = ?").get(socket.data.uid, chId);
}
function accessList(socket) {
  if (isAdminName(socket.data.name)) {
    return db.prepare("SELECT id FROM channels WHERE password_hash IS NOT NULL").all().map((r) => r.id);
  }
  return db.prepare("SELECT channel_id AS id FROM channel_access WHERE user_id = ?").all(socket.data.uid).map((r) => r.id);
}
const sendAccess = (socket) => socket.emit("access", accessList(socket));
const sendAccessAll = () => { for (const [, s] of io.sockets.sockets) sendAccess(s); };

// ===== Очистка чатов =====
// Удаляет сообщения (во всех каналах или в одном) вместе с прикреплёнными файлами
function wipeMessages(channelId = null) {
  const all = channelId === null;
  const files = all
    ? db.prepare("SELECT file_url FROM messages WHERE file_url IS NOT NULL").all()
    : db.prepare("SELECT file_url FROM messages WHERE channel_id = ? AND file_url IS NOT NULL").all(Number(channelId));
  const info = all
    ? db.prepare("DELETE FROM messages").run()
    : db.prepare("DELETE FROM messages WHERE channel_id = ?").run(Number(channelId));
  for (const r of files) fs.rm(path.join(UPLOADS, path.basename(r.file_url)), { force: true }, () => {});
  pruneReactions();
  if (channelId !== null && isDmChannel(channelId)) emitToUsers(dmMembers(channelId), "chat:cleared", { channelId }); // только двум участникам
  else io.emit("chat:cleared", { channelId });
  return Number(info.changes);
}

// Автоочистка: когда наступает назначенное время, один раз стираем всё и выключаемся
function runAutoclean() {
  const at = Number(getSetting("autoclean_at", 0));
  if (!at || Date.now() < at) return;
  const n = wipeMessages();
  delSetting("autoclean_at");
  audit("система", "Автоочистка выполнена", "удалено сообщений: " + n);
  notifyAdmins();
}

function dirSize(dir) {
  let total = 0, files = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const r = dirSize(p); total += r.total; files += r.files; }
    else if (e.isFile()) { try { total += fs.statSync(p).size; files++; } catch {} }
  }
  return { total, files };
}
function dbBytes() {
  let n = 0;
  for (const sfx of ["", "-wal", "-shm"]) { try { n += fs.statSync(DB_FILE + sfx).size; } catch {} }
  return n;
}

io.on("connection", (socket) => {
  // Обёртка для событий: подставляет пустой колбэк, если клиент его не передал,
  // и не даёт ошибке в обработчике уронить весь сервер
  const on = (ev, fn) =>
    socket.on(ev, (...args) => {
      if (typeof args[args.length - 1] !== "function") args.push(() => {});
      try {
        Promise.resolve(fn(...args)).catch((e) => console.error(ev, e));
      } catch (e) {
        console.error(ev, e);
      }
    });

  socket.emit("me", meInfo(socket.data.name)); // клиент узнаёт свой ник и права
  sendAccess(socket);
  if (feat("unread") || feat("dm")) socket.emit("unread:state", unreadState(socket));
  if (
    (feat("status") || feat("dm") || feat("profile")) &&
    [...io.sockets.sockets.values()].filter((s) => s.data.name === socket.data.name).length === 1
  ) {
    io.emit("presence", { name: socket.data.name, online: true });
  }
  notifyAdmins();
  socket.emit("avatars", avatarMap());
  socket.emit("voice:update", voiceState());

  on("channels:list", (cb) => cb(listChannels()));

  // Создание канала (текстового или голосового), по желанию с паролем
  on("channel:create", async (data, cb) => {
    if (!isAdminName(socket.data.name)) return cb(NOT_ADMIN);
    const name = String(data?.name ?? "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "-")
      .slice(0, 30);
    const kind = data?.kind === "voice" ? "voice" : "text";
    if (!name) return cb({ error: "Введи название канала" });
    if (name.startsWith("dm:")) return cb({ error: "Название не может начинаться с «dm:»" });
    let hash = null;
    if (data?.locked) {
      const pw = String(data?.password ?? "");
      if (pw.length < MIN_CHANNEL_PASSWORD || Buffer.byteLength(pw) > 72) {
        return cb({ error: `Пароль канала: от ${MIN_CHANNEL_PASSWORD} символов, не больше 72 байт` });
      }
      hash = await bcrypt.hash(pw, 10);
    }
    try {
      const pos = db.prepare("SELECT COALESCE(MAX(pos), 0) + 1 AS p FROM channels").get().p;
      db.prepare("INSERT INTO channels (name, kind, pos, password_hash) VALUES (?, ?, ?, ?)").run(name, kind, pos, hash);
    } catch {
      return cb({ error: "Такой канал уже есть" });
    }
    audit(socket.data.name, "Создан канал", name + (hash ? " (с паролем)" : ""));
    io.emit("channels:update", listChannels());
    cb({ ok: true });
  });

  // Переименование канала (только администратор)
  on("channel:rename", (id, newName, cb) => {
    if (!isAdminName(socket.data.name)) return cb(NOT_ADMIN);
    id = Number(id);
    const name = String(newName ?? "").trim().toLowerCase().replace(/\s+/g, "-").slice(0, 30);
    if (!name) return cb({ error: "Введи название канала" });
    if (!db.prepare("SELECT id FROM channels WHERE id = ? AND kind != 'dm'").get(id)) return cb({ error: "Канал не найден" });
    try {
      db.prepare("UPDATE channels SET name = ? WHERE id = ?").run(name, id);
    } catch {
      return cb({ error: "Такой канал уже есть" });
    }
    io.emit("channels:update", listChannels());
    cb({ ok: true });
  });

  // Удаление сообщения. Админ: любое, оно исчезает. Обычный человек: только своё
  // и не старше 24 часов, на его месте остаётся пометка «Сообщение удалено»
  on("message:delete", (msgId, cb) => {
    msgId = Number(msgId);
    const m = db
      .prepare("SELECT id, channel_id, user_name, deleted, (strftime('%s','now') - strftime('%s', created_at)) AS age FROM messages WHERE id = ?")
      .get(msgId);
    if (!m) return cb({ error: "Сообщение уже удалено" });
    if (isAdminName(socket.data.name)) {
      db.prepare("DELETE FROM messages WHERE id = ?").run(msgId);
      db.prepare("DELETE FROM reactions WHERE message_id = ?").run(msgId);
      io.to("ch:" + m.channel_id).emit("message:removed", { id: msgId, channelId: m.channel_id });
    } else {
      if (m.user_name !== socket.data.name) return cb({ error: "Можно удалять только свои сообщения" });
      if (m.deleted) return cb({ error: "Сообщение уже удалено" });
      if (m.age > 24 * 3600) return cb({ error: "Прошло больше 24 часов, удалить уже нельзя" });
      db.prepare("UPDATE messages SET deleted = 1, text = '', file_url = NULL, file_name = NULL WHERE id = ?").run(msgId);
      io.to("ch:" + m.channel_id).emit("message:deleted", { id: msgId, channelId: m.channel_id });
    }
    cb({ ok: true });
  });

  // Удаление канала вместе с его сообщениями
  on("channel:delete", (id, cb) => {
    if (!isAdminName(socket.data.name)) return cb(NOT_ADMIN);
    id = Number(id);
    const ch = db.prepare("SELECT id, kind FROM channels WHERE id = ?").get(id);
    if (!ch || ch.kind === "dm") return cb({ error: "Канал уже удалён" });
    if (ch.kind === "text" && db.prepare("SELECT COUNT(*) AS c FROM channels WHERE kind = 'text'").get().c <= 1) {
      return cb({ error: "Нельзя удалить последний текстовый канал" });
    }
    db.prepare("DELETE FROM messages WHERE channel_id = ?").run(id);
    pruneReactions();
    db.prepare("DELETE FROM reads WHERE channel_id = ?").run(id);
    db.prepare("DELETE FROM channels WHERE id = ?").run(id);
    db.prepare("DELETE FROM channel_access WHERE channel_id = ?").run(id);
    voiceMembers.delete(id);
    // Тех, кто сидел в удалённом текстовом канале, отключаем от него
    io.in("ch:" + id).socketsLeave("ch:" + id);
    for (const sock of io.sockets.sockets.values()) if (sock.data.channel === id) sock.data.channel = null;
    io.emit("channels:update", listChannels());
    io.emit("voice:update", voiceState());
    cb({ ok: true });
  });

  // Вход в текстовый канал
  on("channel:join", (id) => {
    id = Number(id);
    if (!db.prepare("SELECT id FROM channels WHERE id = ? AND kind IN ('text', 'dm')").get(id)) return;
    if (!hasAccess(socket, id)) { // канал с паролем, а у человека доступа нет
      if (!isDmChannel(id)) socket.emit("channel:locked", { id });
      return;
    }
    for (const room of socket.rooms) {
      if (room.startsWith("ch:")) socket.leave(room);
    }
    socket.join("ch:" + id);
    socket.data.channel = id;

    const rows = db.prepare("SELECT " + MSG_COLS + " FROM messages WHERE channel_id = ? ORDER BY id DESC LIMIT 100").all(id).reverse();
    socket.emit("history", { channelId: id, messages: decorateMessages(rows) });
    if (feat("unread") || isDmChannel(id)) markRead(socket, id);
  });

  // Сообщение (текст и/или файл)
  on("message", (payload) => {
    const id = socket.data.channel;
    if (!id) return;
    if (!hasAccess(socket, id)) return; // доступ могли отозвать (пароль сменили, личные сообщения выключили)

    const text = String(payload?.text ?? "").trim().slice(0, 2000);

    let fileUrl = null;
    let fileName = null;
    const f = payload?.file;
    if (
      f &&
      /^\/uploads\/[\w-]+(\.[a-z0-9]+)?$/.test(f.url) &&
      isFile(path.join(UPLOADS, path.basename(f.url)))
    ) {
      fileUrl = f.url;
      fileName = String(f.name || "file").slice(0, 200);
    }

    if (!text && !fileUrl) return;

    let replyTo = null;
    if (feat("reply") && payload?.replyTo) {
      const r = db.prepare("SELECT id FROM messages WHERE id = ? AND channel_id = ?").get(Number(payload.replyTo), id);
      if (r) replyTo = r.id;
    }

    const info = db
      .prepare("INSERT INTO messages (channel_id, user_name, text, file_url, file_name, reply_to) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, socket.data.name, text, fileUrl, fileName, replyTo);

    const msg = decorateMessages([
      { id: Number(info.lastInsertRowid), deleted: 0, name: socket.data.name, text, fileUrl, fileName, createdAt: new Date().toISOString(), replyTo, edited: 0, pinned: 0 },
    ])[0];
    io.to("ch:" + id).emit("message", { ...msg, channelId: id });

    const dm = isDmChannel(id);
    if (dm) notifyDm(id); // у обоих обновится список переписок

    // Тем, кто сейчас в другом канале: счётчик непрочитанных и уведомление
    if (feat("unread") || feat("notify") || dm) {
      for (const [, s] of io.sockets.sockets) {
        if (s.data.name === socket.data.name || s.data.channel === id || !hasAccess(s, id)) continue;
        s.emit("unread:bump", {
          channelId: id,
          mention: dm || mentionsUser(text, s.data.name), // личное сообщение считаем важным, как упоминание
          dm,
          from: socket.data.name,
          preview: text || (fileName ? "Файл: " + fileName : ""),
        });
      }
    }
  });

  // Вход в голосовой канал: выдаём пропуск в комнату LiveKit
  on("voice:join", async (id, cb) => {
    try {
      id = Number(id);
      const ch = db.prepare("SELECT id, kind FROM channels WHERE id = ?").get(id);
      if (!ch || ch.kind !== "voice") return cb({ error: "Это не голосовой канал" });
      if (!hasAccess(socket, id)) return cb({ error: "Нужен пароль для этого канала", locked: true });

      leaveVoice(socket);
      socket.data.vs = {};
      const muted =
        !!db.prepare("SELECT server_muted AS m FROM users WHERE name = ?").get(socket.data.name)?.m ||
        (flag("mute_all") && !isAdminName(socket.data.name)); // режим «Заглушить всех» действует и на зашедших позже

      const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
        identity: socket.data.name + "#" + socket.id, // с двух устройств можно сидеть одновременно
        name: socket.data.name,
        ttl: VOICE_TOKEN_TTL,
      });
      at.addGrant({
        roomJoin: true,
        room: "voice-" + id,
        canPublish: !muted, // заглушённый администратором не может отправлять звук
        canSubscribe: true,
      });
      const token = await at.toJwt();

      if (!voiceMembers.has(id)) voiceMembers.set(id, new Map());
      voiceMembers.get(id).set(socket.id, socket.data.name);
      io.emit("voice:update", voiceState());

      cb({ token, url: LIVEKIT_URL, serverMuted: muted });
    } catch (e) {
      console.error(e);
      cb({ error: "Не удалось получить доступ к голосу" });
    }
  });

  // Администратор заглушает человека для всех (или снимает заглушку)
  on("voice:servermute", async (name, muteOn, cb) => {
    if (!isModName(socket.data.name)) return cb(NOT_MOD);
    const u = db.prepare("SELECT id, name FROM users WHERE name = ?").get(String(name ?? ""));
    if (!u) return cb({ error: "Пользователь не найден" });
    if (u.name === socket.data.name) return cb({ error: "Себя заглушить нельзя" });
    if (isAdminName(u.name)) return cb({ error: "Администратора заглушить нельзя" });
    if (isModName(u.name) && !isAdminName(socket.data.name)) return cb({ error: "Модератора может заглушить только администратор" });
    db.prepare("UPDATE users SET server_muted = ? WHERE id = ?").run(muteOn ? 1 : 0, u.id);
    audit(socket.data.name, muteOn ? "Заглушен для всех" : "Снята заглушка", u.name);

    // Если человек сейчас в голосе, сразу меняем его права в LiveKit
    const targets = [];
    for (const [chId, members] of voiceMembers) {
      for (const [sid, nm] of members) if (nm === u.name) targets.push({ chId, sid });
    }
    for (const t of targets) {
      const blocked = !!muteOn || flag("mute_all"); // при включённом режиме «Заглушить всех» личное снятие не разрешает говорить
      io.to(t.sid).emit("servermute", { on: blocked });
      try {
        await livekit.updateParticipant("voice-" + t.chId, u.name + "#" + t.sid, undefined, {
          canPublish: !blocked,
          canSubscribe: true,
          canPublishData: true,
        });
      } catch (e) {
        console.error("LiveKit не принял смену прав (заглушка сохранена и сработает при входе):", e.message);
      }
    }
    io.emit("voice:update", voiceState());
    cb({ ok: true });
  });

  // Список всех аккаунтов (администратор и модераторы)
  on("users:list", (cb) => {
    if (!isModName(socket.data.name)) return cb(NOT_MOD);
    const online = new Set();
    for (const [, s] of io.sockets.sockets) online.add(s.data.name);
    const inVoice = new Map();
    for (const [chId, members] of voiceMembers) for (const nm of members.values()) inVoice.set(nm, chId);
    const users = db
      .prepare("SELECT name, banned, moderator, server_muted AS sm FROM users ORDER BY id")
      .all()
      .map((u) => ({
        name: u.name,
        banned: !!u.banned,
        mod: !!u.moderator,
        smuted: !!u.sm,
        online: online.has(u.name),
        admin: isAdminName(u.name),
        voice: inVoice.has(u.name) ? inVoice.get(u.name) : null,
      }));
    cb({ users });
  });

  // Блокировка аккаунта (или снятие блокировки)
  on("user:ban", async (name, banOn, cb) => {
    if (!isModName(socket.data.name)) return cb(NOT_MOD);
    const u = db.prepare("SELECT id, name FROM users WHERE name = ?").get(String(name ?? ""));
    if (!u) return cb({ error: "Пользователь не найден" });
    if (isAdminName(u.name)) return cb({ error: "Администратора заблокировать нельзя" });
    if (isModName(u.name) && !isAdminName(socket.data.name)) return cb({ error: "Модератора может заблокировать только администратор" });
    db.prepare("UPDATE users SET banned = ? WHERE id = ?").run(banOn ? 1 : 0, u.id);
    audit(socket.data.name, banOn ? "Заблокирован аккаунт" : "Разблокирован аккаунт", u.name);
    if (banOn) {
      db.prepare("DELETE FROM sessions WHERE user_id = ?").run(u.id); // все его входы сразу недействительны
      await kickUser(u.name, "banned");
    }
    io.emit("voice:update", voiceState());
    notifyAdmins();
    cb({ ok: true });
  });

  // ===== Модерация: голос =====
  on("voice:kick", async (name, cb) => {
    if (!isModName(socket.data.name)) return cb(NOT_MOD);
    name = String(name ?? "");
    if (isAdminName(name)) return cb({ error: "Администратора выкинуть нельзя" });
    if (isModName(name) && !isAdminName(socket.data.name)) return cb({ error: "Модератора может выкинуть только администратор" });
    const n = await kickFromVoice(name);
    if (!n) return cb({ error: "Этот человек сейчас не в голосовом канале" });
    audit(socket.data.name, "Выкинут из голоса", name);
    cb({ ok: true });
  });

  on("voice:move", (name, chId, cb) => {
    if (!isModName(socket.data.name)) return cb(NOT_MOD);
    name = String(name ?? "");
    chId = Number(chId);
    const ch = db.prepare("SELECT id, name, kind FROM channels WHERE id = ?").get(chId);
    if (!ch || ch.kind !== "voice") return cb({ error: "Это не голосовой канал" });
    if (isAdminName(name)) return cb({ error: "Администратора перенести нельзя" });
    if (isModName(name) && !isAdminName(socket.data.name)) return cb({ error: "Модератора может перенести только администратор" });
    const targets = [];
    for (const [id, members] of voiceMembers) for (const [sid, nm] of members) if (nm === name && id !== chId) targets.push(sid);
    if (!targets.length) return cb({ error: "Этот человек не в голосовом канале или уже в этом" });
    const u = db.prepare("SELECT id FROM users WHERE name = ?").get(name);
    if (u) db.prepare("INSERT OR IGNORE INTO channel_access (user_id, channel_id) VALUES (?, ?)").run(u.id, chId); // перенос = приглашение
    for (const sid of targets) {
      const sock = io.sockets.sockets.get(sid);
      if (sock) { sendAccess(sock); sock.emit("voice:move", { channelId: chId }); }
    }
    audit(socket.data.name, "Перенесён в другой канал", name + " → " + ch.name);
    cb({ ok: true });
  });

  // ===== Аккаунты (только администратор) =====
  on("user:setmod", (name, onFlag, cb) => {
    if (!isAdminName(socket.data.name)) return cb(NOT_ADMIN);
    const u = db.prepare("SELECT id, name FROM users WHERE name = ?").get(String(name ?? ""));
    if (!u) return cb({ error: "Пользователь не найден" });
    if (isAdminName(u.name)) return cb({ error: "Администратор и так может всё" });
    db.prepare("UPDATE users SET moderator = ? WHERE id = ?").run(onFlag ? 1 : 0, u.id);
    audit(socket.data.name, onFlag ? "Выданы права модератора" : "Сняты права модератора", u.name);
    for (const [, s] of io.sockets.sockets) if (s.data.name === u.name) s.emit("me", meInfo(u.name));
    notifyAdmins();
    cb({ ok: true });
  });

  on("user:resetpass", async (name, cb) => {
    if (!isAdminName(socket.data.name)) return cb(NOT_ADMIN);
    const u = db.prepare("SELECT id, name FROM users WHERE name = ?").get(String(name ?? ""));
    if (!u) return cb({ error: "Пользователь не найден" });
    if (u.name === socket.data.name) return cb({ error: "Свой пароль меняйте в настройках" });
    const temp = tempPassword();
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(await bcrypt.hash(temp, 10), u.id);
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(u.id);
    failures.delete("name:" + u.name.toLowerCase());
    await kickUser(u.name, "reset");
    audit(socket.data.name, "Сброшен пароль", u.name);
    io.emit("voice:update", voiceState());
    notifyAdmins();
    cb({ ok: true, password: temp });
  });

  on("user:delete", async (name, cb) => {
    if (!isAdminName(socket.data.name)) return cb(NOT_ADMIN);
    const u = db.prepare("SELECT id, name, avatar FROM users WHERE name = ?").get(String(name ?? ""));
    if (!u) return cb({ error: "Пользователь не найден" });
    if (isAdminName(u.name)) return cb({ error: "Администратора удалить нельзя" });
    await kickUser(u.name, "deleted");
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(u.id);
    db.prepare("DELETE FROM channel_access WHERE user_id = ?").run(u.id);
    db.prepare("DELETE FROM reads WHERE user_id = ?").run(u.id);
    for (const d of db.prepare("SELECT channel_id AS id FROM dm_members WHERE user_id = ?").all(u.id)) {
      db.prepare("DELETE FROM messages WHERE channel_id = ?").run(d.id);
      db.prepare("DELETE FROM reads WHERE channel_id = ?").run(d.id);
      db.prepare("DELETE FROM dm_members WHERE channel_id = ?").run(d.id);
      db.prepare("DELETE FROM channels WHERE id = ?").run(d.id);
    }
    pruneReactions();
    io.emit("dm:update");
    db.prepare("DELETE FROM users WHERE id = ?").run(u.id);
    removeAvatarFile(u.avatar);
    io.emit("avatar:update", { name: u.name, url: null });
    audit(socket.data.name, "Удалён аккаунт", u.name);
    io.emit("voice:update", voiceState());
    notifyAdmins();
    cb({ ok: true });
  });

  // ===== Каналы: пароль и порядок =====
  on("channel:setpassword", async (id, password, cb) => {
    if (!isAdminName(socket.data.name)) return cb(NOT_ADMIN);
    id = Number(id);
    const ch = db.prepare("SELECT id, name, kind FROM channels WHERE id = ?").get(id);
    if (!ch || ch.kind === "dm") return cb({ error: "Канал не найден" });
    let hash = null;
    if (password !== null && password !== undefined && password !== "") {
      const pw = String(password);
      if (pw.length < MIN_CHANNEL_PASSWORD || Buffer.byteLength(pw) > 72) {
        return cb({ error: `Пароль канала: от ${MIN_CHANNEL_PASSWORD} символов, не больше 72 байт` });
      }
      hash = await bcrypt.hash(pw, 10);
    }
    db.prepare("UPDATE channels SET password_hash = ? WHERE id = ?").run(hash, id);
    db.prepare("DELETE FROM channel_access WHERE channel_id = ?").run(id); // доступ у всех сбрасывается
    if (hash) {
      // Всех, кто сейчас внутри (кроме администратора), выкидываем: нужно ввести новый пароль
      for (const [, s] of io.sockets.sockets) {
        if (!isAdminName(s.data.name) && s.rooms.has("ch:" + id)) {
          s.leave("ch:" + id);
          s.data.channel = null;
          s.emit("channel:locked", { id });
        }
      }
      const names = new Set(voiceMembers.get(id)?.values() || []);
      for (const nm of names) if (!isAdminName(nm)) await kickFromVoice(nm, id);
    }
    audit(socket.data.name, hash ? "Задан или изменён пароль канала" : "Убран пароль канала", ch.name);
    sendAccessAll();
    io.emit("channels:update", listChannels());
    cb({ ok: true });
  });

  // Ввод пароля канала: запоминается для аккаунта, пока администратор не сменит пароль
  on("channel:unlock", async (id, password, cb) => {
    id = Number(id);
    const ch = db.prepare("SELECT id, password_hash FROM channels WHERE id = ?").get(id);
    if (!ch) return cb({ error: "Канал не найден" });
    if (!ch.password_hash) return cb({ ok: true });
    const key = "ch:" + socket.data.uid + ":" + id;
    const wait = blockedFor(key, MAX_FAILS_PER_NAME);
    if (wait) return cb({ error: `Слишком много попыток. Подождите ${wait} мин.` });
    const ok = await bcrypt.compare(String(password ?? "").slice(0, 200), ch.password_hash);
    if (!ok) {
      addFailure(key);
      return cb({ error: "Неверный пароль" });
    }
    failures.delete(key);
    db.prepare("INSERT OR IGNORE INTO channel_access (user_id, channel_id) VALUES (?, ?)").run(socket.data.uid, id);
    sendAccess(socket);
    cb({ ok: true });
  });

  // Порядок каналов внутри раздела: клиент присылает полный список id в новом порядке
  on("channel:reorder", (kind, ids, cb) => {
    if (!isAdminName(socket.data.name)) return cb(NOT_ADMIN);
    kind = kind === "voice" ? "voice" : "text";
    const have = db.prepare("SELECT id FROM channels WHERE kind = ?").all(kind).map((r) => r.id);
    ids = Array.isArray(ids) ? ids.map(Number) : [];
    if (ids.length !== have.length || !have.every((x) => ids.includes(x))) {
      return cb({ error: "Список каналов устарел, обновите страницу" });
    }
    const upd = db.prepare("UPDATE channels SET pos = ? WHERE id = ?");
    ids.forEach((cid, i) => upd.run(i + 1, cid));
    audit(socket.data.name, "Изменён порядок каналов", kind === "voice" ? "голосовые" : "текстовые");
    io.emit("channels:update", listChannels());
    cb({ ok: true });
  });

  // ===== Функции чата (каждая включается тумблером в админ-панели) =====
  on("channel:read", (id) => {
    if (!feat("unread") && !isDmChannel(id)) return;
    id = Number(id);
    if (socket.data.channel === id) markRead(socket, id);
  });

  on("message:edit", (msgId, text, cb) => {
    if (!feat("edit")) return cb(FEATURE_OFF);
    msgId = Number(msgId);
    text = String(text ?? "").trim().slice(0, 2000);
    const m = db
      .prepare("SELECT id, channel_id, user_name, deleted, (strftime('%s','now') - strftime('%s', created_at)) AS age FROM messages WHERE id = ?")
      .get(msgId);
    if (!m) return cb({ error: "Сообщение не найдено" });
    if (m.user_name !== socket.data.name) return cb({ error: "Редактировать можно только свои сообщения" });
    if (m.deleted) return cb({ error: "Сообщение удалено" });
    if (m.age > 24 * 3600) return cb({ error: "Прошло больше 24 часов, изменить уже нельзя" });
    if (!text) return cb({ error: "Сообщение не может быть пустым. Если оно не нужно, удалите его." });
    db.prepare("UPDATE messages SET text = ?, edited = 1 WHERE id = ?").run(text, msgId);
    io.to("ch:" + m.channel_id).emit("message:edited", { id: msgId, channelId: m.channel_id, text });
    cb({ ok: true });
  });

  on("message:react", (msgId, emoji, cb) => {
    if (!feat("reactions")) return cb(FEATURE_OFF);
    if (!REACTIONS.includes(emoji)) return cb({ error: "Такой реакции нет" });
    msgId = Number(msgId);
    const m = db.prepare("SELECT id, channel_id, deleted FROM messages WHERE id = ?").get(msgId);
    if (!m || m.deleted) return cb({ error: "Сообщение не найдено" });
    if (socket.data.channel !== m.channel_id) return cb({ error: "Откройте канал, чтобы поставить реакцию" });
    const had = db.prepare("SELECT 1 AS x FROM reactions WHERE message_id = ? AND user_name = ? AND emoji = ?").get(msgId, socket.data.name, emoji);
    if (had) db.prepare("DELETE FROM reactions WHERE message_id = ? AND user_name = ? AND emoji = ?").run(msgId, socket.data.name, emoji);
    else db.prepare("INSERT INTO reactions (message_id, user_name, emoji) VALUES (?, ?, ?)").run(msgId, socket.data.name, emoji);
    io.to("ch:" + m.channel_id).emit("message:reactions", { id: msgId, channelId: m.channel_id, reactions: reactionsOf(msgId) });
    cb({ ok: true });
  });

  // Закреплять могут администратор и модераторы
  on("message:pin", (msgId, pinOn, cb) => {
    if (!feat("pins")) return cb(FEATURE_OFF);
    if (!isModName(socket.data.name)) return cb(NOT_MOD);
    msgId = Number(msgId);
    const m = db.prepare("SELECT id, channel_id, deleted FROM messages WHERE id = ?").get(msgId);
    if (!m || m.deleted) return cb({ error: "Сообщение не найдено" });
    if (isDmChannel(m.channel_id)) return cb({ error: "В личных сообщениях закреплять нельзя" });
    db.prepare("UPDATE messages SET pinned = ? WHERE id = ?").run(pinOn ? 1 : 0, msgId);
    const ch = db.prepare("SELECT name FROM channels WHERE id = ?").get(m.channel_id);
    audit(socket.data.name, pinOn ? "Закреплено сообщение" : "Откреплено сообщение", ch ? "#" + ch.name : "");
    io.to("ch:" + m.channel_id).emit("message:pinned", { id: msgId, channelId: m.channel_id, pinned: !!pinOn });
    cb({ ok: true });
  });

  on("pins:list", (channelId, cb) => {
    if (!feat("pins")) return cb(FEATURE_OFF);
    channelId = Number(channelId);
    if (!hasAccess(socket, channelId)) return cb({ error: "Нет доступа к каналу" });
    const rows = db.prepare("SELECT " + MSG_COLS + " FROM messages WHERE channel_id = ? AND pinned = 1 AND deleted = 0 ORDER BY id DESC").all(channelId);
    cb({ messages: decorateMessages(rows) });
  });

  on("typing", () => {
    if (!feat("typing")) return;
    const id = socket.data.channel;
    const now = Date.now();
    if (!id || now - (socket.data.typingAt || 0) < 1500) return;
    socket.data.typingAt = now;
    socket.to("ch:" + id).emit("typing", { channelId: id, name: socket.data.name });
  });

  // Поиск по открытому каналу. Ищем в коде, потому что SQLite не различает регистр только у латиницы
  on("search", (query, cb) => {
    if (!feat("search")) return cb(FEATURE_OFF);
    const id = socket.data.channel;
    if (!id) return cb({ error: "Откройте текстовый канал" });
    query = String(query ?? "").trim().slice(0, 100);
    if (query.length < 2) return cb({ error: "Введите хотя бы 2 символа" });
    const q = query.toLowerCase();
    const rows = db
      .prepare("SELECT id, user_name AS name, text, created_at AS createdAt FROM messages WHERE channel_id = ? AND deleted = 0 AND text != '' ORDER BY id DESC LIMIT 5000")
      .all(id)
      .filter((r) => r.text.toLowerCase().includes(q))
      .slice(0, 50);
    cb({ rows });
  });

  on("link:preview", async (url, cb) => {
    if (!feat("linkpreview")) return cb(FEATURE_OFF);
    url = String(url ?? "").slice(0, 500);
    if (!/^https?:\/\//i.test(url)) return cb({ error: "Неверная ссылка" });
    const now = Date.now();
    socket.data.pv = (socket.data.pv || []).filter((t) => now - t < 60e3);
    if (socket.data.pv.length >= 10) return cb({ error: "Слишком часто" });
    socket.data.pv.push(now);
    const data = await linkPreview(url);
    cb(data || { error: "Нет данных" });
  });

  // ===== Личное общение (каждая часть включается своим тумблером) =====
  on("dm:list", (cb) => {
    if (!feat("dm")) return cb(FEATURE_OFF);
    cb({ list: dmListFor(socket.data.uid) });
  });

  // Открыть (или создать) переписку с человеком
  on("dm:open", (name, cb) => {
    if (!feat("dm")) return cb(FEATURE_OFF);
    const u = db.prepare("SELECT id, name, banned FROM users WHERE name = ?").get(String(name ?? ""));
    if (!u || u.banned) return cb({ error: "Пользователь не найден" });
    if (u.id === socket.data.uid) return cb({ error: "Нельзя написать самому себе" });
    const key = dmKey(socket.data.uid, u.id);
    let ch = db.prepare("SELECT id FROM channels WHERE name = ? AND kind = 'dm'").get(key);
    if (!ch) {
      try {
        const r = db.prepare("INSERT INTO channels (name, kind, pos) VALUES (?, 'dm', 0)").run(key);
        ch = { id: Number(r.lastInsertRowid) };
        db.prepare("INSERT OR IGNORE INTO dm_members (channel_id, user_id) VALUES (?, ?)").run(ch.id, socket.data.uid);
        db.prepare("INSERT OR IGNORE INTO dm_members (channel_id, user_id) VALUES (?, ?)").run(ch.id, u.id);
      } catch {
        ch = db.prepare("SELECT id FROM channels WHERE name = ? AND kind = 'dm'").get(key); // вторая сторона успела создать раньше
        if (!ch) return cb({ error: "Не удалось открыть переписку" });
      }
    }
    const st = db.prepare("SELECT status_mode AS mode, status_text AS text FROM users WHERE id = ?").get(u.id);
    cb({ ok: true, dm: { id: ch.id, with: u.name, online: onlineNames().has(u.name), mode: st.mode || "online", text: st.text || "", lastId: null } });
  });

  // Очистка: сообщения и файлы стираются у обоих собеседников, сама переписка остаётся в списке
  on("dm:clear", (id, cb) => {
    if (!feat("dm") || !feat("dm_clear")) return cb(FEATURE_OFF);
    id = Number(id);
    if (!isDmChannel(id) || !hasAccess(socket, id)) return cb({ error: "Переписка не найдена" });
    const n = wipeMessages(id);
    db.prepare("UPDATE channels SET keep = 1 WHERE id = ?").run(id);
    emitToUsers(dmMembers(id), "dm:cleared", { id, by: socket.data.name });
    notifyDm(id);
    cb({ ok: true, count: n });
  });

  // Удаление: переписка пропадает у обоих полностью, позже можно начать новую
  on("dm:delete", (id, cb) => {
    if (!feat("dm") || !feat("dm_delete")) return cb(FEATURE_OFF);
    id = Number(id);
    if (!isDmChannel(id) || !hasAccess(socket, id)) return cb({ error: "Переписка не найдена" });
    const uids = dmMembers(id);
    wipeMessages(id); // сообщения, файлы, реакции
    db.prepare("DELETE FROM reads WHERE channel_id = ?").run(id);
    db.prepare("DELETE FROM dm_members WHERE channel_id = ?").run(id);
    db.prepare("DELETE FROM channels WHERE id = ?").run(id);
    io.in("ch:" + id).socketsLeave("ch:" + id);
    for (const s of io.sockets.sockets.values()) if (s.data.channel === id) s.data.channel = null;
    emitToUsers(uids, "dm:deleted", { id, by: socket.data.name });
    cb({ ok: true });
  });

  on("status:set", (mode, text, cb) => {
    if (!feat("status")) return cb(FEATURE_OFF);
    if (!STATUS_MODES.includes(mode)) return cb({ error: "Неизвестный статус" });
    text = String(text ?? "").trim().slice(0, 60);
    db.prepare("UPDATE users SET status_mode = ?, status_text = ? WHERE id = ?").run(mode, text || null, socket.data.uid);
    io.emit("status:update", { name: socket.data.name, mode, text });
    cb({ ok: true });
  });

  // Список всех участников (чтобы найти, кому написать)
  on("members:list", (cb) => {
    if (!(feat("dm") || feat("status") || feat("profile"))) return cb(FEATURE_OFF);
    const online = onlineNames();
    const members = db
      .prepare("SELECT name, status_mode AS mode, status_text AS text FROM users WHERE banned = 0")
      .all()
      .map((u) => ({ name: u.name, online: online.has(u.name), mode: u.mode || "online", text: u.text || "" }))
      .sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name, "ru"));
    cb({ members });
  });

  on("profile:get", (name, cb) => {
    if (!(feat("profile") || feat("dm") || feat("status"))) return cb(FEATURE_OFF);
    const u = db
      .prepare("SELECT name, bio, created_at AS createdAt, status_mode AS mode, status_text AS text, banned FROM users WHERE name = ?")
      .get(String(name ?? ""));
    if (!u || u.banned) return cb({ error: "Пользователь не найден" });
    let voice = null;
    if (feat("profile")) {
      for (const [chId, members] of voiceMembers) {
        if (![...members.values()].includes(u.name) || !hasAccess(socket, chId)) continue; // название закрытого канала не раскрываем
        const ch = db.prepare("SELECT name FROM channels WHERE id = ?").get(chId);
        if (ch) voice = ch.name;
      }
    }
    cb({
      name: u.name,
      online: onlineNames().has(u.name),
      mode: feat("status") ? u.mode || "online" : "online",
      text: feat("status") ? u.text || "" : "",
      bio: feat("profile") ? u.bio || "" : "",
      createdAt: feat("profile") ? u.createdAt || null : null,
      voice,
    });
  });

  on("profile:setbio", (text, cb) => {
    if (!feat("profile")) return cb(FEATURE_OFF);
    text = String(text ?? "").trim().slice(0, 200);
    db.prepare("UPDATE users SET bio = ? WHERE id = ?").run(text || null, socket.data.uid);
    cb({ ok: true });
  });

  // ===== Админ-панель =====
  on("admin:state", (cb) => {
    if (!isAdminName(socket.data.name)) return cb(NOT_ADMIN);
    cb({
      muteAll: flag("mute_all"),
      maintenance: flag("maintenance"),
      regClosed: flag("reg_closed"),
      invite: currentInvite(),
      autocleanAt: Number(getSetting("autoclean_at", 0)),
      features: featureList(),
    });
  });

  on("admin:setflag", async (key, onFlag, cb) => {
    if (!isAdminName(socket.data.name)) return cb(NOT_ADMIN);
    onFlag = !!onFlag;
    if (key === "mute_all") {
      setSetting("mute_all", onFlag ? 1 : 0);
      await applyMuteAll(onFlag);
      audit(socket.data.name, onFlag ? "Включён режим «Заглушить всех»" : "Выключен режим «Заглушить всех»");
    } else if (key === "maintenance") {
      setSetting("maintenance", onFlag ? 1 : 0);
      audit(socket.data.name, onFlag ? "Включён режим обслуживания" : "Выключен режим обслуживания");
      if (onFlag) {
        const names = new Set();
        for (const [, s] of io.sockets.sockets) if (!isAdminName(s.data.name)) names.add(s.data.name);
        for (const nm of names) await kickUser(nm, "maintenance");
        io.emit("voice:update", voiceState());
      }
    } else if (key === "reg_closed") {
      setSetting("reg_closed", onFlag ? 1 : 0);
      audit(socket.data.name, onFlag ? "Регистрация закрыта" : "Регистрация открыта");
    } else {
      return cb({ error: "Неизвестная настройка" });
    }
    cb({ ok: true });
  });

  on("admin:setinvite", (code, cb) => {
    if (!isAdminName(socket.data.name)) return cb(NOT_ADMIN);
    code = String(code ?? "").trim();
    if (code.length < MIN_INVITE_CODE || code.length > 64) {
      return cb({ error: `Код приглашения: от ${MIN_INVITE_CODE} до 64 символов` });
    }
    setSetting("invite_code", code);
    audit(socket.data.name, "Изменён код приглашения");
    cb({ ok: true, invite: code });
  });

  // Удалить сообщения и файлы: во всех каналах (channelId = null) или в одном
  on("admin:wipe", (channelId, cb) => {
    if (!isAdminName(socket.data.name)) return cb(NOT_ADMIN);
    if (channelId !== null && channelId !== undefined) {
      channelId = Number(channelId);
      const ch = db.prepare("SELECT name FROM channels WHERE id = ? AND kind = 'text'").get(channelId);
      if (!ch) return cb({ error: "Канал не найден" });
      const n = wipeMessages(channelId);
      audit(socket.data.name, "Очищен канал", ch.name + ", сообщений: " + n);
      return cb({ ok: true, count: n });
    }
    const n = wipeMessages(null);
    audit(socket.data.name, "Удалены все чаты", "сообщений: " + n);
    cb({ ok: true, count: n });
  });

  // Автоочистка: тумблер. Через 7 дней после включения всё стирается один раз, и тумблер выключается сам
  on("admin:autoclean", (onFlag, cb) => {
    if (!isAdminName(socket.data.name)) return cb(NOT_ADMIN);
    if (onFlag) {
      const at = Date.now() + 7 * 24 * 3600e3;
      setSetting("autoclean_at", at);
      audit(socket.data.name, "Включена автоочистка", "сработает " + new Date(at).toISOString());
      return cb({ ok: true, at });
    }
    delSetting("autoclean_at");
    audit(socket.data.name, "Выключена автоочистка");
    cb({ ok: true, at: 0 });
  });

  on("admin:stats", (cb) => {
    if (!isAdminName(socket.data.name)) return cb(NOT_ADMIN);
    const names = new Set();
    for (const [, s] of io.sockets.sockets) names.add(s.data.name);
    const voiceNames = new Set();
    for (const m of voiceMembers.values()) for (const nm of m.values()) voiceNames.add(nm);
    const up = dirSize(UPLOADS);
    const count = (t) => db.prepare("SELECT COUNT(*) AS c FROM " + t).get().c;
    cb({
      online: names.size,
      inVoice: voiceNames.size,
      users: count("users"),
      channels: db.prepare("SELECT COUNT(*) AS c FROM channels WHERE kind != 'dm'").get().c,
      messages: count("messages"),
      dbBytes: dbBytes(),
      uploadsBytes: up.total,
      uploadsFiles: up.files,
      uptime: Math.round(process.uptime()),
      startedAt: STARTED_AT,
      pid: process.pid,
      node: process.version,
      supervisor: supervisor(),
      entry: ENTRY_FILE,
      codeMtime: Math.max(mtime(ENTRY_FILE), mtime(path.join(ROOT, "db.js"))), // index.js и db.js читаются только при запуске
      htmlMtime: mtime(path.join(ROOT, "public", "index.html")), // страница отдаётся с диска каждый раз, перезапуск ей не нужен
    });
  });

  // Удаляет загруженные файлы, которые не прикреплены ни к одному сообщению
  on("admin:cleanfiles", (cb) => {
    if (!isAdminName(socket.data.name)) return cb(NOT_ADMIN);
    // Свежие файлы не трогаем: их могут ещё прикреплять к сообщению
    const r = cleanupUploads(15 * 60e3);
    audit(socket.data.name, "Удалены неиспользуемые файлы", r.count + " шт.");
    cb({ ok: true, ...r });
  });

  on("admin:audit", (cb) => {
    if (!isAdminName(socket.data.name)) return cb(NOT_ADMIN);
    cb({ rows: db.prepare("SELECT ts, actor, action, details FROM audit ORDER BY id DESC LIMIT 200").all() });
  });

  on("admin:announce", (text, cb) => {
    if (!isAdminName(socket.data.name)) return cb(NOT_ADMIN);
    text = String(text ?? "").trim().slice(0, 1000);
    if (!text) return cb({ error: "Введите текст объявления" });
    io.emit("announce", { from: socket.data.name, text });
    audit(socket.data.name, "Отправлено объявление", text);
    cb({ ok: true });
  });

  // Перезапуск сервера: процесс завершается, а PM2 поднимает его заново
  on("admin:restart", (cb) => {
    if (!isAdminName(socket.data.name)) return cb(NOT_ADMIN);
    audit(socket.data.name, "Перезапуск сервера");
    console.log("Перезапуск сервера по просьбе администратора", socket.data.name, new Date().toISOString());
    io.emit("server:restarting");
    cb({ ok: true, startedAt: STARTED_AT });
    // Код 1, а не 0: systemd с Restart=on-failure и Docker с on-failure поднимают процесс только после «сбоя». PM2 перезапускает при любом коде
    setTimeout(() => process.exit(1), 1200);
  });

  on("admin:feature", (id, onFlag, cb) => {
    if (!isAdminName(socket.data.name)) return cb(NOT_ADMIN);
    const f = FEATURES.find((x) => x.id === id);
    if (!f) return cb({ error: "Неизвестная функция" });
    setSetting("feat:" + id, onFlag ? 1 : 0);
    audit(socket.data.name, onFlag ? "Включена функция" : "Выключена функция", f.label);
    // Новый набор функций сразу получают все окна всех людей: выключили сломавшуюся функцию, и она пропала у всех без перезагрузки
    io.emit("features:update", { features: enabledFeatures() });
    if (id === "unread" || id === "dm") { // счётчики непрочитанных должны появиться сразу, а не только после следующего входа
      for (const [, s] of io.sockets.sockets) if (feat("unread") || feat("dm")) s.emit("unread:state", unreadState(s));
    }
    cb({ ok: true });
  });

  // Клиент сообщает, выключен ли у него микрофон и звук
  on("voice:state", (d) => {
    if (![...voiceMembers.values()].some((m) => m.has(socket.id))) return;
    socket.data.vs = { muted: !!d?.muted, deaf: !!d?.deaf };
    io.emit("voice:update", voiceState());
  });

  on("voice:leave", () => {
    leaveVoice(socket);
    io.emit("voice:update", voiceState());
  });

  socket.on("disconnect", () => {
    leaveVoice(socket);
    io.emit("voice:update", voiceState());
    notifyAdmins();
    if (
      (feat("status") || feat("dm") || feat("profile")) &&
      ![...io.sockets.sockets.values()].some((s) => s.data.name === socket.data.name)
    ) {
      io.emit("presence", { name: socket.data.name, online: false });
    }
  });
});

// Старые записи квот и регистраций не нужны: для лимитов хватает суток, храним неделю
function pruneRateLogs() {
  const cut = Date.now() - 7 * 24 * 3600e3;
  db.prepare("DELETE FROM uploads_log WHERE ts < ?").run(cut);
  db.prepare("DELETE FROM reg_log WHERE ts < ?").run(cut);
}

// Удаляем загруженные, но так и не прикреплённые к сообщениям файлы (по умолчанию старше суток)
function cleanupUploads(minAgeMs = 24 * 3600e3) {
  pruneRateLogs();
  const used = new Set(
    db.prepare("SELECT file_url FROM messages WHERE file_url IS NOT NULL").all().map((r) => path.basename(r.file_url))
  );
  let count = 0, bytes = 0;
  for (const e of fs.readdirSync(UPLOADS, { withFileTypes: true })) {
    if (!e.isFile() || used.has(e.name)) continue;
    const p = path.join(UPLOADS, e.name);
    const st = fs.statSync(p);
    if (Date.now() - st.mtimeMs >= minAgeMs) {
      fs.rm(p, { force: true }, () => {});
      count++;
      bytes += st.size;
    }
  }
  return { count, bytes };
}
cleanupUploads();
setInterval(cleanupUploads, 6 * 3600e3);
setInterval(runAutoclean, 60e3);
runAutoclean();

process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));

// За Caddy слушаем только локальный адрес. Для доступа с других устройств: HOST=0.0.0.0
console.log("Администратор каналов:", ADMIN_NAME || db.prepare("SELECT name FROM users ORDER BY id LIMIT 1").get()?.name || "(пока нет пользователей)");
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "127.0.0.1";
http.listen(PORT, HOST, () => {
  console.log(`http://${HOST}:${PORT}`);
  console.log("Сервер запущен", new Date(STARTED_AT).toISOString(), "файл:", ENTRY_FILE, "менеджер процессов:", supervisor() || "не обнаружен");
});