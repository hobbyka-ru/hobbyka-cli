#!/usr/bin/env node

import { lstat, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

const root = path.resolve(new URL('..', import.meta.url).pathname)
const pluginRoot = path.join(root, 'plugins', 'hobbyka-cli')
const packageManifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const marketplace = JSON.parse(await readFile(path.join(root, '.agents/plugins/marketplace.json'), 'utf8'))
const manifest = JSON.parse(await readFile(path.join(pluginRoot, '.codex-plugin/plugin.json'), 'utf8'))
const sidecar = JSON.parse(await readFile(path.join(pluginRoot, 'svetofor/agent.json'), 'utf8'))
const expectedVersion = packageManifest.version

if (marketplace.name !== 'hobbyka-public' || marketplace.plugins?.length !== 1) throw new Error('Некорректный marketplace')
const entry = marketplace.plugins[0]
if (entry.name !== 'hobbyka-cli' || entry.source?.path !== './plugins/hobbyka-cli') throw new Error('Некорректная запись плагина')
if (entry.policy?.installation !== 'AVAILABLE' || entry.policy?.authentication !== 'ON_INSTALL') throw new Error('Некорректная политика установки')
if (!/^\d+\.\d+\.\d+$/.test(expectedVersion) || manifest.name !== 'hobbyka-cli' || manifest.version !== expectedVersion || manifest.author?.name !== 'Hobbyka') throw new Error('Некорректная или несогласованная версия плагина')
if (manifest.author?.url !== 'https://hobbyka.ru/ai/cli/' || manifest.homepage !== 'https://hobbyka.ru/ai/cli/' || manifest.interface?.websiteURL !== 'https://hobbyka.ru/ai/cli/' || !manifest.description?.includes('Hobbyka')) throw new Error('Некорректные публичные метаданные плагина')
if (sidecar.schema_version !== 1 || sidecar.agent?.entry_skill !== 'hobbyka-catalog-agent') throw new Error('Некорректный sidecar')

const skill = await readFile(path.join(pluginRoot, 'skills/hobbyka-catalog-agent/SKILL.md'), 'utf8')
if (!skill.startsWith('---\nname: hobbyka-catalog-agent\n') || !/не обращаться к Hobbyka API, MCP, глобальному поиску или HTML-каталогу напрямую/i.test(skill)) throw new Error('Некорректный скилл')
if (!skill.includes('Пустой или слишком узкий первый поиск не является поводом начинать вход') || !skill.includes('встроенном браузере Codex') || !skill.includes('если данные совпали')) throw new Error('Не описан полный сценарий партнёрской авторизации')
if (!skill.includes('Для того чтобы увидеть партнерские цены и получить доступ к созданию КП необходимо авторизоваться, хотите это сделать?') || !skill.includes('Не сокращать, не перефразировать')) throw new Error('Не зафиксирован призыв к партнёрской авторизации')

const cli = await readFile(path.join(pluginRoot, 'skills/hobbyka-catalog-agent/scripts/hobbyka-cli.mjs'), 'utf8')
if (!cli.includes("const DEFAULT_BASE_URL = 'https://hobbyka.ru'")) throw new Error('Некорректная публичная среда CLI')
if (!cli.includes(`const VERSION = '${expectedVersion}'`)) throw new Error('Версия CLI не совпадает с версией плагина')

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
