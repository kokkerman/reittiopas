// a hook for the users gps position. asks for permission, keeps watching the position and debugs fails

import { useCallback, useEffect, useRef, useState } from "react";

export interface UserPosition {
  lat: number;
  lon: number;
  accuracy: number;
}

export type LocationStatus = "off" | "locating" | "on" | "denied" | "insecure" | "unavailable";

export interface Location {
  position: UserPosition | null;
  status: LocationStatus;
  detail: string | null;
  start: () => void;
}

function geolocation_available(): boolean {
  return window.isSecureContext && "geolocation" in navigator;
}

// a status update that leaves an already working location alone.
function unless_on(next_status: LocationStatus) {
  return function (current_status: LocationStatus): LocationStatus {
    return current_status === "on" ? current_status : next_status;
  };
}

export function use_location(): Location {
  const [position, set_position] = useState<UserPosition | null>(null);
  const [status, set_status] = useState<LocationStatus>(function () {
    return geolocation_available() ? "off" : "insecure";
  });
  const [detail, set_detail] = useState<string | null>(null);
  const watch_id = useRef<number | null>(null);

  function stop_watching() {
    if (watch_id.current !== null) {
      navigator.geolocation.clearWatch(watch_id.current);
    }
    watch_id.current = null;
  }

  const start = useCallback(
    function () {
      if (!geolocation_available()) {
        const secure = window.isSecureContext;
        const geolocation_supported = "geolocation" in navigator;
        set_status("insecure");
        set_detail(`${window.location.origin}, secure: ${secure}, geolocation: ${geolocation_supported}`);
        return;
      }

      if (watch_id.current !== null) return;

      set_status(unless_on("locating"));

      function on_position(new_position: GeolocationPosition) {
        const { latitude, longitude, accuracy } = new_position.coords;
        set_position({ lat: latitude, lon: longitude, accuracy });
        set_status("on");
        set_detail(null);
      }

      function on_error(error: GeolocationPositionError) {
        set_detail(`${error.code}: ${error.message || "(no message)"}`);

        if (error.code === error.PERMISSION_DENIED) {
          set_status("denied");
          stop_watching();
        } else {
          // timeouts / no signal: keep watching, it often recovers
          set_status(unless_on("unavailable"));
        }
      }

      watch_id.current = navigator.geolocation.watchPosition(on_position, on_error, {
        enableHighAccuracy: true,
        maximumAge: 5000,
        timeout: 20000,
      });
    },
    [], // eslint shit
  );

  useEffect(
    function () {
      if (!window.isSecureContext || !navigator.permissions) return;

      let cancelled = false;
      navigator.permissions
        .query({ name: "geolocation" })
        .then(function (permission) {
          if (!cancelled && permission.state === "granted") {
            start();
          }
        })
        .catch(function () {
          // right.
        });

      return function () {
        cancelled = true;
      };
    },
    [start],
  );

  useEffect(function () {
    return stop_watching;
    // .
  }, []);

  return { position, status, detail, start };
}
