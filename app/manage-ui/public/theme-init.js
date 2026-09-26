// Pre-paint theme seed. Kept external so the application CSP needs no inline scripts.
(function () {
  var preference = null;
  try { preference = localStorage.getItem("openclaw.theme"); } catch (_) {}
  var dark = preference === "dark" || (preference === "system"
    && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
})();
