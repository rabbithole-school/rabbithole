import type { SeedPortfolioItem } from "./types";

function robotScene({
  title,
  accent,
  detail,
}: {
  title: string;
  accent: string;
  detail: string;
}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800">
  <rect width="1200" height="800" fill="#f7f7fb"/>
  <rect x="70" y="70" width="1060" height="660" rx="36" fill="#ffffff" stroke="#d9d9e8" stroke-width="4"/>
  <text x="110" y="145" font-family="Arial, sans-serif" font-size="42" font-weight="700" fill="#25324b">${title}</text>
  <text x="110" y="190" font-family="Arial, sans-serif" font-size="24" fill="#667085">${detail}</text>
  <path d="M150 600 C360 520 650 690 1030 560" fill="none" stroke="${accent}" stroke-width="24" stroke-linecap="round" stroke-dasharray="18 22"/>
  <rect x="420" y="300" width="360" height="210" rx="30" fill="${accent}"/>
  <rect x="470" y="245" width="260" height="95" rx="24" fill="#25324b"/>
  <circle cx="540" cy="292" r="18" fill="#ffffff"/>
  <circle cx="660" cy="292" r="18" fill="#ffffff"/>
  <rect x="480" y="370" width="105" height="85" rx="14" fill="#ffffff"/>
  <rect x="615" y="370" width="105" height="85" rx="14" fill="#ffffff"/>
  <circle cx="470" cy="530" r="70" fill="#25324b"/>
  <circle cx="730" cy="530" r="70" fill="#25324b"/>
  <circle cx="470" cy="530" r="32" fill="#d9d9e8"/>
  <circle cx="730" cy="530" r="32" fill="#d9d9e8"/>
</svg>`;
}

export const roboticsPortfolioItems: SeedPortfolioItem[] = [
  {
    title: "Line follower test rig",
    caption:
      "The team tested a color sensor against a curved course and moved the sensor closer to the mat after the first run missed two turns.",
    scholarKeys: ["s.kalei", "s.mae", "s.theo"],
    svg: robotScene({
      title: "Line follower test rig",
      accent: "#ad60bf",
      detail: "Color sensor calibration - run 4",
    }),
  },
  {
    title: "Claw prototype test",
    caption:
      "Three builders compared two claw shapes, then added a lower brace so the robot could lift a foam block without twisting.",
    scholarKeys: ["s.leilani", "s.malia", "s.luca"],
    svg: robotScene({
      title: "Claw prototype test",
      accent: "#4f8cc9",
      detail: "Two claw shapes - one stronger brace",
    }),
  },
  {
    title: "Robotics team build review",
    caption:
      "The full group paused after the Wednesday build to compare their drive base, sensor, and claw changes before choosing the next test.",
    scholarKeys: [
      "s.kalei",
      "s.leilani",
      "s.malia",
      "s.iokepa",
      "s.mae",
      "s.theo",
      "s.luca",
    ],
    svg: robotScene({
      title: "Robotics team build review",
      accent: "#4f9d69",
      detail: "Wednesday Block E - shared evidence",
    }),
  },
];
