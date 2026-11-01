// Types for a plugin's DSP file (it runs in the AudioWorklet, after nc-fx's module). Reference it from a typed
// plugin: /// <reference path="node_modules/@netcomposer/nc-fx/src/plugin-worklet.d.ts" />
export {};
declare global {
  /** One insert of the plugin. Every buffer is made in create(); process() and set() allocate nothing. */
  interface NcFxPluginInstance {
    /** A dial moved or a saved value loaded: `key` is the param's id, `value` in plugin.json's units. */
    set?(key: string, value: number): void;
    /** 1 to 128 frames: read inL/inR (don't write them), write outL/outR. Never throw. */
    process(inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array, frames: number): void;
    /** Drop tails and state (panic, or a fresh insert). */
    reset?(): void;
  }
  interface NcFxPluginDefinition {
    /** plugin.json's id. */
    id: string;
    /** plugin.json's version. */
    version: string;
    /** plugin.json's param ids, in the same order. */
    params: string[];
    create(sampleRate: number): NcFxPluginInstance;
  }
  /** Given by nc-fx's worklet. False if the definition is refused. */
  function registerNcFxPlugin(def: NcFxPluginDefinition): boolean;
}
