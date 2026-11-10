// a wrapper for calls to server

import type { PlaceSuggestion, PlanResponse, Stop, StopDepartures, VehicleTrip } from "../types/api_types";

type LatLon = { lat: number; lon: number };

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal });

  if (!response.ok) {
    const body = await response.json().catch(function () {
      return null;
    });
    throw new Error(body?.error ?? `Request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

function lat_lon_param(point: LatLon): string {
  return `${point.lat},${point.lon}`;
}

export const api = {
  stops(signal?: AbortSignal) {
    return get<Stop[]>("/api/stops", signal);
  },

  departures(stop_id: string, signal?: AbortSignal) {
    return get<StopDepartures>(`/api/stops/${encodeURIComponent(stop_id)}/departures`, signal);
  },

  vehicle_trip(id: string, signal?: AbortSignal) {
    return get<VehicleTrip>(`/api/vehicles/${encodeURIComponent(id)}/trip`, signal);
  },

  trip(trip_id: string, date: string, signal?: AbortSignal) {
    return get<VehicleTrip>(`/api/trips/${encodeURIComponent(trip_id)}?date=${date}`, signal);
  },

  places(text: string, focus: LatLon | null, signal?: AbortSignal) {
    const params = new URLSearchParams({ text });
    if (focus) {
      params.set("focus", lat_lon_param(focus));
    }

    return get<PlaceSuggestion[]>(`/api/places?${params}`, signal);
  },

  plan(
    from: LatLon,
    to: LatLon,
    time: number | null, // null = now
    deadline: number | null,
    signal?: AbortSignal,
    route?: { line: string; from: string; to: string }[], // later departures for route
  ) {
    const params = new URLSearchParams({ from: lat_lon_param(from), to: lat_lon_param(to) });
    if (time !== null) {
      params.set("time", String(time));
    }
    if (deadline !== null) {
      params.set("arriveBy", String(deadline));
    }
    if (route) {
      params.set("route", JSON.stringify(route));
    }

    return get<PlanResponse>(`/api/plan?${params}`, signal);
  },
};
