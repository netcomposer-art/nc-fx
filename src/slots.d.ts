import type { FxType } from './catalog.js';
export interface FxSlotV2 { id: string; type: FxType; bypass: boolean; dials: Record<string, number> }
/** The slot chain's state: first to last; the limiter is fixed after the last. JSON-safe. */
export interface FxSlotState { v: 2; chain: FxSlotV2[] }
/** ASTRID's saved hack (hacks.ts HackSlot). */
export interface AstridHackSlot { id: string; type: string; bypass: boolean; dials: Record<string, number> }

export const SLOTS_VERSION: 2;
export const DEFAULT_SLOTS: 3;
export function newSlot(type: string, chain?: ReadonlyArray<{ id: string }>): FxSlotV2 | null;
export function slotName(slot: { id: string; type: string }): string;
export function moveSlot<T>(chain: T[], from: number, to: number): T[];
/** Any saved chain (v2, v1, ASTRID's HackSlot[] / HackWidget[] / schema-2 document) to v2; never throws. */
export function migrateSlots(raw: unknown, max?: number): { state: FxSlotState; dropped: string[]; notes: string[] };
export function sanitizeSlots(raw: unknown, max?: number): FxSlotState;
/** [k, value] engine params for one slot (k 0 = on). */
export function slotProgram(slot: FxSlotV2): Array<[number, number]>;
export function toAstridHacks(state: unknown): { hacks: AstridHackSlot[]; lossy: string[] };
export function astridParams(slot: FxSlotV2, tempo: number): Record<string, number | string | null>;
export function toAstridDocument(state: unknown, tempo: number): { schema: 2; chain: object[] };
