# Jarvis — deploy instructions

This is a real standalone app: a small backend (holds your API keys safely)
+ a frontend (installs on your phone like an app). Takes about 10 minutes,
free tier is enough.

Jarvis runs on Gemini as its primary model, with optional OpenAI as a
fallback if Gemini is unavailable, and native Google Search grounding for
web search. No other providers are used.

## 1. Get API keys

**Gemini (required)**
- Go to https://aistudio.google.com/apikey → Create API Key
- Free tier is generous enough for personal use
- Copy the key — you'll paste it as an environment variable, never into code

**OpenAI (optional fallback)**
- Go to https://platform.openai.com/api-keys → Create new secret key
- Add a small amount of billing credit (usage is pay-as-you-go; personal use
  is typically cents to low dollars per month)
- Only needed if you want a second model to fall back to when Gemini is down

**Jarvis passkey (required)**
- Pick your own passphrase — anything memorable, e.g. a short phrase only
  you know
- This is not an API key from anywhere; you're inventing it yourself
- Without this set, the app refuses every request with a 503 error — see
  "Why there's a passkey" below

**GitHub token (optional — only if you want Jarvis to propose code changes)**
- Go to https://github.com/settings/tokens?type=beta → Generate new
  fine-grained token
- Scope it to **only this one repository**, not all repos
- Permissions: Contents → Read and write, Pull requests → Read and write.
  Nothing else — Jarvis never needs admin, secrets, or workflow access
- Copy the token; also note your repo as `yourname/your-repo`

## 2. Deploy (Vercel — free, easiest)
1. Create a free account at https://vercel.com
2. Install Vercel CLI: `npm install -g vercel` (needs Node.js installed)
3. From this folder, run: `vercel`
4. When prompted, follow the defaults
5. In the Vercel dashboard for your new project → Settings → Environment
   Variables → add `GEMINI_API_KEY` with your key from step 1, `JARVIS_PASSKEY`
   with your chosen passphrase, and `OPENAI_API_KEY` if you set up the fallback.
   If you want GitHub code proposals, also add `GITHUB_TOKEN` and `GITHUB_REPO`
   (e.g. `yourname/Jarvis-evolution`)
6. Redeploy (`vercel --prod`) so the env vars take effect
7. Vercel gives you a URL like `https://jarvis-yourname.vercel.app`

Alternative hosts that work the same way: Render, Railway, Fly.io — any
host that runs a Node.js server and lets you set environment variables.

## 3. Put it on your phone
1. Open the deployed URL in Chrome (Android) or Safari (iPhone)
2. Android Chrome: menu (⋮) → "Add to Home screen"
   iPhone Safari: Share button → "Add to Home Screen"
3. It now opens as its own app icon, full-screen, no browser bar

## 4. Why mic/camera work here but not in a sandboxed preview
Some AI coding tools preview apps inside a sandboxed iframe that blocks
microphone/camera access — a platform restriction, not a code issue. A
real deployed site (this one) has no such sandbox, so the browser's normal
permission prompt appears and voice input works properly.

## Notes
- API keys live only in your hosting provider's environment variables —
  never in the frontend code, never visible to visitors
- Web search uses Gemini's built-in Google Search grounding — no separate
  search API or key needed
- Memory/chat history is stored in the browser's local storage on your
  phone, not on a server
- See `GEMINI-SETUP.md` for the full list of supported environment
  variables (model overrides, fallback models, etc.)

## Why there's a passkey
The deployed URL is public — anyone who has it can reach your server, not
just you. Every `/api/*` route (chat, memory, learning, evolution, and the
GitHub tools) checks an `x-jarvis-key` header against `JARVIS_PASSKEY`
before doing anything. Without it, a stranger with the link could run up
your API bill — and if you've also set up `GITHUB_TOKEN`, they could get
Jarvis to read your source and open pull requests on your behalf. The
first time you open the app you'll be asked to enter the passkey; it's
then remembered on that device.

## About the GitHub integration
If `GITHUB_TOKEN` and `GITHUB_REPO` are set, Jarvis can read files from
your repo and — only when you explicitly ask it to make a code change —
open a pull request on a new branch. It never pushes directly to your
main branch; every proposed change lands as a PR you review and merge
yourself. Files under `.github/`, anything named `.env`, or anything with
"secret" in the path are refused outright, as an extra guard.
