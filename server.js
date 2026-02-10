// =====================================
// IMPORTAÇÕES
// =====================================
require("dotenv").config();

const qrcode = require("qrcode-terminal");
const { Client, LocalAuth } = require("whatsapp-web.js");
const OpenAI = require("openai");

// =====================================
// OPENAI
// =====================================
let openai = null;
if (process.env.OPENAI_API_KEY) {
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}
const OPENAI_MODEL = "gpt-4.1-mini";

// =====================================
// URL OFICIAL DE RESERVA
// =====================================
const RESERVA_URL = "https://mona.tur.br/Reservas";

// =====================================
// ENDEREÇO
// =====================================
const MONA_ADDRESS =
  `Mona Mona Amazon Lodge LTDA\n` +
  `Travessa Igarape Anaeurapucu S/N Km 26\n` +
  `Fortaleza\nSantana - AP\n68926-385`;

// =====================================
// CLIENTE WHATSAPP
// =====================================
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: { headless: false },
});

// =====================================
// UTIL
// =====================================
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function normalize(text = "") {
  return text.trim().toLowerCase();
}

async function typing(chat, ms = 600) {
  try {
    await chat.sendStateTyping();
    await delay(ms);
    await chat.clearState();
  } catch {}
}

// =====================================
// INTENÇÕES (BEM RESTRITIVAS)
// =====================================
function wantsLink(text) {
  return /\b(link|site|url|página|pagina|manda o link|me passa o link)\b/.test(text);
}

function wantsToReserve(text) {
  return /\b(reservar|quero reservar|quero fechar|como pago|pagamento|pagar)\b/.test(text);
}

// =====================================
// MENSAGENS
// =====================================
function welcome() {
  return (
    `Olá! 👋🌿\n\n` +
    `Aqui é o atendimento do *Monã – Terra Sem Males*.\n` +
    `Me conta como posso te ajudar hoje 🙂\n\n` +
    `1️⃣ Day Use\n` +
    `2️⃣ Hospedagem\n` +
    `3️⃣ Regras e dúvidas\n` +
    `4️⃣ Falar com humano`
  );
}

function dayUseInfo() {
  return (
    `🌿 *Day Use privativo (grupo fechado)*\n\n` +
    `⏰ Das *9h às 18h30*\n` +
    `💰 Valor mínimo: *R$ 1.000 por grupo*\n` +
    `🔒 Espaço exclusivo pro seu grupo\n\n` +
    `Se quiser saber o que pode levar, valores ou como funciona, é só me perguntar 🙂`
  );
}

function lodgingInfo() {
  return (
    `🏡 *Hospedagem (opcional ao Day Use)*\n\n` +
    `Temos 2 suítes:\n` +
    `• 1 cama de casal + redes — *R$ 500/noite*\n` +
    `• 2 camas de casal + redes — *R$ 800/noite*\n\n` +
    `Me diz a data que eu te oriento direitinho 🙂`
  );
}

function rulesFaq() {
  return (
    `📌 *Algumas regrinhas importantes 🌿*\n\n` +
    `• Check-in: 9h\n` +
    `• Check-out: até 8h\n` +
    `• Sem visitantes externos\n` +
    `• Sem som alto\n\n` +
    `Qualquer dúvida específica é só falar 🙂`
  );
}

function sendLink() {
  return (
    `Perfeito 😊\n\n` +
    `Você pode reservar e pagar diretamente por aqui:\n` +
    `🔗 ${RESERVA_URL}\n\n` +
    `Se tiver qualquer dúvida durante o processo, me chama.`
  );
}

// =====================================
// IA (SEM LINK)
// =====================================
async function aiReply(userText) {
  if (!openai) return "Entendi 🙂 Me conta só mais um detalhe.";

  const resp = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.5,
    max_tokens: 200,
    messages: [
      {
        role: "system",
        content:
          "Você é um atendente humano, simpático e natural. Nunca envie links. Nunca ofereça links. Apenas responda dúvidas."
      },
      { role: "user", content: userText }
    ]
  });

  return resp.choices[0].message.content.trim();
}

// =====================================
// FLUXO PRINCIPAL
// =====================================
client.on("message", async (msg) => {
  if (msg.fromMe || msg.from.endsWith("@g.us")) return;

  const chat = await msg.getChat();
  const text = normalize(msg.body || "");

  await typing(chat);

  // início
  if (!text || ["oi", "olá", "ola", "menu", "inicio"].includes(text)) {
    return chat.sendMessage(welcome());
  }

  // menu
  if (text === "1") return chat.sendMessage(dayUseInfo());
  if (text === "2") return chat.sendMessage(lodgingInfo());
  if (text === "3") return chat.sendMessage(rulesFaq());
  if (text === "4") return chat.sendMessage("Vou te passar para um humano 🙂");

  // LINK — ÚNICO PONTO ONDE ELE SAI
  if (wantsLink(text) || wantsToReserve(text)) {
    return chat.sendMessage(sendLink());
  }

  // texto livre → IA
  const ai = await aiReply(msg.body);
  return chat.sendMessage(ai);
});

// =====================================
client.on("qr", (qr) => qrcode.generate(qr, { small: true }));
client.on("ready", () => console.log("🤖 Bot conectado!"));
client.initialize();
