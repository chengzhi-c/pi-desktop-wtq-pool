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

> **! A ban is possible. Use at your own discretion; no liability accepted !**

Use local WorkBuddy, Trae and Qoder desktop sign-ins in PI-Desktop. WorkBuddy fails over when an account is rate-limited or out of quota. Trae and Qoder select an account per request and move on to the next sign-in on an authentication failure, a rate limit or exhausted quota, while a problem with the request itself, such as an unknown model or a malformed body, is answered as the upstream answered it. Each source has its own switch, with domestic and international accounts grouped separately.

A rate limit cools for the wait the upstream stated, taking the reset time from the response header when that is the only place it appears. Exhausted quota and a dead sign-in do not recover on their own: that account leaves rotation. A balance read releases an exhausted-quota hold, a fresh sign-in or a manual cooldown reset releases a refused-sign-in hold, and both lapse after six hours (WorkBuddy). Trae and Qoder holds are accounted separately, demoting the sign-in only by the cooldown window (60 seconds by default, configurable up to 24 hours) or by the wait the upstream stated, and it is still used when it is the only one left. When the upstream host cannot be reached at all, the next sign-in is tried.

## Preview

The panel in its default light theme:

![Account pool](https://github.com/chengzhi-c/pi-desktop-wtq-pool/raw/main/docs/preview-pool.png)

The panel subscribes to the host's `appearance:changed`, so its palette and locale follow the host's settings. Two themes:

![Dark theme](https://github.com/chengzhi-c/pi-desktop-wtq-pool/raw/main/docs/preview-dark.png)

The model page edits the display name, context window, output limit, thinking levels and image support. A Trae directory row states only its plan default, which differs per model (116k to 400k). A model that states no larger tier is published with the measured 1M ceiling. A Trae model whose directory states a rate carries a cost tag such as `x0.79`; models whose directory states none, and every Qoder model, stay unlabelled:

![Model settings](https://github.com/chengzhi-c/pi-desktop-wtq-pool/raw/main/docs/preview-models.png)

The growth centre lists one row per account. "Read state" only reads; "Run now" performs that stage alone:

![Growth centre](https://github.com/chengzhi-c/pi-desktop-wtq-pool/raw/main/docs/preview-growth.png)

Live preview: <https://chengzhi-c.github.io/pi-desktop-wtq-pool/>.

`docs/index.html` drives the actual panel code with synthetic demo data. It supports source switching, model settings and theme previews without reading local accounts or tokens.

![Preview page](https://github.com/chengzhi-c/pi-desktop-wtq-pool/raw/main/docs/preview-page.png)

With `showComposerPoints` enabled, the composer toolbar shows the credits of the account behind the current model; click it to inspect that group and switch accounts. The image below is an off-screen render of the actual composer extension:

![Composer credits](https://github.com/chengzhi-c/pi-desktop-wtq-pool/raw/main/docs/preview-composer.png)

To run the preview locally, clone the repository, run `node docs/serve.cjs`, and open the address it prints. The page cannot be opened over `file://`, because a browser will not let it read the panel files beside it.

## Features

- Reuse the local sign-ins: the sign-in files the three desktop apps already saved are read and never modified, and no extra authorization is requested. The single exception is the panel's Add account, which opens the vendor's own login page and writes the result into the plugin's own directory.
- Register model groups by region: each region of each vendor becomes its own provider, and several can be on at once; a region with no account is not registered. A domestic model runs only on domestic accounts, and an international model only on international ones.
- Account distribution: WorkBuddy supports priority, round-robin, expiring credits first and conversation-sticky accounts, and fails over on a rate limit or exhausted quota. Trae and Qoder support priority, round-robin and expiring credits first, and move on to the next sign-in on an authentication failure, a rate limit or exhausted quota.
- Credit automation: automatic check-in is off by default. Once enabled, the scheduled run and "Run now" perform the same round: the three check-ins plus the WorkBuddy streak bonus and cat travel. The upstream advances the streak on a conversation, so the round reports one chat activity per account before reading the streak tiers, and a tier that comes due is unlocked and collected without the user opening WorkBuddy to send a message. The streak step also spends a make-up card when yesterday was missed, collects the one-off starter gift and campaign compensation, and spends the draws a redeemed tier awards. These growth steps run for domestic and international accounts alike; cat travel runs for domestic accounts only, because the international host has no such API. The panel carries a growth-centre tab that reads the state or runs that stage on its own and lists the accounts one row each.
- Token keep-alive: on demand, with no schedule behind it. "Refresh now" on the check-in card runs one pass by hand and handles only tokens within five minutes of expiry and tokens that report no expiry at all; a token with time left costs no request. It serves accounts that have gone unused for a long time: once their token expires, the next request renews it, which pays that round trip on the user's own turn, and a dead refresh token fails that same turn. Disabled accounts and disabled regions stay out.
- Composer credits: with `showComposerPoints` on, the composer toolbar shows the balance of the account behind the current model; click it to switch accounts, and switching the feature off stops the popover's polling. The two WorkBuddy regions publish the same catalogue, so a model name both of them serve carries a gateway suffix (`… (Global)`), which the readout uses to tell the two account groups apart.
- Panel: account and pool state, model selection, the connection check and the growth centre all live in the plugin panel. The model catalogue loads at startup and refreshes on demand once its cache expires; it does not poll while idle. Disabled accounts are never probed, and the panel does not sit on "detecting" because of them.
- Connection check: every finding carries a verdict. A gateway that is not listening, a catalogue that could not be read, a registered address that differs from the one actually bound, and a provider the host did not accept all count as failures and say what to change. A gateway whose start failed is reported with the reason, and the panel surfaces address drift as a restart hint. When the check itself throws, the failure becomes a finding rather than taking the whole channel down.

## Install

PI-Desktop → Plugins → Install local plugin, then select a locally built `.piplug`.

Requires PI-Desktop 0.15.0 or later; see `engines.piDesktop` in `manifest.json`.

Develop and verify with `npm ci && npm run typecheck && npm run build && npm test`. Rebuild `lib/` after changing `src/`.

Pack with `pnpm pi-plugin pack <dir>` and validate with `pnpm pi-plugin check <dir>`; do not use a general-purpose ZIP tool. The artifact holds runtime files only (`lib/`, `renderer/`, `main.js`, `manifest.json`, `package.json` and the docs). `contributes.providers` in `manifest.json` stays empty and is written by the plugin at run time.

## Usage

Sign in inside each vendor's desktop app, then click "Detect accounts again" in the panel. WorkBuddy reads several saved sign-ins; for more than one account, sign in one after another in the app. A `$wbEncrypted` sign-in from 5.6 on is read by asking the locally installed WorkBuddy for the key. The domestic Trae build has two sign-in slots, Trae CN and TRAE SOLO CN. Qoder keeps one sign-in per install, so signing in again in the app overwrites the previous one. The international WorkBuddy client keeps a single sign-in file, so switching accounts overwrites the previous one. The plugin archives a sign-in as it is overwritten, and that account keeps serving until its token expires; signing it in again in the app renews it.

An account can also be added without the desktop app: "Add account" in the panel's WorkBuddy header opens the vendor's login page in a browser, and the account joins the pool once that page completes. The credential is written under `signins/` in the plugin's own data directory and takes part in distribution on the same terms as a desktop sign-in. Such an account also carries a "Delete" action, which confirms on a second press and then removes the sign-in file together with its archive entry, with no way back. The account is added to the region currently selected, so the domestic realm signs in a domestic account and the international realm an international one.

To migrate accounts left behind by another tool, write the files into that directory: `signins/` is the import format, and one `{auth, account}` document named `*.info` dropped there becomes an ordinary account on the next scan. `tools/import-signins.cjs` reads those account files (`--from` accepts files or directories) and writes them in the shape this plugin reads, skipping any account the plugin's own data directory already holds; `--dry-run` shows what would change and `--force` overwrites:

```
node tools/import-signins.cjs --data "<plugin data dir>" --from "<account file or directory>" [--region cn|global|all] [--dry-run] [--force]
```

The panel offers no import or export button. Those files hold live tokens whose reach equals that of the account itself, so exporting them would copy the token elsewhere. To back them up, copy the `signins/` directory, which already has the format a backup needs.

If the model groups do not appear, restart PI-Desktop as the note at the top of the panel says.

The top level selects a source; below it sit four tabs: the account pool, the models, the connection check and the growth centre.

- **Account pool**: each account's label, remaining credits, quota expiry, cooldown state and check-in progress. An account can be disabled on its own or removed, and a region can be pinned to one preferred account. WorkBuddy supports priority, round-robin, expiring credits first and conversation-sticky distribution; Trae and Qoder support priority, round-robin and expiring credits first.
- **Models**: select which models this region exposes; anything unselected stays out of the model picker. The display name, context window, output limit, thinking levels and image support are editable. A model group publishes at most 64 models; any beyond that are marked "not published" while the gateway still serves them.
- **Connection check**: reports line by line whether each gateway is listening, how many models its catalogue returned, whether the registered address matches the one actually bound, and whether the host accepted each provider, and can copy the whole report. A gateway whose start failed is reported with its reason, and the panel surfaces it as address drift.
- **Growth centre**: applies to WorkBuddy only. It lists one row per account, and expanding a row shows that account's streak tiers. "Read state" is read-only and claims nothing; "Run now" performs the growth stage of the scheduled pass on its own and reports it per step: the make-up card, the gift and compensation, the activity report, and the streak tiers with their draws.

Check-in runs per account, or for a whole source from the title bar. Automatic check-in is off by default; when on it claims at 09:00 (Beijing time), and a slot missed earlier the same day is still claimed at the next start, while one from a previous day is not. Trae's daily check-in is once per device; Qoder's new round opens at 10:00 (Beijing time).

The token keep-alive sits on the same card as the schedule, with no hour to set and no background timer: "Refresh now" runs one pass by hand and reports refreshed, already fresh, failed and without a refresh token separately. It touches no check-in progress.

Within the growth stage, the make-up card and the draws are consumed by a run, while the remaining steps are idempotent and repeating them pays nothing twice. A read stays in the plugin process: reloading the panel still paints the last figures, while an app restart starts from "not read yet" and the tab reads once on entry. Entering the tab also re-reads when the figures are over two minutes old, when a pass ran after the read (including the growth stage of a scheduled check-in), or when a region was switched off.

## Settings

Editable from the plugin page; `manifest.json`'s `contributes.settings` declares these eight:

| Key | Default (effective) | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Off: the gateways do not start |
| `sourceWorkbuddy` / `sourceTrae` / `sourceQoder` | `true` | Off: that source is not scanned, published or requested |
| `distribution` | `priority` | How the WorkBuddy pool spreads requests: `priority` uses one account first, `round-robin` spreads evenly, `expiry` spends expiring credits first, `sticky` pins one account per conversation |
| `cooldownSeconds` | `60` | Rate-limit cooldown. A reset time the upstream reports takes precedence; with none, consecutive limits double it up to 15 minutes (a longer configured window is left alone) |
| `authFile` | `""` | WorkBuddy sign-in file path; every `.info` sign-in in its directory is scanned. Empty discovers it |
| `showComposerPoints` | `false` | Show the active account's credits in the composer toolbar |

Panel-managed keys. They are not declared in `manifest.json`'s `contributes.settings`, so the host's settings page does not list them and the panel is the only place to change them; they are still stored through the host's settings interface:

| Key | Default (effective) | Meaning |
| --- | --- | --- |
| `sourceDistributions` | `{}` | Trae/Qoder distribution: `priority` / `round-robin` / `expiry`; unset behaves as `priority` |
| `creditReserves` | `{}` | Per-account credit floor, keyed by account id; an account at or below its floor is not distributed to |
| `autoCheckin` | `{"enabled":false,"hours":[9]}` | Automatic check-in switch and times; `hours` are Beijing-time hours, empty means 09:00 |
| `disabledAccountIds` | `[]` | Account ids disabled in the panel |
| `disabledRegions` | `[]` | Regions disabled on their own, as `source:region` keys |
| `modelSelection` | `{}` | Which models each gateway publishes, plus display name, context window and other overrides |
| `preferredAccountIds` | `{}` | Preferred WorkBuddy account per region |
| `preferredSourceAccounts` | `{}` | Preferred Trae/Qoder account per region, keyed by `source:region` |
| `removedAccounts` | `[]` | Accounts removed from the pool, with label and region kept so the panel can offer a restore |

Both default columns list effective values: `autoCheckin.hours` is stored as an empty array and normalises to `[9]`, and an empty `authFile` means auto-discovery.

Model selection and preferred accounts are saved by the panel.

## Ports

```
WorkBuddy  41831 / 41841
Trae       41851 / 41861
Qoder      41871 / 41881
```

These are the preferred ports. The host reads the addresses before the plugin process starts, so the plugin tries to bind them first and the manifest keeps naming the preferred port. When one is taken, that session binds an OS-assigned port instead; the panel and the connection check then show the address actually bound and advise a restart on drift. On seeing address drift, establish which process holds the port first rather than connecting to an unknown service.

When another process takes a port between the reservation and the listen, that gateway's start fails: its model group is dropped, the connection check reports the reason, and the panel advises restarting PI-Desktop. The host re-reads the manifest only on startup, on enable or disable and on uninstall, so requests reach the new address only after a restart.

The DeepSeek Harness edition uses a separate range starting at 42831, so both plugins can be installed on one machine with each range intact.

## Data

The plugin only reads the vendors' local sign-in files and never writes back sign-in state. Tokens stay in the plugin process and are sent only to the relevant vendor endpoints. Gateways listen on `127.0.0.1`, so other local processes can still call them and spend account quota. The host persists plugin settings and this plugin writes its model groups into its own manifest; the plugin neither manages nor deletes host conversation records.

The plugin's own data directory (the one `pi.plugin.getDataPath()` names) holds four files. `settings.json` is the plugin settings the host persists; the plugin does not write it (a former plugin id's copy is carried over once on first load). `checkin-slots.json` records the check-in slots already collected, kept for three days. `doctor.txt` is the most recent connection report, item by item, and names no account. `credentials-archive.json` keeps the sign-ins a later account switch overwrote, access tokens included, by token expiry, dropping each 30 days after it.

A sign-in added with "Add account" lands in a `signins/` subdirectory of the same place, named after the account's billing identity and read on the same terms as a desktop sign-in. "Delete" in the panel removes that file together with its archive entry, with no way back, whereas "Remove" only disables the account and "Removed accounts" restores it.

If replies go missing after a restart, check both stream completion and the host's persistence log. The plugin sends no telemetry, and panel links open only when clicked.

## Permissions

| Permission | Used for |
| --- | --- |
| `ui.panel` | Open the settings panel |
| `background.service` | Keep the gateways and the scan running |
| `provider.register` | Publish the three sources as model providers in this plugin's manifest |
| `renderer.extension` | Show credits in the composer toolbar |
| `shell.openExternal` | Open external links from the panel footer, and the "Add account" login link |
| `clipboard.write` | Copy the report from the connection-check page |

The plugin process sends outbound requests directly with `fetch`. The host does not yet sandbox the plugin entry process at the OS level, so `manifest.net.domains` constrains only the `pi.net.fetch` channel; this plugin does not request that permission and declares no such field, which leaves the outbound reach decided solely by the targets in the code. The host list below is the complete set of those targets.

Tokens go only to the hosts below, matching `safetyNotes` in `manifest.json`:

- WorkBuddy: `copilot.tencent.com`, `www.codebuddy.cn`, `www.codebuddy.ai`, `www.workbuddy.ai`
- Trae: `api.trae.cn`, `solo.trae.cn`, `trae-api-cn.mchost.guru`, `coresg-normal.trae.ai`, `growsg-normal.trae.ai`
- Qoder: `gateway.qoder.com.cn`, `openapi.qoder.com.cn`, `api3.qoder.sh`, `openapi.qoder.sh`

## Development

```sh
npm ci
npm run typecheck   # tsc --noEmit
npm run build       # compiles src/*.ts into lib/*.js
npm test            # Node's own test runner, offline regressions
```

`main.js` is the plugin process entry: account scanning, the gateways, the panel RPC and the `contributes.providers` declaration all live there. `src/*.ts` is the host-agnostic core (the account pool, the model catalogue, the upstream clients, the gateways), compiled by `build.mjs` with esbuild into `lib/*.js`. `renderer/` holds the panel and the composer readout in plain JavaScript with no build step, and `tests/` holds the offline regressions.

The host-agnostic core:

| Module | Responsibility |
| --- | --- |
| `loopback.ts` | The loopback security model (Host and Origin checks), response writing, stream relay and message redaction |
| `accounts.ts` | WorkBuddy sign-in parsing, token encryption, the account pool and its cooldowns |
| `upstream.ts` | The WorkBuddy upstream client, error classification, rate-limit reset parsing |
| `catalog.ts` | The model catalogue and its static fallback list |
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
| [ardeyouxipianyi/workbuddy2api-hub](https://github.com/ardeyouxipianyi/workbuddy2api-hub) | (c) 2026 ardeyouxipianyi | Growth centre and streak loop (make-up cards, gift, compensation, lottery), multi-account credential retention, activity reporting for international accounts |

## License

MIT, see [LICENSE](./LICENSE).
