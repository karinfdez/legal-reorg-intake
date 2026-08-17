export async function extract(text, classification) {
  return {
    id: "chg_001",
    type: classification?.type ?? "team_move",
    team_size: 6,
    manager_from: "Jordan Hale",
    manager_to: "Maya Chen",
    effective_date: "2026-10-01",
    cost_center_from: "CC-4100",
    cost_center_to: "CC-4200",
  }; // TODO
}
