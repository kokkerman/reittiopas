// a hook that groups the routes

import { useMemo } from "react";
import type { Itinerary } from "../types/api_types";
import { focused_index, type Planner } from "./use_planner";

export interface RouteGroup {
  key: string;
  options: number[];
}

export function route_key(itinerary: Itinerary): string {
  const rides = itinerary.legs.flatMap(function (leg) {
    if (leg.type !== "transit") {
      return [];
    }

    return [`${leg.line}:${leg.from.stopId}>${leg.to.stopId}`];
  });

  return rides.length ? rides.join("|") : "walk";
}

export function group_itineraries(itineraries: Itinerary[]): RouteGroup[] {
  const by_key = new Map<string, RouteGroup>();
  itineraries.forEach(function (itinerary, i) {
    const key = route_key(itinerary);
    const existing_group = by_key.get(key);

    if (existing_group) {
      existing_group.options.push(i);
    } else {
      by_key.set(key, { key, options: [i] });
    }
  });

  function by_departure(left: number, right: number): number {
    return itineraries[left].start - itineraries[right].start;
  }

  function earliest_arrival(route_group: RouteGroup): number {
    const arrivals = route_group.options.map(function (i) {
      return itineraries[i].end;
    });
    return Math.min(...arrivals);
  }

  const groups = [...by_key.values()];
  for (const route_group of groups) {
    route_group.options.sort(by_departure);
  }

  return groups.sort(function (left, right) {
    return earliest_arrival(left) - earliest_arrival(right);
  });
}

export interface PlannerGroups {
  groups: RouteGroup[];
  focused: number | null;
  focused_group: number | null;
  shown_option: (group_index: number) => number;
}

export function use_planner_groups(planner: Pick<Planner, "itineraries" | "selected">): PlannerGroups {
  const groups = useMemo(
    function () {
      return group_itineraries(planner.itineraries ?? []);
    },
    [planner.itineraries],
  );
  const focused = focused_index(planner);

  let focused_group: number | null = null;
  if (focused !== null) {
    const found_index = groups.findIndex(function (route_group) {
      return route_group.options.includes(focused);
    });
    focused_group = found_index === -1 ? null : found_index;
  }

  function shown_option(group_index: number): number {
    if (group_index === focused_group && focused !== null) {
      return focused;
    }

    return groups[group_index].options[0];
  }

  return { groups, focused, focused_group, shown_option };
}
