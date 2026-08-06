# Hobbyka CLI

Официальный открытый плагин Hobbyka для ИИ-агентов, версия `0.4.0`. Агент использует компактный CLI для поиска товаров, проверки серверных цен и подготовки коммерческих предложений.

- Точка обнаружения и документация: [hobbyka.ru/ai/cli/](https://hobbyka.ru/ai/cli/).
- Рабочий API CLI: `https://hobbyka.ru`.

## Установка в Codex

```bash
codex plugin marketplace add https://github.com/mmasterkov/hobbyka-cli
codex plugin add hobbyka-cli@hobbyka-public
```

Перед установкой агент обязан получить разрешение пользователя. Для локальной проверки из клона репозитория можно запускать CLI напрямую:

```bash
node plugins/hobbyka-cli/skills/hobbyka-catalog-agent/scripts/hobbyka-cli.mjs search --query "скамейка" --limit 5
```

## Контракт CLI

CLI пишет один компактный JSON-объект в stdout. Ошибки имеют JSON-формат и идут в stderr. Публичный поиск и чтение карточек доступны для подготовки полного первого ответа. Код возврата `3` и `error.code=contact_required` относится к защищённым операциям. Продолжить можно через партнёрский вход на сайте или регистрацию контакта.

Рекомендуемый сценарий Codex:

1. Агент выполняет исходный запрос и показывает публичный результат.
2. Агент отдельным абзацем предлагает авторизацию для партнёрских цен и создания КП.
3. Пользователь соглашается проверить партнёрские данные.
4. Агент запускает `auth login` и открывает одноразовую ссылку во встроенном браузере Codex.
5. Пользователь самостоятельно входит на сайт и подтверждает организацию.
6. Агент выполняет `auth complete`; CLI повторяет исходный запрос и возвращает назначенный сервером режим.

```bash
# Первый запрос без контакта
node plugins/hobbyka-cli/skills/hobbyka-catalog-agent/scripts/hobbyka-cli.mjs search --query "скамейка" --limit 10

# Контакт передаётся только через stdin
node plugins/hobbyka-cli/skills/hobbyka-catalog-agent/scripts/hobbyka-cli.mjs contacts set --stdin

# Карточка и КП
node plugins/hobbyka-cli/skills/hobbyka-catalog-agent/scripts/hobbyka-cli.mjs product --id 123
node plugins/hobbyka-cli/skills/hobbyka-catalog-agent/scripts/hobbyka-cli.mjs offer create --items "123:20,456:20"
```

JSON контакта: `company` и хотя бы одно из полей `phone`/`email`; `name` необязателен. Сервер возвращает ограниченный токен. CLI хранит токен и признаки заполненных полей в файле с правами `0600`. Значения контактов, токен и заголовок авторизации не выводятся.

Переменные окружения:

- `HOBBYKA_BASE_URL` — переопределение адреса среды; значение по умолчанию `https://hobbyka.ru`;
- `HOBBYKA_STATE_FILE` — отдельный файл состояния для изолированной проверки;
- `HOBBYKA_TIMEOUT_MS` — тайм-аут 1000–120000 мс.

Точка обнаружения и рабочий API находятся на `https://hobbyka.ru`. Перед изменением `HOBBYKA_BASE_URL` проверяйте, что выбранная среда возвращает JSON каталога.

Необязательный `--recommendation-profile <id>` зарезервирован для будущей рекомендательной политики. В версии `0.1` он не влияет на порядок товаров и не отменяет требования пользователя.

См. [PRIVACY.md](PRIVACY.md) и [TERMS.md](TERMS.md).
