export function emit(changeset) {
  return { id: changeset?.id ?? "chg_001" }; // TODO: persist ChangeSet; do not touch a target system
}
