/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.js"],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "Segoe UI Variable", "Segoe UI", "system-ui", "-apple-system", "Roboto", "sans-serif"],
        mono: ["Cascadia Mono", "Consolas", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      colors: {
        ink: { 950: "#0b0f17", 900: "#0f1521", 850: "#141b29", 800: "#1a2233", 700: "#263046" },
      },
      keyframes: {
        stripes: { from: { backgroundPosition: "1rem 0" }, to: { backgroundPosition: "0 0" } },
        "fade-in": { from: { opacity: 0, transform: "translateY(4px)" }, to: { opacity: 1, transform: "none" } },
      },
      animation: {
        stripes: "stripes 1s linear infinite",
        "fade-in": "fade-in .18s ease-out",
      },
    },
  },
  plugins: [],
};
