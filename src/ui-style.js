// The panel's CSS. Colour comes only from nc-ui tokens (custom properties); the only fallbacks are
// currentColor / inherit, so nothing here picks a colour of its own. Motion: one-off feedback only,
// through nc-ui's motion roles (100-250 ms); none on a modulated slider; none under reduced motion.
// nc-fx was created by Peter Semmelhack (https://psem.me/). MIT License.
export var FX_UI_CSS = `
.nc-fx{font-family:var(--nc-ui-font-ui,inherit);color:var(--nc-ui-text,inherit);display:grid;gap:var(--nc-ui-space-3,12px)}
.nc-fx-sec{display:grid;gap:var(--nc-ui-space-2,8px);background:var(--nc-ui-module-bg-stack-2,transparent);padding:var(--nc-ui-space-2,8px)}
.nc-fx-sec[data-bypass] .nc-fx-row{opacity:var(--nc-ui-disabled-opacity,.5)}
.nc-fx-head{display:flex;align-items:center;justify-content:space-between;gap:var(--nc-ui-space-2,8px)}
.nc-fx-title{font-size:var(--nc-ui-label-size,12px);font-weight:600;margin:0}
.nc-fx-on{font:inherit;font-size:var(--nc-ui-label-size,12px);color:var(--nc-ui-text-sub,inherit);background:transparent;border:1px solid currentColor;padding:0 var(--nc-ui-space-2,8px);cursor:pointer;transition:color var(--nc-ui-transition-feedback,.15s),border-color var(--nc-ui-transition-feedback,.15s)}
.nc-fx-on[aria-pressed="true"]{color:var(--nc-ui-accent,currentColor)}
.nc-fx-on:focus-visible,.nc-fx-row input:focus-visible,.nc-fx-row select:focus-visible{outline:2px solid var(--nc-ui-focus-ring,currentColor);outline-offset:2px}
.nc-fx-row{display:grid;grid-template-columns:5.5em 1fr 5.5em;align-items:center;gap:var(--nc-ui-space-2,8px)}
.nc-fx-row label{font-size:var(--nc-ui-label-size,12px);color:var(--nc-ui-text-sub,inherit)}
.nc-fx-row input[type=range]{width:100%;margin:0;accent-color:var(--nc-ui-accent,currentColor)}
.nc-fx-row select{font:inherit;font-size:var(--nc-ui-label-size,12px);color:inherit;background:transparent;border:1px solid currentColor}
.nc-fx-row output{font-family:var(--nc-ui-font-readout,inherit);font-size:var(--nc-ui-readout-size,12px);text-align:right;font-variant-numeric:tabular-nums}
.nc-fx-row[data-overridden] select{opacity:var(--nc-ui-disabled-opacity,.5)}
.nc-fx-row[data-free] output{color:var(--nc-ui-accent,inherit);font-weight:600}
.nc-fx [data-modulated]{transition:none}
@media (prefers-reduced-motion:reduce){.nc-fx,.nc-fx *{transition:none;animation:none}}
`.trim();
