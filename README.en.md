<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://github.com/chengzhi-c/pi-desktop-wtq-pool/raw/main/docs/logo-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="https://github.com/chengzhi-c/pi-desktop-wtq-pool/raw/main/docs/logo.png">
    <img src="https://github.com/chengzhi-c/pi-desktop-wtq-pool/raw/main/docs/logo.png" width="240" alt="WTQ Pool">
  </picture>
</p>

<h1 align="center">WTQ Pool</h1>

<p align="center"><b>Use local WorkBuddy, Trae and Qoder sign-ins in PI-Desktop, with automatic failover when an account is rate-limited or out of quota.</b></p>

<p align="center">
  <b>English</b> | <a href="README.md">简体中文</a>
</p>

<p align="center">
  <a href="#install">Install</a> ·
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

Use local WorkBuddy, Trae and Qoder desktop sign-ins in PI-Desktop. WorkBuddy fails over when an account is rate-limited or out of quota; Trae and Qoder select an account per request and do not guarantee retries after failure. Each source has its own switch, with domestic and international accounts grouped separately.

## Preview

The settings panel, in its default light theme:

![Account pool](https://github.com/chengzhi-c/pi-desktop-wtq-pool/raw/main/docs/preview-pool.png)

The panel follows PI-Desktop's appearance setting, with a palette for each theme:

![Dark theme](https://github.com/chengzhi-c/pi-desktop-wtq-pool/raw/main/docs/preview-dark.png)

The model page edits the display name, context window, output limit, thinking levels and image support. A Trae model whose directory states a rate carries a cost tag such as `x0.79`; models that state none (and every Qoder model) stay unlabelled:

![Model settings](https://github.com/chengzhi-c/pi-desktop-wtq-pool/raw/main/docs/preview-models.png)

Live preview: <https://chengzhi-c.github.io/pi-desktop-wtq-pool/>.

`docs/index.html` loads the actual panel code with synthetic demo data. It supports source switching, model settings and theme previews without reading local accounts or tokens.

![Preview page](https://github.com/chengzhi-c/pi-desktop-wtq-pool/raw/main/docs/preview-page.png)

With `showComposerPoints` enabled, the composer toolbar shows the current model's account credits. Click it to inspect the group and switch accounts. The image below is an off-screen render of the actual composer extension, not a conversation-test screenshot:

![Composer credits](https://github.com/chengzhi-c/pi-desktop-wtq-pool/raw/main/docs/preview-composer.png)

Run it locally after cloning the repo: `node docs/serve.cjs`, then open the address it prints. (`docs/index.html` has to be served over http: a `file://` page cannot read the panel files beside it.)

## Install

PI-Desktop → Plugins → Install local plugin, then select a locally built `.piplug`.

Develop and verify with `npm ci && npm run typecheck && npm run build && npm test`. Rebuild `lib/` after changing `src/`.
Package with PI-Desktop's `PluginCheck` / `PluginPack`, not a general-purpose ZIP tool, and pack a copy of the tree holding runtime files only (`src/`, `tests/`, `build.mjs`, `tsconfig.json` and `package-lock.json` left out) with `manifest.json`'s `contributes.providers` emptied first. `PluginPack` skips only `.git`, `node_modules` and `dist`, and that runtime declaration carries the model groups and port published on this machine, so packing the tree as it stands ships them.

## Usage

Sign in inside each vendor's desktop app, then click "Detect accounts again" in the panel. For several WorkBuddy accounts, sign in one after another in the app; a `$wbEncrypted` sign-in from 5.6 on is read by asking the locally installed WorkBuddy for the key. The domestic Trae build has two sign-in slots, Trae CN and TRAE SOLO CN. Qoder keeps one sign-in per install, so signing in again in the app overwrites the previous one.

If the model groups do not appear, restart PI-Desktop as the note at the top of the panel says.

The panel selects a source at the top level; below it are the account pool, the models and the connection check.

- Account cards provide credit details, check-in, disable, removal and a preferred account per region. The composer popup can refresh the current model's group.
- WorkBuddy supports priority, round-robin, expiring credits first and conversation-sticky accounts. Trae and Qoder support round-robin and expiring credits first.
- Saving model settings updates the plugin declaration. If the host has not reloaded it, restart as the panel indicates. Each group publishes up to 64 models; additional selections are marked "not published" but remain available through the gateway.
- Automatic check-in is off by default. When enabled, it runs at 09:00 Beijing time and catches missed slots on the next start. "Run now" performs the same round: vendor check-ins plus domestic WorkBuddy streak and task rewards and cat travel. Trae limits daily check-in per device; Qoder opens its new round at 10:00.

## Settings

Editable from the plugin page:

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Off: the gateways do not start |
| `sourceWorkbuddy` / `sourceTrae` / `sourceQoder` | `true` | Off: that source is not scanned, published or requested |
| `distribution` | `priority` | How the WorkBuddy pool spreads requests: `priority` uses one account first, `round-robin` spreads evenly, `expiry` spends expiring credits first, `sticky` pins one account per conversation |
| `sourceDistributions` | `{}` | Trae/Qoder distribution: `round-robin` / `expiry`; legacy `priority` is accepted |
| `cooldownSeconds` | `60` | Rate-limit cooldown. A reset time the upstream reports takes precedence; Beijing time |
| `creditReserves` | `{}` | Per-account credit floor, keyed by account id; an account below its floor is not distributed to |
| `authFile` | `""` | WorkBuddy sign-in file path; every `.info` sign-in in its directory is scanned. Empty discovers it |
| `autoCheckin` | `{"enabled":false,"hours":[9]}` | Automatic check-in switch and times; `hours` are Beijing-time hours, empty means 09:00 |
| `showComposerPoints` | `false` | Show the active account's credits in the composer toolbar |

Model selection and preferred accounts are saved by the panel. The command palette also opens the panel, detects accounts again, clears cooldowns, checks in everywhere and runs the connection check.

## Ports

```
WorkBuddy  41831 / 41841
Trae       41851 / 41861
Qoder      41871 / 41881
```

These are the preferred ports. The host reads manifest addresses before the plugin process starts, so the plugin tries to bind them first; when one is taken, the gateway binds an OS-assigned port and publishes that actual address in its runtime provider registration, and both the panel and the connection report show the fallback. On seeing an address drift, first establish which process holds the port rather than connecting to an unknown service. Domestic models only use domestic accounts.

## Data

The plugin only reads the vendors' local sign-in files. Tokens stay in the plugin process and are sent to the relevant vendor endpoints. Gateways listen on `127.0.0.1`; other local processes can still call them and spend account quota. The host persists plugin settings, while model groups are written to this plugin's manifest. The plugin does not directly manage or delete host conversation records. If replies disappear after restart, check both stream completion and host persistence logs.

## Permissions

| Permission | Used for |
| --- | --- |
| `ui.panel` | Open the settings panel |
| `background.service` | Keep the gateways and the scan running |
| `provider.register` | Publish the three sources as model providers in this plugin's manifest |
| `renderer.extension` | Show credits in the composer toolbar |
| `shell.openExternal` | Open external links from the panel footer |
| `clipboard.write` | Copy the report from the connection-check page |

The plugin process sends outbound requests directly with `fetch`. The host does not yet sandbox the plugin entry process at the OS level, so `manifest.net.domains` constrains only the `pi.net.fetch` channel; this plugin does not request that permission and declares no such field, which leaves the reachable set to the code itself. The host list below is the complete set of outbound targets, and it can be checked against `safetyNotes` in `manifest.json`.

Tokens go only to the hosts below, matching `safetyNotes` in `manifest.json`:

- WorkBuddy: `copilot.tencent.com`, `www.codebuddy.cn`, `www.codebuddy.ai`, `www.workbuddy.ai`, `www.workbuddy.cn`
- Trae: `api.trae.cn`, `solo.trae.cn`, `trae-api-cn.mchost.guru`, `coresg-normal.trae.ai`, `growsg-normal.trae.ai`
- Qoder: `gateway.qoder.com.cn`, `openapi.qoder.com.cn`, `api3.qoder.sh`, `openapi.qoder.sh`

## Credits

Several modules are ported from, or reference, the MIT projects below:

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
