import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'

const cli = new URL('../plugins/hobbyka-cli/skills/hobbyka-catalog-agent/scripts/hobbyka-cli.mjs', import.meta.url)
const packageManifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

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

test('Hobbyka CLI по умолчанию использует основной сайт hobbyka.ru', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hobbyka-cli-config-'))
  const result = await run(['config'], { env: { HOBBYKA_STATE_FILE: path.join(directory, 'state.json') } })
  assert.equal(result.code, 0)
  assert.equal(JSON.parse(result.stdout).base_url, 'https://hobbyka.ru')
  assert.deepEqual(JSON.parse(result.stdout).guidance.feature_groups.map((group) => group.id), ['catalog', 'design_materials', 'access', 'commercial_offers', 'orders', 'admin_offers', 'admin_orders', 'cli_info'])
  assert.deepEqual(JSON.parse(result.stdout).guidance.feature_groups.find((group) => group.id === 'design_materials').actions, ['materials request'])
  assert.deepEqual(JSON.parse(result.stdout).guidance.feature_groups.find((group) => group.id === 'access').actions, ['auth status', 'contacts status', 'auth login', 'contacts set'])
})

test('Hobbyka CLI сообщает версию текущего публичного релиза', async () => {
  const result = await run(['version'], { env: {} })
  assert.equal(result.code, 0)
  assert.equal(JSON.parse(result.stdout).version, packageManifest.version)
})

test('локальный SigLIP2-L-поиск строит индекс, возвращает полную карточку и не отправляет фотографию', async (t) => {
  const requests = []
  const server = createServer((request, response) => {
    requests.push(request.url)
    response.setHeader('Content-Type', 'application/json')
    if (request.url?.startsWith('/api/ai/v1/catalog/products/321/')) {
      response.end(JSON.stringify({ data: { id: 321, name: 'Скамейка Тест', description: 'Полная карточка', images: ['https://example.test/321.jpg'], price: { value: 1000, currency: 'RUB' } }, meta: {} }))
      return
    }
    if (request.url?.startsWith('/api/ai/v1/catalog/products/')) {
      response.end(JSON.stringify({
        data: { items: [
          { id: 321, name: 'Скамейка Тест', images: ['https://example.test/321.jpg'], updated_at: '2026-08-14T00:00:00Z' },
          { id: 654, name: 'Урна Тест', images: ['https://example.test/654.jpg'], updated_at: '2026-08-14T00:00:00Z' }
        ] },
        meta: { count: 2, has_more: false }
      }))
      return
    }
    response.statusCode = 404
    response.end(JSON.stringify({ error: { code: 'not_found', message: 'not found' } }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())

  const directory = await mkdtemp(path.join(tmpdir(), 'hobbyka-cli-image-'))
  const runner = path.join(directory, 'vision-runner.mjs')
  const capture = path.join(directory, 'vision-input.json')
  await writeFile(runner, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
const [command, ...args] = process.argv.slice(2)
const flag = (name) => args[args.indexOf(name) + 1]
if (command === 'build') {
  const input = readFileSync(0, 'utf8')
  writeFileSync(process.env.VISION_CAPTURE, input)
  writeFileSync(flag('--index'), 'fake-index')
  process.stdout.write(JSON.stringify({ ok: true, model: flag('--model'), device: 'test', images: 2, product_ids: [321, 654], download_failures: 0 }))
} else {
  const ambiguous = path.basename(flag('--image')).startsWith('ambiguous')
  process.stdout.write(JSON.stringify({ ok: true, model: flag('--model'), candidates: ambiguous ? [{ product_id: 321, score: 0.85 }, { product_id: 654, score: 0.84 }] : [{ product_id: 321, score: 0.96 }, { product_id: 654, score: 0.70 }], top1_margin: ambiguous ? 0.01 : 0.26 }))
}
`)
  await chmod(runner, 0o700)
  const image = path.join(directory, 'query.jpg')
  const ambiguousImage = path.join(directory, 'ambiguous.jpg')
  await Promise.all([writeFile(image, 'image'), writeFile(ambiguousImage, 'image')])
  const env = {
    PATH: process.env.PATH,
    HOBBYKA_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    HOBBYKA_STATE_FILE: path.join(directory, 'state.json'),
    HOBBYKA_IMAGE_INDEX_DIR: path.join(directory, 'index'),
    HOBBYKA_VISION_RUNNER: runner,
    VISION_CAPTURE: capture
  }

  const before = JSON.parse((await run(['image-index', 'status'], { env })).stdout)
  assert.equal(before.image_search.ready, false)
  const built = JSON.parse((await run(['image-index', 'build', '--max-products', '2'], { env })).stdout)
  assert.equal(built.image_search.products, 2)
  assert.equal(built.image_search.images, 2)
  assert.equal(built.image_search.model, 'timm/vit_large_patch16_siglip_384.v2_webli')
  assert.deepEqual(JSON.parse(await readFile(capture, 'utf8')).products.map((product) => product.product_id), [321, 654])
  const after = JSON.parse((await run(['image-index', 'status'], { env })).stdout)
  assert.equal(after.image_search.ready, true)

  const found = JSON.parse((await run(['search', '--image', image], { env })).stdout)
  assert.equal(found.match.status, 'confident')
  assert.equal(found.match.method, 'siglip2_l')
  assert.equal(found.result.product.id, 321)
  assert.equal(found.result.product.description, 'Полная карточка')
  assert.equal(found.provenance.local, true)
  assert.equal(found.candidates[0].product.id, 321)

  const ambiguous = JSON.parse((await run(['search', '--image', ambiguousImage], { env })).stdout)
  assert.equal(ambiguous.match.status, 'ambiguous')
  assert.equal(ambiguous.result.product, null)
  assert.deepEqual(ambiguous.data.data.items.map((product) => product.id), [321, 654])
  assert.equal(requests.some((url) => url.includes('query.jpg') || url.includes('ambiguous.jpg')), false)
  assert.equal(requests.filter((url) => url.startsWith('/api/ai/v1/catalog/products/321/')).length, 1)
})

test('Hobbyka CLI проходит контактный шлюз и создаёт КП без утечки контакта', async (t) => {
  const requests = []
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, idempotency: request.headers['idempotency-key'], body })
    response.setHeader('Content-Type', 'application/json')
    if (request.url === '/api/ai/v1/cli/contacts/' && request.method === 'POST') {
      response.statusCode = 201
      response.end(JSON.stringify({ data: { access_token: 'hka_test_token', expires_at: '2099-01-01T00:00:00Z' }, meta: {} }))
      return
    }
    if (request.url?.startsWith('/api/ai/v1/catalog/products') && new URL(request.url, 'http://localhost').searchParams.get('q') === 'пусто') {
      response.end(JSON.stringify({ data: { items: [] }, meta: { count: 0 } }))
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
    if (request.url === '/api/ai/v1/commercial-offers/' && request.method === 'POST') {
      response.statusCode = 201
      response.end(JSON.stringify({ data: { public_id: 'a'.repeat(40), status: 'ready', total: 2000, pdf_url: 'https://example.test/offer.pdf' }, meta: {} }))
      return
    }
    if (request.url === '/api/ai/v1/material-requests/' && request.method === 'POST') {
      response.statusCode = 201
      response.end(JSON.stringify({ data: { request_id: 'material-test-1', status: 'submitted', request_type: 'design_materials', product: { id: 321, name: 'Скамейка Тест', canonical_url: 'https://hobbyka.test/product/321/' }, message: 'Запрос передан менеджеру Hobbyka.' }, meta: {} }))
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

  const empty = JSON.parse((await run(['search', '--query', 'пусто'], { env })).stdout)
  assert.equal(empty.data.data.items.length, 0)
  assert.equal('contact_gate' in empty, false)
  assert.equal(empty.guidance.recommended_next_step.action, 'review_catalog_result')

  const first = await run(['search', '--query', 'скамейка', '--limit', '5', '--recommendation-profile', 'future-v1'], { env })
  assert.equal(first.code, 0)
  const firstResult = JSON.parse(first.stdout)
  assert.equal(firstResult.data.data.items[0].id, 321)
  assert.equal(firstResult.contact_gate.status, 'required')
  assert.match(firstResult.contact_gate.message, /создать КП без аккаунта.*личным кабинетом/u)
  assert.equal(firstResult.contact_gate.partner_login.next_command, 'node scripts/hobbyka-cli.mjs auth login')
  assert.equal(firstResult.contact_gate.contact_registration.next_command, 'node scripts/hobbyka-cli.mjs contacts set --stdin')
  assert.match(firstResult.contact_gate.contact_registration.explanation, /компанию, телефон либо email.*подготовки КП/u)
  assert.equal(firstResult.guidance.current_state.mode, 'public')
  assert.equal(firstResult.guidance.feature_groups.find((group) => group.id === 'catalog').available, true)
  assert.equal(firstResult.guidance.feature_groups.find((group) => group.id === 'commercial_offers').available, true)
  assert.equal(firstResult.guidance.feature_groups.find((group) => group.id === 'commercial_offers').create_available, false)
  assert.deepEqual(firstResult.guidance.unlock_paths.map((option) => option.id), ['site_login', 'contact_registration'])
  assert.equal(firstResult.guidance.unlock_paths[1].required.includes('телефон либо email'), true)
  assert.equal(firstResult.guidance.recommended_next_step.action, 'review_catalog_result')
  assert.equal(firstResult.recommendation.applied, false)

  const publicProduct = await run(['product', '--id', '321'], { env })
  assert.equal(publicProduct.code, 0)
  assert.equal(JSON.parse(publicProduct.stdout).data.data.id, 321)
  assert.equal(JSON.parse(publicProduct.stdout).contact_gate.status, 'required')
  assert.equal(requests.length, 3, 'публичные чтения должны быть доступны для полного первого ответа')

  const materialContact = { product_id: 321, full_name: 'Секретное Имя', company: 'ООО Материалы', phone: '+7 999 000-00-00', email: 'materials@example.test', comment: 'Нужны BIM-файлы', personal_data_consent: true }
  const materials = await run(['materials', 'request', '--stdin', '--idempotency-key', 'material-test-key'], { env, input: JSON.stringify(materialContact) })
  assert.equal(materials.code, 0)
  assert.equal(JSON.parse(materials.stdout).data.data.status, 'submitted')
  assert.equal(JSON.parse(materials.stdout).guidance.recommended_next_step.action, 'confirm_material_request')
  assert.doesNotMatch(materials.stdout + materials.stderr, /Секретное Имя|ООО Материалы|materials@example\.test|999 000/u)
  const materialRequest = requests.find((entry) => entry.url === '/api/ai/v1/material-requests/')
  assert.equal(materialRequest.idempotency, 'material-test-key')
  assert.equal(materialRequest.body.agent, 'hobbyka-cli')
  assert.equal(materialRequest.body.personal_data_consent, true)

  const rejectedMaterials = await run(['materials', 'request', '--stdin'], { env, input: JSON.stringify({ ...materialContact, personal_data_consent: false }) })
  assert.equal(rejectedMaterials.code, 2)
  assert.equal(JSON.parse(rejectedMaterials.stderr).error.code, 'consent_required')
  assert.equal(requests.filter((entry) => entry.url === '/api/ai/v1/material-requests/').length, 1)

  const blockedOffer = await run(['offer', 'create', '--items', '321:2'], { env })
  assert.equal(blockedOffer.code, 3)
  const blockedError = JSON.parse(blockedOffer.stderr).error
  assert.equal(blockedError.code, 'contact_required')
  assert.equal(blockedError.details.partner_login.next_command, 'node scripts/hobbyka-cli.mjs auth login')
  assert.equal(blockedError.details.guidance.unlock_paths[1].id, 'contact_registration')
  assert.equal(blockedError.details.guidance.recommended_next_step.action, 'resolve_requirement')
  assert.equal(requests.length, 4, 'защищённая операция не должна доходить до сервера')

  const secretContact = { company: 'ООО Секрет', name: 'Иван', email: 'secret@example.test' }
  const registered = await run(['contacts', 'set', '--stdin'], { env, input: JSON.stringify(secretContact) })
  assert.equal(registered.code, 0)
  assert.equal(JSON.parse(registered.stdout).contact.registered, true)
  assert.equal(JSON.parse(registered.stdout).guidance.current_state.contact_registered, true)
  assert.equal(JSON.parse(registered.stdout).guidance.current_state.site_authorized, false)
  assert.deepEqual(JSON.parse(registered.stdout).guidance.feature_groups.find((group) => group.id === 'commercial_offers').actions, ['offer create', 'offer status'])
  assert.equal(JSON.parse(registered.stdout).guidance.feature_groups.find((group) => group.id === 'orders').available, false)
  assert.doesNotMatch(registered.stdout + registered.stderr, /ООО Секрет|Иван|secret@example\.test/)

  const state = await readFile(stateFile, 'utf8')
  assert.doesNotMatch(state, /ООО Секрет|Иван|secret@example\.test/)
  assert.match(state, /hka_test_token/)
  assert.equal((await stat(stateFile)).mode & 0o777, 0o600)

  const product = await run(['product', '--id', '321'], { env })
  assert.equal(product.code, 0)
  assert.equal(JSON.parse(product.stdout).data.data.id, 321)

  const offer = await run(['offer', 'create', '--items', '321:2,variant:654:1'], { env })
  assert.equal(offer.code, 0)
  assert.equal(JSON.parse(offer.stdout).data.data.total, 2000)
  assert.equal(JSON.parse(offer.stdout).guidance.current_state.site_authorized, false)
  assert.equal(JSON.parse(offer.stdout).guidance.recommended_next_step.action, 'review_created_offer')
  const offerRequest = requests.find((entry) => entry.url === '/api/ai/v1/commercial-offers/')
  assert.equal(offerRequest.authorization, 'Bearer hka_test_token')
  assert.deepEqual(offerRequest.body.items, [{ product_id: 321, quantity: 2 }, { variant_id: 654, quantity: 1 }])
  assert.equal('company' in offerRequest.body, false)
  assert.equal('contact' in offerRequest.body, false)
})

test('партнёрский режим проходит профиль, КП и полный цикл заказа через официальный CLI', async (t) => {
  const requests = []
  const offerId = 'b'.repeat(40)
  const revisedOfferId = 'c'.repeat(40)
  const orderId = 'd'.repeat(40)
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body })
    response.setHeader('Content-Type', 'application/json')
    const data = (value, status = 200) => { response.statusCode = status; response.end(JSON.stringify({ data: value, meta: {} })) }
    if (request.url === '/api/partner/v1/auth/device/') return data({ device_code: 'hkd_device_secret', user_code: 'ABCD-EFGH', verification_uri: 'https://hobbyka.test/personal/partner-cli/', verification_uri_complete: 'https://hobbyka.test/personal/partner-cli/?code=ABCD-EFGH', expires_in: 600, interval: 3 }, 201)
    if (request.url === '/api/partner/v1/auth/token/') return data({ status: 'authorized', access_token: 'hka_partner_secret', token_type: 'Bearer', expires_at: '2099-01-01T00:00:00Z', mode: 'partner' })
    if (request.url === '/api/partner/v1/profile/') return data({ partner_id: 7, name: 'pilot', mode: 'partner', roles: ['partner'], scopes: ['catalog.read', 'partner.offers.read', 'partner.offers.write', 'partner.orders.read', 'partner.orders.write'], capabilities: { partner_prices: true, commercial_offer_create: true }, organization: 'Тестовая организация', site_user_id: 4242, contact: { phone_present: true, email_present: true } })
    if (request.url === '/api/partner/v1/auth/logout/') return data({ status: 'logged_out' })
    if (request.url === '/api/partner/v1/commercial-offers/' && request.method === 'POST') return data({ public_id: offerId, status: 'ready', version: 1, total: 1000 }, 201)
    if (request.url === '/api/partner/v1/commercial-offers/?limit=50') return data({ items: [{ public_id: offerId, status: 'ready', version: 1 }] })
    if (request.url === `/api/partner/v1/commercial-offers/${offerId}/` && request.method === 'PATCH') return data({ public_id: revisedOfferId, status: 'ready', version: 2, replaces_public_id: offerId })
    if (request.url === `/api/partner/v1/commercial-offers/${revisedOfferId}/archive/`) return data({ public_id: revisedOfferId, status: 'archived', version: 3 })
    if (request.url === '/api/partner/v1/orders/' && request.method === 'POST') return data({ public_id: orderId, order_id: 77, status: 'new', version: 1, total: 1000 }, 201)
    if (request.url === '/api/partner/v1/orders/?limit=50') return data({ items: [{ public_id: orderId, status: 'new', version: 1 }] })
    if (request.url === `/api/partner/v1/orders/${orderId}/` && request.method === 'GET') return data({ public_id: orderId, status: 'new', version: 1 })
    if (request.url === `/api/partner/v1/orders/${orderId}/` && request.method === 'PATCH') return data({ public_id: orderId, status: 'updated', version: 2 })
    if (request.url === `/api/partner/v1/orders/${orderId}/cancel/`) return data({ public_id: orderId, status: 'canceled', version: 3 })
    response.statusCode = 404
    response.end(JSON.stringify({ error: { code: 'not_found', message: 'not found' } }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())

  const directory = await mkdtemp(path.join(tmpdir(), 'hobbyka-cli-partner-'))
  const stateFile = path.join(directory, 'state.json')
  const env = { HOBBYKA_BASE_URL: `http://127.0.0.1:${server.address().port}`, HOBBYKA_STATE_FILE: stateFile }
  const token = 'hka_partner_secret'
  const login = await run(['auth', 'login'], { env })
  assert.equal(login.code, 0)
  assert.equal(JSON.parse(login.stdout).status, 'site_authorization_required')
  assert.match(JSON.parse(login.stdout).verification_uri_complete, /ABCD-EFGH/)
  assert.equal(JSON.parse(login.stdout).guidance.feature_groups.find((group) => group.id === 'access').actions.includes('auth complete'), true)
  assert.doesNotMatch(login.stdout + login.stderr, /hkd_device_secret/)

  const connected = await run(['auth', 'complete'], { env })
  assert.equal(connected.code, 0)
  assert.equal(JSON.parse(connected.stdout).access.authenticated, true)
  assert.equal(JSON.parse(connected.stdout).access.mode, 'partner')
  assert.equal(JSON.parse(connected.stdout).guidance.current_state.site_authorized, true)
  assert.deepEqual(JSON.parse(connected.stdout).guidance.feature_groups.find((group) => group.id === 'access').actions, ['auth status', 'contacts status', 'auth logout'])
  assert.equal(JSON.parse(connected.stdout).guidance.feature_groups.find((group) => group.id === 'orders').available, true)
  assert.equal(JSON.parse(connected.stdout).guidance.feature_groups.find((group) => group.id === 'commercial_offers').actions.includes('offer revise'), true)
  assert.equal(JSON.parse(connected.stdout).guidance.recommended_next_step.action, 'explain_authorized_access')
  assert.doesNotMatch(connected.stdout + connected.stderr, new RegExp(token))
  assert.equal(requests.find((entry) => entry.url === '/api/partner/v1/profile/').authorization, `Bearer ${token}`)
  const blockedAdmin = await run(['admin', 'offers', 'list'], { env })
  assert.equal(blockedAdmin.code, 4)
  assert.equal(JSON.parse(blockedAdmin.stderr).error.code, 'admin_required')
  assert.equal(JSON.parse(blockedAdmin.stderr).error.details.guidance.recommended_next_step.action, 'resolve_requirement')
  assert.equal(requests.some((entry) => entry.url?.startsWith('/api/internal/v1/')), false)

  const repeatedLogin = await run(['partner', 'login'], { env })
  assert.equal(repeatedLogin.code, 0)
  assert.equal(JSON.parse(repeatedLogin.stdout).status, 'already_authorized')
  assert.equal(JSON.parse(repeatedLogin.stdout).guidance.recommended_next_step.action, 'explain_authorized_access')
  assert.equal(requests.filter((entry) => entry.url === '/api/partner/v1/auth/logout/').length, 0)

  const createdPartnerOffer = await run(['offer', 'create', '--items', 'variant:654:1'], { env })
  assert.equal(createdPartnerOffer.code, 0)
  assert.equal(JSON.parse(createdPartnerOffer.stdout).guidance.recommended_next_step.action, 'review_created_offer')
  assert.equal((await run(['offer', 'list'], { env })).code, 0)
  assert.equal((await run(['offer', 'revise', '--public-id', offerId, '--expected-version', '1', '--items', '321:2'], { env })).code, 0)
  assert.equal((await run(['offer', 'archive', '--public-id', revisedOfferId, '--expected-version', '2'], { env })).code, 0)
  assert.equal((await run(['order', 'create', '--offer-public-id', revisedOfferId], { env })).code, 0)
  assert.equal((await run(['order', 'list'], { env })).code, 0)
  assert.equal((await run(['order', 'get', '--public-id', orderId], { env })).code, 0)
  assert.equal((await run(['order', 'update', '--public-id', orderId, '--expected-version', '1', '--comments', 'Уточнение'], { env })).code, 0)
  assert.equal((await run(['order', 'cancel', '--public-id', orderId, '--expected-version', '2', '--reason', 'Тест'], { env })).code, 0)

  const partnerOffer = requests.find((entry) => entry.url === '/api/partner/v1/commercial-offers/' && entry.method === 'POST')
  assert.equal(partnerOffer.authorization, `Bearer ${token}`)
  assert.deepEqual(partnerOffer.body.items, [{ variant_id: 654, quantity: 1 }])
  assert.equal('company' in partnerOffer.body, false, 'профиль и контакты подставляет сервер')
  const cancel = requests.find((entry) => entry.url?.endsWith('/cancel/'))
  assert.deepEqual(cancel.body, { expected_version: 2, reason: 'Тест' })

  const logout = await run(['auth', 'logout'], { env })
  assert.equal(logout.code, 0)
  assert.equal(JSON.parse(logout.stdout).access.authenticated, false)
  const logoutRequests = requests.filter((entry) => entry.url === '/api/partner/v1/auth/logout/')
  assert.equal(logoutRequests.length, 1)
  assert.equal(logoutRequests[0].authorization, `Bearer ${token}`)
})

test('единая авторизация назначает административный режим и повторяет исходный поиск', async (t) => {
  const requests = []
  let offerWriteEnabled = false
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    requests.push({ url: request.url, authorization: request.headers.authorization })
    response.setHeader('Content-Type', 'application/json')
    const data = (value, status = 200) => { response.statusCode = status; response.end(JSON.stringify({ data: value, meta: {} })) }
    if (request.url?.startsWith('/api/ai/v1/catalog/products')) {
      const price = request.headers.authorization ? 800 : 1000
      return data({ items: [{ id: 321, name: 'Скамейка Тест', price: { value: price, currency: 'RUB' } }] })
    }
    if (request.url === '/api/partner/v1/auth/device/') return data({ device_code: 'hkd_admin_secret', user_code: 'WXYZ-2345', verification_uri: 'https://hobbyka.test/personal/partner-cli/', verification_uri_complete: 'https://hobbyka.test/personal/partner-cli/?code=WXYZ-2345', expires_in: 600, interval: 3 }, 201)
    if (request.url === '/api/partner/v1/auth/token/') return data({ status: 'authorized', access_token: 'hka_admin_secret', token_type: 'Bearer', expires_at: '2099-01-01T00:00:00Z', mode: 'admin' })
    if (request.url === '/api/partner/v1/profile/') return data({ partner_id: 8, name: 'manager', mode: 'admin', roles: ['manager'], scopes: ['catalog.read', 'offers.admin.read', 'orders.admin.read', 'reports.admin.read', ...(offerWriteEnabled ? ['partner.offers.write'] : [])], capabilities: { partner_prices: true, commercial_offer_create: offerWriteEnabled, admin_all_offers: true, admin_all_orders: true, admin_reports: false, future_exports: true }, organization: 'Hobbyka', site_user_id: 500, contact: { phone_present: true, email_present: true } })
    if (request.url === '/api/partner/v1/commercial-offers/' && request.method === 'POST' && offerWriteEnabled) return data({ public_id: 'a'.repeat(40), status: 'ready', version: 1, total: 1000 }, 201)
    if (request.url === '/api/internal/v1/commercial-offers/?page=1&limit=50') return data({ items: [{ id: 44, number: '1-2-3', total: 125000 }] })
    if (request.url === '/api/internal/v1/commercial-offers/44/') return data({ id: 44, number: '1-2-3', items: [{ product_id: 321, quantity: 2 }] })
    if (request.url === '/api/internal/v1/orders/?page=1&limit=50') return data({ items: [{ id: 77, number: '77', price: 125000 }] })
    if (request.url === '/api/internal/v1/orders/77/') return data({ id: 77, number: '77', items: [{ product_id: 321, quantity: 2 }] })
    response.statusCode = 404
    response.end(JSON.stringify({ error: { code: 'not_found', message: 'not found' } }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())

  const directory = await mkdtemp(path.join(tmpdir(), 'hobbyka-cli-admin-'))
  const env = { HOBBYKA_BASE_URL: `http://127.0.0.1:${server.address().port}`, HOBBYKA_STATE_FILE: path.join(directory, 'state.json') }
  const first = JSON.parse((await run(['search', '--query', 'скамейка', '--limit', '5'], { env })).stdout)
  assert.equal(first.data.data.items[0].price.value, 1000)
  assert.equal((await run(['auth', 'login'], { env })).code, 0)
  const complete = JSON.parse((await run(['auth', 'complete'], { env })).stdout)
  assert.equal(complete.access.mode, 'admin')
  assert.deepEqual(complete.access.roles, ['manager'])
  assert.equal(complete.guidance.server_capabilities.future_exports, true)
  assert.equal(complete.guidance.feature_groups.find((group) => group.id === 'admin_offers').available, true)
  assert.equal(complete.guidance.feature_groups.find((group) => group.id === 'admin_orders').available, true)
  const commercialOffers = complete.guidance.feature_groups.find((group) => group.id === 'commercial_offers')
  assert.equal(commercialOffers.create_available, false)
  assert.equal(commercialOffers.supported_actions.includes('offer create'), true)
  assert.match(commercialOffers.requirement, /partner\.offers\.write/u)
  assert.equal(complete.replayed_request.command, 'search')
  assert.equal(complete.replayed_request.data.data.items[0].price.value, 800)
  assert.equal(requests.filter((entry) => entry.url?.startsWith('/api/ai/v1/catalog/products')).length, 2)
  assert.equal(requests.filter((entry) => entry.url?.startsWith('/api/ai/v1/catalog/products')).at(-1).authorization, 'Bearer hka_admin_secret')
  const blockedCreate = await run(['offer', 'create', '--items', 'variant:654:1'], { env })
  assert.equal(blockedCreate.code, 4)
  assert.equal(JSON.parse(blockedCreate.stderr).error.code, 'insufficient_scope')
  assert.equal(requests.some((entry) => entry.url === '/api/partner/v1/commercial-offers/'), false)
  offerWriteEnabled = true
  const refreshedAccess = JSON.parse((await run(['auth', 'status'], { env })).stdout)
  assert.equal(refreshedAccess.guidance.feature_groups.find((group) => group.id === 'commercial_offers').create_available, true)
  assert.equal((await run(['offer', 'create', '--items', 'variant:654:1'], { env })).code, 0)
  assert.equal(requests.filter((entry) => entry.url === '/api/partner/v1/commercial-offers/').length, 1)
  const offers = JSON.parse((await run(['admin', 'offers', 'list'], { env })).stdout)
  assert.equal(offers.data.data.items[0].id, 44)
  assert.equal(JSON.parse((await run(['admin', 'offers', 'get', '--id', '44'], { env })).stdout).data.data.number, '1-2-3')
  assert.equal(JSON.parse((await run(['admin', 'orders', 'list'], { env })).stdout).data.data.items[0].id, 77)
  assert.equal(JSON.parse((await run(['admin', 'orders', 'get', '--id', '77'], { env })).stdout).data.data.items[0].product_id, 321)
  assert.equal(requests.filter((entry) => entry.url?.startsWith('/api/internal/v1/')).every((entry) => entry.authorization === 'Bearer hka_admin_secret'), true)
})
