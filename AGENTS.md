# Codex Mobile contributor guide

## Setup requests

When a user asks to install or set up this repository:

1. Verify Node.js 20+ and npm are available.
2. Run `npm install`.
3. Run `npm run setup` to verify Codex availability, initialize the local token store, and install the token manager skill for the current user.
4. Run `npm test`.
5. Start with `npm start`, or on Windows use `powershell -ExecutionPolicy Bypass -File scripts/start-codex-mobile.ps1 -Foreground`.
6. Report the LAN URL and tell the user to scan the terminal QR code. Never commit or broadly repeat its token-bearing URL.

Do not require an OpenAI API key. Codex Mobile uses the local `codex app-server` and its existing Codex sign-in.

## Runtime data

Secrets, usage statistics, uploads, inline images, logs, and PID files belong in `CODEX_MOBILE_DATA_DIR`. Never move them into tracked files. The default is `%LOCALAPPDATA%\CodexMobile` on Windows and `$XDG_DATA_HOME/codex-mobile` (or `~/.local/share/codex-mobile`) elsewhere.

## Token tasks

Use the repository skill at `.agents/skills/codex-mobile-token-manager/SKILL.md`. `npm run setup` also installs it into the user's `$HOME/.agents/skills` directory for use from other projects. Do not edit `tokens.json` directly and do not expose raw tokens unless the user explicitly requests a URL or QR code.

## Validation

Run `npm test` after source changes. Run `npm run check` for syntax-only verification. For server changes, use a temporary `CODEX_MOBILE_DATA_DIR` and non-default `PORT` so validation cannot alter the user's live tokens or service.
