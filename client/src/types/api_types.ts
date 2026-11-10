// keep this in sync !

export type Mode = "BUS" | "TRAM" | "RAIL" | "SUBWAY" | "FERRY" | string;

export interface Stop {
  id: string;
  name: string;
  code: string | null;
  lat: number;
  lon: number;
  mode: Mode | null;
}

export interface Departure {
  line: string;
  mode: Mode;
  headsign: string;
  scheduledTime: number;
  estimatedTime: number;
  delaySeconds: number; // positive = late
  realtime: boolean;
  cancelled: boolean;
  tripId: string | null;
  serviceDate: string | null;
  vehicleId: string | null;
}

export interface StopDepartures {
  stop: Pick<Stop, "id" | "name" | "code">;
  departures: Departure[];
}


export interface Vehicle {
  id: string;
  mode: Mode;
  line: string;
  headsign: string;
  lat: number;
  lon: number;
  heading: number;
  delaySeconds: number;
}

export interface TripStop {
  id: string;
  name: string;
  lat: number;
  lon: number;
  scheduledTime: number;
  estimatedTime: number;
  realtime: boolean;
}

export interface VehicleTrip {
  vehicle: Vehicle | null;
  tripId: string;
  line: string;
  mode: Mode;
  headsign: string;
  geometry: [number, number][];
  stops: TripStop[];
  nextStopIndex: number;
}


export type Bbox = [minLon: number, minLat: number, maxLon: number, maxLat: number];

export interface ViewportMessage {
  type: "viewport";
  bbox: Bbox | null;
}

export interface VehiclesMessage {
  type: "vehicles";
  full: boolean;
  updated: Vehicle[];
  removed: string[];
}

export interface HeartbeatMessage {
  type: "heartbeat";
}

export type ServerMessage = VehiclesMessage | HeartbeatMessage;


export interface PlaceSuggestion {
  name: string;
  label: string;
  lat: number;
  lon: number;
  layer: string;
}


export interface Place {
  name: string;
  lat: number;
  lon: number;
  stopId?: string;
  stopCode?: string | null;
}

export interface WalkLeg {
  type: "walk";
  mode: "WALK";
  from: Place;
  to: Place;
  start: number;
  end: number;
  distance: number;
  geometry: [number, number][];
}

export interface TransitLeg {
  type: "transit";
  mode: Mode;
  line: string;
  headsign: string;
  tripId: string;
  from: Place;
  to: Place;
  start: number;
  end: number;
  stops: { id: string; name: string; lat: number; lon: number; time: number }[];
  geometry: [number, number][];
}

export type Leg = WalkLeg | TransitLeg;

export interface Itinerary {
  start: number;
  end: number;
  duration: number;
  walkDistance: number;
  transfers: number;
  legs: Leg[];
}

export interface PlanResponse {
  itineraries: Itinerary[];
}
