export const config = {
  apiBase: "/api",
  wsUrl: `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws`,
};
