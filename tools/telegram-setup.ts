import { Api, TelegramClient } from "npm:telegram@2.26.22"
import { StringSession } from "npm:telegram@2.26.22/sessions/index.js"
import { Logger, LogLevel } from "npm:telegram@2.26.22/extensions/Logger.js"

const apiId = Number(prompt("Telegram API ID"))
const apiHash = prompt("Telegram API Hash", { secret: true })?.trim()
const phoneNumber = prompt("Номер отдельного Telegram-аккаунта в международном формате")?.trim()
if (!Number.isSafeInteger(apiId) || apiId < 1 || !apiHash?.match(/^[0-9a-f]{32}$/i) || !phoneNumber?.match(/^\+\d{7,15}$/)) {
  throw new Error("Проверьте API ID, API Hash и номер телефона.")
}

const session = new StringSession("")
const client = new TelegramClient(session, apiId, apiHash, {
  connectionRetries: 2,
  baseLogger: new Logger(LogLevel.NONE),
})

try {
  await client.start({
    phoneNumber,
    phoneCode: async () => prompt("Код из Telegram", { secret: true })?.trim() ?? "",
    password: async () => prompt("Пароль двухэтапной аутентификации", { secret: true }) ?? "",
    onError: async () => true,
  })
  if (!(await client.checkAuthorization())) throw new Error("Вход в Telegram не завершён.")
  const created = await client.invoke(new Api.channels.CreateChannel({
    title: "Video Telegram",
    about: "Хранилище видеотеки",
    broadcast: true,
  }))
  const channel = "chats" in created ? created.chats.find((chat): chat is Api.Channel =>
    chat instanceof Api.Channel && chat.creator === true && chat.title === "Video Telegram") : undefined
  if (!channel?.accessHash) throw new Error("Telegram не вернул параметры закрытого канала.")
  await Deno.writeTextFile("telegram-secrets.env", [
    `TELEGRAM_API_ID=${apiId}`,
    `TELEGRAM_API_HASH=${apiHash}`,
    `TELEGRAM_SESSION=${session.save()}`,
    `TELEGRAM_CHANNEL_ID=${channel.id.toString()}`,
    `TELEGRAM_CHANNEL_HASH=${channel.accessHash.toString()}`,
    "",
  ].join("\n"), { createNew: true, mode: 0o600 })
  console.log("Закрытый канал создан. Секреты записаны в telegram-secrets.env.")
} finally {
  await client.destroy()
}
