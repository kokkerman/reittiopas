// draws the selected vehicle's route and its next stops, with the minutes until it gets to each stop

import { useEffect, useMemo, useState } from "react";
import { Layer, Source } from "react-map-gl/maplibre";
import type { Feature, FeatureCollection } from "geojson";
import { mode_color } from "../styles/mode_colors";
import type { VehicleTrip } from "../types/api_types";
import { format_countdown } from "../utils/time_format";
import { ui_scale } from "../utils/ui_scale";

const TICK_MS = 15000;

interface Props {
  trip: VehicleTrip | null;
}

function upcoming_stop_features(trip: VehicleTrip, now: number): Feature[] {
  const upcoming_stops = trip.stops.slice(trip.nextStopIndex);

  return upcoming_stops.map(function (trip_stop, order) {
    return {
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [trip_stop.lon, trip_stop.lat] },
      properties: { id: trip_stop.id, label: format_countdown(trip_stop.estimatedTime, now), order },
    };
  });
}

export default function TripLayer({ trip }: Props) {
  const [now, set_now] = useState(Date.now());

  useEffect(function () {
    if (!trip) {
      return;
    }

    set_now(Date.now());
    const timer = setInterval(function () {
      set_now(Date.now());
    }, TICK_MS);
    return function () {
      clearInterval(timer);
    };
  }, [trip]);

  const data = useMemo<FeatureCollection>(function () {
    if (!trip) {
      return { type: "FeatureCollection", features: [] };
    }

    return {
      type: "FeatureCollection",
      features: [
        { type: "Feature", geometry: { type: "LineString", coordinates: trip.geometry }, properties: {} },
        ...upcoming_stop_features(trip, now),
      ],
    };
  }, [trip, now]);

  const color = mode_color(trip?.mode);

  return (
    <Source id="trip" type="geojson" data={data}>
      <Layer
        id="trip-line"
        type="line"
        filter={["==", ["geometry-type"], "LineString"]}
        layout={{ "line-cap": "round", "line-join": "round" }}
        paint={{ "line-color": color, "line-width": 4, "line-opacity": 0.8 }}
      />
      <Layer
        id="trip-stops"
        type="circle"
        filter={["==", ["geometry-type"], "Point"]}
        paint={{
          "circle-radius": 4,
          "circle-color": "#0a0a0a",
          "circle-stroke-color": color,
          "circle-stroke-width": 2,
        }}
      />
      <Layer
        id="trip-stop-times"
        type="symbol"
        filter={["==", ["geometry-type"], "Point"]}
        layout={{
          "text-field": ["get", "label"],
          "text-font": ["Noto Sans Bold"],
          "text-size": 14 * ui_scale(),
          "text-anchor": "left",
          "text-offset": [0.7, 0],
          "symbol-sort-key": ["get", "order"],
          "text-padding": 4,
        }}
        paint={{ "text-color": "#ffffff", "text-halo-color": "#0a0a0a", "text-halo-width": 2.5, "text-halo-blur": 0.5 }}
      />
    </Source>
  );
}
