---
name: codex-webui-token-manager
description: Manage Codex WebUI access tokens, folder scopes, LAN access URLs, QR codes, and per-token access statistics. Use when a user asks to add, list, rotate, disable, enable, or delete a Codex WebUI token; restrict a token to one or more project folders; generate a phone-scannable QR code; or inspect/reset token usage.
---

# Codex WebUI Token Manager

Run the bundled wrapper with Node.js. Resolve `<skill-dir>` to the directory containing this `SKILL.md`:

```text
node <skill-dir>/scripts/token.js <command> [arguments]
```

The wrapper locates the installed Codex WebUI repository, so it works from any project directory. Do not edit `tokens.json` directly.

## Safety

- Treat access URLs and QR codes as secrets because they contain a bearer token.
- Never paste token secrets into source files, commits, issues, or chat unless the user explicitly asks to reveal one.
- Use `list` and `stats` for routine inspection; they show fingerprints, not secrets.
- Explain that usage means Codex WebUI access traffic, not OpenAI model-token billing.
- Require the user's explicit intent before destructive `remove` or `reset-stats` commands; the CLI also requires `--yes`.

## Commands

```text
node <skill-dir>/scripts/token.js list [--json]
node <skill-dir>/scripts/token.js add <id> [--label <text>] [--cwd <absolute-path>]...
node <skill-dir>/scripts/token.js rotate <id>
node <skill-dir>/scripts/token.js remove <id> --yes
node <skill-dir>/scripts/token.js enable|disable <id>
node <skill-dir>/scripts/token.js show <id> [--host http://host:port]
node <skill-dir>/scripts/token.js qr <id> [--host http://host:port]
node <skill-dir>/scripts/token.js stats [id] [--json]
node <skill-dir>/scripts/token.js reset-stats [id] --yes
```

Use one `--cwd` per allowed project. Resolve user-provided paths before adding the token. An omitted `--cwd` grants access to all Codex sessions visible to the host account, so call that out before creating an unrestricted token.

Token changes reload automatically in a running server. After `add` or `rotate`, reveal the returned URL only to the requesting user. Use `qr` when they want to connect a mobile device.

## Verification

After a mutation, run `node <skill-dir>/scripts/token.js list` and confirm the expected id, status, fingerprint, and folder scope. Do not verify by opening or echoing the raw token store.
