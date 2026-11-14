// Where the SphereX server lives. Empty = the same address as this page (running locally).
// On GitHub Pages the page and the server are on different addresses, so it points at our Google Cloud Run server.
const onPages = location.hostname.endsWith("github.io");
export const API = onPages ? "https://spherex-api-763325112045.us-east4.run.app" : "";
