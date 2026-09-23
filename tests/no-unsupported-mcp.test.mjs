import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'

test('плагин каталога не подключает неработающий удалённый MCP', async () => {
  const manifest = JSON.parse(await readFile(new URL('../plugins/hobbyka-cli/.codex-plugin/plugin.json', import.meta.url), 'utf8'))
  const agent = await readFile(new URL('../plugins/hobbyka-cli/skills/hobbyka-catalog-agent/agents/openai.yaml', import.meta.url), 'utf8')
  const skill = await readFile(new URL('../plugins/hobbyka-cli/skills/hobbyka-catalog-agent/SKILL.md', import.meta.url), 'utf8')
  const mcpPath = new URL('../plugins/hobbyka-cli/.mcp.json', import.meta.url)

  assert.equal(Object.hasOwn(manifest, 'mcpServers'), false)
  assert.doesNotMatch(agent, /type:\s*["']?mcp\b|\/mcp\/hobbyka\//i)
  assert.doesNotMatch(skill, /удалённый MCP|официальные MCP-инструменты/i)
  await assert.rejects(stat(mcpPath), { code: 'ENOENT' })
})
