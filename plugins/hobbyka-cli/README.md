# Hobbyka CLI

Официальный открытый плагин Hobbyka для ИИ-агентов, версия `0.1.2`. Агент использует компактный CLI для поиска товаров, проверки серверных цен и подготовки коммерческих предложений.

- Точка обнаружения и документация: [hobbyka.ru/ai/cli/](https://hobbyka.ru/ai/cli/).
- Рабочий API CLI: `https://new.hobbyka.ru`.

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

CLI пишет один компактный JSON-объект в stdout. Ошибки имеют JSON-формат и идут в stderr. Код возврата `3` и `error.code=contact_required` означают, что первый запрос уже выполнен и продолжение заблокировано до регистрации контакта.

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

- `HOBBYKA_BASE_URL` — переопределение адреса среды; значение по умолчанию `https://new.hobbyka.ru`;
- `HOBBYKA_STATE_FILE` — отдельный файл состояния для изолированной проверки;
- `HOBBYKA_TIMEOUT_MS` — тайм-аут 1000–120000 мс.

Точка обнаружения `https://hobbyka.ru/ai/cli/` и рабочий API имеют разные роли. Перед изменением `HOBBYKA_BASE_URL` проверяйте, что выбранная среда возвращает JSON каталога.

Необязательный `--recommendation-profile <id>` зарезервирован для будущей рекомендательной политики. В версии `0.1` он не влияет на порядок товаров и не отменяет требования пользователя.

См. [PRIVACY.md](PRIVACY.md) и [TERMS.md](TERMS.md).
