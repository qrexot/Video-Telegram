import { createClient } from "npm:@supabase/supabase-js@2.97.0"

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { autoRefreshToken: false, persistSession: false },
})

class HttpError extends Error {
  constructor(readonly status: number, message = "") { super(message) }
}

function json(data: unknown, status = 200) {
  return Response.json(data, { status })
}

async function authorize(request: Request) {
  const candidate = request.headers.get("x-video-sync") || ""
  if (!/^[a-f0-9]{64}$/.test(candidate)) throw new HttpError(401)
  const access = await db.rpc("video_telegram_import_authorized", { candidate })
  if (access.error) throw access.error
  if (access.data !== true) throw new HttpError(401)
  return candidate
}

let imageMagickReady: Promise<typeof import("npm:@imagemagick/magick-wasm@0.0.39")> | undefined

function imageMagick() {
  if (!imageMagickReady) {
    imageMagickReady = import("npm:@imagemagick/magick-wasm@0.0.39").then(async (magick) => {
      const wasm = new URL("magick.wasm", import.meta.resolve("npm:@imagemagick/magick-wasm@0.0.39"))
      await magick.initializeImageMagick(await Deno.readFile(wasm))
      return magick
    }).catch((error) => {
      imageMagickReady = undefined
      throw error
    })
  }
  return imageMagickReady
}

async function generatePhotoPreview(bytes: Uint8Array) {
  const { ImageMagick, MagickFormat, MagickReadSettings } = await imageMagick()
  const settings = new MagickReadSettings()
  settings.setDefine(MagickFormat.Jpeg, "size", "1000x1000")
  return await ImageMagick.read(bytes, settings, (image) => {
    image.autoOrient()
    const ratio = Math.min(1, 1000 / Math.max(image.width, image.height))
    if (ratio < 1) image.thumbnail(Math.round(image.width * ratio), Math.round(image.height * ratio))
    image.strip()
    image.quality = 76
    return image.write(MagickFormat.Jpeg, (output) => new Blob([new Uint8Array(output)], { type: "image/jpeg" }))
  })
}

async function runTelegramPreviewJob(request: Request) {
  const candidate = await authorize(request)
  const claim = await db.rpc("claim_telegram_photo_preview")
  if (claim.error) throw claim.error
  const row = (claim.data as { id: string; size_bytes: number }[])[0]
  if (!row) return json({ generated: 0 })
  const { id, size_bytes: size } = row
  if (!size || size > 25 * 1024 * 1024) throw new HttpError(400)
  const endpoint = new URL("/functions/v1/video", Deno.env.get("SUPABASE_URL")!)
  endpoint.search = new URLSearchParams({ action: "telegram-preview-source", id }).toString()
  const chunkSize = 2 * 1024 * 1024
  const bytes = new Uint8Array(size)
  const readPart = async (offset: number) => {
    const end = Math.min(size, offset + chunkSize) - 1
    const result = await fetch(endpoint, {
      headers: { "x-video-sync": candidate, Range: `bytes=${offset}-${end}` },
      signal: AbortSignal.timeout(26000),
    })
    if (result.status !== 206) throw new HttpError(502, "Telegram не отдал фото для превью.")
    const chunk = new Uint8Array(await result.arrayBuffer())
    if (chunk.length !== end - offset + 1) throw new HttpError(502)
    bytes.set(chunk, offset)
  }
  for (let offset = 0; offset < size; offset += 3 * chunkSize) {
    const jobs = [offset, offset + chunkSize, offset + 2 * chunkSize].filter((start) => start < size)
    await Promise.all(jobs.map(readPart))
  }
  const preview = await generatePhotoPreview(bytes)
  endpoint.search = new URLSearchParams({ action: "telegram-preview-store", id }).toString()
  const result = await fetch(endpoint, {
    method: "POST", headers: { "x-video-sync": candidate, "Content-Type": "image/jpeg" },
    body: preview, signal: AbortSignal.timeout(20000),
  })
  if (!result.ok) throw new HttpError(502, "Telegram не сохранил превью.")
  return json({ generated: 1, bytes: preview.size })
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return json({ message: "Недоступно." }, 405)
  try {
    return await runTelegramPreviewJob(request)
  } catch (error) {
    if (error instanceof HttpError) return json({ message: error.message }, error.status)
    console.error("Photo preview failed", error instanceof Error ? error.message : "database")
    return json({ message: "Не удалось создать превью." }, 500)
  }
})
