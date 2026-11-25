// Первичная настройка: создаёт .env и livekit.yaml с уникальными ключами.
// Существующие файлы не перезаписывает - можно запускать сколько угодно раз.
//
// Запуск: npm run setup
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ENV_FILE = path.join(ROOT, ".env");
const ENV_EXAMPLE = path.join(ROOT, ".env.example");
const LIVEKIT_FILE = path.join(ROOT, "livekit.yaml");

// Ключи и код приглашения - случайные, одинаковой длины при каждом запуске
const secret = () => randomBytes(32).toString("base64url");
const invite = () => randomBytes(6).toString("hex");
const newKey = () => "API" + randomBytes(8).toString("hex");

if (!fs.existsSync(ENV_EXAMPLE)) {
  console.error("Не найден .env.example - запустите скрипт из папки проекта.");
  process.exit(1);
}

const code = invite();
const key = newKey();
const apiSecret = secret();

let envCreated = false;
if (fs.existsSync(ENV_FILE)) {
  console.log(".env уже есть - оставляю как есть.");
} else {
  const lines = fs.readFileSync(ENV_EXAMPLE, "utf8").split(/\r?\n/);
  const filled = lines.map((line) => {
    if (line.startsWith("INVITE_CODE=")) return "INVITE_CODE=" + code;
    if (line.startsWith("LIVEKIT_API_KEY=")) return "LIVEKIT_API_KEY=" + key;
    if (line.startsWith("LIVEKIT_API_SECRET=")) return "LIVEKIT_API_SECRET=" + apiSecret;
    return line;
  });
  fs.writeFileSync(ENV_FILE, filled.join("\n"), "utf8");
  envCreated = true;
}

let livekitCreated = false;
if (fs.existsSync(LIVEKIT_FILE)) {
  console.log("livekit.yaml уже есть - оставляю как есть.");
} else {
  const yaml = `# Конфиг LiveKit. Секреты те же, что в .env, - файл не коммитить.
port: 7880
rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 60000
  # true - если сервер за NAT или без публичного IP на интерфейсе: LiveKit
  # определит внешний адрес через STUN. Для локального запуска оставьте false.
  use_external_ip: false
keys:
  ${key}: ${apiSecret}
logging:
  level: info
`;
  fs.writeFileSync(LIVEKIT_FILE, yaml, "utf8");
  livekitCreated = true;
}

console.log("");
console.log(envCreated ? "Создан .env" : ".env не тронут");
console.log(livekitCreated ? "Создан livekit.yaml" : "livekit.yaml не тронут");
if (envCreated && livekitCreated) {
  console.log("");
  console.log("Ключи LiveKit лежат в обоих файлах и должны совпадать.");
  console.log("Код приглашения: " + code);
}
console.log("");
console.log("Дальше:");
console.log("  1. livekit-server --config ./livekit.yaml   (или для пробы: livekit-server --dev)");
console.log("  2. npm start");
console.log("  3. Откройте http://127.0.0.1:3000 и зарегистрируйтесь первым -");
console.log("     этот аккаунт станет администратором (если ADMIN_NAME пуст).");
console.log("");
console.log("Для доступа с других машин нужен HTTPS-прокси перед сервером и");
console.log("wss:// адрес LiveKit - см. README.md, там пошаговая установка.");
