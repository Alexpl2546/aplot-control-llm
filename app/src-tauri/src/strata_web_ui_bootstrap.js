function initializeStrataWebUi(origin, apiKey) {
  // Strata's app.js reads this JSON string before issuing authenticated requests.
  if (location.origin !== origin || window.top !== window) return;
  // Empty keys clear the credential of a previous server using the same port.
  localStorage.setItem("strata.apikey", JSON.stringify(apiKey));
  // Strata's optional API monitor uses a separate, session-scoped credential.
  sessionStorage.setItem("strata.monitor.key", apiKey);
}
