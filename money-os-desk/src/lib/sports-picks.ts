/**
 * Sports picks for Command Center / Dabble / prediction markets.
 * Live recommendation as of 2026-10-22.
 */

export const CURRENT_PICKS = [
  {
    sport: "WNBA",
    event: "Las Vegas Aces @ Seattle Storm",
    date: "2026-09-17",
    picks: [
      {
        type: "moneyline",
        selection: "Las Vegas Aces",
        confidence: "high",
        note: "Up 23 in 3rd, Kalshi/Polymarket ~99%, books -9.5 to -10.5",
      },
      {
        type: "player_prop",
        player: "A'ja Wilson",
        market: "points",
        selection: "over 24.5",
        confidence: "cashed",
        note: "Already 31 pts on 11/15 FG in 24 min",
      },
      {
        type: "player_prop",
        player: "Jackie Young",
        market: "points",
        selection: "over 18.5",
        confidence: "medium",
        note: "Dropped 22 in Q1, currently 5 on 2/8 but room to clear",
      },
    ],
    platform: "Dabble",
    status: "live",
  },
];

export function getCurrentPicks() {
  return CURRENT_PICKS;
}
