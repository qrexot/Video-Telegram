import { config } from './config.js'

const $ = (id) => document.getElementById(id)
const loginForm = $('login-form')
const ownerLogin = $('owner-login')
const ownerEntry = $('owner-entry')
const uploadButton = $('upload-open')
const signOutButton = $('sign-out')
const emptyDetail = $('empty-detail')
const uploadForm = $('upload-form')
const telegramDialog = $('telegram-dialog')
const telegramForm = $('telegram-form')
const telegramMessage = $('telegram-message')
let telegramStep = ''
let telegramRequest
const player = $('player')
const video = $('video')
const pageSize = 24
const mebibyte = 1024 * 1024
const photoPartCutoff = 10 * mebibyte
const smallVideoLimit = 20 * mebibyte
const videoLimit = 2_000_000_000
const batchSize = 4 * mebibyte
let token = ''
let libraryRequest
let uploadId
let uploadRequest
let searchTimer
let offset = 0
let libraryKind = 'video'
let libraryView = 'public'
let uploadKind = 'video'
let pendingTrash
let openPhotoItem
let photoDownload
const trash = $('trash-confirm')
const editDialog = $('edit-dialog')
const editForm = $('edit-form')
let editing
const photoDialog = $('photo-dialog')

class RequestError extends Error {
  constructor(message, status) {
    super(message)
    this.status = status
  }
}

function message(element, text = '', isError = false) {
  element.textContent = text
  element.classList.toggle('error', isError)
}

const statusMessages = {
  401: 'Сеанс закончился. Войдите снова.',
  403: 'Этой учётной записи не открыт доступ.',
  409: 'Эта загрузка уже обрабатывается. Обновите список чуть позже.',
  413: 'Выбранный файл или часть загрузки превышает допустимый размер.',
  415: 'Поддерживаются видеофайлы MP4 и WebM.',
  429: 'Слишком много запросов. Попробуйте чуть позже.',
  503: 'Хранилище пока не подключено. Обратитесь к владельцу.',
}

async function responseError(response, fallback) {
  const data = await response.json().catch(() => null)
  return new RequestError(statusMessages[response.status] ?? data?.message ?? fallback, response.status)
}

async function request(action, { method = 'GET', params = {}, body, signal, json } = {}) {
  const query = new URLSearchParams({ action, ...params })
  const headers = { apikey: config.publishableKey }
  if (action === 'session' || action.startsWith('upload') || action === 'telegram-setup' || ['manage', 'cover-upload', 'photo-upload', 'photo-part'].includes(action) || (params.view && params.view !== 'public')) headers.Authorization = `Bearer ${token}`
  if (json) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(json)
  }
  const response = await fetch(`${config.url}/functions/v1/video?${query}`, {
    method, body, signal, headers,
    cache: 'no-store',
  })
  if (!response.ok) throw await responseError(response, 'Запрос не выполнен.')
  return response
}

function updateOwnerControls(signedIn) {
  ownerEntry.hidden = signedIn
  signOutButton.hidden = !signedIn
  uploadButton.hidden = !signedIn
  $('owner-menu').hidden = !signedIn
  $('media-views').hidden = !signedIn
  updateEmptyDetail()
}

function updateEmptyDetail() {
  emptyDetail.textContent = $('search').value.trim() ? 'Попробуйте другой запрос.' :
    libraryView !== 'public' ? 'Здесь пока нет файлов.' :
    uploadButton.hidden ? 'Здесь появятся новые публикации.' : 'Нажми «Добавить», чтобы опубликовать файл.'
}

function signOut() {
  const previousToken = token
  token = ''
  uploadRequest?.abort()
  telegramRequest?.abort()
  if (telegramDialog.open) telegramDialog.close()
  if ($('upload-dialog').open) $('upload-dialog').close()
  uploadForm.reset()
  uploadId = undefined
  updateOwnerControls(false)
  libraryView = 'public'
  updateView()
  if (previousToken) {
    if (trash.open) trash.close()
    if (editDialog.open) editDialog.close()
    if (player.open) player.close()
    void loadLibrary()
  }
  if (previousToken) {
    void fetch(`${config.url}/auth/v1/logout?scope=local`, {
      method: 'POST',
      headers: { apikey: config.publishableKey, Authorization: `Bearer ${previousToken}` },
      keepalive: true,
    }).catch(() => {})
  }
}

function showError(error, element) {
  if (error.name === 'AbortError') return
  if (element === $('upload-status') && [401, 403].includes(error.status)) {
    signOut()
    ownerLogin.showModal()
    message($('login-error'), error.message, true)
    return
  }
  message(element, error instanceof RequestError ? error.message : 'Проверьте подключение и попробуйте снова.', true)
}

async function login(event) {
  event.preventDefault()
  const submit = loginForm.querySelector('button[type=submit]')
  submit.disabled = true
  message($('login-error'), 'Входим…')
  try {
    const fields = new FormData(loginForm)
    const response = await fetch(`${config.url}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: config.publishableKey },
      body: JSON.stringify({ email: fields.get('email').trim(), password: fields.get('password') }),
    })
    if (!response.ok) {
      throw new RequestError(response.status === 429 ? statusMessages[429] : 'Не удалось войти. Проверьте почту и пароль.', response.status)
    }
    const data = await response.json()
    token = data.access_token
    await request('session')
    loginForm.reset()
    message($('login-error'))
    updateOwnerControls(true)
    ownerLogin.close()
    uploadButton.focus()
    void loadLibrary()
  } catch (error) {
    signOut()
    loginForm.elements.password.value = ''
    showError(error, $('login-error'))
  } finally {
    submit.disabled = false
  }
}

const date = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'short', year: 'numeric' })
const size = new Intl.NumberFormat('ru', { maximumFractionDigits: 1 })
const svgNamespace = 'http://www.w3.org/2000/svg'

function assetURL(id, type) {
  const params = new URLSearchParams({ action: 'asset', id, type })
  return `${config.url}/functions/v1/video?${params}`
}

function openPhoto(item) {
  openPhotoItem = item
  $('photo-title').textContent = item.title
  $('photo-description').textContent = item.description
  const dimensions = item.width > 1 && item.height > 1 ? `${item.width} × ${item.height} · ` : ''
  $('photo-meta').textContent = `${dimensions}${size.format(item.size_bytes / mebibyte)} МБ`
  const preview = $('photo-preview')
  preview.hidden = true
  preview.alt = item.title
  message($('photo-preview-status'), 'Загружаем превью…')
  preview.src = assetURL(item.id, 'preview')
  $('photo-original').textContent = 'Скачать оригинал'
  $('photo-original').href = assetURL(item.id, 'original')
  photoDialog.showModal()
}

function updateView() {
  $('library-title').textContent = libraryKind === 'video' ? 'Видеотека' : 'Фотографии'
  $('tab-videos').setAttribute('aria-pressed', String(libraryKind === 'video'))
  $('tab-photos').setAttribute('aria-pressed', String(libraryKind === 'photo'))
  for (const button of document.querySelectorAll('[data-view]')) {
    button.setAttribute('aria-pressed', String(button.dataset.view === libraryView))
  }
}

async function manageItem(id, kind, operation, button) {
  button.disabled = true
  try {
    await request('manage', { method: 'POST', params: { id }, json: { kind, operation } })
    if (trash.open) trash.close()
    await loadLibrary()
  } catch (error) {
    if (trash.open) trash.close()
    $('library-status').hidden = false
    showError(error, $('library-status'))
  } finally {
    button.disabled = false
  }
}

function renderCard(item) {
  const kind = libraryKind
  const isPhoto = kind === 'photo'
  const article = document.createElement('article')
  article.className = 'media-card'
  const card = document.createElement('button')
  card.type = 'button'
  card.className = 'card'
  card.disabled = libraryView !== 'public'
  const cover = document.createElement('span')
  cover.className = 'cover'
  const icon = document.createElementNS(svgNamespace, 'svg')
  icon.setAttribute('aria-hidden', 'true')
  const use = document.createElementNS(svgNamespace, 'use')
  use.setAttribute('href', isPhoto ? '#icon-photo' : '#icon-video')
  icon.append(use)
  cover.append(icon)
  if (!card.disabled && (isPhoto || item.has_cover)) {
    const image = document.createElement('img')
    image.alt = ''
    image.loading = 'lazy'
    image.decoding = 'async'
    image.src = assetURL(item.id, isPhoto ? 'preview' : 'cover')
    image.addEventListener('error', () => image.remove())
    cover.append(image)
  }
  if (!isPhoto && !card.disabled) {
    const play = document.createElement('span')
    play.className = 'cover-play'
    play.setAttribute('aria-hidden', 'true')
    play.textContent = '▶'
    cover.append(play)
  }
  const detail = document.createElement('span')
  detail.className = 'card-detail'
  const title = document.createElement('strong')
  title.textContent = item.title
  const metadata = document.createElement('span')
  metadata.textContent = `${date.format(new Date(item.created_at))} · ${size.format(item.size_bytes / mebibyte)} МБ`
  detail.append(title, metadata)
  card.append(cover, detail)
  card.addEventListener('click', () => isPhoto ? openPhoto(item) : void openPlayer(item))
  article.append(card)
  if (token) {
    const actions = document.createElement('div')
    actions.className = 'card-actions'
    const options = item.deleted_at ? [['restore', 'Восстановить']] : [
      ['edit', 'Изменить'], item.hidden ? ['show', 'Показать'] : ['hide', 'Скрыть'], ['delete', 'Удалить'],
    ]
    for (const [operation, label] of options) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = operation === 'delete' ? 'danger' : 'subtle'
      button.textContent = label
      button.addEventListener('click', () => {
        if (operation === 'edit') {
          editing = { id: item.id, kind }
          editForm.elements.title.value = item.title
          editForm.elements.description.value = item.description || ''
          message($('edit-status'))
          editDialog.showModal()
        } else if (operation === 'delete') {
          pendingTrash = { id: item.id, kind }
          trash.showModal()
        } else void manageItem(item.id, kind, operation, button)
      })
      actions.append(button)
    }
    article.append(actions)
  }
  return article
}

editForm.addEventListener('submit', async (event) => {
  event.preventDefault()
  if (!editing || !token) return
  const submit = editForm.querySelector('button[type="submit"]')
  submit.disabled = true
  const { id, kind } = editing
  try {
    const title = editForm.elements.title.value.trim()
    const description = editForm.elements.description.value.trim()
    await request('manage', { method: 'POST', params: { id }, json: { kind, operation: 'edit', title, description } })
    if (editing?.id === id && editDialog.open) editDialog.close()
    await loadLibrary()
  } catch (error) {
    showError(error, $('edit-status'))
  } finally {
    submit.disabled = false
  }
})

for (const [id, kind] of [['tab-videos', 'video'], ['tab-photos', 'photo']]) {
  $(id).addEventListener('click', () => {
    if (libraryKind === kind) return
    libraryKind = kind
    $('search').value = ''
    updateView()
    void loadLibrary()
  })
}
for (const button of document.querySelectorAll('[data-view]')) {
  button.addEventListener('click', () => {
    libraryView = button.dataset.view
    updateView()
    void loadLibrary()
  })
}
$('trash-submit').addEventListener('click', (event) => {
  if (pendingTrash) void manageItem(pendingTrash.id, pendingTrash.kind, 'delete', event.currentTarget)
})
async function downloadPhoto(event) {
  const item = openPhotoItem
  if (!item || item.size_bytes <= batchSize) return
  event.preventDefault()
  if (photoDownload) return
  const button = event.currentTarget
  const controller = new AbortController()
  photoDownload = controller
  try {
    const chunks = []
    const url = assetURL(item.id, 'original')
    for (let from = 0; from < item.size_bytes; from += batchSize) {
      const to = Math.min(from + batchSize, item.size_bytes) - 1
      const response = await fetch(url, {
        headers: { Range: `bytes=${from}-${to}` }, signal: controller.signal, cache: 'no-store',
      })
      if (response.status !== 206 || response.headers.get('Content-Range') !== `bytes ${from}-${to}/${item.size_bytes}`) {
        throw new Error('Unexpected photo download range')
      }
      chunks.push(await response.blob())
      button.textContent = `Скачивание · ${Math.floor((to + 1) * 100 / item.size_bytes)}%`
    }
    const link = document.createElement('a')
    link.href = URL.createObjectURL(new Blob(chunks, { type: chunks[0].type }))
    link.download = item.filename || item.title
    document.body.append(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(link.href), 30000)
  } catch (error) {
    if (!controller.signal.aborted) button.textContent = 'Повторить скачивание'
    return
  } finally {
    photoDownload = undefined
  }
  button.textContent = 'Скачать оригинал'
}

$('photo-preview').addEventListener('load', (event) => {
  if (!openPhotoItem) return
  event.currentTarget.hidden = false
  message($('photo-preview-status'))
})
$('photo-preview').addEventListener('error', () => {
  if (openPhotoItem) message($('photo-preview-status'), 'Превью пока недоступно. Оригинал можно скачать.')
})
$('photo-original').addEventListener('click', downloadPhoto)
photoDialog.addEventListener('close', () => {
  photoDownload?.abort()
  openPhotoItem = undefined
  $('photo-preview').removeAttribute('src')
})

async function loadLibrary(append = false) {
  libraryRequest?.abort()
  const controller = new AbortController()
  libraryRequest = controller
  const search = $('search').value.trim().slice(0, 120)
  if (!append) {
    offset = 0
    $('cards').replaceChildren()
    $('count').textContent = ''
  }
  $('library-status').hidden = false
  $('empty').hidden = true
  $('more').hidden = true
  message($('library-status'), 'Загружаем список…')
  try {
    const response = await request(libraryKind === 'photo' ? 'photos' : 'list', { params: { search, offset, view: libraryView }, signal: controller.signal })
    const { items, total } = await response.json()
    if (controller.signal.aborted) return
    $('cards').append(...items.map(renderCard))
    offset += items.length
    $('count').textContent = search ? `Найдено: ${total}` : `${libraryKind === 'photo' ? 'Фото' : 'Видео'} · ${total}`
    $('more').hidden = offset >= total || items.length < pageSize
    $('empty').hidden = total !== 0
    $('empty-title').textContent = search ? 'Ничего не найдено' : 'Пока пусто'
    updateEmptyDetail()
    $('library-status').hidden = true
  } catch (error) {
    showError(error, $('library-status'))
  }
}

const quality = $('video-quality')
const speed = $('video-speed')
const playerStatus = $('player-status')
let playerRequest
let sources = []
let activeSource
let resumePlayback
let playbackRequested = false
let playerItem
let variantOriginal

function selectSource() {
  if (quality.value) return quality.value
  const weakConnection = navigator.connection?.saveData || /^(slow-2g|2g|3g)$/.test(navigator.connection?.effectiveType)
  const preferred = weakConnection ? 360 : 720
  return sources.filter((item) => item.quality_height <= preferred).at(-1)?.id || sources[0].id
}

function playSource(id, time = 0) {
  if (activeSource === id) return
  activeSource = id
  resumePlayback = time
  message(playerStatus, 'Загружаем видео…')
  const params = new URLSearchParams({ action: 'play', id, v: '9' })
  video.src = `${config.url}/functions/v1/video?${params}`
  video.playbackRate = Number(speed.value)
  if (playbackRequested && !time) void video.play().catch(() => {})
}

async function openPlayer(item) {
  const controller = new AbortController()
  playerRequest = controller
  playerItem = item
  $('variant-upload').hidden = !token
  $('cover-edit').hidden = !token
  if (item.has_cover) video.poster = assetURL(item.id, 'cover')
  else video.removeAttribute('poster')
  $('player-title').textContent = item.title
  $('player-description').textContent = item.description
  message(playerStatus, 'Подключаем видео…')
  const automatic = new Option('Авто', '')
  quality.replaceChildren(automatic, new Option('Оригинал', item.id))
  quality.value = ''
  updatePlayerControls()
  sources = [item]
  playbackRequested = true
  video.hidden = false
  player.showModal()
  if (item.size_bytes <= 8 * mebibyte) playSource(item.id)
  try {
    const response = await request('qualities', { params: { id: item.id }, signal: controller.signal })
    const result = await response.json()
    if (controller.signal.aborted) return
    sources = [item, ...result.items]
    for (const variant of result.items) {
      quality.add(new Option(`${variant.quality_height}p`, variant.id), quality.options.length - 1)
    }
  } catch (error) {
    if (controller.signal.aborted) return
  }
  if (!activeSource) playSource(selectSource())
}

speed.addEventListener('change', () => { video.playbackRate = Number(speed.value) })
quality.addEventListener('change', () => {
  playbackRequested = playbackRequested || !video.paused
  playSource(selectSource(), video.currentTime)
})

function jpegFrom(source, width, height, bound) {
  const ratio = Math.min(1, bound / Math.max(width, height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * ratio))
  canvas.height = Math.max(1, Math.round(height * ratio))
  const context = canvas.getContext('2d', { alpha: false })
  context.fillStyle = '#191716'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(source, 0, 0, canvas.width, canvas.height)
  return new Promise((resolve, reject) => canvas.toBlob(
    (blob) => blob ? resolve(blob) : reject(new Error('No JPEG')), 'image/jpeg', .82,
  ))
}

async function photoPreview(file) {
  const image = await createImageBitmap(file).catch(() => null)
  if (!image) throw new RequestError('Не удалось открыть фото в этом браузере. Попробуй JPG, PNG или WebP.', 415)
  try {
    return { width: image.width, height: image.height,
      blob: await jpegFrom(image, image.width, image.height, 1400) }
  } finally {
    image.close()
  }
}

async function videoCover(file) {
  const sample = document.createElement('video')
  sample.muted = true
  sample.playsInline = true
  sample.preload = 'auto'
  const url = URL.createObjectURL(file)
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Video frame unavailable')), 7000)
      sample.onloadedmetadata = () => {
        if (Number.isFinite(sample.duration) && sample.duration > .5) {
          sample.currentTime = Math.min(2, sample.duration * .15)
        }
      }
      sample.onseeked = () => { clearTimeout(timeout); resolve() }
      sample.onloadeddata = () => {
        if (!sample.seeking) { clearTimeout(timeout); resolve() }
      }
      sample.onerror = () => { clearTimeout(timeout); reject(new Error('Video decode failed')) }
      sample.src = url
    })
    return await jpegFrom(sample, sample.videoWidth, sample.videoHeight, 800)
  } finally {
    sample.removeAttribute('src')
    sample.load()
    URL.revokeObjectURL(url)
  }
}

async function putCover(id, cover, signal) {
  const data = new FormData()
  data.set('cover', cover, 'cover.jpg')
  await request('cover-upload', { method: 'POST', params: { id }, body: data, signal })
}

async function uploadParts(action, file, params, signal, progress) {
  progress.max = file.size
  progress.value = 0
  for (let sent = 0; sent < file.size; sent += batchSize) {
    const chunk = file.slice(sent, sent + batchSize)
    for (let attempt = 1; ; attempt++) {
      try {
        await request(action, { method: 'POST', params: { ...params, offset: sent }, body: chunk, signal })
        break
      } catch (error) {
        const temporary = error instanceof TypeError || [408, 500, 502, 503, 504].includes(error.status)
        if (!temporary || attempt >= 3 || signal.aborted) throw error
        message($('upload-status'), 'Повторяем отправку части видео…')
        await new Promise((resolve) => setTimeout(resolve, attempt * 1000))
      }
    }
    progress.value = sent + chunk.size
    message($('upload-status'), `Загружено ${Math.floor(100 * progress.value / file.size)}%`)
  }
}

async function upload(event) {
  event.preventDefault()
  if (!token || uploadRequest) return
  const file = uploadForm.elements.video.files[0]
  const title = uploadForm.elements.title.value.trim()
  const description = uploadForm.elements.description.value.trim()
  if (!title || !file?.size) {
    message($('upload-status'), 'Укажи название и выбери непустой видеофайл.', true)
    return
  }
  if (uploadKind === 'photo' && file.size > 25 * mebibyte) {
    message($('upload-status'), 'Фото превышает 25 МБ.', true)
    return
  }
  if (uploadKind === 'video' && file.size > videoLimit) {
    message($('upload-status'), `Размер файла ${size.format(file.size / 1_000_000_000)} ГБ. Лимит 2 ГБ.`, true)
    return
  }

  const controller = new AbortController()
  uploadRequest = controller
  for (const field of uploadForm.elements) field.disabled = true
  const progress = $('upload-progress')
  progress.hidden = false
  progress.removeAttribute('value')
  message($('upload-status'), uploadKind === 'photo' ? 'Готовим превью…' : 'Отправляем видео в Telegram…')
  try {
    const signal = controller.signal
    const variant = variantOriginal ? { original: variantOriginal.id, height: uploadForm.elements.height.value } : {}
    uploadId ??= crypto.randomUUID()
    const cover = uploadKind === 'video' && !variantOriginal ? videoCover(file).catch(() => null) : null
    if (uploadKind === 'photo') {
      const preview = await photoPreview(file)
      const body = new FormData()
      body.set('title', title)
      body.set('description', description)
      if (file.size <= photoPartCutoff) body.set('photo', file)
      else {
        await uploadParts('photo-part', file, { id: uploadId, size: file.size }, signal, progress)
        body.set('size', file.size)
        body.set('mime', file.type)
        body.set('filename', file.name)
      }
      body.set('preview', preview.blob, 'preview.jpg')
      body.set('width', preview.width)
      body.set('height', preview.height)
      message($('upload-status'), 'Сохраняем фото…')
      await request('photo-upload', { method: 'POST', params: { id: uploadId }, body, signal })
    } else if (file.size <= smallVideoLimit) {
      const body = new FormData()
      body.set('video', file)
      body.set('title', title)
      body.set('description', description)
      await request('upload', { method: 'POST', params: { id: uploadId, ...variant }, body, signal })
    } else {
      const params = { id: uploadId, size: file.size, ...variant }
      await uploadParts('upload-part', file, params, signal, progress)
      message($('upload-status'), 'Публикуем видео…')
      await request('upload-finish', { method: 'POST', params, json: { title, description }, signal })
    }
    if (cover) {
      const image = await cover
      if (image && !signal.aborted) {
        await putCover(uploadId, image, signal).catch(() => {})
      }
    }
    if (controller.signal.aborted) return
    uploadId = undefined
    uploadForm.reset()
    $('upload-dialog').close()
    $('search').value = ''
    void loadLibrary()
  } catch (error) {
    showError(error, $('upload-status'))
  } finally {
    uploadRequest = null
    for (const field of uploadForm.elements) field.disabled = false
    $('upload-progress').hidden = true
  }
}

function renderTelegram(step) {
  telegramStep = step
  const needsValue = step === 'code' || step === 'password'
  const field = telegramForm.elements.confirmation
  field.value = ''
  field.required = needsValue
  field.type = step === 'password' ? 'password' : 'text'
  field.inputMode = step === 'code' ? 'numeric' : 'text'
  field.autocomplete = step === 'password' ? 'off' : 'one-time-code'
  $('telegram-field').hidden = !needsValue
  $('telegram-label').textContent = step === 'password' ? 'Пароль двухэтапной защиты Telegram' : 'Код из Telegram'
  $('telegram-submit').textContent = needsValue ? 'Подтвердить' : 'Отправить код'
  $('telegram-restart').hidden = !needsValue
  telegramForm.hidden = !['ready', 'code', 'password'].includes(step)

  const instructions = {
    ready: 'Нажми «Отправить код». Telegram пришлёт код входа.',
    code: 'Открой сообщение от Telegram и введи код здесь.',
    password: 'Telegram запрашивает пароль двухэтапной защиты.',
    connected: 'Закрытый канал подключён. Можно загружать видео.',
    unconfigured: 'Ожидаем настройки канала.',
  }
  message(telegramMessage, instructions[step] || '')
  if (needsValue) field.focus()
}

async function telegramSetup(action) {
  if (telegramRequest) return
  const controller = new AbortController()
  telegramRequest = controller
  const value = telegramForm.elements.confirmation.value
  telegramForm.elements.confirmation.value = ''
  for (const field of telegramForm.elements) field.disabled = true
  message(telegramMessage, 'Связываемся с Telegram…')
  try {
    const response = await request('telegram-setup', action ? {
      method: 'POST', json: { action, value }, signal: controller.signal,
    } : { signal: controller.signal })
    const { step } = await response.json()
    if (controller.signal.aborted) return
    for (const field of telegramForm.elements) field.disabled = false
    renderTelegram(step)
  } catch (error) {
    showError(error, telegramMessage)
  } finally {
    telegramRequest = null
    for (const field of telegramForm.elements) field.disabled = false
  }
}

$('telegram-open').addEventListener('click', () => {
  telegramDialog.showModal()
  telegramForm.hidden = true
  void telegramSetup()
})
telegramForm.addEventListener('submit', (event) => {
  event.preventDefault()
  void telegramSetup(telegramStep === 'ready' ? 'start' : telegramStep)
})
$('telegram-restart').addEventListener('click', () => void telegramSetup('start'))
telegramDialog.addEventListener('close', () => {
  telegramRequest?.abort()
  telegramForm.reset()
})

ownerEntry.addEventListener('click', () => {
  message($('login-error'))
  ownerLogin.showModal()
})
loginForm.addEventListener('submit', login)
ownerLogin.addEventListener('close', () => {
  loginForm.elements.password.value = ''
})
uploadForm.addEventListener('submit', upload)
uploadForm.addEventListener('input', () => { if (!uploadRequest) uploadId = undefined })
signOutButton.addEventListener('click', () => {
  signOut()
  ownerEntry.focus()
})
function showUpload(original) {
  variantOriginal = original
  uploadKind = original ? 'video' : libraryKind
  uploadId = undefined
  uploadForm.reset()
  const isPhoto = uploadKind === 'photo'
  $('upload-title').textContent = original ? 'Добавить копию видео' : isPhoto ? 'Добавить фото' : 'Загрузить видео'
  $('upload-file-label').textContent = isPhoto ? 'Фотография' : 'Видеофайл'
  $('file-hint').textContent = isPhoto ? 'JPG, PNG, WebP, GIF или AVIF · до 25 МБ' : 'MP4 или WebM · до 2 ГБ'
  uploadForm.elements.video.accept = isPhoto ? 'image/*' : 'video/mp4,video/webm,.mp4,.webm'
  $('variant-field').hidden = !original
  message($('upload-status'))
  $('upload-dialog').showModal()
}

$('upload-open').addEventListener('click', () => showUpload())
$('cover-file').addEventListener('change', async (event) => {
  const field = event.currentTarget
  const file = field.files[0]
  const item = playerItem
  if (!file || !item) return
  try {
    const preview = await photoPreview(file)
    await putCover(item.id, preview.blob)
    if (playerItem === item) video.poster = assetURL(item.id, 'cover') + '&updated=' + Date.now()
    void loadLibrary()
  } catch (error) {
    showError(error, playerStatus)
  } finally {
    field.value = ''
  }
})
$('variant-upload').addEventListener('click', () => {
  if (!token || !playerItem) return
  const original = playerItem
  player.close()
  showUpload(original)
})
$('upload-dialog').addEventListener('cancel', (event) => {
  if (uploadRequest) event.preventDefault()
})
for (const button of document.querySelectorAll('[data-close]')) {
  button.addEventListener('click', () => {
    const dialog = button.closest('dialog')
    if (dialog.id !== 'upload-dialog' || !uploadRequest) dialog.close()
  })
}
const seek = $('video-seek')
const bigPlay = $('big-play')
const toggle = $('video-toggle')
const mute = $('video-mute')
let seeking = false

function formatTime(time) {
  const secs = Math.max(0, Math.floor(time || 0))
  const hours = Math.floor(secs / 3600)
  const mins = Math.floor(secs / 60) % 60
  const rest = String(secs % 60).padStart(2, '0')
  return hours ? `${hours}:${String(mins).padStart(2, '0')}:${rest}` : `${mins}:${rest}`
}

function updatePlayerControls() {
  const duration = Number.isFinite(video.duration) ? video.duration : 0
  if (!seeking) seek.value = duration ? Math.round(video.currentTime / duration * 1000) : 0
  seek.disabled = !duration
  $('video-time').textContent = `${formatTime(video.currentTime)} / ${formatTime(duration)}`
  bigPlay.hidden = !video.paused
  toggle.querySelector('use').setAttribute('href', video.paused ? '#icon-play' : '#icon-pause')
  toggle.setAttribute('aria-label', video.paused ? 'Воспроизвести' : 'Пауза')
  mute.querySelector('use').setAttribute('href', video.muted ? '#icon-muted' : '#icon-volume')
  mute.setAttribute('aria-label', video.muted ? 'Включить звук' : 'Выключить звук')
}

function togglePlayback() {
  if (video.paused) {
    playbackRequested = true
    if (activeSource) void video.play().catch(() => {})
  } else {
    playbackRequested = false
    video.pause()
  }
}

for (const control of [toggle, bigPlay, video]) control.addEventListener('click', togglePlayback)
mute.addEventListener('click', () => { video.muted = !video.muted })
seek.addEventListener('input', () => {
  if (!Number.isFinite(video.duration)) return
  seeking = true
  $('video-time').textContent = `${formatTime(video.duration * Number(seek.value) / 1000)} / ${formatTime(video.duration)}`
})
seek.addEventListener('change', () => {
  if (Number.isFinite(video.duration)) video.currentTime = video.duration * Number(seek.value) / 1000
  seeking = false
})
$('video-fullscreen').addEventListener('click', () => {
  if (document.fullscreenElement) void document.exitFullscreen()
  else if ($('player-shell').requestFullscreen) void $('player-shell').requestFullscreen().catch(() => video.webkitEnterFullscreen?.())
  else video.webkitEnterFullscreen?.()
})
for (const event of ['play', 'pause', 'ended', 'volumechange', 'loadedmetadata', 'timeupdate', 'emptied']) {
  video.addEventListener(event, updatePlayerControls)
}
player.addEventListener('keydown', (event) => {
  if (event.target.matches('input, button, select, a, textarea')) return
  if (event.code === 'Space') {
    event.preventDefault()
    togglePlayback()
  }
})

player.addEventListener('close', () => {
  playerRequest?.abort()
  playerItem = undefined
  activeSource = undefined
  resumePlayback = undefined
  playbackRequested = false
  if (document.fullscreenElement === $('player-shell')) void document.exitFullscreen()
  seeking = false
  video.pause()
  video.removeAttribute('src')
  video.removeAttribute('poster')
  video.load()
  video.hidden = true
})
video.addEventListener('loadedmetadata', () => {
  if (resumePlayback && Number.isFinite(video.duration)) {
    video.currentTime = Math.min(resumePlayback, video.duration)
  }
  resumePlayback = undefined
  video.playbackRate = Number(speed.value)
  if (playbackRequested) void video.play().catch(() => {})
  message(playerStatus)
})
video.addEventListener('pause', () => {
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA && resumePlayback === undefined) playbackRequested = false
})
video.addEventListener('playing', () => { playbackRequested = true; message(playerStatus) })
video.addEventListener('waiting', () => {
  if (activeSource) message(playerStatus, 'Буферизация…')
})
video.addEventListener('error', () => {
  if (video.hasAttribute('src')) message($('player-status'), 'Не удалось воспроизвести видео. Проверь подключение и формат файла.', true)
})
uploadForm.elements.video.addEventListener('change', () => {
  const file = uploadForm.elements.video.files[0]
  if (file && !uploadForm.elements.title.value.trim()) {
    uploadForm.elements.title.value = file.name.replace(/\.[^.]+$/, '').slice(0, 120)
  }
})
$('search').addEventListener('input', () => {
  clearTimeout(searchTimer)
  libraryRequest?.abort()
  searchTimer = setTimeout(() => void loadLibrary(), 180)
})
$('more').addEventListener('click', () => void loadLibrary(true))
window.addEventListener('pagehide', (event) => { if (token && !event.persisted) signOut() })
if (config.url && config.publishableKey) {
  ownerEntry.hidden = window.top !== window.self
  updateView()
  updatePlayerControls()
  void loadLibrary()
} else {
  message($('library-status'), 'Видеотека готовится к подключению.')
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !document.querySelector('dialog[open]')) void loadLibrary()
})
