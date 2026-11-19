import { Api, TelegramClient } from "npm:telegram@2.26.22"
import { StringSession } from "npm:telegram@2.26.22/sessions/index.js"
import { Logger, LogLevel } from "npm:telegram@2.26.22/extensions/Logger.js"
import { stdin, stdout } from "node:process"
import { createInterface } from "node:readline/promises"
import { Writable } from "node:stream"

if (!stdin.isTTY || !stdout.isTTY) throw new Error("Запустите настройку в интерактивном терминале.")

let muted = false
const output = new Writable({
  write(chunk, _encoding, callback) {
    if (muted) callback()
    else stdout.write(chunk, callback)
  },
})
const terminal = createInterface({ input: stdin, output, terminal: true })

async function secret(label: string) {
  stdout.write(label + ": ")
  muted = true
  try {
    return await terminal.question("")
  } finally {
    muted = false
    stdout.write("\n")
  }
}

let client: TelegramClient | undefined
try {
  const occupied = await Deno.stat("telegram-secrets.env").then(() => true, (error) => {
    if (error instanceof Deno.errors.NotFound) return false
    throw error
  })
  if (occupied) throw new Error("Файл telegram-secrets.env уже существует.")
  const apiId = Number(await terminal.question("Telegram API ID: "))
  const apiHash = (await secret("Telegram API Hash")).trim()
  const phoneNumber = (await terminal.question("Номер Telegram-аккаунта в международном формате: ")).trim()
  if (!Number.isSafeInteger(apiId) || apiId < 1 || !apiHash.match(/^[0-9a-f]{32}$/i) || !phoneNumber.match(/^\+\d{7,15}$/)) {
    throw new Error("Проверьте API ID, API Hash и номер телефона.")
  }
  const session = new StringSession("")
  client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 2,
    baseLogger: new Logger(LogLevel.NONE),
  })

  await client.start({
    phoneNumber,
    phoneCode: async () => (await secret("Код из Telegram")).trim(),
    password: async () => await secret("Пароль двухэтапной аутентификации"),
    onError: async () => true,
  })
  if (!(await client.checkAuthorization())) throw new Error("Вход в Telegram не завершён.")

  const existingTitle = (await terminal.question("Точное название существующего закрытого канала (Enter создаст новый): ")).trim()
  let channel: Api.Channel | undefined
  if (existingTitle) {
    for await (const dialog of client.iterDialogs({})) {
      const entity = dialog.entity
      if (entity instanceof Api.Channel && entity.broadcast && entity.creator &&
          !entity.username && !entity.usernames?.some((username) => username.active) &&
          entity.title === existingTitle) {
        if (channel) throw new Error("Два закрытых канала имеют это название. Дайте нужному каналу уникальное имя.")
        channel = entity
      }
    }
  } else {
    const created = await client.invoke(new Api.channels.CreateChannel({
      title: "Video Telegram",
      about: "Хранилище видеотеки",
      broadcast: true,
    }))
    if ("chats" in created) {
      channel = created.chats.find((chat): chat is Api.Channel =>
        chat instanceof Api.Channel && chat.creator === true && chat.title === "Video Telegram")
    }
  }
  if (!channel?.accessHash) throw new Error("Закрытый канал не найден в этом Telegram-аккаунте.")
  await Deno.writeTextFile("telegram-secrets.env", [
    `TELEGRAM_API_ID=${apiId}`,
    `TELEGRAM_API_HASH=${apiHash}`,
    `TELEGRAM_SESSION=${session.save()}`,
    `TELEGRAM_CHANNEL_ID=${channel.id.toString()}`,
    `TELEGRAM_CHANNEL_HASH=${channel.accessHash.toString()}`,
    "",
  ].join("\n"), { createNew: true, mode: 0o600 })
  console.log("Секреты канала записаны в telegram-secrets.env.")
} finally {
  terminal.close()
  await client?.destroy()
}
