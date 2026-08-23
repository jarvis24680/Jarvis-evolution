# Jarvis — deploy instructions

This is a real standalone app: a small backend (holds your API key safely)
+ a frontend (installs on your phone like an app). Takes about 10 minutes,
free tier is enough.

## 1. Get an Anthropic API key
- Go to https://console.anthropic.com → API Keys → Create Key
- Add a small amount of billing credit (usage is pay-as-you-go; personal use
  is typically cents to low dollars per month)
- Copy the key — you'll paste it as an environment variable, never into code

## 2. Deploy (Vercel — free, easiest)
1. Create a free account at https://vercel.com
2. Install Vercel CLI: `npm install -g vercel` (needs Node.js installed)
3. From this folder, run: `vercel`
4. When prompted, follow the defaults
5. In the Vercel dashboard for your new project → Settings → Environment
   Variables → add `ANTHROPIC_API_KEY` with your key from step 1
6. Redeploy (`vercel --prod`) so the env var takes effect
7. Vercel gives you a URL like `https://jarvis-yourname.vercel.app`

Alternative hosts that work the same way: Render, Railway, Fly.io — any
host that runs a Node.js server and lets you set environment variables.

## 3. Put it on your phone
1. Open the Vercel URL in Chrome (Android) or Safari (iPhone)
2. Android Chrome: menu (⋮) → "Add to Home screen"
   iPhone Safari: Share button → "Add to Home Screen"
3. It now opens as its own app icon, full-screen, no browser bar

## 4. Why mic/camera work here but not in claude.ai
Claude's artifact preview runs in a sandboxed iframe that blocks
microphone/camera access — a platform restriction, not a code issue. A
real deployed site (this one) has no such sandbox, so the browser's normal
permission prompt appears and voice input works properly.

## Notes
- The API key lives only in your hosting provider's environment variables —
  never in the frontend code, never visible to visitors
- A simple rate limiter (20 requests/minute per visitor) is built into
  server.js to prevent runaway API costs if the link ever leaks
- Memory/chat history is stored in the browser's local storage on your
  phone, not on a server
