export type HapticKind = 'tap' | 'impact';

export function haptic(kind: HapticKind = 'tap') {
  if (document.visibilityState === 'hidden' || typeof navigator.vibrate !== 'function') return;
  navigator.vibrate(kind === 'impact' ? 14 : 7);
}

export function installTouchHaptics() {
  const vibrate = (event: PointerEvent) => {
    if (event.pointerType !== 'touch' || !(event.target instanceof Element)) return;
    const control = event.target.closest<HTMLElement>(
      'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), summary, [role="button"], [role="tab"], [role="switch"], [role="group"][tabindex], [contenteditable="true"]',
    );
    if (!control || control.getAttribute('aria-disabled') === 'true') return;
    haptic(control.dataset.haptic === 'impact' ? 'impact' : 'tap');
  };
  document.addEventListener('pointerup', vibrate, { passive: true });
  return () => document.removeEventListener('pointerup', vibrate);
}
