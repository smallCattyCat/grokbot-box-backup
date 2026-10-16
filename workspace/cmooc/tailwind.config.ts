import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx,mdx}"
  ],
  theme: {
    extend: {
      colors: {
        ink: "#17202a",
        paper: "#f7f7f2",
        moss: "#3e6b48",
        rust: "#a44f35",
        ocean: "#2f6f8f",
        amber: "#c18b31"
      }
    }
  },
  plugins: []
};

export default config;
