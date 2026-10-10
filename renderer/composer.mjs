import React, { useEffect, useRef, useState } from "react";

let host;

const CSS = `
.xd-points{position:relative;display:inline-flex;align-items:center;min-width:0}
.xd-points-btn{border:0;background:transparent;color:var(--ds-text,var(--ds-text-secondary,#c9cbd1));font:inherit;font-size:12px;line-height:1;display:inline-flex;align-items:center;gap:5px;padding:4px 7px;border-radius:999px;cursor:pointer;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.xd-points-btn:hover{background:var(--ds-bg-muted,rgba(127,127,127,.12))}
/* The trigger is a quiet text chip like the controls it sits beside, but the
   colour is one step stronger than tertiary: it is the account's balance, the
   one thing on that row worth a glance, and it has to be findable first. A dot
   carries that meaning without borrowing an icon set the host does not give. */
.xd-points-mark{display:inline-block;width:6px;height:6px;flex:0 0 auto;border-radius:50%;background:#3dd68c}
.xd-points-panel{position:fixed;z-index:40;min-width:240px;max-width:360px;max-height:320px;overflow:auto;padding:8px;border-radius:12px;background:var(--ds-bg-elevated,var(--ds-bg,#1c1d21));color:var(--ds-text,#e8e8ea);box-shadow:0 8px 28px rgba(0,0,0,.28);border:1px solid var(--ds-border,rgba(127,127,127,.25))}
.xd-points-table{width:100%;border-collapse:collapse;font-size:12px}
.xd-points-table th{text-align:left;font-weight:600;padding:4px 6px;color:var(--ds-text-secondary,#8b8d93)}
.xd-points-table td{padding:4px 6px;vertical-align:top}
.xd-points-row{cursor:pointer}
.xd-points-row:hover{background:var(--ds-bg-muted,rgba(127,127,127,.12))}
.xd-points-row.is-active{cursor:default}
.xd-points-dot{display:inline-block;width:6px;height:6px;margin-right:6px;border-radius:50%;background:#3dd68c;vertical-align:middle}
.xd-points-packs{margin:2px 0 0;padding:0;list-style:none;color:var(--ds-text-secondary,#8b8d93)}
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
  },
  en: {
    planQuota: "Plan", addOnQuota: "Add-on", credits: "Credits",
    never: "never expires", monthly: "monthly", days: (days) => days + " days",
    title: "Account credits", account: "Account", balance: "Credits",
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
  const [, setLocale] = useState(currentLocale());
  const W = words();
  const rootRef = useRef(null);
  const panelRef = useRef(null);
  const chipRef = useRef(chip);
  chipRef.current = chip;

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
    if (!host || chip === "") return undefined;
    let stop = false;
    const pull = () => {
      host.dispatch("plugin.call", { method: "xd.composerPoints", args: { chip } })
        .then((next) => { if (!stop) setData(next && next.show === true ? next : null); })
        .catch(() => { if (!stop) setData(null); });
    };
    pull();
    const timer = setInterval(pull, 300000);
    return () => { stop = true; clearInterval(timer); };
  }, [chip]);

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
      setPlace({ left: Math.max(8, rect.right - 280), top: Math.max(8, rect.top - 8) });
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
          style: { left: place.left + "px", top: place.top + "px", transform: "translateY(-100%)" },
        }, error ? h("p", { role: "alert" }, error) : null, accountTable(h, data, (account) => {
          if (!host || account.active === true) return;
          setError("");
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
            // The main process refuses a label it cannot honour - a sign-in that
            // expired between the two reads, say - and says so with show:false.
            // Closing regardless would leave the user believing the account
            // changed, so the panel stays open and the chip keeps reading as it
            // did before the click.
            if (chipRef.current === requestedChip && next && next.show === true) {
              setData(next);
              setOpen(false);
            }
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
      h("button", { type: "button", className: "xd-points-btn", disabled: account.active === true, onClick: () => onPick(account) }, account.label)),
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
