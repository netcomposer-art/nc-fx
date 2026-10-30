// The panel's own CSS. The cards, fields, sliders, selects, switches, "More" and notes are the nc-ui kit's markup and
// are styled by the live nc-ui stylesheet (/nc-ui/nc-ui.css); this only lays out what the kit has no class for: the
// Add row, the move and remove buttons on a card, the limiter line, and the delay's Free time marks.
// The panel itself is stack-1 of nc-ui's module shading (docs/design-rules.md), with the same four declarations as the
// kit's stack-1 rule (specific enough to win over the kit's adjacent shade for an inset section); it is the kit's
// inset section, so it bleeds to its module's edges and pads itself; its cards (kit .nc-ui-fx[data-nc-depth]) are
// stack-2, -3, -4 by position, and bleed to its edges.
// Lengths and colours come only from nc-ui custom properties (no raw colours, no px); the only fallbacks are
// currentColor / inherit. Motion: one-off feedback only, through nc-ui's motion roles (100-250 ms); none on a
// modulated slider; none under reduced motion.
// nc-fx was created by Peter Semmelhack (https://psem.me/). MIT License.
export var FX_UI_CSS = `
.nc-fx{display:flex;flex-direction:column;gap:var(--nc-ui-module-gap);min-width:0;font-family:var(--nc-ui-font-ui,inherit);color:var(--nc-ui-text,inherit)}
.nc-section.nc-fx[data-nc-inset="true"][data-nc-fx][data-testid]{background:var(--nc-ui-module-bg-stack-1,transparent);--nc-ui-text-sub:var(--nc-ui-module-sub-stack-1);--nc-ui-divider:var(--nc-ui-module-div-stack-1);--nc-ui-slider-track:var(--nc-ui-module-div-stack-1)}
.nc-fx-stack{display:flex;flex-direction:column;min-width:0}
.nc-fx-add{display:flex;align-items:baseline;gap:var(--nc-ui-module-gap);min-width:0}
.nc-fx-add .nc-readout{color:var(--nc-ui-text-sub,inherit);font-size:var(--nc-ui-label-size)}
.nc-fx .nc-ui-fx-hd>.nc-ui-fx-name{flex:1 1 auto}
.nc-fx .nc-field[data-nc-fx-select]{display:grid;grid-template-columns:minmax(min(var(--nc-ui-name-width),100%),1fr) auto;grid-template-areas:"label value" "select select";align-items:baseline;column-gap:var(--nc-ui-module-gap);row-gap:var(--nc-ui-control-gap);padding-bottom:var(--nc-ui-module-gap)}
.nc-fx .nc-field[data-nc-fx-select]>.nc-label{grid-area:label;min-width:0}
.nc-fx .nc-field[data-nc-fx-select]>.nc-readout{grid-area:value;max-width:none;text-align:right}
.nc-fx .nc-field[data-nc-fx-select]>.nc-select{grid-area:select;width:100%}
.nc-fx-move{display:inline-flex;flex-direction:column;gap:var(--nc-ui-control-gap);flex:none}
.nc-fx-move-btn,.nc-fx-remove{position:relative;margin:0;padding:0;border:none;background:transparent;color:var(--nc-ui-text-sub,currentColor);cursor:pointer;transition:color var(--nc-ui-transition-feedback,.15s)}
.nc-fx-move-btn{display:flex;align-items:center;justify-content:center;line-height:var(--nc-ui-leading-none)}
.nc-fx-move-btn svg{display:block;inline-size:var(--nc-ui-label-size);block-size:var(--nc-ui-label-size);fill:none;stroke:currentColor;stroke-width:var(--nc-ui-curve-stroke);stroke-linejoin:round}
.nc-fx-move-btn:disabled{opacity:var(--nc-ui-opacity-30);cursor:default}
.nc-fx-remove{flex:none;padding-bottom:var(--nc-ui-control-gap);font:inherit;font-size:var(--nc-ui-label-size);font-weight:var(--nc-ui-control-weight);line-height:var(--nc-ui-label-leading)}
.nc-fx-move-btn:hover:not(:disabled),.nc-fx-remove:hover{color:var(--nc-ui-text,currentColor)}
.nc-fx-move-btn:focus-visible,.nc-fx-remove:focus-visible{outline-style:solid;outline-width:var(--nc-ui-focus-width);outline-color:var(--nc-ui-focus-ring,currentColor);outline-offset:var(--nc-ui-hairline)}
.nc-fx-limiter{font-family:var(--nc-ui-font-readout,inherit)}
.nc-fx .nc-field[data-overridden] .nc-select{color:var(--nc-ui-text-sub,inherit)}
.nc-fx .nc-field[data-free] .nc-readout{color:var(--nc-ui-accent,currentColor)}
@media (pointer:coarse){.nc-fx-move-btn::before,.nc-fx-remove::before{content:"";position:absolute;left:50%;inline-size:max(100%,var(--nc-ui-target-min));block-size:max(100%,var(--nc-ui-target-min));transform:translateX(-50%)}.nc-fx-move-btn:first-child::before{bottom:0}.nc-fx-move-btn:last-child::before{top:0}.nc-fx-remove::before{top:50%;transform:translate(-50%,-50%)}}
.nc-fx [data-modulated]{transition:none}
@media (prefers-reduced-motion:reduce){.nc-fx,.nc-fx *{transition:none;animation:none}}
`.trim();
