// nc-fx plugins (docs/plugins.md). The manifest is plugin.json; the DSP is one script that runs in the AudioWorklet
// and calls registerNcFxPlugin() (types: ./plugin-worklet.d.ts).
import type { FxCatalogEntry } from './catalog.js';

/** A plugin's catalog type: 'plugin:<id>'. */
export type FxPluginType = `plugin:${string}`;

/** One dial. Field names are Web Audio Modules 2.0's WamParameterConfiguration's. */
export interface NcPluginParam {
  /** Lowercase, starting with a letter: letters, digits, _ (not "bypass"). The DSP's set(key, value) gets it. */
  id: string;
  /** The dial's name on the card (up to 24 characters). */
  label: string;
  /** Default 'float'. 'choice' is 0 to choices.length - 1; 'boolean' is 0 or 1. */
  type?: 'float' | 'int' | 'boolean' | 'choice';
  /** Default: minValue. */
  defaultValue?: number;
  /** float and int: required. */
  minValue?: number;
  maxValue?: number;
  /** The dial's step. float: about a hundredth of the range when left out; int: 1. */
  discreteStep?: number;
  /** WAM's skew: kept for WAM hosts; the Studio's dials are linear. */
  exponent?: number;
  /** choice: 2 to 16 names. */
  choices?: string[];
  /** The readout's unit: 'Hz', 'ms', '%', 'dB' ... (up to 8 characters). */
  units?: string;
  /** Show this dial under the card's More. */
  more?: boolean;
}
/** plugin.json (schema/plugin-manifest.schema.json). */
export interface NcPluginManifest {
  $schema?: string;
  ncPlugin: 1;
  /** yourname.effect: lowercase letters and digits, dots or dashes between, up to 64. Saved in sessions. */
  id: string;
  name: string;
  /** x.y.z */
  version: string;
  author: string;
  /** An SPDX licence id, e.g. 'MIT'. */
  licence: string;
  description?: string;
  website?: string;
  keywords?: string[];
  /** The DSP file's name, next to plugin.json. */
  dsp: string;
  /** Up to 15. */
  params: NcPluginParam[];
}
/** A validated manifest: every param's type, range, step and default filled in. */
export interface NcPluginManifestClean extends NcPluginManifest {
  params: Array<Required<Pick<NcPluginParam, 'id' | 'label' | 'type' | 'defaultValue' | 'minValue' | 'maxValue' | 'discreteStep'>> & NcPluginParam>;
}
/** A plugin's facts on its catalog entry. */
export interface FxPluginInfo {
  id: string; version: string; author: string; licence: string;
  /** The worklet's name for it: 'plugin:<id>@<version>'. */
  engine: string;
  /** Slot ids: '<idBase>-1' (the id's last part). */
  idBase: string;
  /** Where plugin.json was loaded from ('' when registered by hand). */
  url: string;
  /** Loaded from the listed registry (sha256 checked). */
  listed: boolean;
  website?: string;
}
export interface FxPluginEntry extends Omit<FxCatalogEntry, 'type'> { type: FxPluginType; plugin: FxPluginInfo }
/** What a chain's getChain() says about a plugin slot. */
export interface FxPluginStatus {
  id: string; version: string; url: string; name: string;
  /** missing: not loaded on this page (the slot is a wire, its dials kept); failed: stopped by nc-fx (a wire). */
  status: 'ready' | 'missing' | 'failed';
  /** For 'failed': one sentence (PLUGIN_ERRORS). */
  error?: string;
}
/** A registry entry (schema/plugin-registry.schema.json). */
export interface NcPluginListing {
  id: string; name: string; version: string; author: string; licence: string; description?: string;
  /** plugin.json, relative to registry.json. */
  manifest: string;
  integrity: { manifest: string; dsp: string };
  checked: string;
}
export interface NcPluginRegistry { v: 1; plugins: NcPluginListing[] }
export interface LoadPluginOptions {
  /** Where nc-fx's dist/worklet.js is served (as createFxCore's moduleUrl); omitted: the Blob fallback. */
  moduleUrl?: string | URL;
  /** sha256 of each file ('sha256-<base64>'): the load fails if either differs. */
  integrity?: { manifest?: string; dsp?: string };
  listed?: boolean;
  expect?: { id?: string; version?: string };
  fetch?: typeof fetch;
  /** Base for a relative url (default: location.href). */
  base?: string;
}

export const PLUGIN_API: 1;
export const PLUGIN_ERRORS: Readonly<Record<1 | 2 | 3 | 4 | 5, string>>;
export function validateManifest(raw: unknown): { ok: boolean; errors: string[]; manifest: NcPluginManifestClean | null };
export function validateRegistry(raw: unknown): { ok: boolean; errors: string[]; registry: NcPluginRegistry };
export function pluginType(id: string): FxPluginType;
export function pluginEntryFromManifest(manifest: NcPluginManifestClean, info?: { url?: string; listed?: boolean }): FxPluginEntry;
/** Into the catalog (the DSP must be registered in the worklet too: loadPlugin does both). Throws for a bad manifest or another version of a loaded id. */
export function registerPlugin(manifest: NcPluginManifest, info?: { url?: string; listed?: boolean }): FxPluginEntry;
/** Fetch, check, load into the context's AudioWorklet and register. Only on a user's action: it runs the plugin's code. */
export function loadPlugin(ctx: BaseAudioContext, url: string | URL, opts?: LoadPluginOptions): Promise<{ entry: FxPluginEntry; manifest: NcPluginManifestClean; url: string }>;
/** The largest DSP file the contract allows: 256 KB. */
export const MAX_DSP_BYTES: number;
/** Load from the two files' contents (no network): for plugins on this computer. `url` is what sessions save (default `local:<id>`), never fetched. Only on a user's action. */
export function loadPluginFiles(ctx: BaseAudioContext, files: { manifest: string | NcPluginManifest; dsp: string; dspName?: string }, opts?: { moduleUrl?: string | URL; url?: string }): Promise<{ entry: FxPluginEntry; manifest: NcPluginManifestClean; url: string }>;
export function loadListedPlugin(ctx: BaseAudioContext, item: NcPluginListing, registryUrl: string, opts?: Omit<LoadPluginOptions, 'integrity' | 'listed' | 'expect'>): Promise<{ entry: FxPluginEntry; manifest: NcPluginManifestClean; url: string }>;
export function fetchRegistry(url: string | URL, opts?: { fetch?: typeof fetch; base?: string }): Promise<{ registry: NcPluginRegistry; url: string; errors: string[] }>;
export function sha256Integrity(bytes: Uint8Array | ArrayBuffer): Promise<string>;
export function toWamDescriptor(manifest: NcPluginManifest): Record<string, string | boolean | string[]>;
export function toWamParameterInfo(manifest: NcPluginManifest): Record<string, { id: string; label: string; type: string; defaultValue: number; minValue: number; maxValue: number; discreteStep: number; exponent: number; choices: string[]; units: string }>;
