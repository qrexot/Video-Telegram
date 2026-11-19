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
const smallVideoLimit = 20 * mebibyte
const videoLimit = 2_000_000_000
const batchSize = 4 * mebibyte
let token = ''
let libraryRequest
let uploadId
let uploadRequest
let searchTimer
let offset = 0

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
  if (action === 'session' || action.startsWith('upload') || action === 'telegram-setup') headers.Authorization = `Bearer ${token}`
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
  $('telegram-open').hidden = !signedIn
  updateEmptyDetail()
}

function updateEmptyDetail() {
  emptyDetail.textContent = $('search').value.trim() ? 'Попробуйте другой запрос.' :
    uploadButton.hidden ? 'Здесь появятся загруженные видео.' : 'Нажмите «Загрузить», чтобы добавить первое видео.'
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

function renderCard(item) {
  const card = document.createElement('button')
  card.type = 'button'
  card.className = 'card'
  const cover = document.createElement('span')
  cover.className = 'cover'
  const icon = document.createElementNS(svgNamespace, 'svg')
  icon.setAttribute('aria-hidden', 'true')
  const use = document.createElementNS(svgNamespace, 'use')
  use.setAttribute('href', '#icon-video')
  icon.append(use)
  cover.append(icon)
  const detail = document.createElement('span')
  detail.className = 'card-detail'
  const title = document.createElement('strong')
  title.textContent = item.title
  const metadata = document.createElement('span')
  metadata.textContent = `${date.format(new Date(item.created_at))} · ${size.format(item.size_bytes / 1048576)} МБ`
  detail.append(title, metadata)
  card.append(cover, detail)
  card.addEventListener('click', () => void openPlayer(item))
  return card
}

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
    const response = await request('list', { params: { search, offset }, signal: controller.signal })
    const { items, total } = await response.json()
    if (controller.signal.aborted) return
    $('cards').append(...items.map(renderCard))
    offset += items.length
    $('count').textContent = search ? `Найдено видео: ${total}` : `Всего видео: ${total}`
    $('more').hidden = offset >= total || items.length < pageSize
    $('empty').hidden = total !== 0
    $('empty-title').textContent = search ? 'Видео не найдено' : 'Видеотека пока пуста'
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
  const params = new URLSearchParams({ action: 'play', id, v: '6' })
  video.src = `${config.url}/functions/v1/video?${params}`
  video.playbackRate = Number(speed.value)
  if (playbackRequested && !time) void video.play().catch(() => {})
}

async function openPlayer(item) {
  const controller = new AbortController()
  playerRequest = controller
  $('player-title').textContent = item.title
  $('player-description').textContent = item.description
  message(playerStatus, 'Подключаем видео…')
  const automatic = new Option('Авто', '')
  quality.replaceChildren(automatic, new Option('Оригинал', item.id))
  quality.value = ''
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
  if (file.size > videoLimit) {
    message($('upload-status'), `Размер файла ${size.format(file.size / 1_000_000_000)} ГБ. Лимит 2 ГБ.`, true)
    return
  }

  const controller = new AbortController()
  uploadRequest = controller
  for (const field of uploadForm.elements) field.disabled = true
  const progress = $('upload-progress')
  progress.hidden = false
  progress.removeAttribute('value')
  message($('upload-status'), 'Отправляем видео в Telegram…')
  try {
    const signal = controller.signal
    uploadId ??= crypto.randomUUID()
    if (file.size <= smallVideoLimit) {
      const body = new FormData()
      body.set('video', file)
      body.set('title', title)
      body.set('description', description)
      await request('upload', { method: 'POST', params: { id: uploadId }, body, signal })
    } else {
      const params = { id: uploadId, size: file.size }
      progress.max = file.size
      progress.value = 0
      for (let sent = 0; sent < file.size; sent += batchSize) {
        const chunk = file.slice(sent, sent + batchSize)
        for (let attempt = 1; ; attempt++) {
          try {
            await request('upload-part', { method: 'POST', params: { ...params, offset: sent }, body: chunk, signal })
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
      message($('upload-status'), 'Публикуем видео…')
      await request('upload-finish', { method: 'POST', params, json: { title, description }, signal })
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
$('upload-open').addEventListener('click', () => {
  message($('upload-status'))
  $('upload-dialog').showModal()
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
player.addEventListener('close', () => {
  playerRequest?.abort()
  activeSource = undefined
  resumePlayback = undefined
  playbackRequested = false
  video.pause()
  video.removeAttribute('src')
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
  void loadLibrary()
} else {
  message($('library-status'), 'Видеотека готовится к подключению.')
}
