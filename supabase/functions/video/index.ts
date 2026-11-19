import { createClient } from "npm:@supabase/supabase-js@2.97.0"
import { Api, TelegramClient } from "npm:telegram@2.26.22"
import { StringSession } from "npm:telegram@2.26.22/sessions/index.js"
import { CustomFile } from "npm:telegram@2.26.22/client/uploads.js"
import { Logger, LogLevel } from "npm:telegram@2.26.22/extensions/Logger.js"
import { PromisedWebSockets } from "npm:telegram@2.26.22/extensions/PromisedWebSockets.js"
import { ConnectionTCPObfuscated } from "npm:telegram@2.26.22/network/connection/index.js"
import bigInt from "npm:big-integer@1.6.52"
import { Buffer } from "node:buffer"

const origin = Deno.env.get("VIDEO_ORIGIN") || "https://qrexot.github.io"
const maxVideo = 20 * 1024 * 1024
const pageSize = 24
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { autoRefreshToken: false, persistSession: false },
})
const headers = {
  "Access-Control-Allow-Origin": origin,
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
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

let telegramPromise: Promise<TelegramConnection> | undefined

function connectTelegram() {
  const apiId = Number(Deno.env.get("TELEGRAM_API_ID"))
  const apiHash = Deno.env.get("TELEGRAM_API_HASH")
  const session = Deno.env.get("TELEGRAM_SESSION")
  const channelId = Deno.env.get("TELEGRAM_CHANNEL_ID")
  const channelHash = Deno.env.get("TELEGRAM_CHANNEL_HASH")
  if (!Number.isSafeInteger(apiId) || apiId <= 0 || !apiHash || !session || !channelId || !channelHash) {
    throw new HttpError(503)
  }
  if (!telegramPromise) {
    telegramPromise = (async () => {
      const auth = new StringSession(session)
      const client = new WebTelegramClient(auth, apiId, apiHash, {
        connection: ConnectionTCPObfuscated, networkSocket: PromisedWebSockets,
        connectionRetries: 1, requestRetries: 2, useWSS: true, autoReconnect: true,
        floodSleepThreshold: 0, baseLogger: new Logger(LogLevel.NONE),
      })
      try {
        const dc = await client.getDC(auth.dcId)
        auth.setDC(dc.id, dc.ipAddress, dc.port)
        await client.connect()
        if (!(await client.checkAuthorization())) throw new Error("not authorized")
        const channel = new Api.InputPeerChannel({ channelId: bigInt(channelId), accessHash: bigInt(channelHash) })
        return { client, channel }
      } catch {
        await client.disconnect().catch(() => {})
        throw new HttpError(503)
      }
    })().catch((error) => {
      telegramPromise = undefined
      throw error
    })
  }
  return telegramPromise
}

async function requireMember(request: Request) {
  const token = request.headers.get("Authorization")?.match(/^Bearer (\S+)$/i)?.[1]
  if (!token || token.length > 8192) throw new HttpError(401)
  const { data: { user }, error } = await db.auth.getUser(token)
  if (error || !user || user.is_anonymous || !user.email_confirmed_at) throw new HttpError(401)

  const member = await db.from("video_members").select("role").eq("user_id", user.id).maybeSingle()
  if (member.error) throw member.error
  if (!member.data) throw new HttpError(403)
  return { id: user.id, role: member.data.role }
}

async function listVideos(params: URLSearchParams) {
  const offset = Number(params.get("offset") || 0)
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) throw new HttpError(400)
  const search = (params.get("search") || "").trim().slice(0, 120)
  let query = db.from("videos").select("id,title,description,created_at,size_bytes", { count: "exact" })
    .not("telegram_message_id", "is", null)
  if (search) query = query.ilike("title", "%" + search.replace(/[\\%_]/g, "\\$&").replaceAll("*", "\\*") + "%")
  const result = await query.order("created_at", { ascending: false }).order("id", { ascending: false })
    .range(offset, offset + pageSize - 1)
  if (result.error) throw result.error
  return json({ items: result.data, total: result.count || 0 })
}

async function readUpload(request: Request) {
  const length = Number(request.headers.get("content-length"))
  const type = request.headers.get("content-type") || ""
  if (!type.toLowerCase().startsWith("multipart/form-data;")) throw new HttpError(415)
  const maxBody = maxVideo + 32 * 1024
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

async function uploadVideo(request: Request, userId: string, id: string | null) {
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
    id, uploader_id: userId, title, description, mime_type: mime, size_bytes: file.size,
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

async function playVideo(id: string | null) {
  if (!id || !uuid.test(id)) throw new HttpError(400)
  const item = await db.from("videos").select("telegram_message_id,mime_type,size_bytes").eq("id", id)
    .not("telegram_message_id", "is", null).maybeSingle()
  if (item.error) throw item.error
  if (!item.data) throw new HttpError(404, "Видео отсутствует в каталоге.")
  const { client, channel } = await connectTelegram()
  const [post] = await client.getMessages(channel, { ids: [item.data.telegram_message_id] })
  if (!(post?.media instanceof Api.MessageMediaDocument) || !(post.media.document instanceof Api.Document)) {
    throw new HttpError(404, "Файл отсутствует в Telegram.")
  }
  if (post.media.document.size.toJSNumber() !== item.data.size_bytes) throw new HttpError(502)
  const body = await client.downloadMedia(post)
  if (!Buffer.isBuffer(body) || body.length !== item.data.size_bytes) throw new HttpError(502, "Не удалось получить видео из Telegram.")
  return new Response(new Uint8Array(body), { headers: { ...headers, "Content-Type": item.data.mime_type } })
}

Deno.serve(async (request) => {
  const requester = request.headers.get("Origin")
  if (requester && requester !== origin) return new Response(null, { status: 403 })
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers })
  const params = new URL(request.url).searchParams
  try {
    const member = await requireMember(request)
    const action = params.get("action")
    if (request.method === "GET" && action === "session") return json({ role: member.role })
    if (request.method === "GET" && action === "list") return await listVideos(params)
    if (request.method === "GET" && action === "play") return await playVideo(params.get("id"))
    if (request.method === "POST" && action === "upload") {
      if (member.role !== "owner") throw new HttpError(403)
      return await uploadVideo(request, member.id, params.get("id"))
    }
    return json({ message: "Действие недоступно." }, 404)
  } catch (error) {
    if (error instanceof HttpError) return json({ message: error.message || "Запрос не выполнен." }, error.status)
    console.error("Video request failed", params.get("action")?.slice(0, 30), error instanceof Error ? error.name : "database")
    return json({ message: "Сервис временно недоступен." }, 500)
  }
})
