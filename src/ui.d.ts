import type { FxCore } from './index.js';
export interface FxPanelOptions {
  fx: FxCore;
  /** Inject the panel CSS into the document (default true). False: link '@netcomposer/nc-fx/ui.css' yourself. */
  injectCss?: boolean;
  /** Only these effects (default all). */
  effects?: string[];
}
export interface FxPanel { readonly root: HTMLElement; update(): void; destroy(): void }
export function mountFxPanel(el: HTMLElement, opts: FxPanelOptions): FxPanel;
