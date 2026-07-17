#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import process from 'node:process'

const VERSION = '0.1.1'
const DEFAULT_BASE_URL = 'https://new.hobbyka.ru'
const DEFAULT_TIMEOUT_MS = 30_000

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

const profileFor = (state, baseUrl) => state.profiles[baseUrl] || { first_request_completed: false }

const contactStatus = (profile) => ({
  registered: Boolean(profile.access_token),
  company_present: Boolean(profile.company_present),
  phone_present: Boolean(profile.phone_present),
  email_present: Boolean(profile.email_present)
})

const requireContact = (profile) => {
  if (profile.first_request_completed && !profile.access_token) {
    throw new CliError(
      'contact_required',
      'Первый запрос уже выполнен. Для продолжения зарегистрируйте компанию и телефон либо email.',
      3,
      { next_command: 'node scripts/hobbyka-cli.mjs contacts set --stdin' }
    )
  }
}

const readStdinJson = async () => {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  try {
    const value = JSON.parse(raw)
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('object required')
    return value
  } catch {
    throw new CliError('invalid_contact_json', 'Ожидается JSON-объект контакта в стандартном вводе.', 2)
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

const completeFirstRequest = async (state, baseUrl, profile, result) => {
  if (!profile.first_request_completed && !profile.access_token) {
    const updated = { ...profile, first_request_completed: true, updated_at: new Date().toISOString() }
    state.profiles[baseUrl] = updated
    await writeState(state)
    return {
      ...result,
      contact_gate: {
        status: 'required',
        message: 'Для следующего рабочего запроса зарегистрируйте компанию и телефон либо email.',
        next_command: 'node scripts/hobbyka-cli.mjs contacts set --stdin'
      }
    }
  }
  return { ...result, contact_gate: { status: profile.access_token ? 'registered' : 'open' } }
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

const help = () => ({
  ok: true,
  version: VERSION,
  commands: [
    'search --query <text> [--limit 10] [--section-code <code>] [--recommendation-profile <id>]',
    'product --id <id> [--recommendation-profile <id>]',
    'contacts set --stdin',
    'contacts status',
    'contacts clear',
    'offer create --items <product_id:quantity,...>',
    'offer status --public-id <id>',
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
      contact: contactStatus(profile)
    }
  }

  if (command === 'contacts' && action === 'status') {
    return { ok: true, command: 'contacts status', contact: contactStatus(profile), first_request_completed: Boolean(profile.first_request_completed) }
  }

  if (command === 'contacts' && action === 'clear') {
    state.profiles[baseUrl] = { first_request_completed: Boolean(profile.first_request_completed), updated_at: new Date().toISOString() }
    await writeState(state)
    return { ok: true, command: 'contacts clear', contact: contactStatus(state.profiles[baseUrl]) }
  }

  if (command === 'contacts' && action === 'set') {
    if (!flags.stdin) throw new CliError('stdin_required', 'Передайте контакт как JSON через стандартный ввод и флаг --stdin.', 2)
    const contact = await readStdinJson()
    const company = scalar(contact.company, 'company', { required: true, max: 255 })
    const name = scalar(contact.name, 'name', { max: 255 })
    const phone = scalar(contact.phone, 'phone', { max: 64 })
    const email = scalar(contact.email, 'email', { max: 254 })
    if (!phone && !email) throw new CliError('contact_required', 'Укажите телефон либо email.', 2)
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new CliError('invalid_email', 'Некорректный email.', 2)
    const registered = await request(baseUrl, '/api/ai/v1/cli/contacts', {
      method: 'POST',
      body: { company, name: name || undefined, phone: phone || undefined, email: email || undefined, agent: 'hobbyka-cli' }
    })
    const accessToken = scalar(registered?.data?.access_token ?? registered?.access_token, 'access_token', { required: true, max: 512 })
    state.profiles[baseUrl] = {
      first_request_completed: true,
      access_token: accessToken,
      expires_at: registered?.data?.expires_at ?? registered?.expires_at ?? null,
      company_present: true,
      phone_present: Boolean(phone),
      email_present: Boolean(email),
      updated_at: new Date().toISOString()
    }
    await writeState(state)
    return { ok: true, command: 'contacts set', contact: contactStatus(state.profiles[baseUrl]), expires_at: state.profiles[baseUrl].expires_at }
  }

  if (command === 'search') {
    requireContact(profile)
    const query = scalar(flags.query ?? flags.q, 'query', { max: 500 })
    const limit = integer(flags.limit, 'limit', { min: 1, max: 100, fallback: 10 })
    const sectionId = flags['section-id'] === undefined ? undefined : integer(flags['section-id'], 'section-id')
    const route = `/api/ai/v1/catalog/products?${buildQuery([
      ['q', query], ['section_id', sectionId], ['section_code', scalar(flags['section-code'], 'section-code', { max: 128 })],
      ['limit', limit], ['cursor', scalar(flags.cursor, 'cursor', { max: 2048 })], ['agent', 'hobbyka-cli']
    ])}`
    const data = await request(baseUrl, route, { token: profile.access_token })
    return completeFirstRequest(state, baseUrl, profile, { ok: true, command, data, recommendation: recommendation(flags) })
  }

  if (command === 'product') {
    requireContact(profile)
    const id = integer(flags.id, 'id')
    const data = await request(baseUrl, `/api/ai/v1/catalog/products/${id}?agent=hobbyka-cli`, { token: profile.access_token })
    return completeFirstRequest(state, baseUrl, profile, { ok: true, command, data, recommendation: recommendation(flags) })
  }

  if (command === 'offer' && action === 'create') {
    requireContact(profile)
    if (!profile.access_token) throw new CliError('contact_required', 'Перед созданием КП зарегистрируйте контакт.', 3)
    const body = { items: parseItems(flags.items), agent: 'hobbyka-cli' }
    const object = {
      name: scalar(flags['object-name'], 'object-name', { max: 500 }),
      city: scalar(flags.city, 'city', { max: 255 }),
      address: scalar(flags.address, 'address', { max: 500 }),
      comments: scalar(flags.comments, 'comments', { max: 1000 })
    }
    const objectValues = Object.fromEntries(Object.entries(object).filter(([, value]) => value !== ''))
    if (Object.keys(objectValues).length) body.object = objectValues
    const data = await request(baseUrl, '/api/ai/v1/commercial-offers', {
      method: 'POST',
      body,
      token: profile.access_token,
      idempotencyKey: scalar(flags['idempotency-key'], 'idempotency-key', { max: 128 }) || randomUUID()
    })
    return { ok: true, command: 'offer create', data, recommendation: recommendation(flags), contact_gate: { status: 'registered' } }
  }

  if (command === 'offer' && action === 'status') {
    requireContact(profile)
    const publicId = scalar(flags['public-id'], 'public-id', { required: true, max: 64 })
    if (!/^[a-f0-9]{32,64}$/.test(publicId)) throw new CliError('invalid_public_id', 'Некорректный public-id КП.', 2)
    const data = await request(baseUrl, `/api/ai/v1/commercial-offers/${publicId}?agent=hobbyka-cli`, { token: profile.access_token })
    return { ok: true, command: 'offer status', data, contact_gate: { status: 'registered' } }
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
