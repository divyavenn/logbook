// A few kinds of touch feedback, each meaning one thing, played by the handler
// that commits an action: never for a press alone, a caret placed, or a scroll.
export type HapticKind = 'selection' | 'success' | 'soft' | 'start' | 'stop' | 'warning' | 'celebrate';

const PATTERNS: Record<HapticKind, number | number[]> = {
  selection: 5,
  success: 10,
  soft: 6,
  start: 14,
  stop: [8, 50, 8],
  warning: [20, 40, 20],
  celebrate: [10, 60, 10, 60, 24],
};

// iOS Safari has no vibration, but toggling a native switch plays the system
// tick (iOS 18 and later). Only one strength, and only inside a gesture, so
// every kind is the same tick there. The switch lives on the body, outside
// any inert part of the page, and is never seen or focused.
let tick: HTMLLabelElement | null = null;
function iosTick() {
  if (!tick) {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('switch', '');
    input.id = 'still-haptic-switch';
    input.tabIndex = -1;
    const label = document.createElement('label');
    label.htmlFor = input.id;
    label.setAttribute('aria-hidden', 'true');
    label.append(input);
    label.style.cssText = 'position:fixed;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);opacity:0;pointer-events:none;';
    document.body.append(label);
    tick = label;
  }
  const active = document.activeElement;
  tick.click();
  // The label must not take the caret from whatever was being written in.
  if (active instanceof HTMLElement && document.activeElement !== active) active.focus({ preventScroll: true });
}

export function haptic(kind: HapticKind) {
  if (document.visibilityState === 'hidden') return;
  if (typeof navigator.vibrate === 'function') { navigator.vibrate(PATTERNS[kind]); return; }
  if (window.matchMedia('(pointer: coarse)').matches) iosTick();
}

// The streak lengths worth marking when a day reaches them.
export const STREAK_MILESTONES = new Set([7, 30, 100, 365]);
