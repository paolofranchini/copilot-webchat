if ("serviceWorker" in navigator && window.isSecureContext) {
  navigator.serviceWorker.register("/service-worker.js")
    .catch((error) => console.error("Registrazione service worker non riuscita:", error));
}
