// Shareable setup: shell colour and play style, from stored preferences and a validated URL fragment.
// A shared setup is not a score and not a replay.

import { SHELL_COLOURS, type ShellColour } from '../robot/materials.ts';

export interface Settings {
  shell: ShellColour;
  trial: boolean;
  course: 'corner';
  v: 1;
}

export const DEFAULT_SETTINGS: Settings = { shell: 'red', trial: false, course: 'corner', v: 1 };

const isShell = (v: unknown): v is ShellColour => typeof v === 'string' && Object.hasOwn(SHELL_COLOURS, v);

/** Pure: stored preferences, then the URL fragment on top. Unknown keys and values are dropped. */
export function parseSettings(hash: string, stored: unknown): Settings {
  const s: Settings = { ...DEFAULT_SETTINGS };
  if (stored && typeof stored === 'object') {
    const o = stored as Record<string, unknown>;
    if (isShell(o.shell)) s.shell = o.shell;
    if (typeof o.trial === 'boolean') s.trial = o.trial;
  }
  try {
    const p = new URLSearchParams(hash.replace(/^#/, ''));
    const shell = p.get('shell');
    if (isShell(shell)) s.shell = shell;
    const trial = p.get('trial');
    if (trial === '1' || trial === '0') s.trial = trial === '1';
  } catch {
    /* keep what we have */
  }
  return s;
}

export function shareFragment(s: Settings): string {
  return new URLSearchParams({ course: `${s.course}-v${s.v}`, shell: s.shell, trial: s.trial ? '1' : '0' }).toString();
}
