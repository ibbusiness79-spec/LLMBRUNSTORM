import { useEffect, useMemo, useRef, useState } from "react";

const GOOGLE_AI_MODEL = "gemini-2.5-flash";
const API_ENDPOINT = "/api/gemini";
const AUTO_CONTINUE_MAX = 3;

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

async function callGeminiChat(messages) {
  const res = await fetchWithRetry(API_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: GOOGLE_AI_MODEL,
      contents: messages.map(msg => ({
        role: msg.role === "assistant" ? "MODEL" : "USER",
        parts: [{ text: msg.text }],
      })),
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
  return { text, finishReason };
}

const systemWelcomeAnalyze =
  "Bonjour ! Décris ton idée pour obtenir une analyse complète.";
const systemWelcomeIdeate =
  "Bonjour ! Donne ton idée et je vais générer des variations créatives.";

function App() {
  const [chatMode, setChatMode] = useState("analyze");
  const [questionCount, setQuestionCount] = useState(0);
  const [awaitingAnswers, setAwaitingAnswers] = useState(false);
  const [forceStructure, setForceStructure] = useState(false);
  const [lastResultText, setLastResultText] = useState("");
  const [lastTruncated, setLastTruncated] = useState(false);
  const [autoContinueCount, setAutoContinueCount] = useState(0);
  const [inputValue, setInputValue] = useState("");
  const [messages, setMessages] = useState([
    { role: "system", text: systemWelcomeAnalyze },
  ]);

  const chatHistoryRef = useRef([]);
  const autoContinueCountRef = useRef(0);
  const chatEndRef = useRef(null);

  const outputHtml = useMemo(
    () => (lastResultText ? renderMarkdown(lastResultText) : ""),
    [lastResultText]
  );

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const setMode = nextMode => {
    setChatMode(nextMode);
    setMessages([
      {
        role: "system",
        text: nextMode === "analyze" ? systemWelcomeAnalyze : systemWelcomeIdeate,
      },
    ]);
    chatHistoryRef.current = [];
    setLastResultText("");
    setQuestionCount(0);
    setAwaitingAnswers(false);
    setForceStructure(false);
    setLastTruncated(false);
    setAutoContinueCount(0);
    autoContinueCountRef.current = 0;
  };

  const appendAssistant = text => {
    setMessages(prev => [...prev, { role: "assistant", text }]);
  };

  const replaceLastAssistant = text => {
    setMessages(prev => {
      const next = [...prev];
      for (let i = next.length - 1; i >= 0; i -= 1) {
        if (next[i].role === "assistant") {
          next[i] = { ...next[i], text };
          return next;
        }
      }
      return next;
    });
  };

  const sendChatMessage = async (text, showUser = true) => {
    if (!text) return;

    if (showUser) {
      setMessages(prev => [...prev, { role: "user", text }]);
      setInputValue("");
      setAutoContinueCount(0);
      autoContinueCountRef.current = 0;
    }

    if (awaitingAnswers) {
      setForceStructure(true);
    }

    if (!chatHistoryRef.current.some(msg => msg.system)) {
      chatHistoryRef.current.push({
        role: "user",
        text: buildChatSystemPrompt(chatMode, {
          questionCount,
          forceStructure: showUser ? forceStructure : true,
        }),
        system: true,
      });
    }

    chatHistoryRef.current.push({ role: "user", text });
    appendAssistant("Réflexion en cours...");

    try {
      const { text: reply, finishReason } = await callGeminiChat(
        chatHistoryRef.current
      );
      chatHistoryRef.current.push({ role: "assistant", text: reply });
      replaceLastAssistant(reply);
      setLastResultText(reply);

      const asked = (reply.match(/\?/g) || []).length;
      if (asked > 0) {
        setQuestionCount(prev => Math.min(3, prev + asked));
        setAwaitingAnswers(true);
      } else {
        setAwaitingAnswers(false);
      }
      setForceStructure(false);

      const truncated = finishReason === "MAX_TOKENS";
      setLastTruncated(truncated);

      if (truncated && autoContinueCountRef.current < AUTO_CONTINUE_MAX) {
        autoContinueCountRef.current += 1;
        setAutoContinueCount(autoContinueCountRef.current);
        setTimeout(() => {
          sendChatMessage("continue", false);
        }, 0);
      }
    } catch (err) {
      replaceLastAssistant(err.message || "Erreur inconnue.");
      setLastResultText("");
      setLastTruncated(false);
    }
  };

  const handleSend = () => {
    const text = inputValue.trim();
    if (!text) return;
    sendChatMessage(text, true);
  };

  const handleContinue = () => {
    if (!lastTruncated) return;
    sendChatMessage("continue", true);
  };

  const handleClear = () => {
    setMessages([
      {
        role: "system",
        text: chatMode === "analyze" ? systemWelcomeAnalyze : systemWelcomeIdeate,
      },
    ]);
    chatHistoryRef.current = [];
    setLastResultText("");
    setQuestionCount(0);
    setAwaitingAnswers(false);
    setForceStructure(false);
    setLastTruncated(false);
    setAutoContinueCount(0);
    autoContinueCountRef.current = 0;
  };

  const buildMarkdownExport = () => {
    const now = new Date();
    const dateStr = now.toLocaleString("fr-FR");
    const section = (title, value) => `## ${title}\n${value}\n`;
    const chatText = chatHistoryRef.current
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
  };

  const downloadFile = (filename, content, mime) => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const handleExportMarkdown = () => {
    const content = buildMarkdownExport();
    downloadFile("analyseur-idee-export.md", content, "text/markdown;charset=utf-8");
  };

  const handleExportPdf = () => {
    const now = new Date();
    const dateStr = now.toLocaleString("fr-FR");
    const outputHtml = lastResultText
      ? renderMarkdown(lastResultText)
      : "<p><em>Aucune génération disponible.</em></p>";
    const chatHtml = chatHistoryRef.current
      .filter(msg => !msg.system)
      .map(
        msg =>
          `<div><strong>${escapeHtml(
            msg.role.toUpperCase()
          )}:</strong> ${escapeHtml(msg.text)}</div>`
      )
      .join("<br />");

    const printable = `
    <!doctype html>
    <html lang="fr">
    <head>
      <meta charset="utf-8" />
      <title>NEXIBRA AI — Export</title>
      <style>
        :root { color-scheme: only light; }
        body {
          font-family: "Space Grotesk", Arial, sans-serif;
          padding: 40px;
          color: #1f1c18;
          background: #f6f1ea;
        }
        h1 { font-family: "Fraunces", Georgia, serif; margin: 0 0 8px; font-size: 32px; }
        h2 { margin: 18px 0 8px; font-size: 18px; }
        section {
          background: #ffffff;
          border: 1px solid rgba(31, 28, 24, 0.12);
          border-radius: 16px;
          padding: 14px 16px;
          margin-bottom: 12px;
        }
        ul { padding-left: 18px; margin: 6px 0; }
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
  };

  const showContinue = lastTruncated && autoContinueCount >= AUTO_CONTINUE_MAX;

  return (
    <>
      <div className="bg"></div>
      <header className="hero">
        <div className="hero-inner">
          <div className="badge">Votre assistant d'idéation</div>
          <h1>NEXIBRA AI</h1>
          <p className="subtitle">
            Décris ton idée et l'IA la structure en tenant compte de la
            faisabilité, rentabilité et viabilité.
          </p>
        </div>
      </header>

      <main className="container">
        <section className="card">
          <div className="card-title">Assistant d'idéation</div>
          <p className="muted">
            Écris ton idée et l'IA te renverra une analyse structurée.
          </p>
          <div className="mode-switch">
            <button
              className={`btn tiny ${chatMode === "analyze" ? "primary" : "ghost"}`}
              onClick={() => setMode("analyze")}
            >
              Analyse structurée
            </button>
            <button
              className={`btn tiny ${chatMode === "ideate" ? "primary" : "ghost"}`}
              onClick={() => setMode("ideate")}
            >
              Idéation libre
            </button>
            <span className="status">
              Mode: {chatMode === "analyze" ? "analyse" : "idéation"}
            </span>
          </div>
          <div className="chat">
            {messages.map((msg, idx) => (
              <div
                key={`${msg.role}-${idx}`}
                className={`chat-msg ${msg.role}`}
                style={{ whiteSpace: "pre-wrap" }}
                {...(msg.role === "assistant"
                  ? { dangerouslySetInnerHTML: { __html: renderMarkdown(msg.text) } }
                  : {})}
              >
                {msg.role !== "assistant" ? msg.text : null}
              </div>
            ))}
            <div ref={chatEndRef}></div>
          </div>
          <div className="chat-input">
            <textarea
              rows={2}
              placeholder="Décris ton idée en quelques phrases..."
              value={inputValue}
              onChange={event => setInputValue(event.target.value)}
              onKeyDown={event => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  handleSend();
                }
              }}
            ></textarea>
            <button className="btn primary" onClick={handleSend}>
              Envoyer
            </button>
          </div>
          <div className="actions">
            <button className="btn ghost" onClick={handleClear}>
              Vider le chat
            </button>
            {showContinue && (
              <button className="btn ghost" onClick={handleContinue}>
                Continuer la réponse
              </button>
            )}
          </div>
        </section>

        <section className="card">
          <div className="card-title">Analyse structurée</div>
          <div className="actions">
            <button className="btn ghost" onClick={handleExportMarkdown}>
              Exporter Markdown
            </button>
            <button className="btn ghost" onClick={handleExportPdf}>
              Exporter PDF
            </button>
          </div>
          <div className="output">
            {outputHtml ? (
              <div dangerouslySetInnerHTML={{ __html: outputHtml }} />
            ) : (
              <div className="placeholder">Les résultats apparaîtront ici.</div>
            )}
          </div>
        </section>
      </main>

      <footer className="footer">
        <div>NEXIBRA AI — de l'intuition à un plan clair et viable.</div>
      </footer>
    </>
  );
}

export default App;
