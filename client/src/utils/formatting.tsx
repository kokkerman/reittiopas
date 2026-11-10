// helpers for showing routes

import { LineTag } from "../components/transit_badges";
import type { Itinerary, Leg } from "../types/api_types";

export function transit_legs(itinerary: Itinerary) {
  return itinerary.legs.filter(function (leg) {
    return leg.type === "transit";
  });
}

export function LineBadge({ leg }: { leg: Leg }) {
  if (leg.type === "walk") return null;

  return <LineTag line={leg.line} mode={leg.mode} />;
}
