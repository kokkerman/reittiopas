// colors for each type of transport

import type { ExpressionSpecification } from "maplibre-gl";

export const MODE_COLORS: Record<string, string> = {
  BUS: "#3b9ce0",
  TRAM: "#2fbf7f",
  RAIL: "#b07cc6",
  SUBWAY: "#ff7a3d",
  FERRY: "#3fd0f0", // just in case
};
export const FALLBACK_COLOR = "#888888";


// once again
export const MODE_COLOR_EXPRESSION: ExpressionSpecification = [
  "match",
  ["get", "mode"],
  ...Object.entries(MODE_COLORS).flat(),
  FALLBACK_COLOR,
] as unknown as ExpressionSpecification;

export function mode_color(mode: string | null | undefined): string {
  return MODE_COLORS[mode ?? ""] ?? FALLBACK_COLOR;
}
