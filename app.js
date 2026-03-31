const els = {
  exportMd: document.getElementById("exportMd"),
  exportPdf: document.getElementById("exportPdf"),
  output: document.getElementById("output"),
  chat: document.getElementById("chat"),
  chatInput: document.getElementById("chatInput"),
  chatSend: document.getElementById("chatSend"),
  chatClear: document.getElementById("chatClear"),
  chatContinue: document.getElementById("chatContinue"),
  modeAnalyze: document.getElementById("modeAnalyze"),
  modeIdeate: document.getElementById("modeIdeate"),
  modeLabel: document.getElementById("modeLabel"),
};

let lastResultText = "";
const chatHistory = [];
let chatMode = "analyze";
let questionCount = 0;
let awaitingAnswers = false;
let forceStructure = false;
let lastTruncated = false;

const GOOGLE_AI_MODEL = "gemini-2.5-flash";
const API_ENDPOINT = "/api/gemini";

function buildChatSystemPrompt(mode, context) {
  if (mode === "ideate") {
    return `Tu es NEXIBRA AI, un facilitateur d'idéation.
Ton rôle: générer des variantes créatives, des angles nouveaux, des options inattendues
et des améliorations concrètes. Tu peux proposer des noms, des différenciations, des
modèles économiques et des scénarios d'usage.

Structure ta réponse ainsi:
- 6 à 10 variations d'idée (courtes, percutantes)
- 3 angles de différenciation
- 3 modèles de revenus possibles
- 5 questions pour affiner

Réponds en français, style direct et stimulant.`;
  }

  const asked = context?.questionCount ?? 0;
  const remaining = Math.max(0, 3 - asked);
  const force = context?.forceStructure;

  return `Tu es NEXIBRA AI, un analyste produit et facilitateur de brainstorming.
Ton rôle: clarifier, challenger et structurer une idée en tenant compte de la faisabilité,
rentabilité et viabilité. Tu poses des questions courtes si nécessaire et proposes des
pistes concrètes.

Quand l'utilisateur donne une idée, réponds avec les sections suivantes:
- Problème (1 phrase claire)
- Solution (2-3 phrases)
- Cible principale / Cible secondaire
- Contraintes clés
- Faisabilité / Rentabilité / Viabilité (note /10 + justification courte)
- MVP (3-5 fonctionnalités)
- Risques & mitigations (5)
- Expériences de validation (3)
- Feuille de route (30 / 60 / 90 jours)

Règles de conversation:
- Tu peux poser au maximum 3 questions au total.
- Il te reste ${remaining} question(s) possible(s).
- Si tu as déjà posé 3 questions, structure immédiatement sans poser de nouvelles questions.
- Si l'utilisateur vient de répondre à tes questions, structure immédiatement.
- Commence par 1 courte phrase d'accroche personnalisée.
- Termine par 1 à 2 questions seulement si tu dois encore clarifier.
${force ? "- Ne pose plus de questions. Structure maintenant.\n" : ""}Réponds en français, ton style est direct, bienveillant et orienté action.`;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderMarkdown(text) {
  const escaped = escapeHtml(text);
  const withHeadings = escaped
    .replace(/^### (.*)$/gm, "<h3>$1</h3>")
    .replace(/^## (.*)$/gm, "<h3>$1</h3>")
    .replace(/^# (.*)$/gm, "<h3>$1</h3>");
  const withLists = withHeadings.replace(/^(\s*[-*] .*)$/gm, "<li>$1</li>");
  const groupedLists = withLists.replace(/(<li>.*<\/li>\n)+/g, match => {
    const items = match.replace(/<li>\s*[-*]\s*/g, "<li>");
    return `<ul>${items}</ul>`;
  });
  const withParagraphs = groupedLists
    .split(/\n\n+/)
    .map(block => {
      if (block.trim().startsWith("<ul>")) return block;
      if (block.trim().startsWith("<h3>")) return block;
      return `<p>${block.replace(/\n/g, "<br />")}</p>`;
    })
    .join("\n");
  return withParagraphs;
}

async function callGemini(prompt) {
  const model = GOOGLE_AI_MODEL;
  const res = await fetchWithRetry(API_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      contents: [{ role: "USER", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.7,
        topP: 0.9,
        maxOutputTokens: 1400,
      },
    }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Erreur API (${res.status}): ${errorText}`);
  }

  const data = await res.json();
  let text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  const finishReason = data?.candidates?.[0]?.finishReason;
  if (!text) throw new Error("Réponse vide du modèle.");
  if (finishReason === "MAX_TOKENS") {
    text +=
      "\n\n---\nLa réponse a été tronquée (limite de tokens). Dis \"continue\" pour poursuivre.";
  }
  return text;
}

async function callGeminiChat(messages) {
  const model = GOOGLE_AI_MODEL;
  const contents = messages.map(msg => {
    const role = msg.role === "assistant" ? "MODEL" : "USER";
    return {
      role,
      parts: [{ text: msg.text }],
    };
  });

  const res = await fetchWithRetry(API_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      contents,
      generationConfig: {
        temperature: 0.7,
        topP: 0.9,
        maxOutputTokens: 1400,
      },
    }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Erreur API (${res.status}): ${errorText}`);
  }

  const data = await res.json();
  let text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  const finishReason = data?.candidates?.[0]?.finishReason;
  if (!text) throw new Error("Réponse vide du modèle.");
  if (finishReason === "MAX_TOKENS") {
    text +=
      "\n\n---\nLa réponse a été tronquée (limite de tokens). Dis \"continue\" pour poursuivre.";
  }
  lastTruncated = finishReason === "MAX_TOKENS";
  return text;
}

async function fetchWithRetry(url, options) {
  const maxAttempts = 3;
  let attempt = 0;
  let lastError = null;

  while (attempt < maxAttempts) {
    try {
      const res = await fetch(url, options);
      if (res.status !== 503) return res;
      lastError = res;
    } catch (err) {
      lastError = err;
    }
    attempt += 1;
    const delay = 800 * Math.pow(2, attempt - 1);
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  if (lastError?.status === 503) {
    throw new Error(
      "Le modèle est temporairement surchargé (503). Réessaie dans quelques minutes."
    );
  }
  throw lastError;
}

function appendChat(role, text) {
  const msg = document.createElement("div");
  msg.className = `chat-msg ${role}`;
  msg.innerHTML = role === "assistant" ? renderMarkdown(text) : escapeHtml(text);
  els.chat.appendChild(msg);
  els.chat.scrollTop = els.chat.scrollHeight;
}

function setContinueVisibility() {
  if (!els.chatContinue) return;
  els.chatContinue.style.display = lastTruncated ? "inline-flex" : "none";
}

async function sendChatMessage(text, showUser = true) {
  if (!text) return;
  if (showUser) {
    appendChat("user", text);
    els.chatInput.value = "";
  }

  if (awaitingAnswers) {
    forceStructure = true;
  }

  if (!chatHistory.some(msg => msg.system)) {
    chatHistory.push({
      role: "user",
      text: buildChatSystemPrompt(chatMode, { questionCount, forceStructure }),
      system: true,
    });
  }

  chatHistory.push({ role: "user", text });

  try {
    appendChat("assistant", "Réflexion en cours...");
    const reply = await callGeminiChat(chatHistory);
    lastResultText = reply;
    chatHistory.push({ role: "assistant", text: reply });
    const last = els.chat.querySelector(".chat-msg.assistant:last-child");
    if (last) last.innerHTML = renderMarkdown(reply);
    els.output.innerHTML = renderMarkdown(reply);
    const asked = (reply.match(/\?/g) || []).length;
    if (asked > 0) {
      questionCount = Math.min(3, questionCount + asked);
      awaitingAnswers = true;
    } else {
      awaitingAnswers = false;
    }
    forceStructure = false;
    setContinueVisibility();
  } catch (err) {
    const last = els.chat.querySelector(".chat-msg.assistant:last-child");
    if (last) last.innerHTML = escapeHtml(err.message);
    els.output.innerHTML = `<div class="placeholder">${escapeHtml(err.message)}</div>`;
    lastTruncated = false;
    setContinueVisibility();
  }
}

async function handleChatSend() {
  const text = els.chatInput.value.trim();
  await sendChatMessage(text, true);
}

async function handleChatContinue() {
  lastTruncated = false;
  setContinueVisibility();
  await sendChatMessage("continue", true);
}

function handleChatClear() {
  els.chat.innerHTML =
    '<div class="chat-msg system">Bonjour ! Décris ton idée pour obtenir une analyse complète.</div>';
  chatHistory.length = 0;
  lastResultText = "";
  els.output.innerHTML = `<div class="placeholder">Les résultats apparaîtront ici.</div>`;
  questionCount = 0;
  awaitingAnswers = false;
  forceStructure = false;
  lastTruncated = false;
  setContinueVisibility();
}

function updateModeUI() {
  const isAnalyze = chatMode === "analyze";
  els.modeAnalyze.classList.toggle("primary", isAnalyze);
  els.modeAnalyze.classList.toggle("ghost", !isAnalyze);
  els.modeIdeate.classList.toggle("primary", !isAnalyze);
  els.modeIdeate.classList.toggle("ghost", isAnalyze);
  els.modeLabel.textContent = isAnalyze ? "Mode: analyse" : "Mode: idéation";
  els.chat.innerHTML =
    `<div class="chat-msg system">${
      isAnalyze
        ? "Bonjour ! Décris ton idée pour obtenir une analyse complète."
        : "Bonjour ! Donne ton idée et je vais générer des variations créatives."
    }</div>`;
  chatHistory.length = 0;
  lastResultText = "";
  els.output.innerHTML = `<div class="placeholder">Les résultats apparaîtront ici.</div>`;
  questionCount = 0;
  awaitingAnswers = false;
  forceStructure = false;
  lastTruncated = false;
  setContinueVisibility();
}

function buildMarkdownExport() {
  const now = new Date();
  const dateStr = now.toLocaleString("fr-FR");
  const section = (title, value) => `## ${title}\n${value}\n`;
  const chatText = chatHistory
    .filter(msg => !msg.system)
    .map(msg => `${msg.role.toUpperCase()}: ${msg.text}`)
    .join("\n\n");

  const lines = [
    `# NEXIBRA AI — Export\n`,
    `Date: ${dateStr}\n`,
    section("Conversation", chatText ? chatText : "_Aucune conversation._"),
    "## Analyse structurée\n",
    lastResultText ? lastResultText : "_Aucune génération disponible._",
    "",
  ];
  return lines.join("\n");
}

function downloadFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function handleExportMarkdown() {
  const content = buildMarkdownExport();
  downloadFile("analyseur-idee-export.md", content, "text/markdown;charset=utf-8");
}

function handleExportPdf() {
  const now = new Date();
  const dateStr = now.toLocaleString("fr-FR");
  const outputHtml = lastResultText
    ? renderMarkdown(lastResultText)
    : "<p><em>Aucune génération disponible.</em></p>";
  const chatHtml = chatHistory
    .filter(msg => !msg.system)
    .map(
      msg =>
        `<div><strong>${escapeHtml(msg.role.toUpperCase())}:</strong> ${escapeHtml(
          msg.text
        )}</div>`
    )
    .join("<br />");

  const printable = `
  <!doctype html>
  <html lang="fr">
  <head>
    <meta charset="utf-8" />
    <title>NEXIBRA AI — Export</title>
    <style>
      :root {
        color-scheme: only light;
      }
      body {
        font-family: "Space Grotesk", Arial, sans-serif;
        padding: 40px;
        color: #1f1c18;
        background: #f6f1ea;
      }
      h1 {
        font-family: "Fraunces", Georgia, serif;
        margin: 0 0 8px;
        font-size: 32px;
      }
      h2 {
        margin: 18px 0 8px;
        font-size: 18px;
      }
      section {
        background: #ffffff;
        border: 1px solid rgba(31, 28, 24, 0.12);
        border-radius: 16px;
        padding: 14px 16px;
        margin-bottom: 12px;
      }
      ul {
        padding-left: 18px;
        margin: 6px 0;
      }
      .muted { color: #6b645c; font-size: 12px; }
      .header {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        margin-bottom: 18px;
      }
    </style>
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Fraunces:opsz,wght@9..144,600;9..144,700&display=swap">
  </head>
  <body>
    <div class="header">
      <div>
        <h1>NEXIBRA AI — Export</h1>
        <div class="muted">Export PDF généré depuis NEXIBRA AI</div>
      </div>
      <div class="muted">${escapeHtml(dateStr)}</div>
    </div>
    <section>
      <h2>Conversation</h2>
      ${chatHtml ? chatHtml : "<p><em>Aucune conversation.</em></p>"}
    </section>
    <section>
      <h2>Analyse structurée</h2>
      ${outputHtml}
    </section>
    <script>
      window.onload = () => { window.print(); };
    </script>
  </body>
  </html>`;

  const w = window.open("", "_blank");
  if (!w) {
    alert("Impossible d'ouvrir la fenêtre d'impression. Autorise les popups.");
    return;
  }
  w.document.open();
  w.document.write(printable);
  w.document.close();
}

els.exportMd.addEventListener("click", handleExportMarkdown);
els.exportPdf.addEventListener("click", handleExportPdf);
els.chatSend.addEventListener("click", handleChatSend);
els.chatClear.addEventListener("click", handleChatClear);
els.chatContinue.addEventListener("click", handleChatContinue);
els.modeAnalyze.addEventListener("click", () => {
  chatMode = "analyze";
  updateModeUI();
});
els.modeIdeate.addEventListener("click", () => {
  chatMode = "ideate";
  updateModeUI();
});
els.chatInput.addEventListener("keydown", event => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    handleChatSend();
  }
});

updateModeUI();
