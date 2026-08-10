# Security Policy

Cycletron is a desktop app; the main surfaces are the Tauri IPC boundary, the
AI provider integrations (API keys in the OS keychain in release builds — dev
builds use an owner-only file under app data; OAuth tokens in app data), the
optional credential imports that read the `codex` CLI's / Grok Build's local
auth files, and the auto-updater (signed manifests).

## Reporting a vulnerability

Please report vulnerabilities privately via
[GitHub Security Advisories](https://github.com/nukleas/cycletron/security/advisories/new)
rather than opening a public issue. Reports are handled on a best-effort
basis by a solo maintainer.

Fixes land in the latest release; earlier alpha builds are not patched.
