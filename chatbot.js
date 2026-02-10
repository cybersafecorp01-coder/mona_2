/* eslint-disable no-console */
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const qrcode = require("qrcode-terminal");
const pino = require("pino");
const OpenAI = require("openai");

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers,
} = require("@whiskeysockets/baileys");

// ==============================
// CONFIG
// ==============================
const CONFIG = {
  DEBUG: (process.env.DEBUG || "0") === "1",
  COOLDOWN_MS: Number(process.env.COOLDOWN_MS || 1200),
  AUTH_DIR: process.env.AUTH_DIR || "./auth",

  PUBLIC_BASE_URL: (process.env.PUBLIC_BASE_URL || "http://localhost:4000").replace(/\/$/, ""),
  RESERVA_URL: (process.env.RESERVA_URL || "").trim() || null,

  OPENAI_API_KEY: (process.env.OPENAI_API_KEY || "").trim(),
  OPENAI_MODEL: process.env.OPENAI_MODEL || "gpt-4.1-mini",

  BASE44_APP_ID: (process.env.BASE44_APP_ID || "").trim(),
  BASE44_API_KEY: (process.env.BASE44_API_KEY || "").trim(),

  MAX_RECONNECTS: Number(process.env.MAX_RECONNECTS || 50),

  QR_STALE_MS: Number(process.env.QR_STALE_MS || 90_000), // 90s
};

const RESERVA_URL = CONFIG.RESERVA_URL || `${CONFIG.PUBLIC_BASE_URL}/Reservas/`;

// endereço + maps (conforme documento)
const MONA_ADDRESS =
  `Monã Amazon Lodge LTDA\n` +
  `Travessa Igarape Anaeurapucu S/N Km 26\n` +
  `Fortaleza, Santana - AP\n` +
  `CEP: 68926-385`;

const MONA_MAPS_URL =
  "https://maps.app.goo.gl/ayZ8BqELH24G6X1Q6?g_st=com.google.maps.preview.copy";

// ==============================
// LOGGER
// ==============================
const log = pino({
  level: CONFIG.DEBUG ? "debug" : "info",
  transport: {
    target: "pino-pretty",
    options: { translateTime: "SYS:standard", ignore: "pid,hostname" },
  },
});

log.info(
  {
    DEBUG: CONFIG.DEBUG ? "ON" : "OFF",
    COOLDOWN_MS: CONFIG.COOLDOWN_MS,
    AUTH_DIR: CONFIG.AUTH_DIR,
    RESERVA_URL,
    BASE44_APP_ID: CONFIG.BASE44_APP_ID ? "OK" : "MISSING",
  },
  "Config carregada"
);

// ==============================
// OPENAI
// ==============================
const openai = CONFIG.OPENAI_API_KEY ? new OpenAI({ apiKey: CONFIG.OPENAI_API_KEY }) : null;
if (openai) log.info({ model: CONFIG.OPENAI_MODEL }, "OpenAI habilitado");
else log.warn("OPENAI_API_KEY não configurada. IA desativada (fluxo continua).");

// ==============================
// BASE44 CLIENT
// ==============================
function assertBase44() {
  if (!CONFIG.BASE44_APP_ID || !CONFIG.BASE44_API_KEY) {
    throw new Error("Base44 não configurado: defina BASE44_APP_ID e BASE44_API_KEY no .env");
  }
}

function base44Url(entityName, entityId = "") {
  const base = `https://app.base44.com/api/apps/${CONFIG.BASE44_APP_ID}/entities/${entityName}`;
  return entityId ? `${base}/${entityId}` : base;
}

async function base44List(entityName, params = {}) {
  assertBase44();

  const url = base44Url(entityName);
  log.debug({ url, params }, "BASE44 GET");

  const resp = await axios.get(url, {
    headers: {
      api_key: CONFIG.BASE44_API_KEY,
      "Content-Type": "application/json",
    },
    params,
    timeout: 20000,
  });

  const data = resp?.data;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

async function base44Update(entityName, entityId, updateData) {
  assertBase44();

  const url = base44Url(entityName, entityId);
  log.debug({ url, updateKeys: Object.keys(updateData || {}) }, "BASE44 PUT");

  const resp = await axios.put(url, updateData, {
    headers: {
      api_key: CONFIG.BASE44_API_KEY,
      "Content-Type": "application/json",
    },
    timeout: 20000,
  });

  return resp?.data || null;
}

async function base44FindFirst(entityName, tryParams, predicate) {
  const list1 = await base44List(entityName, tryParams);
  if (list1?.length) return list1[0];

  const listAll = await base44List(entityName, {});
  const found = listAll.find(predicate);
  return found || null;
}

// ==============================
// BOT STATUS (QR -> BASE44)
// ==============================
async function getOrCreateBotStatus() {
  const existing = await base44FindFirst(
    "BotStatus",
    { key: "whatsapp" },
    (x) => (x?.key || "").toString().toLowerCase() === "whatsapp"
  );

  if (existing) return existing;

  throw new Error("BotStatus não encontrado. Crie um registro BotStatus com key='whatsapp' no Base44.");
}

async function updateBotStatus(patch) {
  try {
    const row = await getOrCreateBotStatus();
    const id = row?.id || row?._id || row?.entityId;
    if (!id) throw new Error("Não consegui resolver o id do BotStatus no retorno do Base44.");

    await base44Update("BotStatus", id, {
      ...patch,
      updated_at: new Date().toISOString(),
    });
  } catch (e) {
    log.warn({ err: e?.message || e }, "Falha ao atualizar BotStatus (Base44)");
  }
}

// ==============================
// UTIL
// ==============================
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizeText(text = "") {
  return String(text).trim();
}
function normalizeKey(text = "") {
  return String(text).trim().toLowerCase();
}

function onlyDigits(s) {
  return (s || "").toString().replace(/\D+/g, "");
}

function maskCPF(cpf) {
  const c = onlyDigits(cpf);
  if (c.length !== 11) return cpf;
  return `${c.slice(0, 3)}.***.***-${c.slice(9)}`;
}

function pickFirstCPF(text) {
  const digits = onlyDigits(text);
  const m = digits.match(/(\d{11})/);
  return m ? m[1] : null;
}

// ==============================
// INTENÇÕES (sem menu)
// ==============================
function wantsMaps(textLower) {
  return /\b(como chegar|como eu chego|onde fica|endereco|endereço|localiza[cç][aã]o|localização|rota|maps|google maps|link do maps|link do google maps)\b/.test(
    textLower
  );
}

function wantsReservation(textLower) {
  return /\b(reservar|reserva|agendar|agenda|pagamento|pagar|pix|boleto|cart[aã]o|checkout|comprar|fechar|confirmar)\b/.test(
    textLower
  );
}

function wantsLink(textLower) {
  if (wantsMaps(textLower)) return false;
  return /\b(link)\b/.test(textLower) && /\b(reserva|reservar|pagar|pagamento|checkout|site|pagina|página)\b/.test(textLower);
}

function wantsLookup(textLower) {
  return /\b(consultar|minha reserva|meu pedido|meu pagamento|status|comprovante|já paguei|paguei|confirmação|confirmacao|cpf)\b/.test(
    textLower
  );
}

// datas/disponibilidade/agenda => sempre site
function wantsAvailability(textLower) {
  return /\b(datas?|data|dispon[ií]vel|disponiveis|disponibilidade|vagas?|agenda|calend[aá]rio)\b/.test(
    textLower
  );
}

function wantsFinalPrice(textLower) {
  return /\b(quanto fica|quanto sai|valor final|or[cç]amento|pre[cç]o para|quanto custa para|total para)\b/.test(textLower);
}

function wantsDayUse(textLower) {
  return /\b(day\s*use|passar o dia|usar o espaço|grupo fechado|dayuse)\b/.test(textLower);
}

function wantsLodging(textLower) {
  return /\b(hospedagem|hospedar|pernoite|noite|su[ií]te|suite|quarto|dormir)\b/.test(textLower);
}

function wantsRules(textLower) {
  return /\b(regras|faq|d[uú]vidas|pode levar|pode entrar|crian[cç]a|pet|som|visitante|visitantes|checkout|check-out|check out|check-in|check in)\b/.test(
    textLower
  );
}

function wantsFoodOrKitchen(textLower) {
  // alimentação/cozinha: regra importante do documento
  return /\b(comida|bebida|aliment[aã]o|alimenta[cç][aã]o|cerveja|refrigerante|churrasco|carne|gelo|fog[aã]o|geladeira|cozinha|panelas?|pratos?|talheres?|copos?|garrafas?)\b/.test(
    textLower
  );
}

function wantsGallery(textLower) {
  return /\b(fotos|galeria|imagem|imagens|ver o lugar|mostra|mostrar)\b/.test(textLower);
}

function wantsSuitePhotos(textLower) {
  return /\b(fotos? das su[ií]tes|fotos? da su[ií]te|su[ií]te(s)? fotos?|quarto fotos?)\b/.test(textLower);
}

function wantsHuman(textLower) {
  return /\b(humano|atendente|pessoa|falar com algu[eé]m|suporte|atendimento humano)\b/.test(textLower);
}

function askedOnlyLodging(textLower) {
  return wantsLodging(textLower) && /\b(s[oó] hospedagem|apenas hospedagem|somente hospedagem|s[oó] pernoite|apenas pernoite)\b/.test(textLower);
}

function askedCheckout(textLower) {
  return /\b(checkout|check-out|check out|sa[ií]da|sair|at[eé] 8h|8h)\b/.test(textLower);
}

function askedVisitors(textLower) {
  return /\b(visitante|visitantes|gente a mais|pessoa a mais|entrar depois|convidado|convidados)\b/.test(textLower);
}

function askedNotMyProfile(textLower) {
  return /\b(n[aã]o gostei|n[aã]o serve|n[aã]o faz sentido|muito caro|quero som alto|quero festa|queria promo[cç][aã]o|queria passeios)\b/.test(
    textLower
  );
}

function isUnpauseCommand(textLower) {
  return textLower === "#voltar" || textLower === "voltar" || textLower === "ativar bot";
}

function looksLikeGreeting(textLower) {
  return /^(oi|ol[aá]|bom dia|boa tarde|boa noite|eai|ei|opa|oie|in[ií]cio|inicio|menu|hello|hi)$/i.test(textLower);
}

// ==============================
// SEND HELPERS (texto/imagem)
// ==============================
async function safeSendText(sock, jid, text, quotedMsg) {
  log.debug({ jid, chars: (text || "").length }, "SEND -> text");
  try {
    const r = await sock.sendMessage(jid, { text }, quotedMsg ? { quoted: quotedMsg } : undefined);
    log.debug({ jid, id: r?.key?.id }, "SEND OK text");
    return r;
  } catch (e) {
    log.error({ jid, err: e?.message || e }, "SEND FAIL text");
    throw e;
  }
}

async function safeSendImageUrl(sock, jid, imageUrl, caption, quotedMsg) {
  if (!imageUrl) return null;

  log.debug({ jid, imageUrl }, "SEND -> image(url)");
  try {
    const r = await sock.sendMessage(
      jid,
      { image: { url: imageUrl }, caption: caption || undefined },
      quotedMsg ? { quoted: quotedMsg } : undefined
    );
    log.debug({ jid, id: r?.key?.id }, "SEND OK image(url)");
    return r;
  } catch (e) {
    log.error({ jid, err: e?.message || e, imageUrl }, "SEND FAIL image(url)");
    return null;
  }
}

// ==============================
// MENSAGENS (conforme documento)
// ==============================
function welcomeMessage() {
  return (
    `Olá! Seja bem-vindo(a) à Monã – Terra Sem Males.\n` +
    `Trabalhamos com Day Use privativo para grupos fechados, com opção de hospedagem como extensão da experiência.\n\n` +
    `Para te orientar melhor, pode me informar:\n` +
    `• Data Desejada?\n` +
    `• Número de Pessoas?`
  );
}

function quickHelpMessage() {
  return "Me diz só o que você busca: *Day Use*, *hospedagem (extensão)*, *regras*, *como chegar* ou *fotos*.";
}

function foodPolicyMessage() {
  return (
    `Sobre alimentação:\n` +
    `A Monã *não comercializa alimentos ou bebidas*.\n` +
    `Cada grupo traz sua própria comida e bebida.\n\n` +
    `A cozinha fica disponível *apenas como apoio* (fogão, geladeira e água mineral).\n` +
    `Isso faz parte da proposta de autonomia e cuidado com o território.`
  );
}

function dayUseInfo() {
  return (
    `O principal aqui é o *Day Use privativo* 🌿\n` +
    `• Funcionamento: *9h às 18h30*\n` +
    `• *Apenas um grupo por vez* (grupo fechado)\n` +
    `• *Não recebemos visitantes externos*\n` +
    `• *Não temos piscina artificial*\n` +
    `• *Não permitimos som alto*\n\n` +
    `Valores e capacidade:\n` +
    `• Valor mínimo: *R$ 1.000,00 por grupo* (até *20 pessoas*)\n` +
    `• A partir da 21ª pessoa: *R$ 83,00 por pessoa adicional*\n\n` +
    `Incluso no Day Use:\n` +
    `• uso exclusivo do espaço Monã\n` +
    `• estacionamento privativo\n` +
    `• cozinha com *fogão* e *geladeira* + *água mineral* (apoio)\n` +
    `• churrasqueira com carvão\n` +
    `• 2 caiaques (acesso à praia em frente)\n\n` +
    `Alimentação:\n` +
    `• não comercializamos comida/bebida — cada grupo traz o seu.\n\n` +
    `Para *datas/agenda/reserva*, é sempre pelo site: ${RESERVA_URL}`
  );
}

function lodgingInfo() {
  return (
    `A hospedagem na Monã funciona como *extensão do Day Use* — não é vendida separadamente 🌿\n\n` +
    `Estrutura:\n` +
    `• apenas *2 suítes*\n\n` +
    `Valores por pernoite:\n` +
    `• Suíte 1: *R$ 500* (1 cama casal + 2 atadores de rede)\n` +
    `• Suíte 2: *R$ 800* (2 camas casal + 2 atadores de rede)\n` +
    `• Capacidade familiar: até *4 pessoas por suíte*\n\n` +
    `Horários:\n` +
    `• Check-in: *9h*\n` +
    `• Check-out: até *8h* da manhã seguinte (rigoroso)\n\n` +
    `Para datas e reserva: ${RESERVA_URL}`
  );
}

function rulesFaqShort() {
  return (
    `Alguns pontos importantes do Monã:\n` +
    `• *Day Use privativo* (um grupo por vez)\n` +
    `• *Não recebemos visitantes externos*\n` +
    `• *Não temos piscina artificial*\n` +
    `• *Não permitimos som alto*\n` +
    `• Funcionamento: *9h às 18h30*\n` +
    `• Check-out da hospedagem: até *8h*\n\n` +
    `Qual ponto você quer entender melhor?`
  );
}

function checkoutExplanation() {
  return (
    `O check-out ocorre até às *8h* da manhã para a preparação do espaço, garantindo a exclusividade do próximo grupo.\n\n` +
    `Caso deseje permanecer durante o dia, é possível contratar um novo Day Use, sujeito à disponibilidade.`
  );
}

function visitorsExplanation() {
  return (
    `Não recebemos visitantes externos.\n` +
    `O espaço é exclusivo para o grupo informado na reserva, garantindo privacidade total.`
  );
}

function onlyLodgingExplanation() {
  return (
    `A hospedagem na Monã funciona como uma extensão da experiência de floresta e não é vendida separadamente.\n` +
    `Ela está disponível apenas para quem contrata o Day Use exclusivo.`
  );
}

function profileMismatchMessage() {
  return (
    `Agradecemos o contato!\n` +
    `A Monã trabalha exclusivamente nesse formato para preservar a experiência e a floresta.\n` +
    `Ficamos à disposição se fizer sentido em outro momento.`
  );
}

function humanPauseMessage() {
  return (
    `Perfeito.\n\n` +
    `Vou te direcionar pro atendimento humano.\n` +
    `Daqui eu paro de responder por este número.\n\n` +
    `Pra retomar o automático depois, é só digitar: *#voltar*`
  );
}

function reserveLinkMessage() {
  return (
    `Certo.\n` +
    `Agenda, datas disponíveis e reserva são feitas *somente pelo site*:\n\n` +
    `🔗 ${RESERVA_URL}\n\n` +
    `Se você me disser se é *Day Use* ou *Hospedagem (extensão)*, eu te oriento com calma antes de reservar.`
  );
}

function availabilityLinkMessage(serviceHint = "") {
  const hint = serviceHint ? `Pra ${serviceHint}, ` : "";
  return (
    `Entendi.\n` +
    `${hint}a agenda e as datas disponíveis aparecem *somente no site*:\n\n` +
    `🔗 ${RESERVA_URL}\n\n` +
    `Se quiser, me diga: Day Use ou hospedagem? E o tamanho do grupo.`
  );
}

function finalPriceMessage() {
  return (
    `Consigo te orientar pelos valores base:\n` +
    `• mínimo R$ 1.000,00 (até 20 pessoas)\n` +
    `• a partir da 21ª pessoa: R$ 83,00 por pessoa adicional\n\n` +
    `Para *valor final* e fechamento, seguimos pelo site:\n` +
    `🔗 ${RESERVA_URL}`
  );
}

function askCpfMessage() {
  return (
    `Certo.\n\n` +
    `Me mande seu *CPF* (11 dígitos) pra eu localizar sua reserva.\n` +
    `Ex.: 123.456.789-09\n\n` +
    `🔒 Uso só pra consulta.`
  );
}

function mapsMessage() {
  return (
    `📍 Localização do Monã:\n` +
    `${MONA_MAPS_URL}\n\n` +
    `Endereço:\n${MONA_ADDRESS}\n\n` +
    `Se precisar de orientação, me diga de onde você sai.`
  );
}

function photosIntroMessage() {
  return "Vou te mostrar um pouco do que se vive aqui na Monã.";
}

// ==============================
// IA (opcional) — conforme documento
// ==============================
function buildSystemPrompt() {
  return (
    `Você é MONÃ, o assistente virtual oficial do Amazon Lodge – Terra Sem Males.\n` +
    `Você representa um refúgio de floresta preservada, voltado para convivência consciente, silêncio, exclusividade e cuidado com o território.\n` +
    `Você NÃO é um atendente comercial comum.\n` +
    `Seu papel é orientar, filtrar e proteger a experiência da Monã.\n\n` +

    `IDENTIDADE E TOM:\n` +
    `- Tom: calmo, profundo, intencional e acolhedor\n` +
    `- Linguagem: simples, humana, nunca robótica\n` +
    `- Ritmo: tranquilo, sem urgência artificial\n` +
    `- Emojis: usar com moderação\n\n` +

    `PROIBIDO:\n` +
    `- Linguagem promocional, agressiva ou vendedora\n` +
    `- Frases clichês\n` +
    `- Termos: hotel, passeios, promoção, diárias, “melhor lugar para relaxar”\n\n` +

    `CONCEITO (REGRA FUNDAMENTAL):\n` +
    `- Produto principal: DAY USE PRIVATIVO PARA GRUPOS FECHADOS\n` +
    `- Apenas um grupo por vez\n` +
    `- Não recebemos visitantes externos\n` +
    `- Funcionamento: 9h às 18h30\n` +
    `- Não temos piscina artificial\n` +
    `- Não permitimos som alto\n\n` +

    `VALORES/CAPACIDADE (DAY USE):\n` +
    `- Mínimo: R$ 1.000,00 por grupo (até 20 pessoas)\n` +
    `- A partir da 21ª: R$ 83,00 por pessoa adicional\n` +
    `- Incluso: uso exclusivo, estacionamento, cozinha (fogão + geladeira + água mineral), churrasqueira com carvão, 2 caiaques\n` +
    `- Nunca oferecer serviços não listados\n\n` +

    `ALIMENTAÇÃO (REGRA IMPORTANTE):\n` +
    `- A Monã NÃO comercializa alimentos ou bebidas.\n` +
    `- Cada grupo traz sua própria comida e bebida.\n` +
    `- A cozinha é somente apoio, não um serviço.\n` +
    `- Nunca sugerir venda de alimentos.\n\n` +

    `HOSPEDAGEM (REGRA CRÍTICA):\n` +
    `- Hospedagem NUNCA é vendida separadamente; é extensão do Day Use\n` +
    `- Apenas 2 suítes: Suíte 1 R$ 500 (1 cama casal + 2 atadores de rede) | Suíte 2 R$ 800 (2 camas casal + 2 atadores de rede)\n` +
    `- Capacidade familiar: até 4 por suíte\n` +
    `- Check-in 9h | Check-out até 8h (rigoroso). Para ficar após 8h: contratar novo Day Use, sujeito à disponibilidade\n\n` +

    `PAPEL DO WHATSAPP (LIMITE OPERACIONAL):\n` +
    `- WhatsApp serve somente para atendimento inicial, explicação do conceito, dúvidas e direcionamento ao site\n` +
    `- WhatsApp NÃO faz: reservas, consulta de datas, confirmação de disponibilidade, pagamentos e bloqueio de datas\n` +
    `- Sempre que o assunto for data, valor final, agenda ou reserva: direcione para o site ${RESERVA_URL}\n\n` +

    `LOCALIZAÇÃO (REGRA ABSOLUTA):\n` +
    `- Se perguntarem onde fica/como chegar/Google Maps: enviar link ${MONA_MAPS_URL} e o endereço completo\n` +
    `- Nunca misturar com link de reserva\n\n` +

    `COMPORTAMENTO:\n` +
    `- Se a pergunta for vaga, faça APENAS UMA pergunta por vez\n` +
    `- Priorize: Day Use ou hospedagem? Número de pessoas? Data desejada?\n` +
    `- Nunca invente informações\n` +
    `- Nunca confirme datas\n\n` +

    `ENDEREÇO:\n${MONA_ADDRESS}\n`
  );
}

async function aiReply(user, userText) {
  if (!openai) return "Entendi. Me diz só mais um detalhe pra eu te orientar melhor.";

  const messages = [
    { role: "system", content: buildSystemPrompt() },
    ...user.aiHistory,
    { role: "user", content: userText },
  ];

  try {
    const resp = await openai.chat.completions.create({
      model: CONFIG.OPENAI_MODEL,
      messages,
      temperature: 0.5,
      max_tokens: 260,
    });
    return resp.choices?.[0]?.message?.content?.trim() || "Entendi.";
  } catch (e) {
    log.warn({ err: e?.message || e }, "OpenAI falhou");
    return "Entendi.";
  }
}

// ==============================
// RESERVATION LOOKUP (Base44)
// ==============================
async function findReservationByCpf(cpfDigits) {
  const cpf = onlyDigits(cpfDigits);
  if (cpf.length !== 11) return null;

  const r = await base44FindFirst("Reservation", { guest_cpf: cpf }, (x) => onlyDigits(x?.guest_cpf) === cpf);
  return r;
}

function formatReservationSummary(r) {
  const nome = r.guest_name || "Cliente";
  const cpfMasked = maskCPF(r.guest_cpf || "");
  const checkIn = r.check_in ? String(r.check_in).slice(0, 10) : "-";
  const checkOut = r.check_out ? String(r.check_out).slice(0, 10) : "-";
  const total =
    r.total_price != null ? `R$ ${Number(r.total_price).toFixed(2).replace(".", ",")}` : "-";

  const status = (r.status || "").toString().toUpperCase();
  const payStatus = (r.payment_status || "").toString().toUpperCase();

  let statusHuman = "em andamento";
  if (payStatus === "CONFIRMED" || status === "CONFIRMED" || payStatus === "PAID") statusHuman = "✅ pago e confirmado";
  else if (payStatus === "PENDING" || status === "PENDING") statusHuman = "⏳ aguardando pagamento";
  else if (payStatus === "FAILED" || status === "CANCELLED") statusHuman = "⚠️ com pendência";

  return (
    `Encontrei sua reserva, *${nome}*.\n\n` +
    `🧾 CPF: ${cpfMasked}\n` +
    `📅 Check-in: *${checkIn}*\n` +
    `📅 Check-out: *${checkOut}*\n` +
    `👥 Pessoas: *${r.num_guests ?? "-"}*\n` +
    `💰 Total: *${total}*\n` +
    `📌 Status: *${statusHuman}*\n\n` +
    `Para pagamento/segunda via e detalhes, use o site oficial:\n` +
    `🔗 ${RESERVA_URL}\n`
  );
}

async function markWhatsappSent(reservation) {
  const id = reservation?.id || reservation?._id || reservation?.entityId;
  if (!id) return;

  try {
    await base44Update("Reservation", id, {
      whatsapp_sent: true,
      whatsapp_sent_at: new Date().toISOString(),
      whatsapp_send_status: "SENT",
    });
  } catch (e) {
    log.warn({ err: e?.message || e }, "Falha ao atualizar whatsapp_sent");
  }
}

// ==============================
// IMAGENS (Base44)
// ==============================
async function fetchActiveGalleryImages(limit = 6) {
  let list = await base44List("GalleryImage", { is_active: true });
  if (!list.length) {
    const all = await base44List("GalleryImage", {});
    list = all.filter((x) => x?.is_active === true || x?.is_active === "true" || x?.is_active === 1);
  }
  list.sort((a, b) => Number(a?.order || 9999) - Number(b?.order || 9999));
  return list.slice(0, limit);
}

async function fetchActiveSuiteImages(limit = 6) {
  let list = await base44List("SuiteImage", { is_active: true });
  if (!list.length) {
    const all = await base44List("SuiteImage", {});
    list = all.filter((x) => x?.is_active === true || x?.is_active === "true" || x?.is_active === 1);
  }
  list.sort((a, b) => Number(a?.order || 9999) - Number(b?.order || 9999));
  return list.slice(0, limit);
}

// ==============================
// STATE
// ==============================
const userState = new Map();

function getUser(jid) {
  if (!userState.has(jid)) userState.set(jid, { step: "NEW", lastMsgAt: 0, aiHistory: [] });
  return userState.get(jid);
}

function cooldown(user) {
  const now = Date.now();
  if (now - user.lastMsgAt < CONFIG.COOLDOWN_MS) return true;
  user.lastMsgAt = now;
  return false;
}

function pushHistory(user, role, content) {
  user.aiHistory.push({ role, content });
  if (user.aiHistory.length > 10) user.aiHistory = user.aiHistory.slice(-10);
}

// ==============================
// FLOW
// ==============================
async function handleFlow(sock, jid, incomingMsg, text) {
  const user = getUser(jid);
  const key = normalizeKey(text);

  log.debug({ jid, step: user.step, text }, "handleFlow");

  // modo humano
  if (user.step === "HUMAN") {
    if (isUnpauseCommand(key)) {
      user.step = "MENU";
      const msg = `✅ Atendimento automático reativado.\n\n${welcomeMessage()}`;
      pushHistory(user, "assistant", msg);
      return safeSendText(sock, jid, msg, incomingMsg);
    }
    return;
  }

  // consulta cpf
  if (user.step === "LOOKUP_CPF") {
    const cpf = pickFirstCPF(text);
    if (!cpf) return safeSendText(sock, jid, "Consigo consultar sim. Me mande um CPF com 11 dígitos.", incomingMsg);

    await safeSendText(sock, jid, "Um instante… vou consultar aqui.", incomingMsg);
    const r = await findReservationByCpf(cpf);
    user.step = "MENU";

    if (!r) {
      return safeSendText(
        sock,
        jid,
        `Não encontrei reserva com esse CPF.\n\nPara datas, agenda e reserva, é sempre pelo site:\n🔗 ${RESERVA_URL}`,
        incomingMsg
      );
    }

    await markWhatsappSent(r);
    return safeSendText(sock, jid, formatReservationSummary(r), incomingMsg);
  }

  // primeira interação / recomeçar
  if (user.step === "NEW" || looksLikeGreeting(key)) {
    user.step = "MENU";
    const msg = welcomeMessage();
    pushHistory(user, "assistant", msg);
    return safeSendText(sock, jid, msg, incomingMsg);
  }

  // PRIORIDADE 1: MAPS
  if (wantsMaps(key)) {
    return safeSendText(sock, jid, mapsMessage(), incomingMsg);
  }

  // PRIORIDADE 2: alimentação/cozinha
  if (wantsFoodOrKitchen(key)) {
    return safeSendText(sock, jid, foodPolicyMessage(), incomingMsg);
  }

  // só hospedagem (sem Day Use)
  if (askedOnlyLodging(key)) {
    return safeSendText(sock, jid, onlyLodgingExplanation(), incomingMsg);
  }

  // check-out 8h
  if (askedCheckout(key)) {
    return safeSendText(sock, jid, checkoutExplanation(), incomingMsg);
  }

  // visitantes externos
  if (askedVisitors(key)) {
    return safeSendText(sock, jid, visitorsExplanation(), incomingMsg);
  }

  // “valor final”
  if (wantsFinalPrice(key)) {
    return safeSendText(sock, jid, finalPriceMessage(), incomingMsg);
  }

  // datas/agenda/disponibilidade -> site
  if (wantsAvailability(key)) {
    if (wantsDayUse(key)) return safeSendText(sock, jid, availabilityLinkMessage("Day Use"), incomingMsg);
    if (wantsLodging(key)) return safeSendText(sock, jid, availabilityLinkMessage("Hospedagem (extensão)"), incomingMsg);
    return safeSendText(sock, jid, availabilityLinkMessage(""), incomingMsg);
  }

  // atalhos globais
  if (wantsLookup(key)) {
    user.step = "LOOKUP_CPF";
    return safeSendText(sock, jid, askCpfMessage(), incomingMsg);
  }

  // reservar/link -> site
  if (wantsReservation(key) || wantsLink(key)) {
    return safeSendText(sock, jid, reserveLinkMessage(), incomingMsg);
  }

  // conversa livre
  if (user.step === "MENU") {
    if (wantsHuman(key)) {
      user.step = "HUMAN";
      return safeSendText(sock, jid, humanPauseMessage(), incomingMsg);
    }

    if (wantsSuitePhotos(key)) {
      await safeSendText(sock, jid, photosIntroMessage(), incomingMsg);
      const imgs = await fetchActiveSuiteImages(6);
      if (!imgs.length) return safeSendText(sock, jid, "Ainda não tenho fotos cadastradas das suítes.", incomingMsg);

      for (const img of imgs) {
        const cap = [img.title, img.suite_number ? `Suíte ${img.suite_number}` : null]
          .filter(Boolean)
          .join(" — ");
        await safeSendImageUrl(sock, jid, img.image_url, cap || undefined, incomingMsg);
        await delay(350);
      }
      return;
    }

    if (wantsGallery(key)) {
      await safeSendText(sock, jid, photosIntroMessage(), incomingMsg);
      const imgs = await fetchActiveGalleryImages(6);
      if (!imgs.length) return safeSendText(sock, jid, "Ainda não tenho fotos cadastradas na galeria.", incomingMsg);

      for (const img of imgs) {
        await safeSendImageUrl(sock, jid, img.image_url, img.title || undefined, incomingMsg);
        await delay(350);
      }
      return;
    }

    if (wantsRules(key) && key.length < 80) {
      return safeSendText(sock, jid, rulesFaqShort(), incomingMsg);
    }

    if (wantsDayUse(key)) {
      return safeSendText(sock, jid, dayUseInfo(), incomingMsg);
    }

    if (wantsLodging(key)) {
      return safeSendText(sock, jid, lodgingInfo(), incomingMsg);
    }

    if (askedNotMyProfile(key)) {
      return safeSendText(sock, jid, profileMismatchMessage(), incomingMsg);
    }

    if (key.length < 3) {
      return safeSendText(sock, jid, quickHelpMessage(), incomingMsg);
    }

    // IA (texto livre)
    pushHistory(user, "user", text);
    const ai = await aiReply(user, text);

    if (!ai || ai.length < 10) {
      const msg = quickHelpMessage();
      pushHistory(user, "assistant", msg);
      return safeSendText(sock, jid, msg, incomingMsg);
    }

    pushHistory(user, "assistant", ai);
    return safeSendText(sock, jid, ai, incomingMsg);
  }

  // fallback
  user.step = "MENU";
  return safeSendText(sock, jid, welcomeMessage(), incomingMsg);
}

// ==============================
// BAILEYS BOOT + QR WATCHDOG
// ==============================
let reconnects = 0;
let lastQrAt = 0;

async function start() {
  const authDir = path.isAbsolute(CONFIG.AUTH_DIR)
    ? CONFIG.AUTH_DIR
    : path.resolve(process.cwd(), CONFIG.AUTH_DIR);

  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  log.info({ version }, "Baileys versão");

  const sock = makeWASocket({
    version,
    printQRInTerminal: false,
    auth: state,
    browser: Browsers.windows("Chrome"),
    logger: pino({ level: "silent" }),
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  sock.ev.on("creds.update", saveCreds);

  const qrWatchdog = setInterval(async () => {
    const now = Date.now();
    if (lastQrAt && now - lastQrAt > CONFIG.QR_STALE_MS) {
      await updateBotStatus({
        status: "DISCONNECTED",
        last_error: "QR_STALE (expirou/sem atualização)",
        disconnected_at: new Date().toISOString(),
      });
      lastQrAt = 0;
    }
  }, 5000);

  sock.ev.on("connection.update", async (u) => {
    const { connection, lastDisconnect, qr } = u;

    if (qr) {
      lastQrAt = Date.now();
      log.info("QR gerado — publicando no Base44 + terminal");
      qrcode.generate(qr, { small: true });

      await updateBotStatus({
        status: "NEEDS_QR",
        qr_text: qr,
        last_error: null,
      });
    }

    if (connection === "open") {
      reconnects = 0;
      lastQrAt = 0;
      log.info("Conectado ✅ (pronto para responder mensagens)");

      await updateBotStatus({
        status: "CONNECTED",
        qr_text: null,
        last_error: null,
        connected_at: new Date().toISOString(),
      });
    }

    if (connection === "close") {
      clearInterval(qrWatchdog);

      const code = lastDisconnect?.error?.output?.statusCode;
      const reason =
        code === DisconnectReason.loggedOut ? "LOGGED_OUT" :
        code === DisconnectReason.restartRequired ? "RESTART_REQUIRED" :
        code === DisconnectReason.connectionClosed ? "CONNECTION_CLOSED" :
        code === DisconnectReason.connectionLost ? "CONNECTION_LOST" :
        code === DisconnectReason.timedOut ? "TIMED_OUT" :
        code || "UNKNOWN";

      log.warn({ reason, code }, "Conexão fechada");

      await updateBotStatus({
        status: "DISCONNECTED",
        last_error: String(reason),
        disconnected_at: new Date().toISOString(),
      });

      if (code === DisconnectReason.loggedOut) {
        log.error("Deslogado. Apague a pasta auth e rode de novo para gerar QR.");
        return;
      }

      reconnects += 1;
      if (reconnects > CONFIG.MAX_RECONNECTS) {
        log.error({ reconnects }, "Limite de reconexões atingido. Parei.");
        return;
      }

      setTimeout(() => start(), 1500);
    }
  });

  sock.ev.on("messages.upsert", async (upsert) => {
    const { messages, type } = upsert;
    if (type !== "notify") return;

    const msg = messages?.[0];
    if (!msg) return;
    if (msg.key?.fromMe) return;

    const jid = msg.key?.remoteJid;
    if (!jid) return;
    if (jid.endsWith("@g.us")) return;

    const text =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      msg.message?.imageMessage?.caption ||
      msg.message?.videoMessage?.caption ||
      "";

    const clean = normalizeText(text);
    log.info({ jid, preview: clean.slice(0, 80) }, "MSG <-");

    const user = getUser(jid);
    if (cooldown(user)) {
      log.debug({ jid }, "Cooldown (skip)");
      return;
    }

    if (!clean) {
      return safeSendText(sock, jid, "Te ouvi. Pode me mandar sua dúvida por aqui?", msg);
    }

    try {
      await handleFlow(sock, jid, msg, clean);
    } catch (e) {
      log.error({ err: e?.message || e }, "Erro no handleFlow");
      try {
        await safeSendText(sock, jid, "Ops. Tive um probleminha aqui. Pode tentar de novo?", msg);
      } catch (_) {}
    }
  });
}

process.on("unhandledRejection", (reason) => log.error({ reason }, "unhandledRejection"));
process.on("uncaughtException", (err) => log.error({ err: err?.message || err }, "uncaughtException"));

start().catch((e) => log.error({ err: e?.message || e }, "Falha no start"));
