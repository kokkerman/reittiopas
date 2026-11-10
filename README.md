# reittiopas

Journey planner and live map for the HSL region.

## Project structure

```
server/src/
  index.ts          api routes
  routing/          the route planner, timetable and walking network
  services/         hsl's api, live vehicles and the websocket
  types/            data sent to the client
  utils/            small helpers

client/src/
  App.tsx           the map and whichever panel is open
  api/              requests to the server
  map/              everything drawn on the map
  panels/           stop, vehicle and planner panels
  components/       reusable ui pieces
  hooks/            state and data
  styles/           colours and panel styles
  utils/            small helpers
  types/            data from the server
```
