---
name: codex-mobile-token-manager
description: Manage Codex Mobile access tokens, folder scopes, LAN access URLs, QR codes, and per-token access statistics. Use when a user asks to add, list, rotate, disable, enable, or delete a Codex Mobile token; restrict a token to one or more project folders; generate a phone-scannable QR code; or inspect/reset token usage.
---

# Codex Mobile Token Manager

Run all commands from the Codex Mobile repository root. Use the repository CLI instead of editing the token store directly.

## Safety

- Treat access URLs and QR codes as secrets because they contain a bearer token.
- Never paste token secrets into source files, commits, issues, or chat unless the user explicitly asks to reveal one.
- Use `list` and `stats` for routine inspection; they show fingerprints, not secrets.
- Explain that usage means Codex Mobile access traffic, not OpenAI model-token billing.
- Require the user's explicit intent before destructive `remove` or `reset-stats` commands; the CLI also requires `--yes`.

## Commands

First ensure dependencies exist with `npm install` when `node_modules` is absent.

```text
npm run token -- list [--json]
npm run token -- add <id> [--label <text>] [--cwd <absolute-path>]...
npm run token -- rotate <id>
npm run token -- remove <id> --yes
npm run token -- enable <id>
npm run token -- disable <id>
npm run token -- show <id> [--host http://host:port]
npm run token -- qr <id> [--host http://host:port]
npm run token -- stats [id] [--json]
npm run token -- reset-stats [id] --yes
```

Use one `--cwd` per allowed project. Resolve user-provided paths before adding the token. An omitted `--cwd` grants access to all Codex sessions visible to the host account, so call that out before creating an unrestricted token.

Token changes reload automatically in a running server. After `add` or `rotate`, reveal the returned URL only to the requesting user. Use `qr` when they want to connect a mobile device.

## Verification

After a mutation, run `npm run token -- list` and confirm the expected id, status, fingerprint, and folder scope. Do not verify by opening or echoing the raw token store.
