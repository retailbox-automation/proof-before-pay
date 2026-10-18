# MCP Inspector CLI run, 2026-10-18

Tool: `@modelcontextprotocol/inspector@2.8.0` (official), against `npm run demo` (`http://127.0.0.1:8787/mcp`), both
protocol eras. `--strict` prints every tool-schema portability problem on stderr and exits 6 on an error-severity one.

| Command (era = `legacy` 2025-11-25, `modern` 2026-07-28) | Exit | Result | File |
|---|---|---|---|
| `--method tools/list --strict` | 0 / 0 | 8 tools; stderr empty = 0 schema problems | `out-<era>.json`, `err-<era>.txt` (0 bytes) |
| `--method tools/list --app-info` | 0 / 0 | 7 of 8 tools link a `ui://proofpay/*.html` card; `prepare_checkout` has none on purpose (the checkout screen belongs to Alexa+) | `app-<era>.ndjson` |
| `--method tools/call --tool-name find_pros --tool-arg trade=electrician 'job_summary=…'` | 0 / 0 | the beat-1 line | `call-<era>.json` |

Full command:
```
npx -y @modelcontextprotocol/inspector@2.8.0 --cli http://127.0.0.1:8787/mcp --transport http \
  --header 'Authorization: Bearer pbp-sandbox-inspector' --protocol-era legacy --method tools/list --strict
```
