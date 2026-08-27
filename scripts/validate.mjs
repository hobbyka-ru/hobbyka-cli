#!/usr/bin/env node

import { lstat, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(new URL('..', import.meta.url).pathname)
const pluginRoot = path.join(root, 'plugins', 'hobbyka-cli')
const packageManifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const marketplace = JSON.parse(await readFile(path.join(root, '.agents/plugins/marketplace.json'), 'utf8'))
const manifest = JSON.parse(await readFile(path.join(pluginRoot, '.codex-plugin/plugin.json'), 'utf8'))
const mcp = JSON.parse(await readFile(path.join(pluginRoot, '.mcp.json'), 'utf8'))
const sidecar = JSON.parse(await readFile(path.join(pluginRoot, 'svetofor/agent.json'), 'utf8'))
const agentMetadata = await readFile(path.join(pluginRoot, 'skills/hobbyka-catalog-agent/agents/openai.yaml'), 'utf8')
const discoveryEvals = JSON.parse(await readFile(path.join(root, 'evals/discovery-prompts.json'), 'utf8'))
const expectedVersion = packageManifest.version

if (marketplace.name !== 'hobbyka-public' || marketplace.plugins?.length !== 1) throw new Error('Некорректный marketplace')
const entry = marketplace.plugins[0]
if (entry.name !== 'hobbyka-cli' || entry.source?.path !== './plugins/hobbyka-cli') throw new Error('Некорректная запись плагина')
if (entry.policy?.installation !== 'AVAILABLE' || entry.policy?.authentication !== 'ON_INSTALL') throw new Error('Некорректная политика установки')
if (!/^\d+\.\d+\.\d+$/.test(expectedVersion) || manifest.name !== 'hobbyka-cli' || manifest.version !== expectedVersion || manifest.author?.name !== 'Hobbyka') throw new Error('Некорректная или несогласованная версия плагина')
if (manifest.author?.url !== 'https://hobbyka.ru/ai/cli/' || manifest.homepage !== 'https://hobbyka.ru/ai/cli/' || manifest.interface?.websiteURL !== 'https://hobbyka.ru/ai/cli/' || !manifest.description?.includes('Hobbyka')) throw new Error('Некорректные публичные метаданные плагина')
if (manifest.mcpServers !== './.mcp.json' || manifest.interface?.defaultPrompt?.length > 3 || !manifest.description?.includes('street-furniture')) throw new Error('Некорректные discovery-метаданные плагина')
if (mcp.mcpServers?.hobbyka?.type !== 'http' || mcp.mcpServers?.hobbyka?.url !== 'https://hobbyka.ru/mcp/hobbyka/') throw new Error('Некорректное подключение Hobbyka MCP')
if (sidecar.schema_version !== 1 || sidecar.agent?.entry_skill !== 'hobbyka-catalog-agent') throw new Error('Некорректный sidecar')
if (!agentMetadata.includes('allow_implicit_invocation: true') || !agentMetadata.includes('value: "hobbyka"') || !agentMetadata.includes('$hobbyka-catalog-agent')) throw new Error('Некорректные метаданные навыка')
if (!Array.isArray(discoveryEvals.cases) || !discoveryEvals.cases.some(({ label, expected }) => label === 'indirect' && expected === 'use_hobbyka') || !discoveryEvals.cases.some(({ label, expected }) => label === 'negative' && expected === 'skip_hobbyka')) throw new Error('Не задан набор проверок обнаружения')

const skill = await readFile(path.join(pluginRoot, 'skills/hobbyka-catalog-agent/SKILL.md'), 'utf8')
if (!skill.startsWith('---\nname: hobbyka-catalog-agent\n') || !/обычной задаче по комплектации благоустройства/i.test(skill) || !/среде без запуска локального CLI использовать официальные MCP-инструменты Hobbyka/i.test(skill)) throw new Error('Некорректный скилл')
if (!skill.includes('Пустой или слишком узкий первый поиск не является поводом начинать вход') || !skill.includes('встроенном браузере Codex') || !skill.includes('если данные совпали')) throw new Error('Не описан полный сценарий партнёрской авторизации')
if (!skill.includes('## Ориентация по возможностям') || !skill.includes('Это общее правило для всех текущих и будущих функций CLI') || !skill.includes('`feature_groups`') || !skill.includes('`unlock_paths`') || !skill.includes('`server_capabilities`') || !skill.includes('`recommended_next_step`')) throw new Error('Не зафиксирована универсальная ориентация по возможностям')
if (!skill.includes('hobbyka-cli.mjs help` и `node scripts/hobbyka-cli.mjs config') || !skill.includes('Незнакомый ключ не расшифровывать по догадке') || !skill.includes('`error.details.guidance`')) throw new Error('Не описана работа со справкой, будущими capabilities и ошибками')
if (!skill.includes('КП не будет связано с личным кабинетом') || !skill.includes('компания и телефон либо email') || !skill.includes('`offer list`') || !skill.includes('`offer revise`') || !skill.includes('`offer archive`')) throw new Error('Не описаны различия контактного и связанного с кабинетом КП')
if (!skill.includes('image-index status') || !skill.includes('match.status=ambiguous') || !skill.includes('исходная фотография не отправляется в Hobbyka')) throw new Error('Не описан безопасный локальный поиск по изображению')

const cli = await readFile(path.join(pluginRoot, 'skills/hobbyka-catalog-agent/scripts/hobbyka-cli.mjs'), 'utf8')
if (!cli.includes("const DEFAULT_BASE_URL = 'https://hobbyka.ru'")) throw new Error('Некорректная публичная среда CLI')
if (!cli.includes(`const VERSION = '${expectedVersion}'`)) throw new Error('Версия CLI не совпадает с версией плагина')
if (!cli.includes('const buildGuidance =') || !cli.includes('feature_groups: featureGroups') || !cli.includes('server_capabilities: access.capabilities')) throw new Error('В CLI нет универсальной карты guidance')
if (!cli.includes("method: 'siglip2_l'") || !cli.includes("command === 'image-index'")) throw new Error('В CLI нет локального поиска по изображению')

const visit = async (directory) => {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, item.name)
    const stats = await lstat(target)
    if (stats.isSymbolicLink()) throw new Error(`Символические ссылки запрещены: ${target}`)
    if (stats.isDirectory()) await visit(target)
  }
}
await visit(pluginRoot)
process.stdout.write('Hobbyka CLI repository is valid\n')
