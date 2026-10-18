<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://github.com/chengzhi-c/pi-desktop-wtq-pool/raw/main/docs/logo-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="https://github.com/chengzhi-c/pi-desktop-wtq-pool/raw/main/docs/logo.png">
    <img src="https://github.com/chengzhi-c/pi-desktop-wtq-pool/raw/main/docs/logo.png" width="240" alt="WTQ Pool">
  </picture>
</p>

<h1 align="center">WTQ Pool</h1>

<p align="center"><sub>For PI-Desktop · <a href="https://github.com/chengzhi-c/dsh-wtq-pool">DeepSeek Harness edition</a></sub></p>

<p align="center"><b>Use local WorkBuddy, Trae and Qoder sign-ins in PI-Desktop, with automatic failover when an account is rate-limited or out of quota.</b></p>

<p align="center">
  <b>English</b> | <a href="README.md">简体中文</a>
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#features">Features</a> ·
  <a href="#usage">Usage</a> ·
  <a href="#settings">Settings</a> ·
  <a href="CHANGELOG.md">Changelog</a> ·
  <a href="https://github.com/chengzhi-c/pi-desktop-wtq-pool/issues">Issues</a>
</p>

<p align="center">
  <a href="https://github.com/chengzhi-c/pi-desktop-wtq-pool/releases"><img src="https://img.shields.io/github/v/release/chengzhi-c/pi-desktop-wtq-pool?style=flat-square&amp;label=release" alt="release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/chengzhi-c/pi-desktop-wtq-pool?style=flat-square" alt="MIT license"></a>
  <a href="https://github.com/chengzhi-c/pi-desktop-wtq-pool/stargazers"><img src="https://img.shields.io/github/stars/chengzhi-c/pi-desktop-wtq-pool?style=flat-square" alt="GitHub stars"></a>
</p>

Use local WorkBuddy, Trae and Qoder desktop sign-ins in PI-Desktop. WorkBuddy fails over when an account is rate-limited or out of quota; Trae and Qoder select an account per request and move on to the next sign-in on an authentication failure, a rate limit or exhausted quota, while a problem with the request itself (an unknown model, a malformed body) is answered as the upstream answered it. Each source has its own switch, with domestic and international accounts grouped separately.

## Preview

The settings panel, in its default light theme:

![Account pool](https://github.com/chengzhi-c/pi-desktop-wtq-pool/raw/main/docs/preview-pool.png)

The panel follows PI-Desktop's appearance setting, with a palette for each theme:

![Dark theme](https://github.com/chengzhi-c/pi-desktop-wtq-pool/raw/main/docs/preview-dark.png)

The model page edits the display name, context window, output limit, thinking levels and image support. A Trae model whose directory states a rate carries a cost tag such as `x0.79`; models that state none (and every Qoder model) stay unlabelled:

![Model settings](https://github.com/chengzhi-c/pi-desktop-wtq-pool/raw/main/docs/preview-models.png)

Live preview: <https://chengzhi-c.github.io/pi-desktop-wtq-pool/>.

`docs/index.html` drives the actual panel code with synthetic demo data. It supports source switching, model settings and theme previews without reading local accounts or tokens.

![Preview page](https://github.com/chengzhi-c/pi-desktop-wtq-pool/raw/main/docs/preview-page.png)

With `showComposerPoints` enabled, the composer toolbar shows the current model's account credits. Click it to inspect the group and switch accounts. The image below is an off-screen render of the actual composer extension:

![Composer credits](https://github.com/chengzhi-c/pi-desktop-wtq-pool/raw/main/docs/preview-composer.png)

To run it locally, clone the repo, run `node docs/serve.cjs`, and open the address it prints. (`docs/index.html` has to be served over http: a `file://` page cannot read the panel files beside it.)

## Features

- Reuse the local sign-ins: the plugin only reads the sign-in files the three desktop apps already saved. It starts no OAuth flow of its own and asks for no extra authorization.
- Register model groups by region: each of the three vendors' regions becomes its own provider, and they can be on at once; a region with no account is not registered.
- Account distribution: WorkBuddy supports priority, round-robin, expiring credits first and conversation-sticky accounts, with failover on rate limits or exhausted quota. Trae and Qoder support round-robin and expiring credits first, and move on to the next sign-in on an authentication failure, a rate limit or exhausted quota. A rate limit cools for the wait the upstream stated, taking the response header when that is the only place it appears. Exhausted quota and a dead sign-in do not recover on their own, so that account leaves rotation until the balance is read again or the user signs in anew. When the upstream host cannot be reached at all, the next sign-in is tried.
- Credit automation: automatic check-in is off by default. The scheduled run and "Run now" perform the same round: vendor check-ins, plus the domestic WorkBuddy streak bonus, task rewards and cat travel. The upstream advances the streak on a conversation, so the round reports one chat activity per domestic account before reading the streak tiers; a tier that comes due is unlocked and collected without the user having to open WorkBuddy and send a message.
- Composer credits: with `showComposerPoints` on, the composer toolbar shows the balance of the account behind the current model; click it to switch accounts. Switching the feature off stops the readout's polling.
- One panel: account state, pool state, model selection and the connection check all live in the plugin's own panel. The model catalog loads at startup and refreshes on demand once its cache expires; it does not poll while idle. An account switched off in the panel is never probed, so it does not leave the panel reading "detecting" either.
- Connection check: every finding carries a verdict. A gateway that is not listening, a catalog that could not be read, a published address that differs from the one bound, or a provider the host did not accept all count as failures and say what to change. A gateway whose start failed is reported with the reason and surfaced as address drift. When the check itself throws, the failure becomes a finding rather than taking the whole channel down.

## Install

PI-Desktop → Plugins → Install local plugin, then select a locally built `.piplug`.

Requires PI-Desktop 0.15.0 or later; see `engines.piDesktop` in `manifest.json`.

Develop and verify with `npm ci && npm run typecheck && npm run build && npm test`. Rebuild `lib/` after changing `src/`.

Pack with `pnpm pi-plugin pack <dir>` and validate with `pnpm pi-plugin check <dir>`, not a general-purpose ZIP tool. The artifact holds runtime files only (`lib/`, `renderer/`, `main.js`, `manifest.json`, `package.json` and the docs), and `manifest.json`'s `contributes.providers` stays empty: the plugin writes it at run time.

## Usage

Sign in inside each vendor's desktop app, then click "Detect accounts again" in the panel. For several WorkBuddy accounts, sign in one after another in the app; a `$wbEncrypted` sign-in from 5.6 on is read by asking the locally installed WorkBuddy for the key. The domestic Trae build has two sign-in slots, Trae CN and TRAE SOLO CN. Qoder keeps one sign-in per install, so signing in again in the app overwrites the previous one.

If the model groups do not appear, restart PI-Desktop as the note at the top of the panel says.

The panel selects a source at the top level; below it are three screens: the account pool, the models and the connection check.

- **Account pool**: each account's label, remaining credits, quota expiry, cooldown state and check-in progress. An account can be disabled on its own or removed, and a region can be pinned to prefer one account. WorkBuddy distributes by using one account first, round-robin, expiring credits first, or one account pinned per conversation; Trae and Qoder offer round-robin and expiring credits first.
- **Models**: select which models this region exposes; anything unselected stays out of the model picker. The display name, context window, output limit, thinking levels and image support are editable. A model group publishes at most 64 models; any beyond that are marked "not published" while the gateway still serves them.
- **Connection check**: reports one line at a time whether each gateway is listening, how many models its catalog returned, whether the published address matches the one actually bound, and whether the host accepted each provider, and can copy the whole report. A gateway whose start failed is reported with its reason, and the panel surfaces it as address drift.

Check-in runs per account, or for a whole source from the title bar. Automatic check-in is off by default; when on it claims at 09:00 (Beijing time), and a slot missed earlier the same day is still claimed at the next start, while one from a previous day is not. "Run now" performs the same round: vendor check-ins, plus the domestic WorkBuddy streak bonus, task rewards and cat travel. Trae's daily check-in is once per device. Qoder's new round opens at 10:00 (Beijing time).

## Settings

Editable from the plugin page. `manifest.json`'s `contributes.settings` declares these eight:

| Key | Default (effective) | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Off: the gateways do not start |
| `sourceWorkbuddy` / `sourceTrae` / `sourceQoder` | `true` | Off: that source is not scanned, published or requested |
| `distribution` | `priority` | How the WorkBuddy pool spreads requests: `priority` uses one account first, `round-robin` spreads evenly, `expiry` spends expiring credits first, `sticky` pins one account per conversation |
| `cooldownSeconds` | `60` | Rate-limit cooldown. A reset time the upstream reports takes precedence; Beijing time |
| `authFile` | `""` | WorkBuddy sign-in file path; every `.info` sign-in in its directory is scanned. Empty discovers it |
| `showComposerPoints` | `false` | Show the active account's credits in the composer toolbar |

Panel-managed keys. They are not declared in `manifest.json`'s `contributes.settings`, so the host's settings page does not list them and the panel is the only place to change them; they are still stored through the host's settings interface:

| Key | Default (effective) | Meaning |
| --- | --- | --- |
| `sourceDistributions` | `{}` | Trae/Qoder distribution: `round-robin` / `expiry`; legacy `priority` is accepted |
| `creditReserves` | `{}` | Per-account credit floor, keyed by account id; an account below its floor is not distributed to |
| `autoCheckin` | `{"enabled":false,"hours":[9]}` | Automatic check-in switch and times; `hours` are Beijing-time hours, empty means 09:00 |
| `disabledAccountIds` | `[]` | Account ids switched off in the panel |
| `disabledRegions` | `[]` | Regions parked on their own, as `source:region` keys |
| `modelSelection` | `{}` | Which models each gateway publishes, plus the display name, context window and other overrides |
| `preferredAccountIds` | `{}` | Preferred WorkBuddy account per region |
| `preferredSourceAccounts` | `{}` | Preferred Trae/Qoder account per region, keyed by `source:region` |
| `removedAccounts` | `[]` | Accounts removed from the pool for good, with their label and region kept so the panel can offer a restore |

Both default columns list effective values: `autoCheckin.hours` is stored as an empty array and normalises to `[9]`; an empty `authFile` means auto-discovery.

Model selection and preferred accounts are saved by the panel. The command palette also opens the panel, detects accounts again, clears cooldowns, checks in everywhere and runs the connection check.

## Ports

```
WorkBuddy  41831 / 41841
Trae       41851 / 41861
Qoder      41871 / 41881
```

These are the preferred ports. The host reads manifest addresses before the plugin process starts, so the plugin tries to bind them first, and the manifest keeps naming the preferred port; when one is taken, the gateway binds an OS-assigned port for that session, and both the panel and the connection report show the address actually bound and advise restarting PI-Desktop on drift. On seeing an address drift, first establish which process holds the port rather than connecting to an unknown service. Domestic models only use domestic accounts.

When another process takes a port between the reservation and the listen, that gateway's start fails: its model group is dropped, the connection check reports the reason, and the panel advises restarting PI-Desktop. The host re-reads the manifest only on startup, on enable/disable and on uninstall, so requests reach the new address only after a restart.

## Data

The plugin only reads the vendors' local sign-in files and does not modify them. Tokens stay in the plugin process and are sent to the relevant vendor endpoints. Gateways listen on `127.0.0.1`; other local processes can still call them and spend account quota. The host persists plugin settings, while model groups are written to this plugin's manifest. The plugin does not directly manage or delete host conversation records. Its own data directory (the one `pi.plugin.getDataPath()` names) also holds two files: `checkin-slots.json`, the check-in slots already collected, written to a temporary file and renamed into place, then kept for three days, and `doctor.txt`, the most recent connection report. If replies disappear after restart, check both stream completion and host persistence logs.

The plugin sends no telemetry. Panel links open only when clicked.

## Permissions

| Permission | Used for |
| --- | --- |
| `ui.panel` | Open the settings panel |
| `background.service` | Keep the gateways and the scan running |
| `provider.register` | Publish the three sources as model providers in this plugin's manifest |
| `renderer.extension` | Show credits in the composer toolbar |
| `shell.openExternal` | Open external links from the panel footer |
| `clipboard.write` | Copy the report from the connection-check page |

The plugin process sends outbound requests directly with `fetch`. The host does not yet sandbox the plugin entry process at the OS level, so `manifest.net.domains` constrains only the `pi.net.fetch` channel; this plugin does not request that permission and declares no such field, so the outbound reach is decided solely by the targets in the code. The host list below is the complete set of outbound targets, and it can be checked against `safetyNotes` in `manifest.json`.

Tokens go only to the hosts below, matching `safetyNotes` in `manifest.json`:

- WorkBuddy: `copilot.tencent.com`, `www.codebuddy.cn`, `www.codebuddy.ai`, `www.workbuddy.ai`, `www.workbuddy.cn`
- Trae: `api.trae.cn`, `solo.trae.cn`, `trae-api-cn.mchost.guru`, `coresg-normal.trae.ai`, `growsg-normal.trae.ai`
- Qoder: `gateway.qoder.com.cn`, `openapi.qoder.com.cn`, `api3.qoder.sh`, `openapi.qoder.sh`

## Development

```sh
npm ci
npm run typecheck   # tsc --noEmit
npm run build       # compiles src/*.ts into lib/*.js
npm test            # Node's own test runner, offline regressions
```

`main.js` is the plugin process entry: account scanning, the gateways, the panel RPC and the `contributes.providers` declaration all live there. `src/*.ts` is the host-agnostic core (the account pool, the model catalog, the upstream clients, the gateways), compiled by `build.mjs` with esbuild into `lib/*.js`. `renderer/` holds the panel and the composer readout in plain JavaScript, with no build step, and `tests/` holds the offline regressions.

The host-agnostic core:

| Module | Responsibility |
| --- | --- |
| `loopback.ts` | The loopback security model (Host/Origin checks, response writing, relay pumping via pumpToResponse/relayStreamOf, message redaction) |
| `accounts.ts` | WorkBuddy sign-in parsing, token encryption, the account pool and its cooldowns |
| `upstream.ts` | The WorkBuddy upstream client, error classification, rate-limit reset parsing |
| `catalog.ts` | The model catalog and its static fallback list |
| `shim.ts` | The WorkBuddy gateway's OpenAI-compatible endpoint |
| `at-rest.ts` | Unsealing 5.6+ encrypted sign-in fields |
| `promo.ts` | Promotion window matching |
| `trae-*.ts` / `qoder-*.ts` | Sign-in discovery, protocol clients, SSE decoding and gateways for both vendors |

## Credits

Several modules are ported from or reference the MIT projects below:

| Project | Copyright | Used for |
| --- | --- | --- |
| [XDTrees/dsh-workbuddy-xdpool](https://github.com/XDTrees/dsh-workbuddy-xdpool) | (c) 2026 XDTrees | WorkBuddy account pool and the port this plugin came from |
| [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) | (c) 2026 Corrine Hu | The loopback endpoint's security model |
| [dingminhua/dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy) | (c) 2026 LaoDing | Upstream API and error classification |
| [dingminhua/dsh-connect-trae](https://github.com/dingminhua/dsh-connect-trae) | (c) 2026 dingminhua | Trae protocol reference |
| [eghrhegpe/dsh-connect-qoder](https://github.com/eghrhegpe/dsh-connect-qoder) | (c) 2026 eghrhegpe | Qoder protocol reference |
| [eric8bit/pi-desktop-workbuddy](https://github.com/eric8bit/pi-desktop-workbuddy) | (c) 2026 eric8bit | The PI-Desktop port of the same upstream, this plugin's predecessor |

## License

MIT, see [LICENSE](./LICENSE).
