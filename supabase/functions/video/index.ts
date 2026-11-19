import { createClient } from "npm:@supabase/supabase-js@2.97.0"
import { Api, TelegramClient } from "npm:telegram@2.26.22"
import { StringSession } from "npm:telegram@2.26.22/sessions/index.js"
import { CustomFile } from "npm:telegram@2.26.22/client/uploads.js"
import { Logger, LogLevel } from "npm:telegram@2.26.22/extensions/Logger.js"
import type { PromisedWebSockets } from "npm:telegram@2.26.22/extensions/PromisedWebSockets.js"
import { computeCheck } from "npm:telegram@2.26.22/Password.js"
import { ConnectionTCPObfuscated } from "npm:telegram@2.26.22/network/connection/index.js"
import bigInt from "npm:big-integer@1.6.52"
import { Buffer } from "node:buffer"

const origin = Deno.env.get("VIDEO_ORIGIN") || "https://qrexot.github.io"
const maxVideo = 20 * 1024 * 1024
const maxLargeVideo = 2_000_000_000
const telegramPartSize = 512 * 1024
const uploadBatch = 8 * telegramPartSize
const pageSize = 24
const playbackRange = 4 * 1024 * 1024
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const serverKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
const db = createClient(Deno.env.get("SUPABASE_URL")!, serverKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})
const headers = {
  "Access-Control-Allow-Origin": origin,
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, range",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Vary": "Origin",
}

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers })
}

class HttpError extends Error {
  constructor(public status: number, message = "") { super(message) }
}

type TelegramConnection = { client: TelegramClient; channel: Api.InputPeerChannel }
class WebTelegramClient extends TelegramClient {
  override getDC(dcId: number, downloadDC = false) {
    return super.getDC(dcId, downloadDC, true)
  }
}

// Use the runtime WebSocket so Telegram connects over TLS without raw TCP.
class TelegramSocket {
  private socket?: WebSocket
  private chunks: Buffer[] = []
  private pending?: () => void

  async connect(port: number, host: string, testServers = false) {
    const socket = new WebSocket(`wss://${host}:${port}/apiws${testServers ? "_test" : ""}`, "binary")
    socket.binaryType = "arraybuffer"
    this.socket = socket
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { socket.close(); reject(new Error("Telegram connection timed out")) }, 10000)
      socket.onopen = () => { clearTimeout(timeout); resolve() }
      socket.onerror = () => { clearTimeout(timeout); reject(new Error("Telegram connection failed")) }
      socket.onclose = () => {
        clearTimeout(timeout)
        this.pending?.()
        reject(new Error("Telegram connection closed"))
      }
      socket.onmessage = (event) => {
        this.chunks.push(Buffer.from(event.data as ArrayBuffer))
        this.pending?.()
      }
    })
    return this
  }

  async read(number: number) {
    while (!this.chunks.length) {
      if (this.socket?.readyState !== WebSocket.OPEN) throw new Error("Telegram connection closed")
      await new Promise<void>((resolve) => { this.pending = resolve })
      this.pending = undefined
    }
    const chunk = this.chunks[0]
    if (chunk.length <= number) return this.chunks.shift()!
    this.chunks[0] = chunk.subarray(number)
    return chunk.subarray(0, number)
  }

  async readExactly(number: number) {
    const chunks: Buffer[] = []
    while (number > 0) {
      const chunk = await this.read(number)
      chunks.push(chunk)
      number -= chunk.length
    }
    return Buffer.concat(chunks)
  }

  async readAll() {
    const head = await this.read(Number.MAX_SAFE_INTEGER)
    return Buffer.concat([head, ...this.chunks.splice(0)])
  }

  write(data: Buffer) {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error("Telegram connection closed")
    this.socket.send(new Uint8Array(data))
  }

  async close() {
    this.socket?.close()
    this.pending?.()
  }
}

type TelegramState = {
  apiId: number
  apiHash: string
  phone: string
  channelId: string
  session?: string
  channelHash?: string
  codeHash?: string
  step?: "code" | "password"
  expires?: number
  retryAfter?: number
  busyUntil?: number
}

const setupTable = "video_telegram_setup"
const stateKey = crypto.subtle.digest("SHA-256", new TextEncoder().encode(`video-telegram-setup/v1:${serverKey}`))
  .then((hash) => crypto.subtle.importKey("raw", hash, "AES-GCM", false, ["encrypt", "decrypt"]))

async function encryptState(userId: string, state: TelegramState) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = new TextEncoder().encode(JSON.stringify(state))
  const extra = new TextEncoder().encode(userId)
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: extra }, await stateKey, data)
  return Buffer.concat([iv, new Uint8Array(sealed)]).toString("base64")
}

async function decryptState(userId: string, encoded: string): Promise<TelegramState> {
  const bytes = new Uint8Array(Buffer.from(encoded, "base64"))
  const extra = new TextEncoder().encode(userId)
  const plaintext = await crypto.subtle.decrypt({
    name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: extra,
  }, await stateKey, bytes.slice(12))
  return JSON.parse(new TextDecoder().decode(plaintext))
}

function clientFor(state: TelegramState) {
  const session = new StringSession(state.session || "")
  if (!state.session) session.setDC(4, "vesta.web.telegram.org", 443)
  const client = new WebTelegramClient(session, state.apiId, state.apiHash, {
    connection: ConnectionTCPObfuscated,
    networkSocket: TelegramSocket as unknown as typeof PromisedWebSockets,
    connectionRetries: 1, requestRetries: 2, useWSS: true, autoReconnect: false,
    floodSleepThreshold: 0, baseLogger: new Logger(LogLevel.NONE), deviceModel: "Video Telegram",
  })
  return { client, session }
}

let telegramPromise: Promise<TelegramConnection> | undefined

async function storageState(): Promise<TelegramState> {
  const apiId = Number(Deno.env.get("TELEGRAM_API_ID"))
  const apiHash = Deno.env.get("TELEGRAM_API_HASH")
  const session = Deno.env.get("TELEGRAM_SESSION")
  const channelId = Deno.env.get("TELEGRAM_CHANNEL_ID")
  const channelHash = Deno.env.get("TELEGRAM_CHANNEL_HASH")
  if (apiId && apiHash && session && channelId && channelHash) {
    return { apiId, apiHash, session, channelId, channelHash, phone: "" }
  }
  const { data, error } = await db.from(setupTable).select("user_id,encrypted_state")
    .order("user_id").limit(12)
  if (error) throw error
  for (const row of data) {
    const state = await decryptState(row.user_id, row.encrypted_state)
    if (state.session && state.channelHash) return state
  }
  throw new HttpError(503)
}

function connectTelegram() {
  if (!telegramPromise) {
    telegramPromise = (async () => {
      const state = await storageState()
      const { client, session } = clientFor(state)
      try {
        const dc = await client.getDC(session.dcId)
        session.setDC(dc.id, dc.ipAddress, dc.port)
        await client.connect()
        if (!(await client.checkAuthorization())) throw new Error("Telegram session expired")
        const channel = new Api.InputPeerChannel({
          channelId: bigInt(state.channelId), accessHash: bigInt(state.channelHash!),
        })
        return { client, channel }
      } catch {
        await client.destroy().catch(() => {})
        throw new HttpError(503)
      }
    })().catch((error) => {
      telegramPromise = undefined
      throw error
    })
  }
  return telegramPromise
}

function setupStatus(state?: TelegramState) {
  const step = state?.channelHash ? "connected" :
    (state?.expires ?? 0) > Date.now() ? state?.step : undefined
  return json({ step: step ?? (state ? "ready" : "unconfigured") })
}

async function setupTelegram(request: Request, ownerId: string) {
  const { data: row, error } = await db.from(setupTable).select("revision,encrypted_state")
    .eq("user_id", ownerId).maybeSingle()
  if (error) throw error
  if (request.method === "GET") return setupStatus(row ? await decryptState(ownerId, row.encrypted_state) : undefined)

  const input = await request.json().catch(() => null)
  if (!input || typeof input !== "object") throw new HttpError(400)
  if (input?.action === "configure") {
    if (row) throw new HttpError(409)
    const { apiId, apiHash, phone, channelId } = input
    if (!Number.isSafeInteger(apiId) || apiId < 1 || apiId > 2147483647 ||
        typeof apiHash !== "string" || !/^[a-f0-9]{32}$/i.test(apiHash) ||
        typeof phone !== "string" || !/^\+\d{7,15}$/.test(phone) ||
        typeof channelId !== "string" || !/^\d{1,15}$/.test(channelId)) throw new HttpError(400)
    const state = { apiId, apiHash, phone, channelId }
    const saved = await db.from(setupTable).insert({ user_id: ownerId, encrypted_state: await encryptState(ownerId, state) })
    if (saved.error) throw saved.error
    return setupStatus(state)
  }
  if (!row) throw new HttpError(400, "Сначала укажите данные Telegram.")
  const state = await decryptState(ownerId, row.encrypted_state)
  if (state.channelHash) return setupStatus(state)

  const now = Date.now()
  const start = input?.action === "start"
  if (!start && !["code", "password"].includes(input?.action)) throw new HttpError(400)
  if ((state.busyUntil ?? 0) > now) throw new HttpError(409, "Telegram уже обрабатывает запрос.")
  if (start && (state.retryAfter ?? 0) > now) throw new HttpError(429)
  if (!start && ((state.expires ?? 0) <= now || state.step !== input.action || !state.session)) {
    throw new HttpError(400, "Срок действия входа истёк. Запросите новый код.")
  }
  if (input.action === "code" && (typeof input.value !== "string" || !/^\d{4,8}$/.test(input.value))) {
    throw new HttpError(400, "Введите код из Telegram.")
  }
  if (input.action === "password" && (typeof input.value !== "string" || !input.value || input.value.length > 512)) {
    throw new HttpError(400, "Введите пароль Telegram.")
  }
  const revision = row.revision + 1
  const reserved = await db.from(setupTable).update({
    revision, encrypted_state: await encryptState(ownerId, { ...state, busyUntil: now + 90000, retryAfter: start ? now + 60000 : state.retryAfter }),
  }).eq("user_id", ownerId).eq("revision", row.revision).select("revision").maybeSingle()
  if (reserved.error) throw reserved.error
  if (!reserved.data) throw new HttpError(409)
  const save = async (next: TelegramState) => {
    const saved = await db.from(setupTable).update({ encrypted_state: await encryptState(ownerId, { ...next, busyUntil: undefined }) })
      .eq("user_id", ownerId).eq("revision", revision).select("revision").maybeSingle()
    if (saved.error) throw saved.error
    if (!saved.data) throw new HttpError(409)
    return setupStatus(next)
  }
  const { client, session } = clientFor(state)
  try {
    await client.connect()
    if (start) {
      const { phoneCodeHash } = await client.sendCode({ apiId: state.apiId, apiHash: state.apiHash }, state.phone)
      return await save({
        ...state, session: session.save(), step: "code", codeHash: phoneCodeHash,
        expires: now + 5 * 60000, retryAfter: now + 60000,
      })
    }
    if (input.action === "code") {
      try {
        await client.invoke(new Api.auth.SignIn({ phoneNumber: state.phone, phoneCodeHash: state.codeHash!, phoneCode: input.value }))
      } catch (error) {
        if ((error as { errorMessage?: string }).errorMessage !== "SESSION_PASSWORD_NEEDED") throw error
        return await save({ ...state, session: session.save(), step: "password", codeHash: undefined })
      }
    } else {
      const challenge = await client.invoke(new Api.account.GetPassword())
      await client.invoke(new Api.auth.CheckPassword({ password: await computeCheck(challenge, input.value) }))
    }

    for await (const dialog of client.iterDialogs({})) {
      const channel = dialog.entity
      if (channel instanceof Api.Channel && channel.id.toString() === state.channelId &&
          channel.broadcast && (channel.creator || channel.adminRights?.postMessages) &&
          !channel.username && !channel.usernames?.some((username) => username.active) && channel.accessHash) {
        return await save({
          apiId: state.apiId, apiHash: state.apiHash, phone: state.phone, channelId: state.channelId,
          session: session.save(), channelHash: channel.accessHash.toString(),
        })
      }
    }
    await client.invoke(new Api.auth.LogOut()).catch(() => {})
    throw new HttpError(400, "Этот аккаунт не может публиковать видео в указанном закрытом канале.")
  } catch (error) {
    await save({ ...state, retryAfter: start ? now + 60000 : state.retryAfter }).catch(() => {})
    if (error instanceof HttpError) throw error
    const code = (error as { errorMessage?: string }).errorMessage
    if (code === "PHONE_CODE_INVALID") throw new HttpError(400, "Неверный код из Telegram.")
    if (code === "PHONE_CODE_EXPIRED") throw new HttpError(400, "Код истёк. Запросите новый.")
    if (code === "PASSWORD_HASH_INVALID") throw new HttpError(400, "Неверный пароль Telegram.")
    if (code?.includes("FLOOD")) throw new HttpError(429, "Telegram ограничил число попыток. Попробуйте позже.")
    console.error("Telegram setup failed", code ?? (error instanceof Error ? error.name : "unknown"))
    throw new HttpError(502, "Telegram не завершил вход. Попробуйте ещё раз.")
  } finally {
    await client.destroy().catch(() => {})
  }
}

async function requireOwner(request: Request) {
  const token = request.headers.get("Authorization")?.match(/^Bearer (\S+)$/i)?.[1]
  if (!token || token.length > 8192) throw new HttpError(401)
  const { data: { user }, error } = await db.auth.getUser(token)
  if (error || !user || user.is_anonymous || !user.email_confirmed_at) throw new HttpError(401)

  const member = await db.from("video_members").select("role").eq("user_id", user.id).maybeSingle()
  if (member.error) throw member.error
  if (member.data?.role !== "owner") throw new HttpError(403)
  return user.id
}

const mediaBucket = "video-library-media"
const mediaStorage = db.storage.from(mediaBucket)

function validId(id: string | null): string {
  if (!id || !uuid.test(id)) throw new HttpError(400)
  return id
}

async function listMedia(params: URLSearchParams, action: string) {
  const photos = action === "photos"
  const view = params.get("view") || "public"
  const offset = Number(params.get("offset") || 0)
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) throw new HttpError(400)
  if (!["public", "hidden", "trash"].includes(view)) throw new HttpError(400)
  const search = (params.get("search") || "").trim().slice(0, 120)
  const fields = "id,title,description,created_at,size_bytes,hidden,deleted_at"
  let query = db.from(photos ? "photos" : "videos").select(
    fields + (photos ? ",width,height" : ",has_cover"), { count: "exact" },
  )
  if (!photos) query = query.not("telegram_message_id", "is", null).is("original_id", null)
  if (view === "trash") query = query.not("deleted_at", "is", null)
  else query = query.is("deleted_at", null).eq("hidden", view === "hidden")
  if (search) query = query.ilike("title", "%" + search.replace(/[\\%_*]/g, "\\$&") + "%")
  const result = await query.order("created_at", { ascending: false }).order("id", { ascending: false })
    .range(offset, offset + pageSize - 1)
  if (result.error) throw result.error
  return json({ items: result.data, total: result.count || 0 })
}

async function publishedVideo(id: string) {
  const { data, error } = await db.from("videos")
    .select("id,original_id,telegram_message_id,mime_type,size_bytes,has_cover,hidden,deleted_at")
    .eq("id", id).not("telegram_message_id", "is", null).maybeSingle()
  if (error) throw error
  if (!data || data.hidden || data.deleted_at) throw new HttpError(404)
  if (data.original_id) {
    const root = await db.from("videos").select("id").eq("id", data.original_id)
      .eq("hidden", false).is("deleted_at", null).maybeSingle()
    if (root.error) throw root.error
    if (!root.data) throw new HttpError(404)
  }
  return data
}

async function manageMedia(request: Request, id: string) {
  const input = await request.json().catch(() => null)
  if (!input || !["video", "photo"].includes(input.kind)) throw new HttpError(400)
  const table = input.kind === "photo" ? "photos" : "videos"
  const changes: Record<string, Record<string, unknown>> = {
    hide: { hidden: true }, show: { hidden: false },
    delete: { deleted_at: new Date().toISOString() }, restore: { deleted_at: null },
  }
  if (typeof input.operation !== "string" || !Object.hasOwn(changes, input.operation)) throw new HttpError(400)
  let query = db.from(table).update(changes[input.operation]).eq("id", id)
  if (table === "videos") query = query.is("original_id", null).not("telegram_message_id", "is", null)
  const { data, error } = await query.select("id").maybeSingle()
  if (error) throw error
  if (!data) throw new HttpError(404)
  return json({ id })
}

const photoTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif", "image/heic", "image/heif"])

async function storePhoto(request: Request, id: string) {
  const form = await readUpload(request, 27 * 1024 * 1024)
  const photo = form.get("photo")
  const preview = form.get("preview")
  const rawTitle = form.get("title")
  const title = typeof rawTitle === "string" ? rawTitle.trim() : ""
  const description = String(form.get("description") ?? "").trim()
  const width = Number(form.get("width"))
  const height = Number(form.get("height"))
  if (!(photo instanceof File) || !photoTypes.has(photo.type) || !photo.size ||
      !(preview instanceof File) || preview.type !== "image/jpeg" || !preview.size || preview.size > 1024 * 1024 ||
      !title || title.length > 120 || description.length > 1200 ||
      !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 100000 || height > 100000) {
    throw new HttpError(400, "Проверь фото и его описание.")
  }
  if (photo.size > 25 * 1024 * 1024) throw new HttpError(413)
  const existing = await db.from("photos").select("id").eq("id", id).maybeSingle()
  if (existing.error) throw existing.error
  if (existing.data) return json({ id })
  const original = `photos/${id}/original`
  const thumb = `photos/${id}/preview.jpg`
  for (const [key, file] of [[original, photo], [thumb, preview]] as const) {
    const result = await mediaStorage.upload(key, file, { contentType: file.type, upsert: true })
    if (result.error) throw result.error
  }
  const row = await db.from("photos").insert({
    id, title, description, filename: photo.name.slice(0, 240), mime_type: photo.type,
    size_bytes: photo.size, width, height,
  })
  if (row.error && row.error.code !== "23505") throw row.error
  return json({ id }, 201)
}

async function storeCover(request: Request, id: string) {
  const row = await db.from("videos").select("id").eq("id", id)
    .is("original_id", null).is("deleted_at", null).not("telegram_message_id", "is", null).maybeSingle()
  if (row.error) throw row.error
  if (!row.data) throw new HttpError(404)
  const form = await readUpload(request, 1024 * 1024 + 32768)
  const cover = form.get("cover")
  if (!(cover instanceof File) || cover.type !== "image/jpeg" || !cover.size || cover.size > 1024 * 1024) throw new HttpError(400)
  const result = await mediaStorage.upload(`covers/${id}.jpg`, cover, { contentType: "image/jpeg", upsert: true })
  if (result.error) throw result.error
  const saved = await db.from("videos").update({ has_cover: true }).eq("id", id)
  if (saved.error) throw saved.error
  return json({ id })
}

async function mediaAsset(params: URLSearchParams) {
  const id = validId(params.get("id"))
  const type = params.get("type")
  let key: string
  let fileName: string | undefined
  let mime = "image/jpeg"
  if (type === "cover") {
    const video = await publishedVideo(id)
    if (!video.has_cover) throw new HttpError(404)
    key = `covers/${id}.jpg`
  } else if (type === "preview" || type === "original") {
    const photo = await db.from("photos").select("filename,mime_type").eq("id", id)
      .eq("hidden", false).is("deleted_at", null).maybeSingle()
    if (photo.error) throw photo.error
    if (!photo.data) throw new HttpError(404)
    key = `photos/${id}/${type === "original" ? "original" : "preview.jpg"}`
    if (type === "original") {
      fileName = photo.data.filename
      mime = photo.data.mime_type
    }
  } else throw new HttpError(400)
  const object = await fetch(`${Deno.env.get("SUPABASE_URL")}/storage/v1/object/authenticated/${mediaBucket}/${key}`, {
    headers: { Authorization: `Bearer ${serverKey}`, apikey: serverKey },
  })
  if (!object.ok || !object.body) throw new HttpError(object.status === 404 ? 404 : 502)
  const result = new Headers({ ...headers, "Content-Type": mime })
  if (fileName) result.set("Content-Disposition", `attachment; filename="photo"; filename*=UTF-8''${encodeURIComponent(fileName.toWellFormed()).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16))}`)
  return new Response(object.body, { headers: result })
}

async function readUpload(request: Request, maxBody = maxVideo + 32 * 1024) {
  const length = Number(request.headers.get("content-length"))
  const type = request.headers.get("content-type") || ""
  if (!type.toLowerCase().startsWith("multipart/form-data;")) throw new HttpError(415)
  if (length > maxBody) throw new HttpError(413)
  if (!request.body) throw new HttpError(400)
  const reader = request.body.getReader()
  const chunks: Uint8Array<ArrayBuffer>[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBody) {
        await reader.cancel()
        throw new HttpError(413)
      }
      chunks.push(new Uint8Array(value))
    }
  } finally {
    reader.releaseLock()
  }
  try {
    return await new Response(new Blob(chunks), { headers: { "content-type": type } }).formData()
  } catch {
    throw new HttpError(400)
  }
}

function videoMime(bytes: Buffer) {
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp") return "video/mp4"
  if (bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) &&
      bytes.subarray(4, 128).includes(Buffer.from("webm"))) return "video/webm"
  throw new HttpError(415)
}

async function variantFields(params: URLSearchParams) {
  const original = params.get("original")
  const height = Number(params.get("height"))
  if (original === null && !params.has("height")) return {}
  if (!original || !uuid.test(original) || ![360, 480, 720, 1080, 2160].includes(height) || original === params.get("id")) throw new HttpError(400)
  const item = await db.from("videos").select("id").eq("id", original)
    .is("original_id", null).not("telegram_message_id", "is", null).maybeSingle()
  if (item.error) throw item.error
  if (!item.data) throw new HttpError(404)
  return { original_id: original, quality_height: height }
}

async function listQualities(id: string | null) {
  if (!id || !uuid.test(id)) throw new HttpError(400)
  await publishedVideo(id)
  const result = await db.from("videos").select("id,quality_height")
    .eq("original_id", id).not("telegram_message_id", "is", null).eq("hidden", false).is("deleted_at", null).order("quality_height")
  if (result.error) throw result.error
  return json({ items: result.data })
}

async function uploadVideo(request: Request, userId: string, params: URLSearchParams) {
  const id = params.get("id")
  if (!id || !uuid.test(id)) throw new HttpError(400)
  const form = await readUpload(request)
  const rawTitle = form.get("title")
  const rawDescription = form.get("description")
  const file = form.get("video")
  const title = typeof rawTitle === "string" ? rawTitle.trim() : ""
  const description = typeof rawDescription === "string" ? rawDescription.trim() : ""
  if (!title || title.length > 120 || description.length > 1200 || !(file instanceof File) || !file.size) {
    throw new HttpError(400, "Проверьте название и видеофайл.")
  }
  if (file.size > maxVideo) throw new HttpError(413)
  const content = Buffer.from(await file.arrayBuffer())
  const mime = videoMime(content)
  const { client, channel } = await connectTelegram()
  const row = await db.from("videos").insert({
    id, uploader_id: userId, title, description, mime_type: mime, size_bytes: file.size, ...await variantFields(params),
  })
  if (row.error?.code === "23505") {
    const prior = await db.from("videos").select("telegram_message_id").eq("id", id)
      .eq("uploader_id", userId).maybeSingle()
    if (prior.error) throw prior.error
    if (prior.data?.telegram_message_id) return json({ id })
    throw new HttpError(409)
  }
  if (row.error) throw row.error

  let fileHandle
  try {
    const filename = mime === "video/mp4" ? "video.mp4" : "video.webm"
    fileHandle = await client.uploadFile({ file: new CustomFile(filename, content.length, "", content), workers: 2 })
  } catch {
    await db.from("videos").delete().eq("id", id).is("telegram_message_id", null)
    throw new HttpError(502, "Telegram не принял файл. Попробуйте снова.")
  }

  return await finishUpload(client, channel, id, mime, fileHandle)
}

async function finishUpload(client: TelegramClient, channel: Api.InputPeerChannel, id: string, mime: string, fileHandle: Api.TypeInputFile) {
  // Use a stable MTProto random_id for retries within this request.
  const randomId = bigInt(id.replaceAll("-", "").slice(0, 15), 16)
  const result = await client.invoke(new Api.messages.SendMedia({
    peer: channel,
    media: new Api.InputMediaUploadedDocument({
      file: fileHandle, mimeType: mime, forceFile: true,
      attributes: [new Api.DocumentAttributeFilename({ fileName: mime === "video/mp4" ? "video.mp4" : "video.webm" })],
    }),
    message: id,
    randomId,
  })).catch(() => { throw new HttpError(502, "Telegram не подтвердил отправку видео.") })
  const updates = "updates" in result ? result.updates : []
  const sentId = result instanceof Api.UpdateShortSentMessage ? result.id :
    updates.find((update): update is Api.UpdateMessageID =>
      update instanceof Api.UpdateMessageID && update.randomId?.equals(randomId) === true)?.id ??
    updates.find((update): update is Api.UpdateNewChannelMessage =>
      update instanceof Api.UpdateNewChannelMessage && update.message instanceof Api.Message &&
      update.message.message === id)?.message.id
  if (!sentId) throw new HttpError(502, "Telegram не подтвердил публикацию видео.")
  const saved = await db.from("videos").update({ telegram_message_id: sentId }).eq("id", id)
    .is("telegram_message_id", null).select("id").single()
  if (saved.error) throw saved.error
  return json({ id }, 201)
}

function largeVideoParams(params: URLSearchParams) {
  const id = params.get("id")
  const size = Number(params.get("size"))
  if (!id || !uuid.test(id) || !Number.isSafeInteger(size) || size <= maxVideo) throw new HttpError(400)
  if (size > maxLargeVideo) throw new HttpError(413)
  return { id, size, parts: Math.ceil(size / telegramPartSize), fileId: bigInt(id.replaceAll("-", "").slice(0, 15), 16) }
}

async function uploadVideoPart(request: Request, params: URLSearchParams, ownerId: string) {
  const { id, size, parts, fileId } = largeVideoParams(params)
  const offset = Number(params.get("offset"))
  if (!params.has("offset") || !Number.isSafeInteger(offset) || offset < 0 || offset >= size || offset % uploadBatch) throw new HttpError(400)
  const expected = Math.min(size - offset, uploadBatch)
  const chunks: Uint8Array<ArrayBuffer>[] = []
  let received = 0
  if (!request.body) throw new HttpError(400)
  for await (const chunk of request.body) {
    received += chunk.length
    if (received > expected) throw new HttpError(413)
    chunks.push(new Uint8Array(chunk))
  }
  if (received !== expected) throw new HttpError(400)
  const bytes = Buffer.concat(chunks)
  const { client } = await connectTelegram()
  if (offset === 0) {
    const mime = videoMime(bytes)
    const { data, error } = await db.from("videos").select("id").eq("id", id).maybeSingle()
    if (error) throw error
    if (!data) {
      const { error } = await db.from("videos").insert({
        id, uploader_id: ownerId, title: "Видео", description: "", mime_type: mime, size_bytes: size, ...await variantFields(params),
      })
      if (error && error.code !== "23505") throw error
    }
  }
  const pending = await db.from("videos").select("size_bytes,telegram_message_id").eq("id", id)
    .eq("uploader_id", ownerId).maybeSingle()
  if (pending.error) throw pending.error
  if (!pending.data || pending.data.size_bytes !== size) throw new HttpError(409)
  if (pending.data.telegram_message_id) return json({ id })
  for (let index = 0; index < received; index += telegramPartSize) {
    const stored = await client.invoke(new Api.upload.SaveBigFilePart({
      fileId, filePart: (offset + index) / telegramPartSize, fileTotalParts: parts,
      bytes: bytes.subarray(index, index + telegramPartSize),
    }))
    if (!stored) throw new HttpError(502, "Telegram не сохранил часть видео. Повтори загрузку.")
  }
  return json({ received })
}

async function publishLargeVideo(request: Request, params: URLSearchParams, ownerId: string) {
  const { id, size, parts, fileId } = largeVideoParams(params)
  const metadata = await request.json().catch(() => null)
  const title = typeof metadata?.title === "string" ? metadata.title.trim() : ""
  const description = typeof metadata?.description === "string" ? metadata.description.trim() : ""
  if (!title || title.length > 120 || description.length > 1200) throw new HttpError(400)
  const item = await db.from("videos").select("size_bytes,mime_type,telegram_message_id").eq("id", id)
    .eq("uploader_id", ownerId).maybeSingle()
  if (item.error) throw item.error
  if (!item.data || item.data.size_bytes !== size) throw new HttpError(409)
  if (item.data.telegram_message_id) return json({ id })
  const updated = await db.from("videos").update({ title, description }).eq("id", id).is("telegram_message_id", null)
  if (updated.error) throw updated.error
  const { client, channel } = await connectTelegram()
  const mime = item.data.mime_type
  const file = new Api.InputFileBig({ id: fileId, parts, name: mime === "video/mp4" ? "video.mp4" : "video.webm" })
  return await finishUpload(client, channel, id, mime, file)
}

async function playVideo(request: Request, id: string | null) {
  const data = await publishedVideo(validId(id))
  const { client, channel } = await connectTelegram()
  const [post] = await client.getMessages(channel, { ids: [data.telegram_message_id] })
  if (!(post?.media instanceof Api.MessageMediaDocument) || !(post.media.document instanceof Api.Document)) {
    throw new HttpError(404, "Файл отсутствует в Telegram.")
  }
  if (post.media.document.size.toJSNumber() !== data.size_bytes) throw new HttpError(502)
  const doc = post.media.document
  const size = data.size_bytes
  const range = request.headers.get("Range")
  let start = 0
  let end = size - 1
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range)
    if (!match || (!match[1] && !match[2])) {
      return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } })
    }
    if (match[1]) {
      start = Number(match[1])
      if (match[2]) end = Math.min(end, Number(match[2]))
    } else {
      start = Math.max(0, size - Number(match[2]))
    }
    if (!Number.isSafeInteger(start) || start >= size || end < start) {
      return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } })
    }
    // Keep each range response short enough for an Edge Function invocation.
    end = Math.min(end, start + playbackRange - 1)
  }
  const location = new Api.InputDocumentFileLocation({
    id: doc.id, accessHash: doc.accessHash, fileReference: doc.fileReference, thumbSize: "",
  })
  let sender = client.getSender(doc.dcId)
  let offset = Math.floor(start / telegramPartSize) * telegramPartSize
  let remaining = end - start + 1
  let canceled = false
  let firstPart = true
  const queue: Promise<Buffer | null>[] = []
  const fill = (count: number) => {
    while (!canceled && queue.length < count && offset <= end) {
      const at = offset
      offset += telegramPartSize
      queue.push((async () => {
        const get = async () => await client.invokeWithSender(new Api.upload.GetFile({
          location, offset: bigInt(at), limit: telegramPartSize,
        }), await sender)
        let result
        try {
          result = await get()
        } catch (error) {
          const dc = (error as { newDc?: number }).newDc
          if (!dc) throw error
          sender = client.getSender(dc)
          result = await get()
        }
        return result instanceof Api.upload.File ? result.bytes : null
      })().catch(() => null))
    }
  }
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      fill(firstPart ? 1 : 3)
      const part = await queue.shift()
      if (canceled) return
      const skip = firstPart ? start % telegramPartSize : 0
      firstPart = false
      if (!part || part.length <= skip) {
        canceled = true
        controller.error(new Error("Incomplete Telegram download"))
        return
      }
      const bytes = part.subarray(skip, skip + remaining)
      remaining -= bytes.length
      controller.enqueue(new Uint8Array(bytes))
      if (!remaining) controller.close()
    },
    cancel() { canceled = true },
  })
  const responseHeaders = new Headers({
    ...headers, "Content-Type": data.mime_type, "Content-Length": String(remaining),
    "Cache-Control": "private, no-store",
    "Accept-Ranges": "bytes", "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges",
  })
  if (range) responseHeaders.set("Content-Range", `bytes ${start}-${end}/${size}`)
  return new Response(body, { status: range ? 206 : 200, headers: responseHeaders })
}

Deno.serve(async (request) => {
  const requester = request.headers.get("Origin")
  if (requester && requester !== origin) return new Response(null, { status: 403 })
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers })
  const params = new URL(request.url).searchParams
  try {
    const action = params.get("action")
    if (request.method === "GET" && (action === "list" || action === "photos")) {
      if (params.has("view") && params.get("view") !== "public") await requireOwner(request)
      return await listMedia(params, action)
    }
    if (request.method === "GET" && action === "asset") return await mediaAsset(params)
    if (request.method === "POST" && ["photo-upload", "cover-upload", "manage"].includes(action || "")) {
      await requireOwner(request)
      const id = validId(params.get("id"))
      if (action === "photo-upload") return await storePhoto(request, id)
      if (action === "cover-upload") return await storeCover(request, id)
      return await manageMedia(request, id)
    }
    if (request.method === "GET" && action === "qualities") return await listQualities(params.get("id"))
    if (request.method === "GET" && action === "play") return await playVideo(request, params.get("id"))
    if ((request.method === "GET" || request.method === "POST") && action === "telegram-setup") {
      const ownerId = await requireOwner(request)
      return await setupTelegram(request, ownerId)
    }
    if (request.method === "GET" && action === "session") {
      await requireOwner(request)
      return json({ role: "owner" })
    }
    if (request.method === "POST" && (action === "upload-part" || action === "upload-finish")) {
      const ownerId = await requireOwner(request)
      return action === "upload-part" ? await uploadVideoPart(request, params, ownerId) :
        await publishLargeVideo(request, params, ownerId)
    }
    if (request.method === "POST" && action === "upload") {
      const ownerId = await requireOwner(request)
      return await uploadVideo(request, ownerId, params)
    }
    return json({ message: "Действие недоступно." }, 404)
  } catch (error) {
    if (error instanceof HttpError) return json({ message: error.message || "Запрос не выполнен." }, error.status)
    console.error("Video request failed", params.get("action")?.slice(0, 30), error instanceof Error ? error.name : "database")
    return json({ message: "Сервис временно недоступен." }, 500)
  }
})
