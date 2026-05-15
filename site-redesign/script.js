const toggle = document.querySelector("[data-nav-toggle]");
const nav = document.querySelector("[data-nav]");

if (toggle && nav) {
  toggle.addEventListener("click", () => {
    const isOpen = nav.classList.toggle("is-open");
    document.body.classList.toggle("nav-open", isOpen);
    toggle.setAttribute("aria-expanded", String(isOpen));
  });

  nav.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => {
      nav.classList.remove("is-open");
      document.body.classList.remove("nav-open");
      toggle.setAttribute("aria-expanded", "false");
    });
  });
}

const revealObserver = "IntersectionObserver" in window
  ? new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            revealObserver.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12 }
    )
  : null;

document.querySelectorAll(".reveal").forEach((element) => {
  if (revealObserver) {
    revealObserver.observe(element);
  } else {
    element.classList.add("is-visible");
  }
});

if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
  document.querySelectorAll("video[autoplay]").forEach((video) => {
    video.removeAttribute("autoplay");
    video.pause();
  });
}

document.querySelectorAll("[data-mail-form]").forEach((form) => {
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const subject = encodeURIComponent(data.get("subject") || "Blank Space inquiry");
    const lines = [];

    for (const [key, value] of data.entries()) {
      if (key !== "subject" && value) {
        const label = key
          .replaceAll("-", " ")
          .replace(/\b\w/g, (letter) => letter.toUpperCase());
        lines.push(`${label}: ${value}`);
      }
    }

    const body = encodeURIComponent(lines.join("\n"));
    window.location.href = `mailto:oxfordoccasions@gmail.com?subject=${subject}&body=${body}`;

    const status = form.querySelector("[data-form-status]");
    if (status) {
      status.textContent = "Your email app should open with the details filled in. If it does not, email oxfordoccasions@gmail.com.";
    }
  });
});
