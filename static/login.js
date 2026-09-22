const form = document.getElementById("loginForm");
const errEl = document.getElementById("err");

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const password = document.getElementById("password").value;
  errEl.textContent = "";
  try {
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (res.ok) {
      window.location.href = "/";
    } else {
      errEl.textContent = "Password errata";
    }
  } catch (err) {
    errEl.textContent = "Errore di rete";
  }
});
