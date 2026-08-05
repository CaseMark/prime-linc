# prime-linc

case.dev-native RLM agent harness. Forked from [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent), shaped like [Linc](https://github.com/CaseMark/linc).

One API key powers models, vaults, OCR, legal/web search, and the [casedev CLI](https://docs.case.dev/cli).

## Install

Requires Node.js 22.8 or newer:

```bash
npm install -g @casemark/prime-linc
prime-linc
```

The package also exposes `linc` for CaseMark/Bastion compatibility and `pi` for
upstream CLI compatibility.

To develop from source:

```bash
git clone https://github.com/CaseMark/prime-linc.git
cd prime-linc
npm ci
npm run build
./prime-linc.sh
```

Config: `~/.prime-linc/`  
Auth shared with casedev CLI: `~/.config/case/config.json` (`sk_case_*`)

## Auth

```bash
export CASE_API_KEY=sk_case_...
prime-linc
# or /login → case.dev
```

Env: `CASE_API_KEY`, `CASEDEV_API_KEY`, optional `CASEDEV_API_BASE_URL`.

## case.dev-native

- Default model provider: case.dev (`api.case.dev/llm/v1`)
- Built-in tools: `vault_list`, `vault_search`, `vault_download`, `vault_upload`, `legal_research`, `web_search`, `skill_search`, `skill_read`
- Identity/system prompt: prime-linc + case.dev
- Daemon sockets / user-agent isolated from upstream Prime Agent

## Docs

- [case.dev](https://case.dev) · [docs](https://docs.case.dev) · [CLI](https://docs.case.dev/cli)
- Local agent docs: `packages/coding-agent/docs/`

## License

MIT — see [LICENSE](LICENSE). Upstream: Prime Agent / pi-mono.
