const ALLOWED_METHODS = ["POST"];

module.exports = async (req, res) => {
  if (!ALLOWED_METHODS.includes(req.method)) {
    res.setHeader("Allow", ALLOWED_METHODS.join(", "));
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error:
        "Clé API manquante côté serveur. Configure GOOGLE_AI_API_KEY dans Vercel.",
    });
  }

  const { model, contents, generationConfig } = req.body || {};
  const safeModel = model || "gemini-2.5-flash";

  if (!Array.isArray(contents) || contents.length === 0) {
    return res.status(400).json({ error: "Payload invalide: contents requis." });
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${safeModel}:generateContent?key=${encodeURIComponent(
    apiKey
  )}`;

  try {
    const upstream = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents,
        generationConfig: generationConfig || {
          temperature: 0.7,
          topP: 0.9,
          maxOutputTokens: 800,
        },
      }),
    });

    const text = await upstream.text();
    if (!upstream.ok) {
      return res.status(upstream.status).send(text);
    }
    return res.status(200).send(text);
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Erreur serveur." });
  }
};
