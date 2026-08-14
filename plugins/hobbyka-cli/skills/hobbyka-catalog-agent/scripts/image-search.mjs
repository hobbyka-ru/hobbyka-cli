import { spawn } from 'node:child_process'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const VISION_SCRIPT = fileURLToPath(new URL('./hobbyka-image-search.py', import.meta.url))
const MAX_IMAGE_BYTES = 25 * 1024 * 1024

export class ImageSearchError extends Error {
  constructor(code, message, details) {
    super(message)
    this.code = code
    this.details = details
  }
}

export const imageIndexPaths = () => {
  const root = process.env.HOBBYKA_IMAGE_INDEX_DIR
    ? path.resolve(process.env.HOBBYKA_IMAGE_INDEX_DIR)
    : path.join(process.env.XDG_CACHE_HOME || path.join(homedir(), '.cache'), 'hobbyka-cli', 'image-search-v1')
  return { root, embeddings: path.join(root, 'embeddings.npz'), catalog: path.join(root, 'catalog.json') }
}

const visionCommand = (args) => process.env.HOBBYKA_VISION_RUNNER
  ? { executable: path.resolve(process.env.HOBBYKA_VISION_RUNNER), args }
  : { executable: 'uv', args: ['run', '--script', VISION_SCRIPT, '--', ...args] }

const runVision = (args, input) => new Promise((resolve, reject) => {
  const command = visionCommand(args)
  const child = spawn(command.executable, command.args, { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
  const stdout = []
  const stderr = []
  const timeoutMs = Number(process.env.HOBBYKA_VISION_TIMEOUT_MS || 1_800_000)
  const timeout = setTimeout(() => child.kill('SIGTERM'), Number.isInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 3_600_000 ? timeoutMs : 1_800_000)
  child.stdout.on('data', (chunk) => stdout.push(chunk))
  child.stderr.on('data', (chunk) => stderr.push(chunk))
  child.on('error', (error) => {
    clearTimeout(timeout)
    reject(new ImageSearchError(
      error?.code === 'ENOENT' ? 'vision_runtime_missing' : 'vision_runtime_failed',
      error?.code === 'ENOENT' ? 'Для локального поиска по изображению установите uv.' : 'Не удалось запустить локальный поиск по изображению.',
      error?.code === 'ENOENT' ? { install: 'https://docs.astral.sh/uv/getting-started/installation/' } : undefined
    ))
  })
  child.on('close', (code, signal) => {
    clearTimeout(timeout)
    let result
    try { result = JSON.parse(Buffer.concat(stdout).toString('utf8')) } catch { result = null }
    if (code !== 0 || !result) {
      let failure
      try { failure = JSON.parse(Buffer.concat(stderr).toString('utf8')) } catch { failure = null }
      reject(new ImageSearchError(
        signal ? 'vision_timeout' : failure?.error?.code || 'vision_failed',
        signal ? 'Локальный поиск по изображению превысил тайм-аут.' : failure?.error?.message || 'Локальный поиск по изображению завершился ошибкой.'
      ))
      return
    }
    resolve(result)
  })
  child.stdin.end(input === undefined ? undefined : JSON.stringify(input))
})

const readCatalog = async () => {
  const files = imageIndexPaths()
  try {
    const catalog = JSON.parse(await readFile(files.catalog, 'utf8'))
    if (catalog?.version !== 1 || typeof catalog.model !== 'string' || !Array.isArray(catalog.products)) throw new Error('invalid catalog')
    return catalog
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new ImageSearchError('image_index_missing', 'Сначала постройте локальный индекс изображений.', { next_command: 'node scripts/hobbyka-cli.mjs image-index build' })
    }
    throw new ImageSearchError('image_index_invalid', 'Локальный индекс изображений повреждён. Постройте его заново.')
  }
}

export const imageIndexStatus = async () => {
  const files = imageIndexPaths()
  try {
    const [catalog, embeddings] = await Promise.all([readCatalog(), stat(files.embeddings)])
    return {
      ready: embeddings.isFile(), directory: files.root, products: catalog.products.length,
      model: catalog.model, catalog_revision: catalog.catalog_revision, created_at: catalog.created_at
    }
  } catch (error) {
    if (error instanceof ImageSearchError && error.code === 'image_index_missing') return { ready: false, directory: files.root }
    if (error?.code === 'ENOENT') return { ready: false, directory: files.root }
    throw error
  }
}

export const buildImageIndex = async ({ products, baseUrl, catalogRevision, model }) => {
  const files = imageIndexPaths()
  await mkdir(files.root, { recursive: true, mode: 0o700 })
  const temporaryEmbeddings = `${files.embeddings}.${process.pid}.tmp.npz`
  const temporaryCatalog = `${files.catalog}.${process.pid}.tmp`
  try {
    const vision = await runVision(['build', '--index', temporaryEmbeddings, '--model', model], {
      products: products.map((product) => ({ product_id: product.id, image_urls: product.images }))
    })
    const indexedIds = new Set(vision.product_ids)
    const catalog = {
      version: 1, model: vision.model, base_url: baseUrl, catalog_revision: catalogRevision, created_at: new Date().toISOString(),
      products: products.filter((product) => indexedIds.has(product.id))
    }
    await writeFile(temporaryCatalog, `${JSON.stringify(catalog)}\n`, { mode: 0o600 })
    await rename(temporaryEmbeddings, files.embeddings)
    await rename(temporaryCatalog, files.catalog)
    return { ...vision, products: catalog.products.length, directory: files.root, catalog_revision: catalogRevision }
  } catch (error) {
    await Promise.all([unlink(temporaryEmbeddings).catch(() => {}), unlink(temporaryCatalog).catch(() => {})])
    throw error
  }
}

export const searchImageIndex = async ({ image, model, topK }) => {
  const files = imageIndexPaths()
  let imageStats
  try { imageStats = await stat(image) } catch { throw new ImageSearchError('image_unavailable', 'Не удалось прочитать изображение.') }
  if (!imageStats.isFile() || imageStats.size < 1 || imageStats.size > MAX_IMAGE_BYTES) {
    throw new ImageSearchError('invalid_image', 'Изображение должно быть обычным файлом размером до 25 МБ.')
  }
  const catalog = await readCatalog()
  if (catalog.model !== model) {
    throw new ImageSearchError('image_index_model_mismatch', 'Индекс построен другой моделью. Постройте его заново с выбранной моделью.')
  }
  try {
    const embeddings = await stat(files.embeddings)
    if (!embeddings.isFile()) throw new Error('not a file')
  } catch {
    throw new ImageSearchError('image_index_missing', 'Сначала постройте локальный индекс изображений.', { next_command: 'node scripts/hobbyka-cli.mjs image-index build' })
  }
  const result = await runVision(['search', '--index', files.embeddings, '--image', image, '--model', model, '--top-k', String(topK)])
  const products = new Map(catalog.products.map((product) => [product.id, product]))
  return {
    ...result,
    candidates: result.candidates.filter((candidate) => products.has(candidate.product_id)).map((candidate) => ({ ...candidate, product: products.get(candidate.product_id) })),
    provenance: { local: true, model: result.model, catalog_revision: catalog.catalog_revision, index_created_at: catalog.created_at }
  }
}
