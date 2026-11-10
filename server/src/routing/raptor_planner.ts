// claude did the heavy lifting for the writing of this mid algo

import type { Itinerary, Leg, Mode, Place, TransitLeg, WalkLeg } from "../types/api_types.js";
import { distance } from "../utils/geo_grid.js";
import type { Pattern, Timetable } from "./gtfs_timetable.js";
import type { WalkSearch } from "./walk_graph.js";

export interface PlanOptions {
  from: { lat: number; lon: number };
  to: { lat: number; lon: number };
  time: number;
  deadline: number | null;
  route: RideSpec[] | null;
  walk_speed: number;
  max_walk_distance: number;
  max_transfers: number;
  transfer_slack: number;
  modes: Set<Mode> | null;
  num_itineraries: number;
}

export interface RideSpec {
  line: string;
  from: string;
  to: string;
}

export const DEFAULT_PLAN_OPTIONS = {
  walkSpeed: 1.3,
  maxWalkDistance: 1000,
  maxTransfers: 4,
  transferSlack: 60,
  numItineraries: 8,
};

const DETOUR = 1.3;
const MAX_DIRECT_WALK = 3000;

const WALK_BEATS_RIDE = 1 / 3;

const WINDOW = 60 * 60;
const MAX_RUNS = 60;
const TIME_BUDGET_MS = 700;

const WALK_RELUCTANCE = 1.5;
const TRANSFER_PENALTY = 4 * 60;
const WAIT_AT_HOME_WEIGHT = 0.15;
const LIGHT_WALK = 400;
const MAX_LATE_ARRIVAL = 45 * 60;
const MAX_COST_RATIO = 1.4;
const MAX_COST_EXTRA = 10 * 60;
const ARRIVE_BY_PROBE = 3 * 3600;
const ROUTE_LOOKAHEAD = 4 * 3600;
const ROUTE_DEPARTURES = 5;
const MAX_CHANGE_WAIT = 45 * 60;
const INF = 0x7fffffff;

const ACCESS = 1;
const TRANSIT = 2;
const WALK = 3;

interface Round {
  arr: Int32Array;
  src: Int8Array;
  kind: Uint8Array;
  from: Int32Array;
  pattern: Int32Array;
  trip: Int32Array;
  board_pos: Int32Array;
  alight_pos: Int32Array;
  walk: Float32Array;
}

function new_round(stop_count: number, prev?: Round): Round {
  return {
    arr: prev ? prev.arr.slice() : new Int32Array(stop_count).fill(INF),
    src: prev ? prev.src.slice() : new Int8Array(stop_count).fill(-1),
    kind: new Uint8Array(stop_count),
    from: new Int32Array(stop_count),
    pattern: new Int32Array(stop_count),
    trip: new Int32Array(stop_count),
    board_pos: new Int32Array(stop_count),
    alight_pos: new Int32Array(stop_count),
    walk: new Float32Array(stop_count),
  };
}

interface Journey {
  rounds: Round[];
  round: number;
  egress_stop: number;
  egress_walk: number;
}

function walking_seconds(metres: number, walk_speed: number): number {
  return Math.round(metres / walk_speed);
}

function mode_allowed(options: PlanOptions, mode: Mode): boolean {
  return !options.modes || options.modes.has(mode);
}

function departure_at(pattern: Pattern, trip: number, position: number): number {
  return pattern.dep[trip * pattern.stops.length + position];
}

function arrival_at(pattern: Pattern, trip: number, position: number): number {
  return pattern.arr[trip * pattern.stops.length + position];
}

function earliest_trip(
  timetable: Timetable,
  pattern_index: number,
  position: number,
  ready: number,
  limit: number,
): number {
  const pattern = timetable.patterns[pattern_index];
  const stop_count = pattern.stops.length;
  let lo = 0;
  let hi = limit;
  while (lo < hi) {
    const middle = (lo + hi) >> 1;
    if (pattern.dep[middle * stop_count + position] >= ready) {
      hi = middle;
    } else {
      lo = middle + 1;
    }
  }
  while (lo < limit && pattern.dep[lo * stop_count + position] < ready) lo++;
  return lo < limit ? lo : -1;
}

function search(
  timetable: Timetable,
  options: PlanOptions,
  access: Map<number, number>,
  egress: Map<number, number>,
  start_time: number,
): Journey[] {
  const num_stops = timetable.stop_ids.length;
  function walk_time(metres: number) {
    return walking_seconds(metres, options.walk_speed);
  }
  const best = new Int32Array(num_stops).fill(INF);
  const rounds: Round[] = [new_round(num_stops)];
  const journeys: Journey[] = [];
  let target_bound = INF;

  let marked: number[] = [];
  const first_round = rounds[0];
  for (const [stop_index, metres] of access) {
    const arrival = start_time + walk_time(metres);
    if (arrival < first_round.arr[stop_index]) {
      first_round.arr[stop_index] = arrival;
      first_round.src[stop_index] = 0;
      first_round.kind[stop_index] = ACCESS;
      first_round.walk[stop_index] = metres;
      best[stop_index] = arrival;
      marked.push(stop_index);
    }
  }

  for (let k = 1; k <= options.max_transfers + 1 && marked.length; k++) {
    const prev = rounds[k - 1];
    const cur = new_round(num_stops, prev);
    rounds.push(cur);

    const queue = new Map<number, number>();
    for (const stop_index of marked) {
      const stop_patterns = timetable.stop_patterns[stop_index];
      for (let i = 0; i < stop_patterns.length; i += 2) {
        const pattern_index = stop_patterns[i];
        const position = stop_patterns[i + 1];
        const route = timetable.routes[timetable.patterns[pattern_index].route];
        if (!mode_allowed(options, route.mode)) continue;

        const queued_position = queue.get(pattern_index);
        if (queued_position === undefined || position < queued_position) {
          queue.set(pattern_index, position);
        }
      }
    }

    const improved: number[] = [];
    for (const [pattern_index, start_position] of queue) {
      const pattern = timetable.patterns[pattern_index];
      const stop_count = pattern.stops.length;
      let trip = -1;
      let board_stop = -1;
      let board_pos = -1;
      let board_leave = -INF;
      for (let position = start_position; position < stop_count; position++) {
        const stop_index = pattern.stops[position];

        if (trip >= 0) {
          const arrival = pattern.arr[trip * stop_count + position];
          if (arrival < best[stop_index] && arrival < target_bound) {
            cur.arr[stop_index] = arrival;
            cur.src[stop_index] = k;
            cur.kind[stop_index] = TRANSIT;
            cur.from[stop_index] = board_stop;
            cur.pattern[stop_index] = pattern_index;
            cur.trip[stop_index] = trip;
            cur.board_pos[stop_index] = board_pos;
            cur.alight_pos[stop_index] = position;
            best[stop_index] = arrival;
            improved.push(stop_index);
          }
        }

        const reached = prev.arr[stop_index];
        if (reached === INF) continue;

        const reached_by = rounds[prev.src[stop_index]].kind[stop_index];
        const walked_from_origin = reached_by === ACCESS;
        const ready = reached + (walked_from_origin ? 0 : options.transfer_slack);
        const may_board_here = trip < 0 || ready <= pattern.dep[trip * stop_count + position];
        if (!may_board_here) continue;

        const trip_limit = trip < 0 ? pattern.n_trips : trip + 1;
        const candidate = earliest_trip(timetable, pattern_index, position, ready, trip_limit);
        // walking from the origin, prefer the stop that lets you leave latest (on a tie, the
        // later one: less walking, less riding).
        let leave = -INF;
        if (walked_from_origin) {
          const departure = candidate >= 0 ? pattern.dep[candidate * stop_count + position] : 0;
          leave = departure - walk_time(rounds[0].walk[stop_index]);
        }

        const found_other_trip = candidate >= 0 && candidate !== trip;
        const same_trip_leave_no_earlier =
          candidate === trip && candidate >= 0 && walked_from_origin && leave >= board_leave;
        if (found_other_trip) {
          trip = candidate;
          board_stop = stop_index;
          board_pos = position;
          board_leave = leave;
        } else if (same_trip_leave_no_earlier) {
          // same vehicle, catchable one stop later with no earlier start: board here instead,
          // so the rider isn't sent to a farther stop for the very same bus.
          board_stop = stop_index;
          board_pos = position;
          board_leave = leave;
        }
      }
    }

    const walked: number[] = [];
    for (const stop_index of improved) {
      if (cur.kind[stop_index] !== TRANSIT || cur.src[stop_index] !== k) continue;

      const transfers = timetable.transfers[stop_index];
      for (let j = 0; j < transfers.to.length; j++) {
        const to_stop = transfers.to[j];
        const metres = transfers.distance[j];
        const arrival = cur.arr[stop_index] + walk_time(metres);
        if (arrival < best[to_stop] && arrival < target_bound) {
          cur.arr[to_stop] = arrival;
          cur.src[to_stop] = k;
          cur.kind[to_stop] = WALK;
          cur.from[to_stop] = stop_index;
          cur.walk[to_stop] = metres;
          best[to_stop] = arrival;
          walked.push(to_stop);
        }
      }
    }

    let egress_stop = -1;
    for (const [stop_index, metres] of egress) {
      if (cur.src[stop_index] !== k) continue;

      const arrival = cur.arr[stop_index] + walk_time(metres);
      if (arrival < target_bound) {
        target_bound = arrival;
        egress_stop = stop_index;
      }
    }
    if (egress_stop >= 0) {
      journeys.push({ rounds, round: k, egress_stop, egress_walk: egress.get(egress_stop)! });
    }

    marked = [...new Set([...improved, ...walked])];
  }

  return journeys;
}


function stop_place(timetable: Timetable, stop_index: number): Place {
  return {
    name: timetable.stop_names[stop_index],
    lat: timetable.stop_lat[stop_index],
    lon: timetable.stop_lon[stop_index],
    stopId: timetable.stop_ids[stop_index],
    stopCode: timetable.stop_codes[stop_index],
  };
}

function walk_leg(from: Place, to: Place, metres: number, geometry?: [number, number][]): WalkLeg {
  return {
    type: "walk",
    mode: "WALK",
    from,
    to,
    start: 0, // filled in by buildItinerary
    end: 0,
    distance: Math.round(metres),
    geometry: geometry ?? [
      [from.lon, from.lat],
      [to.lon, to.lat],
    ],
  };
}

function leg_geometry(
  pattern: Pattern,
  board_pos: number,
  alight_pos: number,
  stops: { lat: number; lon: number }[],
): [number, number][] {
  if (!pattern.shape || !pattern.stop_shape_index) {
    return stops.map(function (stop): [number, number] {
      return [stop.lon, stop.lat];
    });
  }

  const first = stops[0];
  const last = stops[stops.length - 1];
  const out: [number, number][] = [[first.lon, first.lat]];
  for (let i = pattern.stop_shape_index[board_pos]; i <= pattern.stop_shape_index[alight_pos]; i++) {
    out.push([pattern.shape[2 * i], pattern.shape[2 * i + 1]]);
  }
  out.push([last.lon, last.lat]);
  return out;
}

function transit_leg(
  timetable: Timetable,
  pattern_index: number,
  trip: number,
  board_pos: number,
  alight_pos: number,
): TransitLeg {
  const pattern = timetable.patterns[pattern_index];
  const stop_count = pattern.stops.length;
  const route = timetable.routes[pattern.route];
  const stops = [];
  for (let position = board_pos; position <= alight_pos; position++) {
    const stop_index = pattern.stops[position];
    const times = position === board_pos ? pattern.dep : pattern.arr;
    const time = times[trip * stop_count + position] + timetable.base;
    stops.push({
      id: timetable.stop_ids[stop_index],
      name: timetable.stop_names[stop_index],
      lat: timetable.stop_lat[stop_index],
      lon: timetable.stop_lon[stop_index],
      time,
    });
  }

  return {
    type: "transit",
    mode: route.mode,
    line: route.shortName,
    headsign: pattern.headsigns[trip],
    tripId: pattern.trip_ids[trip],
    from: stop_place(timetable, pattern.stops[board_pos]),
    to: stop_place(timetable, pattern.stops[alight_pos]),
    start: stops[0].time,
    end: stops[stops.length - 1].time,
    stops,
    geometry: leg_geometry(pattern, board_pos, alight_pos, stops),
  };
}

function build_itinerary(legs: Leg[], walk_speed: number): Itinerary {
  const merged: Leg[] = [];
  for (const leg of legs) {
    const last = merged[merged.length - 1];
    if (leg.type === "walk" && last?.type === "walk") {
      merged[merged.length - 1] = {
        ...last,
        to: leg.to,
        distance: last.distance + leg.distance,
        geometry: [...last.geometry, ...leg.geometry.slice(1)],
      };
    } else {
      merged.push(leg);
    }
  }

  const first_ride = merged.findIndex(function (leg) {
    return leg.type === "transit";
  });
  for (let i = first_ride - 1; i >= 0; i--) {
    const leg = merged[i] as WalkLeg;
    leg.end = merged[i + 1].start;
    leg.start = leg.end - walking_seconds(leg.distance, walk_speed);
  }
  for (let i = Math.max(first_ride, 0); i < merged.length; i++) {
    const leg = merged[i];
    if (leg.type !== "walk") continue;

    if (i > 0) {
      leg.start = merged[i - 1].end;
    }
    leg.end = leg.start + walking_seconds(leg.distance, walk_speed);
  }

  const start = merged[0].start;
  const end = merged[merged.length - 1].end;
  const rides = merged.filter(function (leg) {
    return leg.type === "transit";
  }).length;
  return {
    start,
    end,
    duration: end - start,
    walkDistance: merged.reduce(function (sum, leg) {
      return sum + (leg.type === "walk" ? leg.distance : 0);
    }, 0),
    transfers: Math.max(0, rides - 1),
    legs: merged,
  };
}


interface Snap {
  vertex: number;
  distance: number;
}

interface WalkContext {
  timetable: Timetable;
  origin: Place;
  destination: Place;
  origin_snap: Snap | null;
  dest_snap: Snap | null;
}

function street_line(
  timetable: Timetable,
  from: Place,
  vertices: number[] | null,
  to: Place,
): [number, number][] | undefined {
  if (!timetable.walk || !vertices) return undefined;
  const street_points = vertices.map(function (vertex) {
    return timetable.walk!.coord(vertex);
  });
  return [[from.lon, from.lat], ...street_points, [to.lon, to.lat]];
}

function access_geometry(walk_context: WalkContext, stop_index: number) {
  const { timetable } = walk_context;
  const stop_vertex = timetable.stop_vertex[stop_index];
  if (!walk_context.origin_snap || stop_vertex < 0) return undefined;

  const path = timetable.walk!.from_origin.path(stop_vertex);
  return street_line(timetable, walk_context.origin, path, stop_place(timetable, stop_index));
}

function egress_geometry(walk_context: WalkContext, stop_index: number) {
  const { timetable } = walk_context;
  const stop_vertex = timetable.stop_vertex[stop_index];
  if (!walk_context.dest_snap || stop_vertex < 0) return undefined;

  const path = timetable.walk!.from_destination.path(stop_vertex);
  const path_from_stop = path ? path.reverse() : null;
  return street_line(timetable, stop_place(timetable, stop_index), path_from_stop, walk_context.destination);
}

function transfer_geometry(timetable: Timetable, from_stop: number, to_stop: number) {
  const from_vertex = timetable.stop_vertex[from_stop];
  const to_vertex = timetable.stop_vertex[to_stop];
  if (!timetable.walk || from_vertex < 0 || to_vertex < 0) return undefined;

  timetable.walk.scratch.run(from_vertex, 2000, function (vertex) {
    return vertex === to_vertex;
  });
  const path = timetable.walk.scratch.path(to_vertex);
  return street_line(timetable, stop_place(timetable, from_stop), path, stop_place(timetable, to_stop));
}

function access_leg(walk_context: WalkContext, stop_index: number, metres: number): WalkLeg {
  const to = stop_place(walk_context.timetable, stop_index);
  return walk_leg(walk_context.origin, to, metres, access_geometry(walk_context, stop_index));
}

function egress_leg(walk_context: WalkContext, stop_index: number, metres: number): WalkLeg {
  const from = stop_place(walk_context.timetable, stop_index);
  return walk_leg(from, walk_context.destination, metres, egress_geometry(walk_context, stop_index));
}

function transfer_leg(timetable: Timetable, from_stop: number, to_stop: number, metres: number): WalkLeg {
  const from = stop_place(timetable, from_stop);
  const to = stop_place(timetable, to_stop);
  return walk_leg(from, to, metres, transfer_geometry(timetable, from_stop, to_stop));
}

function reconstruct(walk_context: WalkContext, journey: Journey, walk_speed: number): Itinerary {
  const { timetable } = walk_context;
  const reversed: Leg[] = [egress_leg(walk_context, journey.egress_stop, journey.egress_walk)];
  let round = journey.round;
  let stop_index = journey.egress_stop;
  for (let guard = 0; guard < 64; guard++) {
    const source_round = journey.rounds[round].src[stop_index];
    const source = journey.rounds[source_round];
    const kind = source.kind[stop_index];
    if (kind === ACCESS) {
      reversed.push(access_leg(walk_context, stop_index, source.walk[stop_index]));
      break;
    }

    if (kind === WALK) {
      const from_stop = source.from[stop_index];
      reversed.push(transfer_leg(timetable, from_stop, stop_index, source.walk[stop_index]));
      stop_index = from_stop;
      round = source_round;
    } else {
      reversed.push(
        transit_leg(
          timetable,
          source.pattern[stop_index],
          source.trip[stop_index],
          source.board_pos[stop_index],
          source.alight_pos[stop_index],
        ),
      );
      stop_index = source.from[stop_index];
      round = source_round - 1;
    }
  }
  return build_itinerary(reversed.reverse(), walk_speed);
}


export class PlanError extends Error {}

function stops_within_walk(
  timetable: Timetable,
  place: Place,
  snap: Snap | null,
  walk_search: WalkSearch | null,
  max_walk: number,
  search_radius: number,
): Map<number, number> {
  const out = new Map<number, number>();
  if (snap && walk_search) {
    walk_search.run(snap.vertex, search_radius, function (vertex, metres) {
      for (const stop_index of timetable.vertex_stops.get(vertex) ?? []) {
        const total = snap.distance + metres + timetable.stop_snap[stop_index];
        const known = out.get(stop_index) ?? Infinity;
        if (total <= max_walk && total < known) {
          out.set(stop_index, total);
        }
      }
    });
    return out;
  }

  const nearby = timetable.grid.near(place.lat, place.lon, max_walk / DETOUR);
  for (const { index, distance: straight_line } of nearby) {
    out.set(index, straight_line * DETOUR);
  }
  return out;
}

function dominates(left: Itinerary, right: Itinerary): boolean {
  const no_worse =
    left.end <= right.end &&
    left.start >= right.start &&
    left.walkDistance <= right.walkDistance &&
    left.transfers <= right.transfers;
  const better =
    left.end < right.end ||
    left.start > right.start ||
    left.walkDistance < right.walkDistance ||
    left.transfers < right.transfers;
  return no_worse && better;
}

function ride_key(itinerary: Itinerary): string {
  const trip_ids = itinerary.legs.map(function (leg) {
    return leg.type === "transit" ? leg.tripId : "";
  });
  return trip_ids.filter(Boolean).join(">");
}

function beats_same_ride(candidate: Itinerary, kept: Itinerary): boolean {
  const order =
    kept.end - candidate.end || candidate.start - kept.start || kept.walkDistance - candidate.walkDistance;
  return order > 0;
}

function prune(itineraries: Itinerary[]): Itinerary[] {
  const by_ride = new Map<string, Itinerary>();
  for (const itinerary of itineraries) {
    const key = ride_key(itinerary);
    const kept = by_ride.get(key);
    if (!kept || beats_same_ride(itinerary, kept)) {
      by_ride.set(key, itinerary);
    }
  }

  const unique = [...by_ride.values()];
  return unique.filter(function (right) {
    return !unique.some(function (left) {
      return left !== right && dominates(left, right);
    });
  });
}

function direct_walk(walk_context: WalkContext): { metres: number; line: [number, number][] | undefined } {
  const { timetable, origin, destination, origin_snap, dest_snap } = walk_context;
  const straight_metres = distance(origin.lat, origin.lon, destination.lat, destination.lon) * DETOUR;
  if (!timetable.walk || !origin_snap || !dest_snap) return { metres: straight_metres, line: undefined };

  const street_metres = timetable.walk.from_origin.distance_to(dest_snap.vertex);
  const reachable = street_metres !== Infinity;
  const metres = reachable ? origin_snap.distance + street_metres + dest_snap.distance : Infinity;
  const path = timetable.walk.from_origin.path(dest_snap.vertex);
  return { metres, line: street_line(timetable, origin, path, destination) };
}

export function plan(timetable: Timetable, options: PlanOptions): Itinerary[] {
  const start_time = options.time - timetable.base;
  const outside_timetable = start_time < -6 * 3600 || start_time > 36 * 3600;
  if (outside_timetable) {
    throw new PlanError("Time is outside the loaded timetable (today/tomorrow)");
  }

  const origin: Place = { name: "Lähtöpaikka", lat: options.from.lat, lon: options.from.lon };
  const destination: Place = { name: "Määränpää", lat: options.to.lat, lon: options.to.lon };
  const walk_context: WalkContext = {
    timetable,
    origin,
    destination,
    origin_snap: timetable.walk?.snap(origin.lat, origin.lon) ?? null,
    dest_snap: timetable.walk?.snap(destination.lat, destination.lon) ?? null,
  };
  const access = stops_within_walk(
    timetable,
    origin,
    walk_context.origin_snap,
    timetable.walk?.from_origin ?? null,
    options.max_walk_distance,
    Math.max(options.max_walk_distance, MAX_DIRECT_WALK),
  );
  const egress = stops_within_walk(
    timetable,
    destination,
    walk_context.dest_snap,
    timetable.walk?.from_destination ?? null,
    options.max_walk_distance,
    options.max_walk_distance,
  );

  if (options.route) {
    return follow_route(timetable, options, walk_context, access, egress, options.route, start_time);
  }

  let pool: Itinerary[];
  if (options.deadline === null) {
    pool = profile_both(timetable, options, walk_context, access, egress, start_time, start_time + WINDOW);
  } else {
    pool = arrive_by_pool(timetable, options, walk_context, access, egress, start_time, options.deadline);
  }
  let result = pick(pool, options);

  const direct = direct_walk(walk_context);
  if (direct.metres <= MAX_DIRECT_WALK) {
    const walk = walk_leg(origin, destination, direct.metres, direct.line);
    const walk_duration = walking_seconds(direct.metres, options.walk_speed);
    if (options.deadline !== null) {
      walk.start = Math.max(options.time, options.deadline - walk_duration);
    } else {
      walk.start = options.time;
    }
    walk.end = walk.start + walk_duration;

    result = result.filter(function (itinerary) {
      return walk_duration >= itinerary.duration * WALK_BEATS_RIDE;
    });

    const arrives_in_time = options.deadline === null || walk.end <= options.deadline;
    if (arrives_in_time) {
      result.push(build_itinerary([walk], options.walk_speed));
    }
  }
  return result.sort(function (left, right) {
    return left.start - right.start || left.end - right.end;
  });
}

function arrive_by_pool(
  timetable: Timetable,
  options: PlanOptions,
  walk_context: WalkContext,
  access: Map<number, number>,
  egress: Map<number, number>,
  start_time: number,
  deadline: number,
): Itinerary[] {
  const deadline_time = deadline - timetable.base;
  const probe_from = Math.max(start_time, deadline_time - ARRIVE_BY_PROBE);
  let probe: Itinerary[] = [];
  if (deadline_time > start_time) {
    const journeys = search(timetable, options, access, egress, probe_from);
    probe = journeys.map(function (journey) {
      return reconstruct(walk_context, journey, options.walk_speed);
    });
  }

  const durations = probe.map(function (itinerary) {
    return itinerary.end - itinerary.start;
  });
  const fastest = Math.min(...durations);
  if (!Number.isFinite(fastest)) return [];

  const window_start = Math.max(probe_from, deadline_time - Math.round(fastest * 1.5) - 20 * 60);
  const pool = profile_both(timetable, options, walk_context, access, egress, window_start, deadline_time);
  return pool.filter(function (itinerary) {
    return itinerary.end <= deadline;
  });
}

function profile(
  timetable: Timetable,
  options: PlanOptions,
  walk_context: WalkContext,
  access: Map<number, number>,
  egress: Map<number, number>,
  from_t: number,
  to_t: number,
): Itinerary[] {
  const all: Itinerary[] = [];
  const started = performance.now();
  function within_time_budget() {
    return performance.now() - started < TIME_BUDGET_MS;
  }
  let departure = from_t;
  for (let run = 0; run < MAX_RUNS && departure <= to_t && within_time_budget(); run++) {
    const journeys = search(timetable, options, access, egress, departure);
    if (!journeys.length) break;

    let earliest = Infinity;
    for (const journey of journeys) {
      const itinerary = reconstruct(walk_context, journey, options.walk_speed);
      const itinerary_start = itinerary.start - timetable.base;
      earliest = Math.min(earliest, itinerary_start);
      if (itinerary_start <= to_t) {
        all.push(itinerary);
      }
    }
    departure = Math.max(departure, earliest) + 60;
  }
  return prune(all);
}

function only_light_walks(walks: Map<number, number>): Map<number, number> {
  const light = [...walks].filter(function ([, metres]) {
    return metres <= LIGHT_WALK;
  });
  return new Map(light);
}

function profile_both(
  timetable: Timetable,
  options: PlanOptions,
  walk_context: WalkContext,
  access: Map<number, number>,
  egress: Map<number, number>,
  from_t: number,
  to_t: number,
): Itinerary[] {
  const all = profile(timetable, options, walk_context, access, egress, from_t, to_t);

  const light_access = only_light_walks(access);
  const light_egress = only_light_walks(egress);
  const differs = light_access.size < access.size || light_egress.size < egress.size;
  const both_reachable = light_access.size > 0 && light_egress.size > 0;
  if (differs && both_reachable) {
    all.push(...profile(timetable, options, walk_context, light_access, light_egress, from_t, to_t));
  }
  return prune(all);
}


const stop_index_cache = new WeakMap<Timetable, Map<string, number>>();
function stop_index_of(timetable: Timetable, id: string): number | undefined {
  let index_by_id = stop_index_cache.get(timetable);
  if (!index_by_id) {
    const entries = timetable.stop_ids.map(function (stop_id, i): [string, number] {
      return [stop_id, i];
    });
    index_by_id = new Map(entries);
    stop_index_cache.set(timetable, index_by_id);
  }
  return index_by_id.get(id);
}

interface ResolvedRide {
  line: string;
  from: number;
  to: number;
}

interface RideOption {
  pattern_index: number;
  board_pos: number;
  alight_pos: number;
}

interface ChosenRide extends RideOption {
  trip: number;
  departure: number;
}

function resolve_rides(timetable: Timetable, route: RideSpec[]): ResolvedRide[] | null {
  const rides: ResolvedRide[] = [];
  for (const ride of route) {
    const from = stop_index_of(timetable, ride.from);
    const to = stop_index_of(timetable, ride.to);
    if (from === undefined || to === undefined) return null;
    rides.push({ line: ride.line, from, to });
  }
  return rides;
}

function ride_options(timetable: Timetable, line: string, from: number, to: number): RideOption[] {
  const out: RideOption[] = [];
  const stop_patterns = timetable.stop_patterns[from];
  for (let i = 0; i < stop_patterns.length; i += 2) {
    const pattern_index = stop_patterns[i];
    const pattern = timetable.patterns[pattern_index];
    if (timetable.routes[pattern.route].shortName !== line) continue;

    const board_pos = stop_patterns[i + 1];
    const alight_pos = pattern.stops.indexOf(to, board_pos + 1);
    if (alight_pos > board_pos) {
      out.push({ pattern_index, board_pos, alight_pos });
    }
  }
  return out;
}

function earliest_ride(timetable: Timetable, choices: RideOption[], ready: number): ChosenRide | null {
  let best: ChosenRide | null = null;
  for (const choice of choices) {
    const pattern = timetable.patterns[choice.pattern_index];
    const trip = earliest_trip(timetable, choice.pattern_index, choice.board_pos, ready, pattern.n_trips);
    if (trip < 0) continue;

    const departure = departure_at(pattern, trip, choice.board_pos);
    if (!best || departure < best.departure) {
      best = { ...choice, trip, departure };
    }
  }
  return best;
}

function transfer_metres(timetable: Timetable, from: number, to: number): number | null {
  if (from === to) return 0;

  const transfers = timetable.transfers[from];
  for (let j = 0; j < transfers.to.length; j++) {
    if (transfers.to[j] === to) return transfers.distance[j];
  }
  return null;
}

function follow_route(
  timetable: Timetable,
  options: PlanOptions,
  walk_context: WalkContext,
  access: Map<number, number>,
  egress: Map<number, number>,
  route: RideSpec[],
  start_time: number,
): Itinerary[] {
  function walk_time(metres: number) {
    return walking_seconds(metres, options.walk_speed);
  }
  const rides = resolve_rides(timetable, route);
  if (!rides || !rides.length) return [];

  const choices_per_ride = rides.map(function (ride) {
    return ride_options(timetable, ride.line, ride.from, ride.to);
  });
  const first_stop = rides[0].from;
  const last_stop = rides[rides.length - 1].to;
  const access_metres = access.get(first_stop);
  const egress_metres = egress.get(last_stop);
  const some_ride_impossible = choices_per_ride.some(function (choices) {
    return !choices.length;
  });
  if (access_metres === undefined || egress_metres === undefined || some_ride_impossible) return [];

  const change_walks: number[] = [];
  for (let i = 0; i + 1 < rides.length; i++) {
    const metres = transfer_metres(timetable, rides[i].to, rides[i + 1].from);
    if (metres === null) return [];
    change_walks.push(metres);
  }

  const out: Itinerary[] = [];
  const last_departure = start_time + ROUTE_LOOKAHEAD;
  let leave = start_time;
  while (out.length < ROUTE_DEPARTURES && leave <= last_departure) {
    let ready = leave + walk_time(access_metres);
    const chosen: ChosenRide[] = [];
    for (let i = 0; i < rides.length; i++) {
      const best = earliest_ride(timetable, choices_per_ride[i], ready);
      if (!best) return out;

      const is_first_ride = i === 0;
      if (is_first_ride && best.departure > last_departure) return out;
      if (!is_first_ride && best.departure - ready > MAX_CHANGE_WAIT) return out;
      chosen.push(best);

      const pattern = timetable.patterns[best.pattern_index];
      ready = arrival_at(pattern, best.trip, best.alight_pos);
      if (i + 1 < rides.length) {
        ready += walk_time(change_walks[i]) + options.transfer_slack;
      }
    }

    const legs: Leg[] = [access_leg(walk_context, first_stop, access_metres)];
    for (let i = 0; i < chosen.length; i++) {
      const ride = chosen[i];
      legs.push(transit_leg(timetable, ride.pattern_index, ride.trip, ride.board_pos, ride.alight_pos));

      const changes_stop = i + 1 < chosen.length && rides[i].to !== rides[i + 1].from;
      if (changes_stop) {
        legs.push(transfer_leg(timetable, rides[i].to, rides[i + 1].from, change_walks[i]));
      }
    }
    legs.push(egress_leg(walk_context, last_stop, egress_metres));
    out.push(build_itinerary(legs, options.walk_speed));

    leave = chosen[0].departure - walk_time(access_metres) + 1;
  }
  return out;
}

function cost(itinerary: Itinerary, walk_speed: number): number {
  const extra_walk_cost = (WALK_RELUCTANCE - 1) * (itinerary.walkDistance / walk_speed);
  return itinerary.duration + extra_walk_cost + itinerary.transfers * TRANSFER_PENALTY;
}

function latest_leaving(pool: Itinerary[]): Itinerary {
  return pool.reduce(function (left, right) {
    const leaves_later = right.start > left.start;
    const arrives_sooner_on_tie = right.start === left.start && right.end < left.end;
    return leaves_later || arrives_sooner_on_tie ? right : left;
  });
}

function earliest_arriving(pool: Itinerary[]): Itinerary {
  return pool.reduce(function (left, right) {
    const arrives_sooner = right.end < left.end;
    const leaves_later_on_tie = right.end === left.end && right.start > left.start;
    return arrives_sooner || leaves_later_on_tie ? right : left;
  });
}

function pick(pool: Itinerary[], options: PlanOptions): Itinerary[] {
  if (!pool.length) return [];

  const arrive_by = options.deadline !== null;
  const anchor = arrive_by ? latest_leaving(pool) : earliest_arriving(pool);
  const pool_costs = pool.map(function (itinerary) {
    return cost(itinerary, options.walk_speed);
  });
  const cheapest = Math.min(...pool_costs);
  const sane = pool.filter(function (itinerary) {
    const not_too_late = arrive_by || itinerary.end <= anchor.end + MAX_LATE_ARRIVAL;
    return not_too_late && cost(itinerary, options.walk_speed) <= cheapest * MAX_COST_RATIO + MAX_COST_EXTRA;
  });

  const cost_entries = sane.map(function (itinerary): [Itinerary, number] {
    return [itinerary, cost(itinerary, options.walk_speed)];
  });
  const costs = new Map(cost_entries);
  function is_beaten(right: Itinerary) {
    return sane.some(function (left) {
      if (left === right) return false;
      return left.start >= right.start && left.end <= right.end && costs.get(left)! <= costs.get(right)!;
    });
  }
  const frontier = sane.filter(function (itinerary) {
    return itinerary === anchor || !is_beaten(itinerary);
  });

  function wait_at_home(itinerary: Itinerary) {
    return arrive_by ? options.deadline! - itinerary.end : itinerary.start - options.time;
  }
  function score(itinerary: Itinerary) {
    return costs.get(itinerary)! + WAIT_AT_HOME_WEIGHT * wait_at_home(itinerary);
  }
  const rest = frontier
    .filter(function (itinerary) {
      return itinerary !== anchor;
    })
    .sort(function (left, right) {
      return score(left) - score(right);
    });
  return [anchor, ...rest].slice(0, options.num_itineraries);
}
