// a hook holding the journey planner's state

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/api_client";
import type { Itinerary } from "../types/api_types";
import { error_message, is_abort_error } from "../utils/errors";
import { route_key } from "./use_route_groups";

export interface PlannerPlace {
  name: string;
  lat: number;
  lon: number;
}

export type PlannerField = "from" | "to";

type PlannerNotice = { text: string; route: string };

export interface Planner {
  from: PlannerPlace | null;
  to: PlannerPlace | null;
  active: PlannerField;
  time: number | null;
  arrive_time: number | null;
  set_arrive_time: (time: number | null) => void;
  arrive_limit: boolean;
  set_arrive_limit: (on: boolean) => void;
  load_more: (index: number) => void;
  loading_more: boolean;
  notice: PlannerNotice | null;
  itineraries: Itinerary[] | null;
  loading: boolean;
  error: string | null;
  selected: number | null;
  editing: boolean;
  set_editing: (editing: boolean) => void;
  set_place: (field: PlannerField, place: PlannerPlace | null) => void;
  set_active: (field: PlannerField) => void;
  set_time: (time: number | null) => void;
  swap: () => void;
  select: (index: number | null) => void;
  search: () => void;
  reset: () => void;
}

function has_transit(itinerary: Itinerary): boolean {
  return itinerary.legs.some(function (leg) {
    return leg.type === "transit";
  });
}

function ridden_route(itinerary: Itinerary): { line: string; from: string; to: string }[] {
  return itinerary.legs.flatMap(function (leg) {
    if (leg.type !== "transit") {
      return [];
    }

    return [{ line: leg.line, from: leg.from.stopId!, to: leg.to.stopId! }];
  });
}

// identifies an option by the exact vehicles it rides, to spot duplicates. shoutout claude
function trip_signature(itinerary: Itinerary): string {
  return itinerary.legs
    .map(function (leg) {
      return leg.type === "transit" ? leg.tripId : "";
    })
    .join(">");
}

function earliest_arrival(itineraries: Itinerary[]): number {
  const arrivals = itineraries.map(function (itinerary) {
    return itinerary.end;
  });
  return Math.min(...arrivals);
}

function latest_departure(itineraries: Itinerary[]): number {
  const departures = itineraries.map(function (itinerary) {
    return itinerary.start;
  });
  return Math.max(...departures);
}

function by_start_then_end(left: Itinerary, right: Itinerary): number {
  return left.start - right.start || left.end - right.end;
}

export function use_planner(): Planner {
  const [from, set_from] = useState<PlannerPlace | null>(null);
  const [to, set_to] = useState<PlannerPlace | null>(null);
  const [active, set_active] = useState<PlannerField>("from");
  const [time, set_time] = useState<number | null>(null);
  const [itineraries, set_itineraries] = useState<Itinerary[] | null>(null);
  const [loading, set_loading] = useState(false);
  const [error, set_error] = useState<string | null>(null);
  const [selected, set_selected] = useState<number | null>(null);
  const [editing, set_editing] = useState(true);
  const [arrive_time, set_arrive_time] = useState<number | null>(null);
  const [arrive_limit, set_arrive_limit] = useState(false);
  const [loading_more, set_loading_more] = useState(false);
  const [notice, set_notice] = useState<PlannerNotice | null>(null);

  const request = useRef<AbortController | null>(null);

  function deadline(): number | null {
    if (!arrive_limit) {
      return null;
    }

    return arrive_time ?? Math.floor(Date.now() / 1000);
  }

  function show_error_unless_aborted(caught_error: unknown) {
    if (!is_abort_error(caught_error)) {
      set_error(error_message(caught_error));
    }
  }

  const limiting_arrive_time = arrive_limit ? arrive_time : null;

  useEffect(
    function () {
      request.current?.abort();
      set_itineraries(null);
      set_selected(null);
      set_error(null);
      set_loading(false);
      set_loading_more(false);
      set_notice(null);
    },
    [from, to, time, arrive_limit, limiting_arrive_time],
  );

  const search = useCallback(
    function () {
      if (!from || !to) return;

      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;

      set_itineraries(null);
      set_selected(null);
      set_error(null);
      set_notice(null);
      set_loading(true);

      api
        .plan(from, to, time, deadline(), controller.signal)
        .then(function (response) {
          set_itineraries(response.itineraries);
        })
        .catch(show_error_unless_aborted)
        .finally(function () {
          if (!controller.signal.aborted) {
            set_loading(false);
          }
        });
    },
    [from, to, time, arrive_limit, arrive_time],
  );

  const load_more = useCallback(
    function (index: number) {
      const current = itineraries;
      const base = current?.[index];
      if (!from || !to || !current || !base || loading_more) return;

      const route = ridden_route(base);
      if (!route.length && !arrive_limit) return;

      const controller = new AbortController();
      request.current = controller;
      set_loading_more(true);

      let plan_request;
      if (arrive_limit) {
        const rides = current.filter(has_transit);
        plan_request = api.plan(from, to, time, earliest_arrival(rides) - 60, controller.signal);
      } else {
        const same_route = current.filter(function (itinerary) {
          return route_key(itinerary) === route_key(base);
        });
        plan_request = api.plan(from, to, latest_departure(same_route) + 60, null, controller.signal, route);
      }

      plan_request
        .then(function (response) {
          const known_trips = new Set(current.map(trip_signature));
          const fresh = response.itineraries.filter(function (itinerary) {
            return has_transit(itinerary) && !known_trips.has(trip_signature(itinerary));
          });

          if (!fresh.length) {
            const text = arrive_limit ? "Ei aiempia vaihtoehtoja" : "Ei myöhempiä lähtöjä tälle reitille";
            set_notice({ text, route: route_key(base) });
            return;
          }

          const merged = [...current, ...fresh].sort(by_start_then_end);
          set_notice(null);
          set_itineraries(merged);
          set_selected(function (selected_index) {
            return merged.indexOf(current[selected_index ?? index]);
          });
        })
        .catch(show_error_unless_aborted)
        .finally(function () {
          if (!controller.signal.aborted) {
            set_loading_more(false);
          }
        });
    },
    [from, to, time, arrive_limit, itineraries, loading_more],
  );

  const set_place = useCallback(function (field: PlannerField, place: PlannerPlace | null) {
    if (field === "to") {
      set_to(place);
      return;
    }

    set_from(place);
    if (place) {
      set_active("to");
    }
  }, []);

  const swap = useCallback(
    function () {
      set_from(to);
      set_to(from);
    },
    [from, to],
  );

  const reset = useCallback(function () {
    set_from(null);
    set_to(null);
    set_active("from");
    set_time(null);
    set_arrive_time(null);
    set_arrive_limit(false);
    set_editing(true);
  }, []);

  return {
    from,
    to,
    active,
    time,
    itineraries,
    loading,
    error,
    selected,
    editing,
    set_editing,
    set_place,
    set_active,
    set_time,
    swap,
    select: set_selected,
    search,
    reset,
    arrive_time,
    set_arrive_time,
    arrive_limit,
    set_arrive_limit,
    load_more,
    loading_more,
    notice,
  };
}

function arrives_sooner(candidate: Itinerary, current_best: Itinerary): boolean {
  if (candidate.end !== current_best.end) {
    return candidate.end < current_best.end;
  }

  return candidate.duration < current_best.duration;
}

export function focused_index(planner: Pick<Planner, "selected" | "itineraries">): number | null {
  if (planner.selected !== null) return planner.selected;

  const { itineraries } = planner;
  if (!itineraries?.length) return null;

  let best = 0;
  itineraries.forEach(function (candidate, i) {
    if (arrives_sooner(candidate, itineraries[best])) {
      best = i;
    }
  });
  return best;
}
