import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'

const cli = new URL('../plugins/hobbyka-cli/skills/hobbyka-catalog-agent/scripts/hobbyka-cli.mjs', import.meta.url)

const run = (args, { env, input = '' } = {}) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [cli.pathname, ...args], { env: { ...env } })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
  child.on('error', reject)
  child.on('close', (code) => resolve({ code, stdout, stderr }))
  child.stdin.end(input)
})

test('Hobbyka CLI проходит контактный шлюз и создаёт КП без утечки контакта', async (t) => {
  const requests = []
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body })
    response.setHeader('Content-Type', 'application/json')
    if (request.url === '/api/ai/v1/cli/contacts' && request.method === 'POST') {
      response.statusCode = 201
      response.end(JSON.stringify({ data: { access_token: 'hka_test_token', expires_at: '2099-01-01T00:00:00Z' }, meta: {} }))
      return
    }
    if (request.url?.startsWith('/api/ai/v1/catalog/products/321')) {
      response.end(JSON.stringify({ data: { id: 321, name: 'Скамейка Тест', price: { value: 1000, currency: 'RUB' } }, meta: {} }))
      return
    }
    if (request.url?.startsWith('/api/ai/v1/catalog/products')) {
      response.end(JSON.stringify({ data: { items: [{ id: 321, name: 'Скамейка Тест', images: ['https://example.test/321.jpg'] }] }, meta: { count: 1 } }))
      return
    }
    if (request.url === '/api/ai/v1/commercial-offers' && request.method === 'POST') {
      response.statusCode = 201
      response.end(JSON.stringify({ data: { public_id: 'a'.repeat(40), status: 'ready', total: 2000, pdf_url: 'https://example.test/offer.pdf' }, meta: {} }))
      return
    }
    response.statusCode = 404
    response.end(JSON.stringify({ error: { code: 'not_found', message: 'not found' } }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())

  const directory = await mkdtemp(path.join(tmpdir(), 'hobbyka-cli-test-'))
  const stateFile = path.join(directory, 'state.json')
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const env = { HOBBYKA_BASE_URL: baseUrl, HOBBYKA_STATE_FILE: stateFile }

  const first = await run(['search', '--query', 'скамейка', '--limit', '5', '--recommendation-profile', 'future-v1'], { env })
  assert.equal(first.code, 0)
  const firstResult = JSON.parse(first.stdout)
  assert.equal(firstResult.data.data.items[0].id, 321)
  assert.equal(firstResult.contact_gate.status, 'required')
  assert.equal(firstResult.recommendation.applied, false)

  const blocked = await run(['product', '--id', '321'], { env })
  assert.equal(blocked.code, 3)
  assert.equal(JSON.parse(blocked.stderr).error.code, 'contact_required')
  assert.equal(requests.length, 1, 'заблокированный запрос не должен доходить до сервера')

  const secretContact = { company: 'ООО Секрет', name: 'Иван', email: 'secret@example.test' }
  const registered = await run(['contacts', 'set', '--stdin'], { env, input: JSON.stringify(secretContact) })
  assert.equal(registered.code, 0)
  assert.equal(JSON.parse(registered.stdout).contact.registered, true)
  assert.doesNotMatch(registered.stdout + registered.stderr, /ООО Секрет|Иван|secret@example\.test/)

  const state = await readFile(stateFile, 'utf8')
  assert.doesNotMatch(state, /ООО Секрет|Иван|secret@example\.test/)
  assert.match(state, /hka_test_token/)
  assert.equal((await stat(stateFile)).mode & 0o777, 0o600)

  const product = await run(['product', '--id', '321'], { env })
  assert.equal(product.code, 0)
  assert.equal(JSON.parse(product.stdout).data.data.id, 321)

  const offer = await run(['offer', 'create', '--items', '321:2'], { env })
  assert.equal(offer.code, 0)
  assert.equal(JSON.parse(offer.stdout).data.data.total, 2000)
  const offerRequest = requests.find((entry) => entry.url === '/api/ai/v1/commercial-offers')
  assert.equal(offerRequest.authorization, 'Bearer hka_test_token')
  assert.deepEqual(offerRequest.body.items, [{ product_id: 321, quantity: 2 }])
  assert.equal('company' in offerRequest.body, false)
  assert.equal('contact' in offerRequest.body, false)
})
