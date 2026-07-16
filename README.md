# Hobbyka CLI

Официальный открытый плагин Hobbyka для Codex и других ИИ-агентов. Плагин предоставляет CLI для поиска и подбора товаров, безопасной регистрации контакта и подготовки коммерческого предложения по серверным ценам Hobbyka.

## Установка в Codex

Перед установкой агент должен получить разрешение пользователя.

```bash
codex plugin marketplace add mmasterkov/hobbyka-cli
codex plugin add hobbyka-cli@hobbyka-public
```

После установки откройте новую задачу Codex. Пользователь может сформулировать обычный запрос на подбор товара; скилл направит агента в Hobbyka CLI и запретит прямую работу с API или MCP.

## Разработка

```bash
npm run check
```

Код плагина находится в [`plugins/hobbyka-cli`](plugins/hobbyka-cli).
