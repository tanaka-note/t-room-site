export const WEATHER_LABELS = Object.freeze({
  sunny: "晴れ", cloudy: "曇り", partly_cloudy: "曇り晴れ", cloudy_rain: "雨くもり",
  rain: "雨", heavy_rain: "大雨", thunder: "雷", snow: "雪だるま"
});

export function createUnsetWeatherIcon() {
  const icon = document.createElement("span");
  icon.className = "weather-pictogram";
  icon.setAttribute("role", "img");
  icon.setAttribute("aria-label", "天気：未設定");
  icon.title = "未設定";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 32 32");
  svg.setAttribute("aria-hidden", "true");
  for (const [d, fill] of [
    ["m4 19 13-14a3 3 0 0 1 4 0l7 7a3 3 0 0 1 0 4L17 28H11l-7-5a3 3 0 0 1 0-4Z", "#cbd5e1"],
    ["m4 19 6-6 14 12-3 3H11l-7-5a3 3 0 0 1 0-4Z", "#f1f5f9"]
  ]) {
    const path = document.createElementNS(svg.namespaceURI, "path");
    for (const [key, value] of Object.entries({ d, fill, stroke: "#64748b", "stroke-width": "1.5", "stroke-linejoin": "round" })) path.setAttribute(key, value);
    svg.append(path);
  }
  icon.append(svg);
  return icon;
}

// Owned SVG shapes: no platform emoji, external assets or user-supplied markup.
export function createWeatherIcon(weather) {
  if (!Object.hasOwn(WEATHER_LABELS, weather)) return null;
  const icon = document.createElement("span");
  icon.className = "weather-pictogram";
  icon.dataset.weather = weather;
  icon.setAttribute("role", "img");
  icon.setAttribute("aria-label", `天気：${WEATHER_LABELS[weather]}`);
  icon.title = WEATHER_LABELS[weather];
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 32 32");
  svg.setAttribute("aria-hidden", "true");
  const shape = (tag, attrs) => {
    const node = document.createElementNS(svg.namespaceURI, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    svg.append(node);
  };
  const cloud = (fill = "#cbd5e1") => shape("path", {
    d: "M7 22a5 5 0 0 1-1-10 7 7 0 0 1 13-3 6 6 0 0 1 6 13Z",
    fill, stroke: "#64748b", "stroke-width": 1.4, "stroke-linejoin": "round"
  });
  const sun = (cx, cy, radius) => {
    for (let i = 0; i < 8; i++) {
      const a = i * Math.PI / 4;
      shape("line", { x1: cx + Math.cos(a) * (radius + 2), y1: cy + Math.sin(a) * (radius + 2),
        x2: cx + Math.cos(a) * (radius + 4), y2: cy + Math.sin(a) * (radius + 4),
        stroke: "#d97706", "stroke-width": 2, "stroke-linecap": "round" });
    }
    shape("circle", { cx, cy, r: radius, fill: "#fbbf24", stroke: "#d97706", "stroke-width": 1.2 });
  };
  const rain = (xs, color, end = 29) => {
    for (const x of xs) shape("line", { x1: x, y1: 25, x2: x - 2, y2: end,
      stroke: color, "stroke-width": 2.2, "stroke-linecap": "round" });
  };
  if (weather === "sunny") sun(16, 16, 7);
  if (weather === "cloudy") cloud();
  if (weather === "partly_cloudy") { sun(11, 10, 5); cloud("#dbe3eb"); }
  if (weather === "cloudy_rain") { cloud(); rain([13, 22], "#3b82f6", 27); }
  if (weather === "rain") { cloud("#93c5fd"); rain([9, 17, 25], "#2563eb"); }
  if (weather === "heavy_rain") { cloud("#64748b"); rain([7, 13, 19, 25], "#1d4ed8", 31); }
  if (weather === "thunder") {
    cloud("#94a3b8");
    shape("path", { d: "m17 17-6 8h5l-2 6 10-11h-6l3-3Z", fill: "#facc15", stroke: "#a16207", "stroke-width": 1 });
  }
  if (weather === "snow") {
    shape("circle", { cx: 16, cy: 23, r: 8, fill: "#effaff", stroke: "#38bdf8", "stroke-width": 1.5 });
    shape("circle", { cx: 16, cy: 11, r: 6, fill: "#fff", stroke: "#38bdf8", "stroke-width": 1.5 });
    shape("path", { d: "M10 5h12M12 5V1h8v4", fill: "#475569", stroke: "#475569", "stroke-width": 2 });
    shape("path", { d: "M11 17h10v3h-4v5h-3v-5h-3Z", fill: "#38bdf8" });
    for (const [cx, cy] of [[14, 10], [19, 10], [16, 25], [16, 28]]) shape("circle", { cx, cy, r: 1, fill: "#334155" });
    shape("path", { d: "m16 12 6 1-6 2Z", fill: "#f97316" });
  }
  icon.append(svg);
  return icon;
}
