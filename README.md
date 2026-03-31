# NEXIBRA AI (React + Vite)

Ce projet utilise une API serverless (`/api/gemini`) pour garder la clé côté serveur.

## Variables d'environnement

Crée un fichier `.env` en local (non versionné) ou configure la variable dans Vercel:

```
GOOGLE_AI_API_KEY=TA_CLE_GOOGLE
```

## Lancer en local

```
npm install
npm run dev
```

Si tu veux tester l'API serverless en local comme sur Vercel, utilise `vercel dev`
avec la variable d'environnement configurée.
