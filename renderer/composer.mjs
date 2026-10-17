import React, { useEffect, useRef, useState } from "react";

let host;
const REFRESH_INTERVAL_MS = 300000;
const WARMUP_INTERVAL_MS = 5000;
const WARMUP_WINDOW_MS = 120000;

/** The margin kept between the popup and the edge of the window, in px. */
const PANEL_MARGIN = 8;

/** The popup's own width cap, in px. */
const PANEL_MAX_WIDTH = 360;

/**
 * The width the popup is padded out to, in px.
 *
 * The stylesheet sizes the box to its contents, and a real row is only an
 * address and a balance, so the box collapsed to roughly 220px and read as
 * cramped next to the composer. A floor keeps that space without forcing the
 * box wide for rows that do not need it.
 */
const PANEL_MIN_WIDTH = 280;

/** How tall the popup is allowed to get, in px. */
const PANEL_MAX_HEIGHT = 320;

const CSS = `
.xd-points{position:relative;display:inline-flex;align-items:center;min-width:0}
.xd-points-btn{border:0;background:transparent;color:var(--ds-text,var(--ds-text-secondary,#c9cbd1));font:inherit;font-size:12px;line-height:1;display:inline-flex;align-items:center;gap:5px;padding:4px 7px;border-radius:999px;cursor:pointer;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.xd-points-btn:hover{background:var(--ds-bg-muted,rgba(127,127,127,.12))}
/* The trigger is a quiet text chip like the controls it sits beside, but the
   colour is one step stronger than tertiary: it is the account's balance, the
   one thing on that row worth a glance, and it has to be findable first. A dot
   carries that meaning without borrowing an icon set the host does not give. */
.xd-points-mark{display:inline-block;width:6px;height:6px;flex:0 0 auto;border-radius:50%;background:#4f9f7c}
.xd-points-panel{position:fixed;z-index:40;box-sizing:border-box;width:max-content;max-width:${PANEL_MAX_WIDTH}px;max-height:${PANEL_MAX_HEIGHT}px;overflow:auto;padding:8px;border-radius:12px;background:var(--ds-bg-elevated,var(--ds-bg,#1c1d21));color:var(--ds-text,#e8e8ea);box-shadow:0 8px 28px rgba(0,0,0,.28);border:1px solid var(--ds-border,rgba(127,127,127,.25))}
.xd-points-table{width:100%;border-collapse:collapse;font-size:11px;line-height:1.4}
.xd-points-table th{text-align:left;font-weight:600;padding:4px 6px;color:var(--ds-text-secondary,#8b8d93)}
.xd-points-table td{padding:4px 6px;vertical-align:top}
/* The row reuses the trigger's button, which is sized for a chip standing alone
   in the composer: its 12px type, 1px leading and 220px cap all fight the cell,
   and its padding would stack on the cell's and double the row's height. Those
   are restated for the table, so the row follows the popup's own type and a long
   account name is bounded by the cell instead of stretching the panel. */
.xd-points-table .xd-points-btn{font-size:inherit;line-height:inherit;padding:0;max-width:250px}
/* The selected row's name is a disabled button. The hosts disagree about how to
   dim one - PI-Desktop has a global button:disabled rule that fades it, DeepSeek
   Harness has none - so the fade is stated here and both read the same. */
.xd-points-table .xd-points-btn:disabled{opacity:.5}
.xd-points-row{cursor:pointer}
.xd-points-row:hover{background:var(--ds-bg-muted,rgba(127,127,127,.12))}
.xd-points-row.is-active{cursor:default}
.xd-points-dot{display:inline-block;width:6px;height:6px;margin-right:6px;border-radius:50%;background:#4f9f7c;vertical-align:middle}
.xd-points-packs{margin:2px 0 0;padding:0;list-style:none;color:var(--ds-text-secondary,#8b8d93)}
.xd-points-bar{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px}
.xd-points-refresh{border:0;background:transparent;color:var(--ds-text-secondary,#8b8d93);font:inherit;font-size:12px;padding:3px 8px;border-radius:999px;cursor:pointer}
.xd-points-refresh:hover:not(:disabled){background:var(--ds-bg-muted,rgba(127,127,127,.12));color:var(--ds-text,#e8e8ea)}
.xd-points-refresh:disabled{opacity:.5;cursor:default}
`;

export async function onLoad(pi) {
  host = pi;
  pi.ui.injectStyle(CSS);
  pi.slots.register({
    slot: "composerControl",
    positions: ["right"],
    component: ComposerPoints,
  });
}

/**
 * The few words this module owns, in both languages.
 *
 * The host document carries the locale (`<html lang>`, the same source the panel
 * reads), so the popup follows the app instead of always reading Chinese: the
 * panel's own table cannot be reached from here, because this module is loaded
 * into the host's document rather than the panel's.
 */
const WORDS = {
  zh: {
    planQuota: "套餐", addOnQuota: "资源包", credits: "积分",
    never: "不过期", monthly: "月度", days: (days) => days + "天",
    title: "查看账号积分", account: "账号", balance: "积分",
    refresh: "刷新积分", refreshing: "正在刷新…",
    refused: "这个账号无法切换，刷新后重试",
    saved: "已设为优先；积分面板暂不可用，恢复后自动生效",
    unavailable: "已设为优先，但该账号现在不能服务（冷却或已停用），恢复后自动生效",
  },
  en: {
    planQuota: "Plan", addOnQuota: "Add-on", credits: "Credits",
    never: "never expires", monthly: "monthly", days: (days) => days + " days",
    title: "Account credits", account: "Account", balance: "Credits",
    refresh: "Refresh credits", refreshing: "Refreshing…",
    refused: "That account cannot be switched; refresh and try again",
    saved: "Set as preferred; the credits panel is unavailable right now and it takes over once it recovers",
    unavailable: "Set as preferred, but that account cannot serve right now (cooling or switched off); it takes over once it recovers",
  },
};
function currentLocale() {
  return String(
    (typeof document !== "undefined" && document.documentElement && document.documentElement.lang)
    || (typeof navigator !== "undefined" && navigator.language)
    || "zh-CN",
  ).toLowerCase();
}

function words() {
  return currentLocale().indexOf("zh") === 0 ? WORDS.zh : WORDS.en;
}

/**
 * A balance, printed the way the panel prints it: whole numbers as they are,
 * anything else to two decimals, so the chip and the card never disagree about
 * the same account.
 */
function formatCredits(value) {
  const number = Number(value);
  return Number.isInteger(number)
    ? number.toLocaleString()
    : number.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function packName(pack) {
  const W = words();
  if (typeof pack.packageName === "string" && pack.packageName !== "") return pack.packageName;
  if (pack.nameKey === "credits.planQuota") return W.planQuota;
  if (pack.nameKey === "credits.addOnQuota") return W.addOnQuota;
  return W.credits;
}

function packWhen(pack) {
  const W = words();
  const at = typeof pack.roundExpiresAtMs === "number" ? pack.roundExpiresAtMs : pack.expiresAtMs;
  // `at > Date.now()` alone is the whole test: a value that is not a date never
  // arrives here - Qoder's own parser drops anything past the year 2200 as its
  // "no expiry" sentinel and reports `neverExpires` instead, which is handled
  // below.
  if (typeof at === "number" && at > Date.now()) {
    const date = new Date(at);
    return (date.getMonth() + 1) + "/" + date.getDate();
  }
  if (pack.neverExpires === true) return W.never;
  if (pack.monthly === true) return W.monthly;
  if (typeof pack.validDays === "number") return W.days(pack.validDays);
  return "";
}

function ComposerPoints() {
  const [chip, setChip] = useState("");
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState(null);
  const [error, setError] = useState("");
  // The account a stored-but-not-serving notice is about. A cooling account
  // recovers on its own, so without this the notice outlived the condition it
  // described and eventually contradicted the active dot beside it.
  const [errorFor, setErrorFor] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [, setLocale] = useState(currentLocale());
  const W = words();
  const rootRef = useRef(null);
  const panelRef = useRef(null);
  const chipRef = useRef(chip);
  chipRef.current = chip;
  const restartPollRef = useRef(() => {});

  // The host prints the selected model on the chip it renders beside this slot
  // as `alias?.trim() || modelId`, and for this plugin the alias is the name
  // the picker shows. That text is therefore the only handle the plugin gets on
  // the current selection, and it is what it hands back to the main process.
  useEffect(() => {
    const root = rootRef.current;
    const bar = root && root.closest(".composer-right");
    if (!bar) return undefined;
    const read = () => {
      const node = bar.querySelector(".composer-model-thinking-model");
      setChip(node && node.textContent ? node.textContent.trim() : "");
      setLocale(currentLocale());
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(bar, { subtree: true, characterData: true, childList: true });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setData(null);
    setOpen(false);
    setError("");
    setErrorFor("");
    if (!host || chip === "") return undefined;
    let stop = false;
    let timer = 0;
    let startedAt = Date.now();
    // Re-armed rather than fixed-interval: the readout asks again quickly while
    // a balance of ours is still unread, and slowly once it has one - or once
    // the model turns out not to be ours, in which case there is nothing coming
    // and no reason to keep asking quickly.
    const schedule = (current) => {
      const ours = current !== null && current.ours === true;
      const settled = current !== null && typeof current.total === "number";
      const warming = ours && Date.now() - startedAt < WARMUP_WINDOW_MS;
      clearTimeout(timer);
      timer = setTimeout(pull, settled || !warming ? REFRESH_INTERVAL_MS : WARMUP_INTERVAL_MS);
    };
    const pull = () => {
      host.dispatch("plugin.call", { method: "xd.composerPoints", args: { chip } })
        .then((next) => {
          if (stop) return;
          // The chip is switched off in the panel: `show: false` alone cannot
          // say that, and without this the poll would keep asking every few
          // minutes for the rest of the session about a feature nobody is
          // using. The timer stops here; a model change remounts this effect
          // and starts it again.
          if (next && next.enabled === false) {
            setData(null);
            clearTimeout(timer);
            return;
          }
          setData(next && next.show === true ? next : null);
          schedule(next);
        })
        .catch(() => { if (!stop) { setData(null); schedule(null); } });
    };
    restartPollRef.current = () => { clearTimeout(timer); startedAt = Date.now(); pull(); };
    pull();
    return () => { stop = true; clearTimeout(timer); restartPollRef.current = () => {}; };
  }, [chip]);

  // A cooling account recovers by itself, so the notice that named it has to go
  // when that account starts serving: it described a state that no longer
  // holds, and it is this popup's own marking that says so.
  useEffect(() => {
    if (errorFor === "" || data === null) return undefined;
    const row = (data.accounts || []).find((account) => account.id === errorFor);
    if (row && row.active === true) {
      setError("");
      setErrorFor("");
    }
    return undefined;
  }, [data, errorFor]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event) => {
      const target = event.target;
      if ((rootRef.current && rootRef.current.contains(target)) || (panelRef.current && panelRef.current.contains(target))) return;
      setOpen(false);
    };
    const onKey = (event) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !rootRef.current) return undefined;
    const placePanel = () => {
      const rect = rootRef.current.getBoundingClientRect();
      const right = Math.max(PANEL_MARGIN, window.innerWidth - rect.right);
      // The cap counts the column the right anchor already took, so the box
      // stops at the window's left edge instead of hanging past it. The floor
      // is clamped the same way, so a narrow window shortens the box rather
      // than pushing it off the edge.
      const width = Math.max(0, Math.min(PANEL_MAX_WIDTH, window.innerWidth - right - PANEL_MARGIN));
      setPlace({
        right,
        top: Math.max(PANEL_MARGIN, rect.top - PANEL_MARGIN),
        minWidth: Math.min(PANEL_MIN_WIDTH, width),
        maxWidth: width,
      });
    };
    placePanel();
    window.addEventListener("resize", placePanel);
    return () => window.removeEventListener("resize", placePanel);
  }, [open, data]);

  const h = React.createElement;
  // No answer means no chip at all. `hidden` cannot do it: the class sets
  // `display:inline-flex`, an author rule beats the attribute's user-agent
  // rule, and an empty pill was left sitting in the composer. The outer span
  // stays mounted either way - the observer above reads the selected model
  // from it.
  const button = data === null ? null : h("button", {
    type: "button",
    className: "xd-points-btn",
    title: W.title,
    "aria-expanded": open,
    onClick: () => setOpen((value) => !value),
  },
    h("span", { className: "xd-points-mark", "aria-hidden": "true" }),
    chipText(data),
  );

  return h("span", { className: "xd-points", ref: rootRef },
    button,
    open && data && place
      ? h("div", {
          className: "xd-points-panel",
          ref: panelRef,
          role: "dialog",
          "aria-label": W.title,
          style: { right: place.right + "px", top: place.top + "px", minWidth: place.minWidth + "px", maxWidth: place.maxWidth + "px", transform: "translateY(-100%)" },
        },
        h("div", { className: "xd-points-bar" },
          h("span", null, W.title),
          h("button", {
            type: "button",
            className: "xd-points-refresh",
            disabled: refreshing,
            onClick: () => {
              if (!host || refreshing) return;
              setRefreshing(true);
              setError("");
              const requestedChip = chip;
              host.dispatch("plugin.call", { method: "xd.composerRefresh", args: { chip } })
                .then((next) => {
                  if (chipRef.current !== requestedChip) return;
                  if (next && next.show === true) setData(next);
                })
                .catch((failure) => {
                  if (chipRef.current !== requestedChip) return;
                  setError(String(failure && failure.message ? failure.message : failure));
                })
                .finally(() => { setRefreshing(false); });
            },
          }, refreshing ? W.refreshing : W.refresh),
        ),
        error ? h("p", { role: "alert" }, error) : null, accountTable(h, data, (account) => {
          if (!host || account.active === true) return;
          setError("");
          setErrorFor("");
          const requestedChip = chip;
          host.dispatch("plugin.call", {
            method: "xd.composerPrefer",
            args: {
              chip,
              source: data.source,
              region: data.region,
              accountId: account.id || "",
              accountLabel: account.label || "",
            },
          }).then((next) => {
            if (chipRef.current !== requestedChip) return;
            // `saved` is the main process's word for "the preference is stored
            // and already in force", so it is the one thing that separates a
            // refusal from a snapshot that merely went missing between the
            // popup's read and this click.
            if (!next || next.saved !== true) {
              setError(W.refused);
              setErrorFor("");
              return;
            }
            if (next.show !== true) {
              setError(W.saved);
              setErrorFor(account.id || "");
              return;
            }
            setData(next);
            restartPollRef.current();
            // `unavailable` means the preference was stored but the account
            // cannot serve yet - the pool skips a cooling, switched-off or
            // reserve-held one - so the marked row is still someone else and the
            // click would look ignored if the popup closed on it.
            if (next.unavailable === true) {
              setError(W.unavailable);
              setErrorFor(account.id || "");
              return;
            }
            setOpen(false);
          }).catch((failure) => {
            if (chipRef.current === requestedChip) setError(String(failure && failure.message ? failure.message : failure));
          });
        }))
      : null,
  );
}

/**
 * The number alone.
 *
 * Naming the source beside it (`WorkBuddy 国内 · 12,345`) pushed the chip past
 * the width the composer gives it, and the text was ellipsised before the
 * balance - the one thing it exists to say - could be read. Which account the
 * number belongs to is what the panel behind the click answers.
 */
function chipText(data) {
  return typeof data.total === "number" ? formatCredits(data.total) : "—";
}

function accountTable(h, data, onPick) {
  const W = words();
  const qoder = data.source === "qoder";
  const rows = (data.accounts || []).map((account) => h("tr", {
    key: account.id || account.label,
    className: "xd-points-row" + (account.active ? " is-active" : ""),
  },
    h("td", null,
      account.active ? h("span", { className: "xd-points-dot", "aria-hidden": "true" }) : null,
      // The name is bounded by the cell, so a long one is ellipsised rather than
      // stretching the panel; the full value stays reachable on hover.
      h("button", { type: "button", className: "xd-points-btn", title: account.label || "", disabled: account.active === true, onClick: () => onPick(account) }, account.label)),
    h("td", null,
      typeof account.total === "number" ? formatCredits(account.total) : (account.plan || "—"),
      qoder && Array.isArray(account.packages)
        ? h("ul", { className: "xd-points-packs" }, account.packages.map((pack, index) => {
            const when = packWhen(pack);
            const remain = typeof pack.remain === "number" ? formatCredits(pack.remain) : "—";
            return h("li", { key: index }, packName(pack) + " " + remain + (when === "" ? "" : " · " + when));
          }))
        : null,
    ),
  ));
  return h("table", { className: "xd-points-table" },
    h("thead", null, h("tr", null, h("th", null, W.account), h("th", null, W.balance))),
    h("tbody", null, rows),
  );
}
