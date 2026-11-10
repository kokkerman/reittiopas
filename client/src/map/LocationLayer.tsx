// draws the user on the map. Claude did this

import { useEffect, useMemo, useRef, useState } from "react";
import { Layer, Source } from "react-map-gl/maplibre";
import type { ExpressionSpecification } from "maplibre-gl";
import type { FeatureCollection } from "geojson";
import type { UserPosition } from "../hooks/use_location";

const COLOR = "#3b82f6";
const GLIDE_MS = 600;
const GLIDE_FRAME_MS = 33;

/*

accuracy circle radius in pixels, computed by the map from the `accuracy` (metres) and
`lat` properties: metres per pixel at zoom z is 40075016.686 * cos(lat) / 2^(z + 9).
so the circle scales with zoom without rebuilding any geometry.

*/
const METRES_PER_PX_Z0 = ["/", ["*", 40075016.686, ["cos", ["/", ["*", ["get", "lat"], Math.PI], 180]]], 512];
const ACCURACY_RADIUS = [
  "interpolate",
  ["exponential", 2],
  ["zoom"],
  0,
  ["/", ["get", "accuracy"], METRES_PER_PX_Z0],
  22,
  ["/", ["*", ["get", "accuracy"], 2 ** 22], METRES_PER_PX_Z0],
] as unknown as ExpressionSpecification;

function smoothstep(progress: number): number {
  return progress * progress * (3 - 2 * progress);
}

function interpolate_position(start: UserPosition, end: UserPosition, amount: number): UserPosition {
  return {
    lat: start.lat + (end.lat - start.lat) * amount,
    lon: start.lon + (end.lon - start.lon) * amount,
    accuracy: start.accuracy + (end.accuracy - start.accuracy) * amount,
  };
}

function use_glide(target: UserPosition | null): UserPosition | null {
  const [shown, set_shown] = useState(target);
  const shown_ref = useRef(target);

  useEffect(function () {
    const shown_now = shown_ref.current;
    if (!target || !shown_now) {
      shown_ref.current = target;
      set_shown(target);
      return;
    }
    const start = shown_now;
    const end = target;

    let frame = 0;
    let last_frame_time = 0;
    const start_time = performance.now();

    function step(now: number) {
      const progress = Math.min(1, (now - start_time) / GLIDE_MS);
      const is_finished = progress === 1;

      if (is_finished || now - last_frame_time >= GLIDE_FRAME_MS) {
        last_frame_time = now;
        const next_position = interpolate_position(start, end, smoothstep(progress));
        shown_ref.current = next_position;
        set_shown(next_position);
      }

      if (progress < 1) {
        frame = requestAnimationFrame(step);
      }
    }

    frame = requestAnimationFrame(step);
    return function () {
      cancelAnimationFrame(frame);
    };
  }, [target]);

  return shown;
}

export default function LocationLayer({ position: target_position }: { position: UserPosition | null }) {
  const position = use_glide(target_position);

  const data = useMemo<FeatureCollection>(function () {
    if (!position) {
      return { type: "FeatureCollection", features: [] };
    }

    const { lat, lon, accuracy } = position;
    return {
      type: "FeatureCollection",
      features: [{ type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties: { lat, accuracy } }],
    };
  }, [position]);

  return (
    <Source id="user-location" type="geojson" data={data}>
      <Layer
        id="user-accuracy"
        type="circle"
        paint={{
          "circle-radius": ACCURACY_RADIUS,
          "circle-color": COLOR,
          "circle-opacity": 0.12,
          "circle-stroke-color": COLOR,
          "circle-stroke-width": 1,
          "circle-stroke-opacity": 0.4,
          "circle-pitch-alignment": "map",
        }}
      />
      <Layer
        id="user-dot"
        type="circle"
        paint={{ "circle-radius": 7, "circle-color": COLOR, "circle-stroke-color": "#ffffff", "circle-stroke-width": 2 }}
      />
    </Source>
  );
}
