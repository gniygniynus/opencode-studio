/* Zero-FOUC theme & desktop platform class pre-initializer (externalized for strict CSP compliance) */
(function () {
  try {
    var snap = JSON.parse(localStorage.getItem("ocs_ap_snap") || "null");
    if (snap && snap.theme === "dark") {
      document.documentElement.setAttribute("data-theme", "dark");
    }
    if (snap && snap.fontSize) {
      document.documentElement.style.setProperty("--font-size-base", snap.fontSize + "px");
    }
  } catch (e) {}
})();
