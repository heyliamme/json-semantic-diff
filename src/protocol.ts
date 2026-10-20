import type { DiffOptions } from './core/diff';

export type Side = 'left' | 'right';

export interface SideData {
  label: string;
  /** Second line in the column header: a path, a git ref, "selection, lines 4–20". */
  detail?: string;
  text: string;
  /** Double-clicking a line can open the source at that line. */
  canReveal: boolean;
  /** What the host needs to reopen this side after a window reload. */
  restore: Restore;
}

export interface Restore {
  label: string;
  detail?: string;
  uri?: string;
  /** The file this side shows as of HEAD. */
  head?: string;
  /** Kept for sides that can't be read back from their document. */
  text?: string;
  lineOffset?: number;
  live?: boolean;
}

export interface ViewOptions extends DiffOptions {
  changesOnly: boolean;
  /** Unchanged objects and arrays longer than this many lines start folded. */
  foldThreshold: number;
}

export type ToWebview =
  | { type: 'init'; left: SideData; right: SideData; options: ViewOptions }
  | { type: 'side'; side: Side; data: SideData }
  | { type: 'options'; options: ViewOptions };

export type FromWebview =
  | { type: 'ready' }
  | { type: 'reveal'; side: Side; line: number; col: number }
  | { type: 'textDiff'; left: string; right: string; options: DiffOptions }
  | { type: 'copy'; text: string; what: string }
  | { type: 'pick'; side: Side }
  | { type: 'paste'; side: Side }
  | { type: 'swap' }
  | { type: 'saveIgnore'; patterns: string[] };
