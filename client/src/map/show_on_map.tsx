// lets any list show a place on the map: flies there and puts a pulsing ring on it. simple!

import { createContext, useContext, type MouseEvent, type ReactNode } from "react";
import { Marker } from "react-map-gl/maplibre";

export interface MapPoint {
  lat: number;
  lon: number;
}

export const ShowOnMapContext = createContext<(point: MapPoint) => void>(function () {});

export function use_show_on_map() {
  return useContext(ShowOnMapContext);
}

interface PlaceLinkProps {
  point: MapPoint;
  className?: string;
  children: ReactNode;
}

export function PlaceLink({ point, className: class_name = "", children }: PlaceLinkProps) {
  const show_on_map = use_show_on_map();

  function handle_click(event: MouseEvent) {
    event.stopPropagation();
    show_on_map(point);
  }

  return (
    <button
      type="button"
      onClick={handle_click}
      className={`min-w-0 truncate text-left underline decoration-neutral-600 decoration-dotted underline-offset-4 ${class_name}`}
    >
      {children}
    </button>
  );
}

export function HighlightMarker({ point }: { point: MapPoint | null }) {
  if (!point) {
    return null;
  }

  return (
    <Marker longitude={point.lon} latitude={point.lat} anchor="center" style={{ pointerEvents: "none" }}>
      <div className="relative size-6">
        <div className="absolute inset-0 animate-ping rounded-full border-2 border-white" />
        <div className="absolute inset-1 rounded-full border-2 border-white" />
      </div>
    </Marker>
  );
}
