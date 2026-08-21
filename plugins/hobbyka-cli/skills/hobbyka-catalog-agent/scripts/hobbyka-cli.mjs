#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { buildImageIndex, imageIndexStatus, ImageSearchError, searchImageIndex } from './image-search.mjs'

const VERSION = '0.6.0'
const DEFAULT_BASE_URL = 'https://hobbyka.ru'
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_IMAGE_MODEL = 'timm/vit_large_patch16_siglip_384.v2_webli'
const AUTHORIZATION_PROMPT = 'Можно продолжить подбор без передачи данных, создать КП без аккаунта после сохранения контакта или войти через сайт, чтобы связать работу с личным кабинетом. Какой следующий шаг вам подходит?'
const CONTACT_EXPLANATION = 'Сохранить контакт — записать компанию, телефон либо email, при желании имя, и интерес клиента. Эти данные нужны менеджеру для продолжения работы, подготовки КП и связи с клиентом.'

class CliError extends Error {
  constructor(code, message, exitCode = 1, details = undefined) {
    super(message)
    this.code = code
    this.exitCode = exitCode
    this.details = details
  }
}

const output = (value, stream = process.stdout) => stream.write(`${JSON.stringify(value)}\n`)

const parseArgs = (argv) => {
  const positionals = []
  const flags = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      positionals.push(token)
      continue
    }
    const separator = token.indexOf('=')
    if (separator > 2) {
      flags[token.slice(2, separator)] = token.slice(separator + 1)
      continue
    }
    const name = token.slice(2)
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags[name] = next
      index += 1
    } else {
      flags[name] = true
    }
  }
  return { positionals, flags }
}

const scalar = (value, name, { required = false, max = 500 } = {}) => {
  const result = value === undefined || value === null ? '' : String(value).trim()
  if ((required && result === '') || result.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(result)) {
    throw new CliError('invalid_argument', `Некорректное значение ${name}.`, 2, { field: name })
  }
  return result
}

const integer = (value, name, { min = 1, max = Number.MAX_SAFE_INTEGER, fallback } = {}) => {
  if ((value === undefined || value === '') && fallback !== undefined) return fallback
  const result = Number(value)
  if (!Number.isInteger(result) || result < min || result > max) {
    throw new CliError('invalid_argument', `${name} должен быть целым числом от ${min} до ${max}.`, 2, { field: name })
  }
  return result
}

const decimal = (value, name, { min = -1, max = 1, fallback } = {}) => {
  if ((value === undefined || value === '') && fallback !== undefined) return fallback
  const result = Number(value)
  if (!Number.isFinite(result) || result < min || result > max) {
    throw new CliError('invalid_argument', `${name} должен быть числом от ${min} до ${max}.`, 2, { field: name })
  }
  return result
}

const normalizeBaseUrl = (value) => {
  let url
  try {
    url = new URL(value || DEFAULT_BASE_URL)
  } catch {
    throw new CliError('invalid_base_url', 'Некорректный HOBBYKA_BASE_URL.', 2)
  }
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new CliError('insecure_base_url', 'Для удалённого Hobbyka разрешён только HTTPS.', 2)
  }
  url.pathname = url.pathname.replace(/\/+$/, '')
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

const stateFile = () => {
  if (process.env.HOBBYKA_STATE_FILE) return path.resolve(process.env.HOBBYKA_STATE_FILE)
  const configRoot = process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config')
  return path.join(configRoot, 'hobbyka-cli', 'state.json')
}

const emptyState = () => ({ version: 1, profiles: {} })

const readState = async () => {
  try {
    const value = JSON.parse(await readFile(stateFile(), 'utf8'))
    if (value?.version !== 1 || typeof value.profiles !== 'object' || value.profiles === null) return emptyState()
    return value
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyState()
    throw new CliError('state_unavailable', 'Не удалось прочитать защищённое состояние CLI.', 5)
  }
}

const writeState = async (state) => {
  const file = stateFile()
  const directory = path.dirname(file)
  const temporary = `${file}.${process.pid}.tmp`
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 })
    await chmod(temporary, 0o600)
    await rename(temporary, file)
    await chmod(file, 0o600)
  } catch {
    throw new CliError('state_unavailable', 'Не удалось сохранить защищённое состояние CLI.', 5)
  }
}

const profileFor = (state, baseUrl) => state.profiles[baseUrl] || { first_request_completed: false, mode: 'public' }

const contactStatus = (profile) => ({
  registered: Boolean(profile.access_token),
  company_present: Boolean(profile.company_present),
  phone_present: Boolean(profile.phone_present),
  email_present: Boolean(profile.email_present)
})

const authenticatedMode = (profile) => ['partner', 'admin'].includes(profile.mode) && Boolean(profile.access_token)

const accessStatus = (profile) => ({
  mode: authenticatedMode(profile) ? profile.mode : 'public',
  authenticated: authenticatedMode(profile),
  roles: Array.isArray(profile.roles) ? profile.roles : [],
  capabilities: profile.capabilities && typeof profile.capabilities === 'object' ? profile.capabilities : {},
  profile_verified_at: profile.partner_verified_at || null
})

const nextStepFor = (command, { authenticated, contactRegistered, outcome }) => {
  if (outcome === 'blocked') {
    return { action: 'resolve_requirement', explanation: 'Объясните условие доступа и предложите подходящий безопасный маршрут.' }
  }
  const steps = {
    search: { action: 'review_catalog_result', explanation: 'Покажите найденные товары и уточните, нужно ли сравнение, карточка или переход к КП.' },
    'image-index build': { action: 'search_by_image', explanation: 'Локальный индекс готов. Передайте фотографию в search --image.' },
    product: { action: 'review_product', explanation: 'Объясните карточку товара и уточните, нужно ли сравнение или добавление в КП.' },
    'materials request': { action: 'confirm_material_request', explanation: 'Сообщите, что заявка передана менеджеру, и покажите товар и идентификатор запроса из ответа.' },
    'contacts set': { action: 'continue_protected_goal', explanation: 'Контакт сохранён. Вернитесь к исходной цели и запросите недостающие параметры.' },
    'auth login': { action: 'complete_site_authorization', explanation: 'Покажите ссылку входа и дождитесь самостоятельного подтверждения на сайте.' },
    'auth complete': { action: 'explain_authorized_access', explanation: 'Сравните повторённый запрос с публичным результатом и объясните открывшиеся функции.' },
    'offer create': { action: 'review_created_offer', explanation: 'Покажите номер, статус, итог и PDF из ответа сервера, затем предложите доступное продолжение.' },
    'offer status': { action: 'review_offer_status', explanation: 'Объясните текущий статус КП и следующее доступное действие.' },
    'offer list': { action: 'choose_offer', explanation: 'Покажите список и помогите выбрать КП для просмотра, новой версии или заказа.' },
    'offer revise': { action: 'review_offer_version', explanation: 'Покажите новую версию и её связь с предыдущим КП.' },
    'offer archive': { action: 'confirm_offer_archive', explanation: 'Сообщите об архивировании и предложите вернуться к списку КП.' },
    'order create': { action: 'review_created_order', explanation: 'Покажите номер, статус и итог заказа, затем объясните доступные действия.' },
    'order list': { action: 'choose_order', explanation: 'Покажите список и помогите выбрать заказ для просмотра или изменения.' },
    'order get': { action: 'review_order', explanation: 'Объясните состав, статус и текущую версию заказа перед следующим действием.' },
    'order update': { action: 'confirm_order_update', explanation: 'Покажите обновлённое состояние заказа.' },
    'order cancel': { action: 'confirm_order_cancel', explanation: 'Сообщите об отмене и покажите итоговый статус заказа.' }
  }
  return steps[command] || {
    action: 'clarify_goal',
    explanation: authenticated || contactRegistered
      ? 'Объясните текущие возможности и уточните ближайшую цель пользователя.'
      : 'Уточните, хочет ли пользователь найти товар, создать КП или узнать о других возможностях.'
  }
}

const buildGuidance = (profile, { command = 'help', outcome = 'ready' } = {}) => {
  const access = accessStatus(profile)
  const contactRegistered = Boolean(profile.access_token) && !access.authenticated
  const accessActions = ['auth status', 'contacts status']
  if (access.authenticated) accessActions.push('auth logout')
  else accessActions.push('auth login')
  if (profile.pending_device_code) accessActions.push('auth complete')
  if (!profile.access_token) accessActions.push('contacts set')
  if (contactRegistered) accessActions.push('contacts clear')
  const offerActions = access.authenticated
    ? ['offer create', 'offer status', 'offer list', 'offer revise', 'offer archive']
    : contactRegistered ? ['offer create', 'offer status'] : []
  const featureGroups = [
    { id: 'catalog', available: true, summary: 'Текстовый и локальный визуальный поиск, сравнение и чтение карточек товаров.', actions: ['search', 'product', 'image-index build', 'image-index status'] },
    { id: 'design_materials', available: true, summary: 'Запрос менеджеру на чертежи, 2D-, 3D-, BIM- и другие материалы по товару.', actions: ['materials request'], requirement: 'ФИО, телефон, email и явное согласие на обработку персональных данных.' },
    { id: 'access', available: true, summary: 'Вход через сайт, проверка режима и безопасное сохранение контакта.', actions: accessActions, requirement: accessActions.includes('contacts set') ? 'Сохранение контакта требует согласия пользователя.' : null },
    { id: 'commercial_offers', available: offerActions.length > 0, summary: 'Создание и ведение коммерческих предложений.', actions: offerActions, requirement: offerActions.length ? null : 'Вход через сайт или сохранённый контакт.' },
    { id: 'orders', available: access.authenticated, summary: 'Создание, просмотр, изменение и отмена своих заказов.', actions: access.authenticated ? ['order create', 'order list', 'order get', 'order update', 'order cancel'] : [], requirement: access.authenticated ? null : 'Вход через сайт Hobbyka.' },
    { id: 'admin_offers', available: access.mode === 'admin' && access.capabilities.admin_all_offers === true, summary: 'Чтение всех КП для менеджера или администратора.', actions: access.mode === 'admin' && access.capabilities.admin_all_offers === true ? ['admin offers list', 'admin offers get'] : [], requirement: access.mode === 'admin' && access.capabilities.admin_all_offers === true ? null : 'Режим admin и capability admin_all_offers.' },
    { id: 'admin_orders', available: access.mode === 'admin' && access.capabilities.admin_all_orders === true, summary: 'Чтение всех заказов для менеджера или администратора.', actions: access.mode === 'admin' && access.capabilities.admin_all_orders === true ? ['admin orders list', 'admin orders get'] : [], requirement: access.mode === 'admin' && access.capabilities.admin_all_orders === true ? null : 'Режим admin и capability admin_all_orders.' },
    { id: 'cli_info', available: true, summary: 'Справка, версия и текущая конфигурация CLI.', actions: ['help', 'version', 'config'] }
  ]
  const unlockPaths = []
  if (!access.authenticated) {
    unlockPaths.push({ id: 'site_login', suitable_for: 'Есть аккаунт Hobbyka и нужна связь с личным кабинетом.', required: ['подтверждение входа на сайте Hobbyka'], next_command: 'node scripts/hobbyka-cli.mjs auth login' })
  }
  if (!profile.access_token) {
    unlockPaths.push({ id: 'contact_registration', suitable_for: 'Пользователю без аккаунта нужна защищённая операция вроде создания КП.', required: ['согласие пользователя', 'компания', 'телефон либо email'], next_command: 'node scripts/hobbyka-cli.mjs contacts set --stdin' })
  }
  return {
    current_state: { mode: access.mode, site_authorized: access.authenticated, contact_registered: contactRegistered },
    feature_groups: featureGroups,
    unlock_paths: unlockPaths,
    server_capabilities: access.capabilities,
    recommended_next_step: nextStepFor(command, { authenticated: access.authenticated, contactRegistered, outcome })
  }
}

const partnerStatus = (profile) => ({
  connected: authenticatedMode(profile),
  mode: accessStatus(profile).mode,
  profile_verified_at: profile.partner_verified_at || null
})

const requireContact = (profile, command) => {
  if (profile.first_request_completed && !profile.access_token) {
    throw new CliError(
      'contact_required',
      'Для защищённой операции авторизуйтесь через аккаунт Hobbyka или сохраните контакт.',
      3,
      authorizationGate(command)
    )
  }
}

const requireAuthorized = (profile, command) => {
  if (!authenticatedMode(profile)) {
    throw new CliError('authorization_required', 'Войдите через сайт командой auth login.', 3, { guidance: buildGuidance(profile, { command, outcome: 'blocked' }) })
  }
}

const requireAdmin = (profile, command) => {
  if (accessStatus(profile).mode !== 'admin') {
    throw new CliError('admin_required', 'Команда доступна менеджерам и администраторам Hobbyka после auth login.', 4, { guidance: buildGuidance(profile, { command, outcome: 'blocked' }) })
  }
}

const readStdinJson = async (code = 'invalid_json', message = 'Ожидается JSON-объект в стандартном вводе.') => {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  try {
    const value = JSON.parse(raw)
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('object required')
    return value
  } catch {
    throw new CliError(code, message, 2)
  }
}

const recommendation = (flags) => {
  const profile = scalar(flags['recommendation-profile'], 'recommendation-profile', { max: 128 })
  return profile
    ? { profile, applied: false, note: 'Параметр зарезервирован и не меняет явные требования пользователя в версии 0.1.' }
    : undefined
}

const request = async (baseUrl, route, { method = 'GET', body, token, idempotencyKey } = {}) => {
  const controller = new AbortController()
  const timeoutMs = integer(process.env.HOBBYKA_TIMEOUT_MS, 'HOBBYKA_TIMEOUT_MS', { min: 1000, max: 120000, fallback: DEFAULT_TIMEOUT_MS })
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const headers = { Accept: 'application/json', 'User-Agent': `hobbyka-cli/${VERSION}` }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = `Bearer ${token}`
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey
  try {
    const response = await fetch(`${baseUrl}${route}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    })
    const text = await response.text()
    let payload = null
    try { payload = text === '' ? null : JSON.parse(text) } catch { payload = null }
    if (!response.ok) {
      const serverError = payload?.error || payload
      throw new CliError(
        scalar(serverError?.code, 'server_error_code', { max: 128 }) || 'hobbyka_request_failed',
        scalar(serverError?.message, 'server_error_message', { max: 1000 }) || `Hobbyka вернул HTTP ${response.status}.`,
        response.status === 401 || response.status === 403 ? 4 : 5,
        { http_status: response.status, request_id: response.headers.get('x-request-id') || undefined }
      )
    }
    return payload
  } catch (error) {
    if (error instanceof CliError) throw error
    if (error?.name === 'AbortError') throw new CliError('request_timeout', 'Hobbyka не ответил за отведённое время.', 5)
    throw new CliError('network_error', 'Не удалось подключиться к Hobbyka.', 5)
  } finally {
    clearTimeout(timeout)
  }
}

const authorizationGate = (command = 'protected operation') => ({
  status: 'required',
  message: AUTHORIZATION_PROMPT,
  guidance: buildGuidance({ first_request_completed: true, mode: 'public' }, { command, outcome: 'blocked' }),
  partner_login: {
    eligibility: 'existing_site_account',
    next_command: 'node scripts/hobbyka-cli.mjs auth login',
    explanation: 'Вход связывает дальнейшую работу с КП с личным кабинетом.'
  },
  contact_registration: {
    eligibility: 'no_site_account',
    next_command: 'node scripts/hobbyka-cli.mjs contacts set --stdin',
    explanation: CONTACT_EXPLANATION
  }
})

const completeFirstRequest = async (state, baseUrl, profile, result, repeatRequest, hasResult = true) => {
  if (!hasResult && !profile.access_token) return { ...result, guidance: buildGuidance(profile, { command: repeatRequest.command }) }
  if (!profile.first_request_completed && !profile.access_token) {
    const updated = { ...profile, mode: 'public', first_request_completed: true, pending_repeat: repeatRequest, updated_at: new Date().toISOString() }
    state.profiles[baseUrl] = updated
    await writeState(state)
    return { ...result, contact_gate: authorizationGate(repeatRequest.command), guidance: buildGuidance(updated, { command: repeatRequest.command }) }
  }
  if (!profile.access_token) {
    const updated = { ...profile, pending_repeat: repeatRequest, updated_at: new Date().toISOString() }
    state.profiles[baseUrl] = updated
    await writeState(state)
    return { ...result, contact_gate: authorizationGate(repeatRequest.command), guidance: buildGuidance(updated, { command: repeatRequest.command }) }
  }
  return { ...result, access: accessStatus(profile), contact_gate: { status: authenticatedMode(profile) ? profile.mode : 'registered' }, guidance: buildGuidance(profile, { command: repeatRequest.command }) }
}

const serverProfile = (payload) => payload?.data || payload

const normalizedServerMode = (profile) => profile?.mode === 'admin' ? 'admin' : 'partner'

const profileWithVerifiedAccess = (profile, verifiedProfile) => ({
  ...profile,
  mode: normalizedServerMode(verifiedProfile),
  roles: Array.isArray(verifiedProfile?.roles) ? verifiedProfile.roles : profile.roles,
  capabilities: verifiedProfile?.capabilities && typeof verifiedProfile.capabilities === 'object' ? verifiedProfile.capabilities : profile.capabilities
})

const replayPendingRequest = async (baseUrl, profile) => {
  const pending = profile.pending_repeat
  if (!pending || !['search', 'product'].includes(pending.command) || typeof pending.route !== 'string' || !pending.route.startsWith('/api/ai/v1/catalog/')) return null
  const data = await request(baseUrl, pending.route, { token: profile.access_token })
  return { command: pending.command, data }
}

const collectImageCatalog = async (baseUrl, token, { maxProducts, imagesPerProduct }) => {
  const products = []
  const seenProducts = new Set()
  const seenCursors = new Set()
  let cursor = ''
  while (products.length < maxProducts) {
    const route = `/api/ai/v1/catalog/products/?${buildQuery([
      ['limit', Math.min(100, maxProducts - products.length)], ['cursor', cursor], ['agent', 'hobbyka-cli-image-index']
    ])}`
    const payload = await request(baseUrl, route, { token })
    const items = payload?.data?.items ?? payload?.items
    if (!Array.isArray(items)) throw new CliError('invalid_catalog_response', 'Hobbyka вернул некорректную страницу каталога.', 5)
    for (const item of items) {
      if (!Number.isInteger(item?.id) || seenProducts.has(item.id) || !Array.isArray(item.images) || item.images.length === 0) continue
      seenProducts.add(item.id)
      products.push({ ...item, images: item.images.slice(0, imagesPerProduct) })
      if (products.length >= maxProducts) break
    }
    const meta = payload?.meta ?? payload?.data?.meta ?? {}
    if (!meta.has_more) break
    const nextCursor = scalar(meta.next_cursor, 'next_cursor', { required: true, max: 2048 })
    if (seenCursors.has(nextCursor)) throw new CliError('catalog_pagination_loop', 'Hobbyka повторил курсор каталога.', 5)
    seenCursors.add(nextCursor)
    cursor = nextCursor
  }
  if (products.length === 0) throw new CliError('empty_catalog', 'В каталоге нет товаров с изображениями.', 5)
  const revision = createHash('sha256').update(JSON.stringify(products.map((product) => [product.id, product.updated_at, product.images]))).digest('hex')
  return { products, revision }
}

const buildQuery = (entries) => {
  const query = new URLSearchParams()
  for (const [key, value] of entries) if (value !== undefined && value !== '') query.set(key, String(value))
  return query.toString()
}

const parseItems = (value) => {
  const input = scalar(value, 'items', { required: true, max: 4000 })
  const items = input.split(',').map((entry, index) => {
    const match = entry.trim().match(/^(\d+):(\d+(?:\.\d+)?)$/)
    if (!match || Number(match[1]) < 1 || Number(match[2]) <= 0) {
      throw new CliError('invalid_items', 'items должен иметь формат product_id:quantity через запятую.', 2, { index })
    }
    return { product_id: Number(match[1]), quantity: Number(match[2]) }
  })
  if (items.length < 1 || items.length > 100) throw new CliError('invalid_items', 'Нужно указать от 1 до 100 позиций.', 2)
  return items
}

const publicIdentifier = (value, name) => {
  const result = scalar(value, name, { required: true, max: 64 })
  if (!/^[a-f0-9]{32,64}$/.test(result)) throw new CliError('invalid_public_id', `Некорректный ${name}.`, 2)
  return result
}

const help = () => ({
  ok: true,
  version: VERSION,
  guidance: buildGuidance({ first_request_completed: false, mode: 'public' }),
  commands: [
    'search --query <text> [--limit 10] [--section-code <code>] [--recommendation-profile <id>]',
    'search --image <path> [--limit 10] [--min-score 0.90] [--min-margin 0.05]',
    'image-index build [--max-products <n>] [--images-per-product 2] [--model <path-or-hf-id>]',
    'image-index status',
    'product --id <id> [--recommendation-profile <id>]',
    'materials request --stdin [--idempotency-key <key>]',
    'contacts set --stdin',
    'contacts status',
    'contacts clear',
    'auth login',
    'auth complete',
    'auth status',
    'auth logout',
    'partner <login|complete|status|logout> (совместимый псевдоним auth)',
    'offer create --items <product_id:quantity,...>',
    'offer status --public-id <id>',
    'offer list',
    'offer revise --public-id <id> --expected-version <n> --items <product_id:quantity,...>',
    'offer archive --public-id <id> --expected-version <n>',
    'order create (--items <product_id:quantity,...> | --offer-public-id <id>)',
    'order list',
    'order get --public-id <id>',
    'order update --public-id <id> --expected-version <n> [--comments <text>]',
    'order cancel --public-id <id> --expected-version <n> [--reason <text>]',
    'admin offers list [--number <number>] [--manager-id <id>] [--date-from YYYY-MM-DD] [--date-to YYYY-MM-DD] [--active Y|N] [--page 1] [--limit 50]',
    'admin offers get --id <id>',
    'admin orders list [--id <id>] [--user-id <id>] [--status <code>] [--date-from YYYY-MM-DD] [--date-to YYYY-MM-DD] [--page 1] [--limit 50]',
    'admin orders get --id <id>',
    'config'
  ]
})

const main = async () => {
  const { positionals, flags } = parseArgs(process.argv.slice(2))
  const command = positionals[0] || 'help'
  const action = positionals[1]
  if (flags.help || command === 'help') return help()
  if (flags.version || command === 'version') return { ok: true, version: VERSION }

  const baseUrl = normalizeBaseUrl(flags['base-url'] || process.env.HOBBYKA_BASE_URL)
  const state = await readState()
  const profile = profileFor(state, baseUrl)

  if (command === 'config') {
    return {
      ok: true,
      command,
      base_url: baseUrl,
      state_file: stateFile(),
      contact: contactStatus(profile),
      access: accessStatus(profile),
      partner: partnerStatus(profile),
      image_search: await imageIndexStatus(),
      guidance: buildGuidance(profile, { command })
    }
  }

  if (command === 'image-index' && action === 'status') {
    return { ok: true, command: 'image-index status', image_search: await imageIndexStatus(), guidance: buildGuidance(profile, { command: 'image-index status' }) }
  }

  if (command === 'image-index' && action === 'build') {
    const maxProducts = integer(flags['max-products'], 'max-products', { min: 1, max: 100000, fallback: 100000 })
    const imagesPerProduct = integer(flags['images-per-product'], 'images-per-product', { min: 1, max: 5, fallback: 2 })
    const model = scalar(flags.model || process.env.HOBBYKA_IMAGE_MODEL || DEFAULT_IMAGE_MODEL, 'model', { required: true, max: 2048 })
    const catalog = await collectImageCatalog(baseUrl, profile.access_token, { maxProducts, imagesPerProduct })
    try {
      const imageSearch = await buildImageIndex({ products: catalog.products, baseUrl, catalogRevision: catalog.revision, model })
      return { ok: true, command: 'image-index build', image_search: imageSearch, guidance: buildGuidance(profile, { command: 'image-index build' }) }
    } catch (error) {
      if (error instanceof ImageSearchError) throw new CliError(error.code, error.message, 5, error.details)
      throw error
    }
  }

  const authCommand = command === 'auth' || command === 'partner'

  if (authCommand && action === 'login') {
    if (authenticatedMode(profile)) {
      const verified = await request(baseUrl, '/api/partner/v1/profile/', { token: profile.access_token })
      const verifiedProfile = serverProfile(verified)
      const currentProfile = profileWithVerifiedAccess(profile, verifiedProfile)
      return {
        ok: true, command: `${command} login`,
        status: 'already_authorized',
        access: accessStatus(currentProfile),
        profile: verifiedProfile,
        guidance: buildGuidance(currentProfile, { command: 'auth complete' })
      }
    }
    const authorization = await request(baseUrl, '/api/partner/v1/auth/device/', {
      method: 'POST', body: { client_name: 'Hobbyka CLI' }
    })
    const data = authorization?.data || authorization
    const deviceCode = scalar(data?.device_code, 'device_code', { required: true, max: 128 })
    state.profiles[baseUrl] = {
      ...profile,
      mode: 'public',
      pending_device_code: deviceCode,
      pending_user_code: scalar(data?.user_code, 'user_code', { required: true, max: 16 }),
      pending_expires_at: new Date(Date.now() + integer(data?.expires_in, 'expires_in', { min: 60, max: 3600 }) * 1000).toISOString(),
      updated_at: new Date().toISOString()
    }
    await writeState(state)
    return {
      ok: true, command: `${command} login`, status: 'site_authorization_required',
      user_code: state.profiles[baseUrl].pending_user_code,
      verification_uri: data?.verification_uri,
      verification_uri_complete: data?.verification_uri_complete,
      expires_at: state.profiles[baseUrl].pending_expires_at,
      next_command: 'node scripts/hobbyka-cli.mjs auth complete',
      guidance: buildGuidance(state.profiles[baseUrl], { command: 'auth login' })
    }
  }

  if (authCommand && action === 'complete') {
    const deviceCode = scalar(profile.pending_device_code, 'pending_device_code', { required: true, max: 128 })
    const authorization = await request(baseUrl, '/api/partner/v1/auth/token/', { method: 'POST', body: { device_code: deviceCode } })
    const data = authorization?.data || authorization
    if (data?.status === 'authorization_pending') {
      return { ok: true, command: `${command} complete`, status: 'authorization_pending', user_code: profile.pending_user_code, verification_uri_complete: `${baseUrl}/personal/partner-cli/?code=${encodeURIComponent(profile.pending_user_code)}`, guidance: buildGuidance(profile, { command: 'auth login' }) }
    }
    const token = scalar(data?.access_token, 'access_token', { required: true, max: 512 })
    state.profiles[baseUrl] = {
      ...profile, first_request_completed: true, mode: data?.mode === 'admin' ? 'admin' : 'partner', access_token: token,
      expires_at: data?.expires_at || null, partner_verified_at: null, updated_at: new Date().toISOString()
    }
    await writeState(state)
    const verified = await request(baseUrl, '/api/partner/v1/profile/', { token })
    const verifiedProfile = serverProfile(verified)
    state.profiles[baseUrl].mode = normalizedServerMode(verifiedProfile)
    state.profiles[baseUrl].roles = Array.isArray(verifiedProfile?.roles) ? verifiedProfile.roles : []
    state.profiles[baseUrl].scopes = Array.isArray(verifiedProfile?.scopes) ? verifiedProfile.scopes : []
    state.profiles[baseUrl].capabilities = verifiedProfile?.capabilities && typeof verifiedProfile.capabilities === 'object' ? verifiedProfile.capabilities : {}
    state.profiles[baseUrl].partner_verified_at = new Date().toISOString()
    state.profiles[baseUrl].updated_at = new Date().toISOString()
    const replayedRequest = await replayPendingRequest(baseUrl, state.profiles[baseUrl])
    delete state.profiles[baseUrl].pending_device_code
    delete state.profiles[baseUrl].pending_user_code
    delete state.profiles[baseUrl].pending_expires_at
    delete state.profiles[baseUrl].pending_repeat
    await writeState(state)
    return { ok: true, command: `${command} complete`, status: 'authorized', access: accessStatus(state.profiles[baseUrl]), profile: verifiedProfile, replayed_request: replayedRequest, guidance: buildGuidance(state.profiles[baseUrl], { command: 'auth complete' }) }
  }

  if (authCommand && action === 'status') {
    if (!authenticatedMode(profile)) return { ok: true, command: `${command} status`, access: accessStatus(profile), guidance: buildGuidance(profile, { command: 'auth status' }) }
    const verified = await request(baseUrl, '/api/partner/v1/profile/', { token: profile.access_token })
    const verifiedProfile = serverProfile(verified)
    const currentProfile = profileWithVerifiedAccess(profile, verifiedProfile)
    return { ok: true, command: `${command} status`, access: accessStatus(currentProfile), profile: verifiedProfile, guidance: buildGuidance(currentProfile, { command: 'auth status' }) }
  }

  if (authCommand && action === 'logout') {
    if (authenticatedMode(profile)) await request(baseUrl, '/api/partner/v1/auth/logout/', { method: 'POST', body: {}, token: profile.access_token })
    state.profiles[baseUrl] = { first_request_completed: false, mode: 'public', updated_at: new Date().toISOString() }
    await writeState(state)
    return { ok: true, command: `${command} logout`, access: accessStatus(state.profiles[baseUrl]), partner: partnerStatus(state.profiles[baseUrl]), guidance: buildGuidance(state.profiles[baseUrl], { command: 'auth logout' }) }
  }

  if (command === 'contacts' && action === 'status') {
    return { ok: true, command: 'contacts status', contact: contactStatus(profile), first_request_completed: Boolean(profile.first_request_completed), guidance: buildGuidance(profile, { command: 'contacts status' }) }
  }

  if (command === 'contacts' && action === 'clear') {
    state.profiles[baseUrl] = { first_request_completed: Boolean(profile.first_request_completed), updated_at: new Date().toISOString() }
    await writeState(state)
    return { ok: true, command: 'contacts clear', contact: contactStatus(state.profiles[baseUrl]), guidance: buildGuidance(state.profiles[baseUrl], { command: 'contacts clear' }) }
  }

  if (command === 'contacts' && action === 'set') {
    if (!flags.stdin) throw new CliError('stdin_required', 'Передайте контакт как JSON через стандартный ввод и флаг --stdin.', 2)
    const contact = await readStdinJson('invalid_contact_json', 'Ожидается JSON-объект контакта в стандартном вводе.')
    const company = scalar(contact.company, 'company', { required: true, max: 255 })
    const name = scalar(contact.name, 'name', { max: 255 })
    const phone = scalar(contact.phone, 'phone', { max: 64 })
    const email = scalar(contact.email, 'email', { max: 254 })
    if (!phone && !email) throw new CliError('contact_required', 'Укажите телефон либо email.', 2)
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new CliError('invalid_email', 'Некорректный email.', 2)
    const registered = await request(baseUrl, '/api/ai/v1/cli/contacts/', {
      method: 'POST',
      body: { company, name: name || undefined, phone: phone || undefined, email: email || undefined, agent: 'hobbyka-cli' }
    })
    const accessToken = scalar(registered?.data?.access_token ?? registered?.access_token, 'access_token', { required: true, max: 512 })
    state.profiles[baseUrl] = {
      first_request_completed: true,
      mode: 'public',
      access_token: accessToken,
      expires_at: registered?.data?.expires_at ?? registered?.expires_at ?? null,
      company_present: true,
      phone_present: Boolean(phone),
      email_present: Boolean(email),
      updated_at: new Date().toISOString()
    }
    await writeState(state)
    return { ok: true, command: 'contacts set', contact: contactStatus(state.profiles[baseUrl]), expires_at: state.profiles[baseUrl].expires_at, guidance: buildGuidance(state.profiles[baseUrl], { command: 'contacts set' }) }
  }

  if (command === 'search') {
    if (flags.image) {
      const query = scalar(flags.query ?? flags.q, 'query', { max: 500 })
      if (query) throw new CliError('unsupported_argument', 'Локальный поиск принимает либо --image, либо --query.', 2)
      const image = path.resolve(scalar(flags.image, 'image', { required: true, max: 4096 }))
      const limit = integer(flags.limit, 'limit', { min: 1, max: 20, fallback: 10 })
      const minScore = decimal(flags['min-score'], 'min-score', { fallback: 0.90 })
      const minMargin = decimal(flags['min-margin'], 'min-margin', { min: 0, fallback: 0.05 })
      const model = scalar(flags.model || process.env.HOBBYKA_IMAGE_MODEL || DEFAULT_IMAGE_MODEL, 'model', { required: true, max: 2048 })
      let local
      try { local = await searchImageIndex({ image, model, topK: 20 }) } catch (error) {
        if (error instanceof ImageSearchError) throw new CliError(error.code, error.message, 5, error.details)
        throw error
      }
      const first = local.candidates[0]
      if (!first) throw new CliError('empty_image_index', 'Локальный индекс не вернул кандидатов.', 5)
      const confident = first.score >= minScore && local.top1_margin >= minMargin
      const productRoute = `/api/ai/v1/catalog/products/${first.product_id}/?agent=hobbyka-cli`
      const product = confident ? await request(baseUrl, productRoute, { token: profile.access_token }) : null
      const candidates = local.candidates.slice(0, limit)
      return {
        ok: true, command, data: product || { data: { items: candidates.map((candidate) => candidate.product) }, meta: { count: candidates.length } },
        result: { product: product ? serverProfile(product) : null },
        match: { status: confident ? 'confident' : 'ambiguous', confidence: first.score, method: 'siglip2_l', top1_margin: local.top1_margin, thresholds: { min_score: minScore, min_margin: minMargin } },
        candidates, provenance: local.provenance, guidance: buildGuidance(profile, { command })
      }
    }
    const query = scalar(flags.query ?? flags.q, 'query', { max: 500 })
    const limit = integer(flags.limit, 'limit', { min: 1, max: 100, fallback: 10 })
    const sectionId = flags['section-id'] === undefined ? undefined : integer(flags['section-id'], 'section-id')
    const route = `/api/ai/v1/catalog/products/?${buildQuery([
      ['q', query], ['section_id', sectionId], ['section_code', scalar(flags['section-code'], 'section-code', { max: 128 })],
      ['limit', limit], ['cursor', scalar(flags.cursor, 'cursor', { max: 2048 })], ['agent', 'hobbyka-cli']
    ])}`
    const data = await request(baseUrl, route, { token: profile.access_token })
    const items = data?.data?.items ?? data?.items
    const hasResult = !Array.isArray(items) || items.length > 0
    return completeFirstRequest(state, baseUrl, profile, { ok: true, command, data, recommendation: recommendation(flags) }, { command, route }, hasResult)
  }

  if (command === 'product') {
    const id = integer(flags.id, 'id')
    const route = `/api/ai/v1/catalog/products/${id}/?agent=hobbyka-cli`
    const data = await request(baseUrl, route, { token: profile.access_token })
    return completeFirstRequest(state, baseUrl, profile, { ok: true, command, data, recommendation: recommendation(flags) }, { command, route })
  }

  if (command === 'materials' && action === 'request') {
    if (!flags.stdin) throw new CliError('stdin_required', 'Передайте данные формы как JSON через стандартный ввод и флаг --stdin.', 2)
    const input = await readStdinJson('invalid_material_request_json', 'Ожидается JSON-объект заявки на материалы в стандартном вводе.')
    const productId = integer(input.product_id, 'product_id')
    const fullName = scalar(input.full_name, 'full_name', { required: true, max: 255 })
    const company = scalar(input.company, 'company', { max: 255 })
    const phone = scalar(input.phone, 'phone', { required: true, max: 64 })
    const email = scalar(input.email, 'email', { required: true, max: 254 })
    const comment = scalar(input.comment, 'comment', { max: 2000 })
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new CliError('invalid_email', 'Некорректный email.', 2)
    if (input.personal_data_consent !== true) throw new CliError('consent_required', 'Для отправки заявки требуется явное согласие на обработку персональных данных.', 2)
    const data = await request(baseUrl, '/api/ai/v1/material-requests/', {
      method: 'POST',
      body: { product_id: productId, full_name: fullName, company: company || undefined, phone, email, comment: comment || undefined, personal_data_consent: true, agent: 'hobbyka-cli' },
      token: profile.access_token,
      idempotencyKey: scalar(flags['idempotency-key'] || input.idempotency_key, 'idempotency-key', { max: 128 }) || randomUUID()
    })
    return { ok: true, command: 'materials request', data, guidance: buildGuidance(profile, { command: 'materials request' }) }
  }

  if (command === 'offer' && action === 'create') {
    requireContact(profile, 'offer create')
    if (!profile.access_token) throw new CliError('contact_required', 'Перед созданием КП зарегистрируйте контакт.', 3, { guidance: buildGuidance(profile, { command: 'offer create', outcome: 'blocked' }) })
    const body = { items: parseItems(flags.items), agent: 'hobbyka-cli' }
    const object = {
      name: scalar(flags['object-name'], 'object-name', { max: 500 }),
      city: scalar(flags.city, 'city', { max: 255 }),
      address: scalar(flags.address, 'address', { max: 500 }),
      comments: scalar(flags.comments, 'comments', { max: 1000 })
    }
    const objectValues = Object.fromEntries(Object.entries(object).filter(([, value]) => value !== ''))
    if (Object.keys(objectValues).length) body.object = objectValues
    const partnerMode = authenticatedMode(profile)
    const data = await request(baseUrl, partnerMode ? '/api/partner/v1/commercial-offers/' : '/api/ai/v1/commercial-offers/', {
      method: 'POST',
      body,
      token: profile.access_token,
      idempotencyKey: scalar(flags['idempotency-key'], 'idempotency-key', { max: 128 }) || randomUUID()
    })
    return { ok: true, command: 'offer create', data, recommendation: recommendation(flags), contact_gate: { status: partnerMode ? 'partner' : 'registered' }, guidance: buildGuidance(profile, { command: 'offer create' }) }
  }

  if (command === 'offer' && action === 'status') {
    requireContact(profile, 'offer status')
    const publicId = scalar(flags['public-id'], 'public-id', { required: true, max: 64 })
    if (!/^[a-f0-9]{32,64}$/.test(publicId)) throw new CliError('invalid_public_id', 'Некорректный public-id КП.', 2)
    const data = await request(baseUrl, `/api/ai/v1/commercial-offers/${publicId}/?agent=hobbyka-cli`, { token: profile.access_token })
    return { ok: true, command: 'offer status', data, contact_gate: { status: 'registered' }, guidance: buildGuidance(profile, { command: 'offer status' }) }
  }

  if (command === 'offer' && action === 'list') {
    requireAuthorized(profile, 'offer list')
    const limit = integer(flags.limit, 'limit', { min: 1, max: 100, fallback: 50 })
    const data = await request(baseUrl, `/api/partner/v1/commercial-offers/?limit=${limit}`, { token: profile.access_token })
    return { ok: true, command: 'offer list', data, guidance: buildGuidance(profile, { command: 'offer list' }) }
  }

  if (command === 'offer' && action === 'revise') {
    requireAuthorized(profile, 'offer revise')
    const publicId = publicIdentifier(flags['public-id'], 'public-id')
    const body = { expected_version: integer(flags['expected-version'], 'expected-version'), items: parseItems(flags.items), agent: 'hobbyka-cli' }
    const data = await request(baseUrl, `/api/partner/v1/commercial-offers/${publicId}/`, {
      method: 'PATCH', body, token: profile.access_token,
      idempotencyKey: scalar(flags['idempotency-key'], 'idempotency-key', { max: 128 }) || randomUUID()
    })
    return { ok: true, command: 'offer revise', data, guidance: buildGuidance(profile, { command: 'offer revise' }) }
  }

  if (command === 'offer' && action === 'archive') {
    requireAuthorized(profile, 'offer archive')
    const publicId = publicIdentifier(flags['public-id'], 'public-id')
    const data = await request(baseUrl, `/api/partner/v1/commercial-offers/${publicId}/archive/`, {
      method: 'POST', body: { expected_version: integer(flags['expected-version'], 'expected-version') }, token: profile.access_token
    })
    return { ok: true, command: 'offer archive', data, guidance: buildGuidance(profile, { command: 'offer archive' }) }
  }

  if (command === 'order') {
    requireAuthorized(profile, `order ${action || ''}`.trim())
    if (action === 'list') {
      const limit = integer(flags.limit, 'limit', { min: 1, max: 100, fallback: 50 })
      const data = await request(baseUrl, `/api/partner/v1/orders/?limit=${limit}`, { token: profile.access_token })
      return { ok: true, command: 'order list', data, guidance: buildGuidance(profile, { command: 'order list' }) }
    }
    if (action === 'get') {
      const publicId = publicIdentifier(flags['public-id'], 'public-id')
      const data = await request(baseUrl, `/api/partner/v1/orders/${publicId}/`, { token: profile.access_token })
      return { ok: true, command: 'order get', data, guidance: buildGuidance(profile, { command: 'order get' }) }
    }
    if (action === 'create') {
      const body = { comments: scalar(flags.comments, 'comments', { max: 1000 }) || undefined }
      if (flags.items) body.items = parseItems(flags.items)
      if (flags['offer-public-id']) body.offer_public_id = publicIdentifier(flags['offer-public-id'], 'offer-public-id')
      if (!body.items && !body.offer_public_id) throw new CliError('invalid_argument', 'Укажите --items либо --offer-public-id.', 2)
      const data = await request(baseUrl, '/api/partner/v1/orders/', {
        method: 'POST', body, token: profile.access_token,
        idempotencyKey: scalar(flags['idempotency-key'], 'idempotency-key', { max: 128 }) || randomUUID()
      })
      return { ok: true, command: 'order create', data, guidance: buildGuidance(profile, { command: 'order create' }) }
    }
    if (action === 'update') {
      const publicId = publicIdentifier(flags['public-id'], 'public-id')
      const body = { expected_version: integer(flags['expected-version'], 'expected-version'), comments: scalar(flags.comments, 'comments', { max: 1000 }) }
      const data = await request(baseUrl, `/api/partner/v1/orders/${publicId}/`, { method: 'PATCH', body, token: profile.access_token })
      return { ok: true, command: 'order update', data, guidance: buildGuidance(profile, { command: 'order update' }) }
    }
    if (action === 'cancel') {
      const publicId = publicIdentifier(flags['public-id'], 'public-id')
      const body = { expected_version: integer(flags['expected-version'], 'expected-version'), reason: scalar(flags.reason, 'reason', { max: 500 }) }
      const data = await request(baseUrl, `/api/partner/v1/orders/${publicId}/cancel/`, { method: 'POST', body, token: profile.access_token })
      return { ok: true, command: 'order cancel', data, guidance: buildGuidance(profile, { command: 'order cancel' }) }
    }
  }

  if (command === 'admin') {
    requireAdmin(profile, `admin ${action || ''} ${positionals[2] || ''}`.trim())
    const resource = action
    const operation = positionals[2]
    if (resource === 'offers' && operation === 'list') {
      const route = `/api/internal/v1/commercial-offers/?${buildQuery([
        ['number', scalar(flags.number, 'number', { max: 64 })],
        ['manager_id', flags['manager-id'] === undefined ? undefined : integer(flags['manager-id'], 'manager-id')],
        ['date_from', scalar(flags['date-from'], 'date-from', { max: 10 })],
        ['date_to', scalar(flags['date-to'], 'date-to', { max: 10 })],
        ['active', scalar(flags.active, 'active', { max: 1 })],
        ['page', integer(flags.page, 'page', { min: 1, max: 1000000, fallback: 1 })],
        ['limit', integer(flags.limit, 'limit', { min: 1, max: 100, fallback: 50 })]
      ])}`
      const data = await request(baseUrl, route, { token: profile.access_token })
      return { ok: true, command: 'admin offers list', access: accessStatus(profile), data, guidance: buildGuidance(profile, { command: 'admin offers list' }) }
    }
    if (resource === 'offers' && operation === 'get') {
      const id = integer(flags.id, 'id')
      const data = await request(baseUrl, `/api/internal/v1/commercial-offers/${id}/`, { token: profile.access_token })
      return { ok: true, command: 'admin offers get', access: accessStatus(profile), data, guidance: buildGuidance(profile, { command: 'admin offers get' }) }
    }
    if (resource === 'orders' && operation === 'list') {
      const route = `/api/internal/v1/orders/?${buildQuery([
        ['id', flags.id === undefined ? undefined : integer(flags.id, 'id')],
        ['user_id', flags['user-id'] === undefined ? undefined : integer(flags['user-id'], 'user-id')],
        ['status', scalar(flags.status, 'status', { max: 32 })],
        ['date_from', scalar(flags['date-from'], 'date-from', { max: 10 })],
        ['date_to', scalar(flags['date-to'], 'date-to', { max: 10 })],
        ['page', integer(flags.page, 'page', { min: 1, max: 1000000, fallback: 1 })],
        ['limit', integer(flags.limit, 'limit', { min: 1, max: 100, fallback: 50 })]
      ])}`
      const data = await request(baseUrl, route, { token: profile.access_token })
      return { ok: true, command: 'admin orders list', access: accessStatus(profile), data, guidance: buildGuidance(profile, { command: 'admin orders list' }) }
    }
    if (resource === 'orders' && operation === 'get') {
      const id = integer(flags.id, 'id')
      const data = await request(baseUrl, `/api/internal/v1/orders/${id}/`, { token: profile.access_token })
      return { ok: true, command: 'admin orders get', access: accessStatus(profile), data, guidance: buildGuidance(profile, { command: 'admin orders get' }) }
    }
  }

  throw new CliError('unknown_command', 'Неизвестная команда Hobbyka CLI.', 2, { command, action })
}

try {
  output(await main())
} catch (error) {
  const safe = error instanceof CliError ? error : new CliError('internal_error', 'Внутренняя ошибка Hobbyka CLI.', 1)
  output({ ok: false, error: { code: safe.code, message: safe.message, details: safe.details } }, process.stderr)
  process.exitCode = safe.exitCode
}
