// Vendored from zenbu-labs/terminal-browser (https://github.com/zenbu-labs/terminal-browser),
// claude-code-plugin/hooks/urls.ts at commit 2165ae76c9639e3996829ab0e6d54ddbd4f06ad8.
// MIT licence, Copyright 2026 Zenbu Labs, Inc.: see ./LICENSE beside this file.
// Changes: none.

export function normalizeUrl(raw: string): string {
  const text = raw.trim()
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return text
  if (/^localhost(:\d+)?(\/|$)/.test(text) || /^\d+\.\d+\.\d+\.\d+/.test(text)) return `http://${text}`
  return `https://${text}`
}
