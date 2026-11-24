# Установка на сервер

Инструкция для Ubuntu 22.04/24.04 или Debian 12. Пример доменов:
`chat.example.com` — чат, `livekit.example.com` — голос. Замените их на свои.

Схема: Node.js слушает `127.0.0.1:3000`, Caddy принимает HTTPS и проксирует к
нему и к LiveKit; медиа LiveKit идёт напрямую по UDP.

## 0. Что понадобится

- VPS с публичным IPv4, root или sudo.
- Домен и две A-записи: `chat.` и `livekit.` на IP сервера (Caddy сам получит
  сертификаты Let's Encrypt).
- Открытые порты: `22/tcp`, `80/tcp`, `443/tcp`, `7881/tcp`,
  `50000-60000/udp`.

## 1. Node.js 22

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs git
node -v   # должно быть v22.13 или новее
```

## 2. Пользователь и папка

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin ramacord
sudo mkdir -p /opt/ramacord
sudo chown ramacord:ramacord /opt/ramacord
sudo -u ramacord git clone https://github.com/luciferiuss/ramacord.git /opt/ramacord
cd /opt/ramacord
sudo -u ramacord npm ci
```

## 3. Настройки

```bash
sudo -u ramacord npm run setup
```

Скрипт создаст `.env` и `livekit.yaml` со случайными ключами (существующие
файлы не трогает) и напечатает код приглашения. Теперь поправьте `.env`:

```bash
sudo -u ramacord nano /opt/ramacord/.env
```

Что изменить для продакшена:

| Переменная | Значение |
|---|---|
| `NODE_ENV` | `production` |
| `HOST` | `127.0.0.1` (оставить: снаружи только Caddy) |
| `ADMIN_NAME` | ник своего аккаунта (или оставить пустым — админ = первый зарегистрированный) |
| `INVITE_CODE` | код из вывода `npm run setup` или свой (от 12 символов) |
| `LIVEKIT_URL` | `wss://livekit.example.com` |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | уже сгенерированы, менять не нужно |

Лимиты можно оставить по умолчанию или подстроить под сервер:

| Переменная | По умолчанию | Что ограничивает |
|---|---|---|
| `VOICE_TOKEN_TTL` | `10m` | срок токена голоса (LiveKit продлевает его в звонке) |
| `UPLOAD_PER_HOUR` | `30` | файлов в час с аккаунта |
| `UPLOAD_USER_MB` | `250` | мегабайт за сутки на аккаунт |
| `UPLOAD_TOTAL_MB` | `2048` | мегабайт за сутки на сервер |
| `REG_LIMIT_IP` | `3` | аккаунтов с одного IP за сутки |
| `REG_LIMIT_TOTAL` | `20` | аккаунтов на сервер за сутки |

Пароль канала — от 8 символов, код приглашения — от 12; это проверяет сервер.

Права на файлы: `.env` и `livekit.yaml` должны быть недоступны остальным.

```bash
sudo chmod 600 /opt/ramacord/.env /opt/ramacord/livekit.yaml
```

## 4. LiveKit

```bash
curl -sSL https://get.livekit.io | bash
livekit-server --version
```

Проверьте `livekit.yaml`: ключи должны совпадать с `.env`. Параметр
`rtc.use_external_ip` по умолчанию `false` (локальный запуск); если сервер за
NAT или в облаке без публичного IP на интерфейсе — поставьте `true`, тогда
LiveKit определит внешний адрес через STUN.

Сервис:

```bash
sudo tee /etc/systemd/system/livekit.service > /dev/null <<'EOF'
[Unit]
Description=LiveKit Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ramacord
WorkingDirectory=/opt/ramacord
ExecStart=/usr/local/bin/livekit-server --config /opt/ramacord/livekit.yaml
Restart=on-failure
RestartSec=3
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now livekit
sudo systemctl status livekit
```

## 5. Сервис чата

```bash
sudo tee /etc/systemd/system/ramacord.service > /dev/null <<'EOF'
[Unit]
Description=Ramacord
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ramacord
WorkingDirectory=/opt/ramacord
ExecStart=/usr/bin/node --env-file-if-exists=.env index.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now ramacord
sudo systemctl status ramacord
curl -I http://127.0.0.1:3000
```

Кнопка «Перезапустить сервер» в админ-панели работает потому, что процесс
завершается с кодом 1, а `Restart=on-failure` поднимает его заново.

## 6. Caddy и HTTPS

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

`/etc/caddy/Caddyfile`:

```
chat.example.com {
	encode zstd gzip
	reverse_proxy 127.0.0.1:3000
}

livekit.example.com {
	reverse_proxy 127.0.0.1:7880
}
```

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Сжатие (`encode`) важно: WASM-модель шумодава ~17 МБ, по сети она уезжает
примерно в 10 МБ, и только когда пользователь включит DeepFilterNet3.

## 7. Файрвол

```bash
sudo ufw allow 22/tcp
sudo ufw allow 80,443/tcp
sudo ufw allow 7881/tcp
sudo ufw allow 50000:60000/udp
sudo ufw enable
```

Порт `7880` наружу не открывайте — к LiveKit снаружи ходят только через
Caddy по HTTPS. UDP-диапазон нужен для медиа и проксироваться не может.

## 8. Первый вход

1. Откройте `https://chat.example.com`.
2. Зарегистрируйтесь: ник, пароль (от 6 символов), код приглашения.
3. Этот аккаунт — администратор (если `ADMIN_NAME` пуст). Запишите ник в
   `ADMIN_NAME`, чтобы роль не зависела от порядка регистрации:
   `sudo nano /opt/ramacord/.env`, затем `sudo systemctl restart ramacord`.
4. Админ-панель → **Функции**: включите нужные (по умолчанию всё выключено).
5. Админ-панель → **Доступ**: при желании закройте регистрацию совсем.
6. Проверьте голос: зайдите в голосовой канал с двух устройств. Браузер
   разрешит микрофон только на `https://`.

## 9. Обновление

```bash
cd /opt/ramacord
sudo -u ramacord git pull
sudo -u ramacord npm ci
sudo systemctl restart ramacord
```

База и загрузки при обновлении не затрагиваются: `mycord.db` и `uploads/`
лежат рядом с кодом и в git не входят.

## 10. Резервные копии

Проще всего — админ-панель → **Сервер** → «Резервная копия базы»: скачается
целиком `mycord.db`. Помните, что в нём хеши паролей и токены входа.

Копия на сервере без остановки:

```bash
sudo apt install -y sqlite3
sudo sqlite3 /opt/ramacord/mycord.db ".backup '/var/backups/ramacord-$(date +%F).db'"
```

Загрузки копируются отдельно: `sudo tar czf /var/backups/uploads-$(date +%F).tar.gz -C /opt/ramacord uploads`.

## 11. Если что-то не работает

- **«Не заданы переменные окружения»** — `.env` не найден или пуст. Запускайте
  из папки проекта (`npm start` или юнит из шага 5), проверьте имя файла.
- **502 от Caddy** — процесс не слушает порт: `sudo journalctl -u ramacord -n 50`.
- **Голос не подключается** — `LIVEKIT_URL` должен быть `wss://`; проверьте,
  что открыты `7881/tcp` и UDP-диапазон, и что `Caddyfile` проксирует
  `livekit.` домен.
- **Микрофон не запрашивается** — страница открыта по `http://`. Нужен HTTPS.
- **Долго включается DeepFilterNet3** — это ~17 МБ WASM; убедитесь, что в
  Caddy включено `encode zstd gzip`.
- **«ВНИМАНИЕ: INVITE_CODE не задан, регистрация открыта всем»** — задайте
  `INVITE_CODE` в `.env` и перезапустите сервис.
- **«ВНИМАНИЕ: INVITE_CODE короче 12 символов»** — код легко подобрать; смените
  его в админ-панели («Доступ») или в `.env`.
- **«С этого адреса уже создано слишком много аккаунтов»** — сработал лимит
  регистраций (`REG_LIMIT_IP`, по умолчанию 3 в сутки с одного IP).
- **«Дневной лимит загрузок»** — квота аккаунта или сервера (`UPLOAD_USER_MB`,
  `UPLOAD_TOTAL_MB`); файлы больше 25 МБ не принимаются никогда.
