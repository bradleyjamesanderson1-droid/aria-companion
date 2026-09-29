# Aria

An animated character you talk to by voice or text. She's a front end for Claude, and through Claude she can reach your connected tools (Gmail, Calendar, Notion, GitHub and anything else that runs an MCP server) plus web search.

- **Her office**: Aria is drawn like a 90s TV cartoon (bold ink outlines, hard-edged cel shading, big dark hair with blue highlights) and sits turned 45° in an oversized cable-knit sweater at her desk in a cozy evening office: city view, banker's lamp, bookshelf, a wall clock that shows the real time, steaming coffee and a beige CRT. She blinks, glances between you, her screen and the window, lip-syncs to her voice, types while she thinks and gestures while she talks. Claude picks her expression on every reply.
- **Voice in and out**: tap the mic, or turn on **Talk mode** for hands-free back-and-forth. She starts speaking as soon as the first sentence arrives. Tap her or press Esc to interrupt.
- **Text**: the chat panel shows the full conversation and works without voice.
- **Pomodoro timer**: a focus/break timer under the character. Aria says "Start!" and "Stop!" at every change, with a chime and a one-minute warning. Lengths, the number of sessions before a long break, and auto-start are in the gear menu. In the claude.ai version you can also just ask her ("start a pomodoro", "make breaks ten minutes", "how long is left?").
- **Tools**: Claude calls your MCP servers directly through the API's MCP connector, and a chip shows which tool she's using. She's told to ask before sending, deleting, booking or sharing anything.

## Hosted version (no setup)

`artifact/aria.html` is Aria as a claude.ai page, built from `artifact/template.html` plus the shared `public/avatar.js` and `public/pomodoro.js` by `npm run build:artifact`. She uses Claude through your own claude.ai account and calls your claude.ai connectors directly (Gmail, Google Calendar, Google Drive, Notion), so no API key or tokens are needed. She can read and search, and she can save Gmail drafts, but she can't send anything. claude.ai pages block the microphone, so this version takes typed messages and answers out loud. For voice input, run the local version below.

## Quick start

```bash
npm install
cp .env.example .env              # add ANTHROPIC_API_KEY
cp mcp-servers.example.json mcp-servers.json   # optional: your tools
npm start
```

Open http://127.0.0.1:3000 in Chrome, Edge or Safari. Voice input uses the browser's Web Speech API; Firefox gets text chat and spoken replies only.

## Connecting your tools

Add your tools to `mcp-servers.json`. Each entry is a remote MCP server:

```json
{
  "name": "notion",
  "label": "Notion",
  "url": "https://mcp.notion.com/mcp",
  "authorization_token": "${NOTION_MCP_TOKEN}",
  "allowed_tools": ["notion-search", "notion-fetch"],
  "enabled": true
}
```

- `${VAR}` is filled in from `.env`, so tokens stay out of the JSON file. Both files are git-ignored.
- `allowed_tools` is optional. When you set it, only those tools are enabled, which is a good way to start read-only.
- The server must be reachable from Anthropic's API over HTTPS (Streamable HTTP or SSE). Servers that only run locally over stdio won't work here.

**About your claude.ai connectors**: connectors you've linked in the Claude app, such as Gmail, Calendar, Drive and Notion, are tied to your claude.ai account. The API can't borrow them. For each one, point this app at an MCP server URL and give it an OAuth access token or API key for that service. Notion and GitHub host official remote MCP servers, and the example file shows both. For Google and Microsoft 365, run or pick a remote MCP server and put its URL in the file.

## Configuration

| Variable | Default | |
|---|---|---|
| `ANTHROPIC_API_KEY` | (none) | Required |
| `COMPANION_NAME` | `Aria` | Her name, used in the UI and in her system prompt |
| `COMPANION_USER_NAME` | (empty) | Your name |
| `COMPANION_MODEL` | `claude-opus-5` | Any current Claude model |
| `COMPANION_EFFORT` | `medium` | `low` gives snappier voice replies; `high` is more thorough |
| `HOST` / `PORT` | `127.0.0.1` / `3000` | |
| `COMPANION_ACCESS_TOKEN` | (empty) | Required before you bind to anything other than localhost |

Refusal fallback is on (`fallbacks: "default"`). If Claude declines a request, the API re-runs it on the recommended fallback model instead of returning a refusal.

## Security

This app can act on your email, calendar and documents, so treat it like a logged-in session:

- It listens on localhost only by default. It won't start on another interface unless `COMPANION_ACCESS_TOKEN` is set, and the browser asks for that token.
- To use it from your phone, put it behind HTTPS (for example a Tailscale or Cloudflare tunnel) with the access token set. Browsers only allow microphone access on HTTPS or localhost.
- Start with `allowed_tools` limited to read and draft tools, and widen it once you trust the setup.

## How it fits together

```
Browser (public/)                          server.js                         Claude API
┌─────────────────────────┐   POST /api/chat   ┌───────────────┐  stream  ┌──────────────────────┐
│ avatar.js  canvas face   │ ───────────────▶  │ session history│ ───────▶ │ claude-opus-5         │
│ app.js     mic → text    │ ◀─── SSE ──────── │ MCP config     │ ◀─────── │  + MCP connector ──▶ your MCP servers
│            text → voice  │  text/tool events │                │          │  + web search         │
└─────────────────────────┘                    └───────────────┘          └──────────────────────┘
```

- `server.js`: no framework, one dependency (`@anthropic-ai/sdk`). It keeps each browser tab's history in memory, streams Claude's reply back as server-sent events, and continues automatically when a long tool run pauses.
- `public/avatar.js`: the character and her office, drawn on a canvas. `setMood()`, `setState()` and the speech hooks drive everything. Open the console and try `companion.avatar.setMood("playful")`.
- `public/app.js`: speech recognition, sentence-by-sentence speech, stripping the mood tags, and the chat UI.

## Ideas for next steps

- A higher-quality voice: swap `tts.push()` for a neural TTS service and drive `setMouth()` from the audio's volume.
- A custom look: change the colors in `styles.css` (`--hair`, `--iris`, `--top`…) or redraw the shapes in `avatar.js`. You could also replace the SVG with a Live2D or VRM model that uses the same `setMood`/`setMouth` interface.
- Memory: add a client-side tool that saves facts to a file so she remembers across restarts.
- Wake word: keep a lightweight recognizer running and start Talk mode when it hears her name.
