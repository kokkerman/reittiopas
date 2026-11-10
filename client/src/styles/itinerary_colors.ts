// the colors used for the different routes in the planner

import type { ExpressionSpecification } from "maplibre-gl";

export const ITINERARY_COLORS = ["#4f9cf9", "#f59e0b", "#e879f9", "#34d399", "#f87171", "#22d3ee", "#a3e635", "#fb923c"];

export function itinerary_color(index: number): string {
  return ITINERARY_COLORS[index % ITINERARY_COLORS.length];
}

// only god knows
export const ITINERARY_COLOR_EXPRESSION = [
  "match",
  ["%", ["get", "route"], ITINERARY_COLORS.length],
  ...ITINERARY_COLORS.flatMap(function (color, i) {
    return [i, color];
  }),
  ITINERARY_COLORS[0],
] as unknown as ExpressionSpecification;
