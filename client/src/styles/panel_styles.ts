// shared styling that will find a better home in the future

export const PANEL_SURFACE ="map-panel rounded-2xl border border-neutral-700/60 bg-neutral-900 text-neutral-100 shadow-lg shadow-black/50";

export const BOTTOM_PANEL_POSITION = "absolute inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-10 sm:inset-x-auto sm:bottom-4 sm:left-4 sm:w-96";

export const BOTTOM_PANEL = `${BOTTOM_PANEL_POSITION} flex flex-col overflow-hidden ${PANEL_SURFACE}`;

export const SHEET_SPRING = { type: "spring", stiffness: 700, damping: 60, mass: 0.6 } as const;

export const TOP_PANEL = `absolute inset-x-3 top-[max(0.75rem,env(safe-area-inset-top))] z-10 sm:inset-x-auto sm:top-4 sm:left-4 sm:w-96 ${PANEL_SURFACE}`;

export const PANEL_SPRING = { type: "spring", stiffness: 520, damping: 42, mass: 0.8 } as const;

export const BOTTOM_PANEL_MOTION = {
  initial: { y: 40, opacity: 0 },
  animate: { y: 0, opacity: 1 },
  exit: { y: 40, opacity: 0 },
  transition: PANEL_SPRING,
} as const;

export const TOP_PANEL_MOTION = {
  initial: { y: -24, opacity: 0 },
  animate: { y: 0, opacity: 1 },
  exit: { y: -24, opacity: 0 },
  transition: PANEL_SPRING,
} as const;
