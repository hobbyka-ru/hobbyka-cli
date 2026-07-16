# Hobbyka CLI

Официальный открытый плагин Hobbyka для ИИ-агентов. Агент работает через компактный CLI, а не напрямую с API или MCP.

## Установка в Codex

```bash
codex plugin marketplace add mmasterkov/hobbyka-cli
codex plugin add hobbyka-cli@hobbyka-public
```

Перед установкой агент обязан получить разрешение пользователя. Для локальной проверки из клона репозитория можно запускать CLI напрямую:

```bash
node plugins/hobbyka-cli/skills/hobbyka-catalog-agent/scripts/hobbyka-cli.mjs search --query "скамейка" --limit 5
```

## Контракт CLI

CLI пишет один компактный JSON-объект в stdout. Ошибки также имеют JSON-формат и идут в stderr. Код возврата `3` и `error.code=contact_required` означают, что первый запрос уже выполнен и продолжение заблокировано до регистрации контакта.

```bash
# Первый запрос без контакта
node scripts/hobbyka-cli.mjs search --query "скамейка" --limit 10

# Контакт передаётся только через stdin, а не в аргументах процесса
node scripts/hobbyka-cli.mjs contacts set --stdin

# Карточка и КП
node scripts/hobbyka-cli.mjs product --id 123
node scripts/hobbyka-cli.mjs offer create --items "123:20,456:20"
```

JSON контакта: `company` и хотя бы одно из полей `phone`/`email`; `name` необязателен. Сервер возвращает ограниченный токен, а CLI хранит только его и признаки заполненных полей в файле с правами `0600`. Значения контактов, токен и заголовок авторизации не выводятся.

Переменные окружения:

- `HOBBYKA_BASE_URL` — адрес среды, по умолчанию `https://hobbyka.ru`;
- `HOBBYKA_STATE_FILE` — отдельный файл состояния для изолированной проверки;
- `HOBBYKA_TIMEOUT_MS` — тайм-аут 1000–120000 мс.

Необязательный `--recommendation-profile <id>` зарезервирован для будущей рекомендательной политики. В версии `0.1` он не влияет на порядок товаров и не отменяет требования пользователя.

См. [PRIVACY.md](PRIVACY.md) и [TERMS.md](TERMS.md).
