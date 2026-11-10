// talks to hsl digitransit api

import { decode_polyline, helsinki_date, parse_clock } from "../utils/time_utils.js";
import type {
  Departure,
  PlaceSuggestion,
  Stop,
  StopDepartures,
  TripStop,
  VehicleTrip,
} from "../types/api_types.js";
import { all_vehicles, to_public, type VehicleState } from "./vehicle_feed.js";

const ENDPOINT = "https://api.digitransit.fi/routing/v2/hsl/gtfs/v1"; // not an env var, i know.

export class DigitransitError extends Error {
  constructor(message: string, public status = 502) {
    super(message);
  }
}

function api_key(): string {
  const key = process.env.DIGITRANSIT_KEY;
  if (!key) {
    throw new DigitransitError("DIGITRANSIT_KEY is not set on the server", 500);
  }
  return key;
}


// these wrappers are pretty much claude made
async function graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const key = api_key();

  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "digitransit-subscription-key": key,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new DigitransitError(`Digitransit responded ${response.status} ${response.statusText}`);
  }

  // errors come back as HTTP 200 with an `errors` array.
  const body = (await response.json()) as { data?: T; errors?: { message: string }[] };
  if (body.errors?.length) {
    const messages = body.errors
      .map(function (error) {
        return error.message;
      })
      .join("; ");
    throw new DigitransitError(`Digitransit error: ${messages}`);
  }
  if (!body.data) {
    throw new DigitransitError("Digitransit returned no data");
  }
  return body.data;
}

interface RawStop {
  gtfsId: string;
  name: string;
  code: string | null;
  lat: number;
  lon: number;
  vehicleMode: string | null;
  locationType: string | null;
}

const STOPS_TTL_MS = 12 * 60 * 60 * 1000;
let stops_cache: { at: number; stops: Stop[] } | null = null;
let stops_in_flight: Promise<Stop[]> | null = null;

function is_boarding_stop(raw_stop: RawStop): boolean {
  return !raw_stop.locationType || raw_stop.locationType === "STOP";
}

function to_stop(raw_stop: RawStop): Stop {
  return {
    id: raw_stop.gtfsId,
    name: raw_stop.name,
    code: raw_stop.code,
    lat: raw_stop.lat,
    lon: raw_stop.lon,
    mode: raw_stop.vehicleMode,
  };
}

async function fetch_all_stops(): Promise<Stop[]> {
  const data = await graphql<{ stops: RawStop[] }>(`{
    stops { gtfsId name code lat lon vehicleMode locationType }
  }`);
  const stops = data.stops.filter(is_boarding_stop).map(to_stop);
  stops_cache = { at: Date.now(), stops };
  return stops;
}

export async function get_all_stops(): Promise<Stop[]> {
  if (stops_cache && Date.now() - stops_cache.at < STOPS_TTL_MS) return stops_cache.stops;
  if (stops_in_flight) return stops_in_flight;

  stops_in_flight = fetch_all_stops().finally(function () {
    stops_in_flight = null;
  });

  return stops_in_flight;
}

interface RawTripIdentity {
  route: { gtfsId: string };
  directionId: string | number | null;
  departureStoptime: { scheduledDeparture: number } | null;
}

interface RawStoptime {
  scheduledDeparture: number;
  realtimeDeparture: number;
  departureDelay: number;
  realtime: boolean;
  realtimeState: string;
  serviceDay: number;
  headsign: string | null;
  trip: {
    gtfsId: string;
    directionId: string | number | null;
    route: { gtfsId: string; shortName: string | null; mode: string };
    departureStoptime: { scheduledDeparture: number } | null;
  } | null;
}

interface RawStopWithTimes {
  gtfsId: string;
  name: string;
  code: string | null;
  stoptimesWithoutPatterns: RawStoptime[];
}

const DEPARTURES_QUERY = `
  query ($id: String!, $n: Int!) {
    stop(id: $id) {
      gtfsId name code
      stoptimesWithoutPatterns(numberOfDepartures: $n, omitNonPickups: true, omitCanceled: false) {
        scheduledDeparture realtimeDeparture departureDelay
        realtime realtimeState serviceDay headsign
        trip {
          gtfsId directionId
          route { gtfsId shortName mode }
          departureStoptime { scheduledDeparture } # trip's first departure, to find its live vehicle
        }
      }
    }
  }
`;

export async function get_departures(stop_id: string, count = 15): Promise<StopDepartures | null> {
  const data = await graphql<{ stop: RawStopWithTimes | null }>(DEPARTURES_QUERY, { id: stop_id, n: count });
  const stop = data.stop;
  if (!stop) return null;

  const live = live_vehicle_index();
  const departures = stop.stoptimesWithoutPatterns.map(function (stoptime) {
    return to_departure(stoptime, live);
  });

  return {
    stop: { id: stop.gtfsId, name: stop.name, code: stop.code },
    departures,
  };
}

function to_departure(stoptime: RawStoptime, live: Map<string, VehicleState>): Departure {
  const trip = stoptime.trip;
  const vehicle = trip ? find_vehicle(live, trip, stoptime.serviceDay) : undefined;

  return {
    tripId: trip?.gtfsId ?? null,
    serviceDate: service_date_of(stoptime.serviceDay),
    vehicleId: vehicle?.id ?? null,
    line: trip?.route.shortName ?? "?",
    mode: trip?.route.mode ?? "BUS",
    headsign: stoptime.headsign ?? "",
    scheduledTime: stoptime.serviceDay + stoptime.scheduledDeparture,
    estimatedTime: stoptime.serviceDay + stoptime.realtimeDeparture,
    delaySeconds: stoptime.realtime ? stoptime.departureDelay : 0,
    realtime: stoptime.realtime,
    cancelled: stoptime.realtimeState === "CANCELED",
  };
}


function service_day_to_date(service_day: number): string {
  return helsinki_date((service_day + 3 * 3600) * 1000);
}

function service_date_of(service_day: number): string {
  return service_day_to_date(service_day).replaceAll("-", "");
}

function format_clock(seconds: number): string {
  const hours = String(Math.floor(seconds / 3600) % 24).padStart(2, "0");
  const minutes = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function live_vehicle_key(route_id: string, direction: number, operating_day: string, start_time: string): string {
  return `${route_id}|${direction}|${operating_day}|${start_time}`;
}

function live_vehicle_index(): Map<string, VehicleState> {
  const index = new Map<string, VehicleState>();
  for (const vehicle of all_vehicles()) {
    const key = live_vehicle_key(vehicle.route_id, vehicle.direction, vehicle.operating_day, vehicle.start_time);
    index.set(key, vehicle);
  }
  return index;
}

function find_vehicle(
  live: Map<string, VehicleState>,
  trip: RawTripIdentity,
  service_day: number,
): VehicleState | undefined {
  if (!trip.departureStoptime || trip.directionId === null) return undefined;

  const route_id = trip.route.gtfsId.replace(/^HSL:/, "");
  const hfp_direction = Number(trip.directionId) + 1; // GTFS 0/1 → HFP 1/2
  const operating_day = service_day_to_date(service_day);
  const start_time = format_clock(trip.departureStoptime.scheduledDeparture);
  return live.get(live_vehicle_key(route_id, hfp_direction, operating_day, start_time));
}

interface RawTripStoptime {
  stop: { gtfsId: string; name: string; lat: number; lon: number };
  scheduledArrival: number;
  realtimeArrival: number;
  realtime: boolean;
  serviceDay: number;
}

interface RawTrip {
  gtfsId: string;
  tripHeadsign: string | null;
  route: { shortName: string | null; mode: string };
  tripGeometry: { points: string } | null;
  stoptimes: RawTripStoptime[];
}

interface RawTripWithDeparture extends RawTrip {
  directionId: string | number | null;
  route: { gtfsId: string; shortName: string | null; mode: string };
  departureStoptime: { scheduledDeparture: number; serviceDay: number } | null;
}

function to_trip_stops(stoptimes: RawTripStoptime[]): TripStop[] {
  return stoptimes.map(function (stoptime) {
    return {
      id: stoptime.stop.gtfsId,
      name: stoptime.stop.name,
      lat: stoptime.stop.lat,
      lon: stoptime.stop.lon,
      scheduledTime: stoptime.serviceDay + stoptime.scheduledArrival,
      estimatedTime: stoptime.serviceDay + stoptime.realtimeArrival,
      realtime: stoptime.realtime,
    };
  });
}

function trip_geometry(trip: RawTrip, stops: TripStop[]): [number, number][] {
  if (trip.tripGeometry) return decode_polyline(trip.tripGeometry.points);
  return stops.map(function (stop): [number, number] {
    return [stop.lon, stop.lat];
  });
}

const TRIP_QUERY = `
  query ($id: String!, $serviceDate: String!) {
    trip(id: $id) {
      gtfsId tripHeadsign directionId
      route { gtfsId shortName mode }
      tripGeometry { points }
      departureStoptime(serviceDate: $serviceDate) { scheduledDeparture serviceDay }
      stoptimes: stoptimesForDate(serviceDate: $serviceDate) {
        stop { gtfsId name lat lon }
        scheduledArrival realtimeArrival realtime serviceDay
      }
    }
  }
`;

export async function get_trip(trip_id: string, service_date: string): Promise<VehicleTrip | null> {
  const data = await graphql<{ trip: RawTripWithDeparture | null }>(TRIP_QUERY, {
    id: trip_id,
    serviceDate: service_date,
  });
  const trip = data.trip;
  if (!trip || !trip.stoptimes.length) return null;

  const vehicle = trip.departureStoptime
    ? find_vehicle(live_vehicle_index(), trip, trip.departureStoptime.serviceDay)
    : undefined;
  if (vehicle) {
    const live = await get_vehicle_trip(vehicle);
    if (live) return live;
  }

  const stops = to_trip_stops(trip.stoptimes);
  return {
    vehicle: null,
    tripId: trip.gtfsId,
    line: trip.route.shortName ?? "?",
    mode: trip.route.mode,
    headsign: trip.tripHeadsign ?? "",
    geometry: trip_geometry(trip, stops),
    stops,
    nextStopIndex: scheduled_next_stop_index(stops),
  };
}

function scheduled_next_stop_index(stops: TripStop[]): number {
  const now = Date.now() / 1000;
  const index = stops.findIndex(function (stop) {
    return stop.estimatedTime >= now - 30;
  });
  return index < 0 ? stops.length : index;
}

const FUZZY_TRIP_QUERY = `
  query ($route: String!, $direction: Int!, $date: String!, $serviceDate: String!, $time: Int!) {
    fuzzyTrip(route: $route, direction: $direction, date: $date, time: $time) {
      gtfsId tripHeadsign
      route { shortName mode }
      tripGeometry { points }
      # Plain \`stoptimes\` has no date (serviceDay -1) and no realtime; this one has both.
      stoptimes: stoptimesForDate(serviceDate: $serviceDate) {
        stop { gtfsId name lat lon }
        scheduledArrival realtimeArrival realtime serviceDay
      }
    }
  }
`;

// HFP start is "HH:mm" on the operating day; trips belonging to yesterday's
// operating day that start after midnight are "24:xx+" in GTFS terms.
function gtfs_start_time(vehicle: VehicleState): number {
  const start_time = parse_clock(vehicle.start_time);
  const is_previous_operating_day = vehicle.operating_day !== helsinki_date(vehicle.seen_at);
  const is_after_midnight = start_time < 6 * 3600;
  if (is_previous_operating_day && is_after_midnight) return start_time + 86400;
  return start_time;
}

function vehicle_next_stop_index(vehicle: VehicleState, stops: TripStop[]): number {
  if (!vehicle.next_stop_id) return stops.length;

  const next_stop_gtfs_id = `HSL:${vehicle.next_stop_id}`;
  const index = stops.findIndex(function (stop) {
    return stop.id === next_stop_gtfs_id;
  });
  return index < 0 ? 0 : index;
}

export async function get_vehicle_trip(vehicle: VehicleState): Promise<VehicleTrip | null> {
  const data = await graphql<{ fuzzyTrip: RawTrip | null }>(FUZZY_TRIP_QUERY, {
    route: `HSL:${vehicle.route_id}`,
    direction: vehicle.direction - 1, // HFP 1/2 → GTFS 0/1
    date: vehicle.operating_day,
    serviceDate: vehicle.operating_day.replaceAll("-", ""),
    time: gtfs_start_time(vehicle),
  });
  const trip = data.fuzzyTrip;
  if (!trip) return null;

  const stops = to_trip_stops(trip.stoptimes);
  return {
    vehicle: to_public(vehicle),
    tripId: trip.gtfsId,
    line: trip.route.shortName ?? vehicle.line,
    mode: trip.route.mode,
    headsign: trip.tripHeadsign ?? vehicle.headsign,
    geometry: trip_geometry(trip, stops),
    stops,
    nextStopIndex: vehicle_next_stop_index(vehicle, stops),
  };
}

const GEOCODING_URL = "https://api.digitransit.fi/geocoding/v1/autocomplete"; // yeah yeah env var would be better
const HSL_BOUNDS = { min_lat: 59.9, max_lat: 60.45, min_lon: 24.3, max_lon: 25.5 };

interface GeocodingFeature {
  geometry: { coordinates: [number, number] };
  properties: { name: string; label: string; layer: string };
}

function geocoding_params(text: string, focus?: { lat: number; lon: number }): URLSearchParams {
  const params = new URLSearchParams({ text, lang: "fi" });
  for (const [bound_name, bound_value] of Object.entries(HSL_BOUNDS)) {
    params.set(`boundary.rect.${bound_name}`, String(bound_value));
  }
  if (focus) {
    params.set("focus.point.lat", String(focus.lat));
    params.set("focus.point.lon", String(focus.lon));
  }
  return params;
}

export async function search_places(
  text: string,
  focus?: { lat: number; lon: number },
  limit = 8,
): Promise<PlaceSuggestion[]> {
  const params = geocoding_params(text, focus);
  const response = await fetch(`${GEOCODING_URL}?${params}`, {
    headers: { "digitransit-subscription-key": api_key() },
  });
  if (!response.ok) {
    throw new DigitransitError(`Geocoding responded ${response.status} ${response.statusText}`);
  }
  const body = (await response.json()) as { features?: GeocodingFeature[] };

  const seen = new Set<string>();
  const suggestions: PlaceSuggestion[] = [];
  for (const feature of body.features ?? []) {
    const [lon, lat] = feature.geometry.coordinates;
    const { name, label, layer } = feature.properties;

    const key = `${label}|${lat.toFixed(4)}|${lon.toFixed(4)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    suggestions.push({ name, label, lat, lon, layer });
    if (suggestions.length >= limit) break;
  }
  return suggestions;
}
